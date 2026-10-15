import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

const PROTOCOL = '2025-06-18';
const SUPPORTED = new Set(['2025-03-26', PROTOCOL, '2025-11-25']);
const MAX_BYTES = 2 * 1024 * 1024;
const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function validateEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    // URL parser diagnostics may include the raw input. Keep errors credential-free.
    throw new Error('Invalid MCP endpoint URL');
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost'].includes(url.hostname)
      ))
  ) {
    throw new Error(
      'Use HTTPS or loopback HTTP without credentials, query or fragment',
    );
  }
  return url.href;
}

// Object key order and tools/list order are immaterial; schema arrays are preserved.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

export function contract(tools) {
  if (!Array.isArray(tools) || !tools.length)
    throw new Error('tools/list must contain tools');
  const names = new Set();
  return tools
    .map((tool) => {
      if (
        !isObject(tool) ||
        typeof tool.name !== 'string' ||
        !tool.name ||
        names.has(tool.name) ||
        !isObject(tool.inputSchema) ||
        tool.inputSchema.type !== 'object'
      ) {
        throw new Error('Invalid or duplicate tool definition');
      }
      names.add(tool.name);
      return { name: tool.name, inputSchema: canonical(tool.inputSchema) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function diffContract(expected, actual) {
  const left = new Map(
    contract(expected).map((tool) => [tool.name, tool.inputSchema]),
  );
  const right = new Map(
    contract(actual).map((tool) => [tool.name, tool.inputSchema]),
  );
  return {
    missing: [...left.keys()].filter((name) => !right.has(name)),
    unexpected: [...right.keys()].filter((name) => !left.has(name)),
    changed: [...left.keys()].filter(
      (name) =>
        right.has(name) &&
        JSON.stringify(left.get(name)) !== JSON.stringify(right.get(name)),
    ),
  };
}

const digest = (tools) =>
  createHash('sha256')
    .update(JSON.stringify(contract(tools)))
    .digest('hex');

export function validateEntries(result) {
  if (
    !isObject(result) ||
    (result.isError !== undefined && result.isError !== false) ||
    !Array.isArray(result.content)
  ) {
    throw new Error('read_entries failed or returned invalid MCP content');
  }
  const structured = result.structuredContent?.result;
  const texts = result.content.filter(
    (item) => item.type === 'text' && typeof item.text === 'string',
  );
  let payload = structured;
  if (payload === undefined) {
    try {
      payload = JSON.parse(texts[0]?.text);
    } catch {
      throw new Error('read_entries did not return JSON entries');
    }
  }
  if (
    !isObject(payload) ||
    !Array.isArray(payload.entries) ||
    payload.entries.length > 1 ||
    payload.entries.some(
      (entry) => !isObject(entry) || typeof entry.id !== 'string' || !entry.id,
    )
  ) {
    throw new Error('read_entries did not return an entries array for limit=1');
  }
  return {
    tool: 'read_entries',
    arguments: { limit: 1 },
    entriesCount: payload.entries.length,
  };
}

// SSE streams may stay open. Read only through the matching response, then cancel.
async function rpcBody(response, id) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty JSON-RPC response');
  const decoder = new TextDecoder();
  const sse = (response.headers.get('content-type') || '').includes(
    'text/event-stream',
  );
  let buffer = '';
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      bytes += value?.byteLength || 0;
      if (bytes > MAX_BYTES) throw new Error('JSON-RPC response exceeds 2 MiB');
      buffer += decoder.decode(value, { stream: !done });
      if (sse) {
        // Normalize CRLF across chunk boundaries as well as within chunks.
        buffer = buffer.replace(/\r\n/g, '\n');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
          let message;
          try {
            message = JSON.parse(data);
          } catch {
            throw new Error('Invalid SSE JSON');
          }
          if (message.id === id) return message;
        }
      }
      if (done) break;
    }
    if (sse) throw new Error('SSE ended without matching JSON-RPC id');
    try {
      return JSON.parse(buffer);
    } catch {
      throw new Error('Invalid JSON-RPC JSON');
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export class McpClient {
  constructor(
    endpoint,
    {
      timeoutMs = 10000,
      deadline = Date.now() + 90000,
      fetchImpl = fetch,
    } = {},
  ) {
    this.endpoint = validateEndpoint(endpoint);
    this.timeoutMs = timeoutMs;
    this.deadline = deadline;
    this.fetchImpl = fetchImpl;
    this.id = 0;
    this.protocol = undefined;
    this.session = undefined;
  }

  async send(method, params = {}, notification = false) {
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw new Error('Canary deadline exceeded');
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(this.timeoutMs, remaining),
    );
    const id = notification ? undefined : ++this.id;
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'user-agent': 'agent-commons-canary/1.0',
    };
    if (this.protocol) headers['mcp-protocol-version'] = this.protocol;
    if (this.session) headers['mcp-session-id'] = this.session;
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers,
        redirect: 'error',
        signal: controller.signal,
        body: JSON.stringify({
          jsonrpc: '2.0',
          ...(notification ? {} : { id }),
          method,
          params,
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`${method}: HTTP ${response.status}`);
      }
      if (notification) {
        await response.body?.cancel();
        return;
      }
      if (method === 'initialize')
        this.session = response.headers.get('mcp-session-id') || undefined;
      const message = await rpcBody(response, id);
      if (
        !isObject(message) ||
        message.jsonrpc !== '2.0' ||
        message.id !== id ||
        Object.hasOwn(message, 'error') ||
        !isObject(message.result)
      ) {
        throw new Error(`${method}: invalid or error JSON-RPC response`);
      }
      return message.result;
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`${method}: timeout`);
      // Do not copy remote error bodies, headers, session IDs or entry text to evidence.
      if (error instanceof TypeError)
        throw new Error(`${method}: network failure`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async initialize() {
    const info = await this.send('initialize', {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'agent-commons-canary', version: '1.0.0' },
    });
    if (
      !SUPPORTED.has(info.protocolVersion) ||
      !isObject(info.capabilities?.tools) ||
      typeof info.serverInfo?.name !== 'string' ||
      typeof info.serverInfo?.version !== 'string'
    ) {
      throw new Error('Invalid initialize result or unsupported protocol');
    }
    this.protocol = info.protocolVersion;
    await this.send('notifications/initialized', {}, true);
    return {
      protocolVersion: info.protocolVersion,
      serverInfo: {
        name: info.serverInfo.name,
        version: info.serverInfo.version,
      },
    };
  }

  async listTools() {
    const tools = [];
    const cursors = new Set();
    let cursor;
    do {
      const page = await this.send(
        'tools/list',
        cursor === undefined ? {} : { cursor },
      );
      if (!Array.isArray(page.tools))
        throw new Error('tools/list missing tools array');
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (
          typeof cursor !== 'string' ||
          !cursor ||
          cursors.has(cursor) ||
          cursors.size >= 20
        )
          throw new Error('Invalid tools/list pagination');
        cursors.add(cursor);
      }
    } while (cursor !== undefined);
    return contract(tools);
  }
}

export async function runCanary({
  endpoint,
  expected,
  sourceSha,
  attempts = 5,
  timeoutMs = 10000,
  budgetMs = 90000,
  delayMs = 1000,
  fetchImpl = fetch,
}) {
  // Reject secret-bearing URLs before building any evidence or attempt record.
  endpoint = validateEndpoint(endpoint);
  if (!/^[a-f0-9]{40}$/.test(sourceSha || ''))
    throw new Error('A full source commit SHA is required');
  if (
    expected &&
    (expected.sourceSha !== sourceSha ||
      expected.formatVersion !== 1 ||
      expected.toolsSha256 !== digest(expected.tools))
  )
    throw new Error(
      'Expected contract provenance/hash does not match this build',
    );
  const deadline = Date.now() + budgetMs;
  const evidence = {
    formatVersion: 1,
    sourceSha,
    endpoint,
    startedAt: new Date().toISOString(),
    status: 'failed',
    attempts: [],
  };
  let snapshot;
  for (
    let attempt = 1;
    attempt <= attempts && Date.now() < deadline;
    attempt++
  ) {
    const record = { attempt, stage: 'initialize' };
    evidence.attempts.push(record);
    try {
      const client = new McpClient(endpoint, {
        timeoutMs,
        deadline,
        fetchImpl,
      });
      record.initialize = await client.initialize();
      record.stage = 'tools/list';
      record.tools = await client.listTools();
      record.toolsSha256 = digest(record.tools);
      if (!record.tools.some((tool) => tool.name === 'read_entries'))
        throw new Error('read_entries is missing');
      if (expected) {
        record.diff = diffContract(expected.tools, record.tools);
        if (Object.values(record.diff).some((names) => names.length))
          throw new Error('Built and live MCP contracts differ');
      }
      record.stage = 'tools/call';
      record.call = validateEntries(
        await client.send('tools/call', {
          name: 'read_entries',
          arguments: { limit: 1 },
        }),
      );
      record.stage = 'complete';
      record.status = 'passed';
      evidence.status = 'passed';
      snapshot = {
        formatVersion: 1,
        sourceSha,
        ...record.initialize,
        tools: record.tools,
        toolsSha256: record.toolsSha256,
      };
      break;
    } catch (error) {
      record.status = 'failed';
      record.error = error.message;
    }
    if (attempt < attempts)
      await sleep(
        Math.min(
          delayMs * 2 ** (attempt - 1),
          10000,
          Math.max(0, deadline - Date.now()),
        ),
      );
  }
  evidence.finishedAt = new Date().toISOString();
  return { evidence, snapshot };
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      endpoint: { type: 'string' },
      expected: { type: 'string' },
      capture: { type: 'string' },
      evidence: { type: 'string', default: 'work/mcp-canary.json' },
      sha: { type: 'string', default: process.env.GITHUB_SHA },
      attempts: { type: 'string', default: '5' },
      timeout: { type: 'string', default: '10000' },
      budget: { type: 'string', default: '90000' },
    },
  });
  let report;
  try {
    if (
      !values.endpoint ||
      Boolean(values.expected) === Boolean(values.capture)
    )
      throw new Error(
        'Specify endpoint and exactly one of expected or capture',
      );
    const endpoint = validateEndpoint(values.endpoint);
    const numeric = ['attempts', 'timeout', 'budget'].map((key) =>
      Number(values[key]),
    );
    if (
      numeric.some((value) => !Number.isSafeInteger(value) || value < 1) ||
      numeric[0] > 20 ||
      numeric[1] > 30000 ||
      numeric[2] > 120000
    )
      throw new Error('Invalid attempts/timeout/budget bounds');
    if (
      values.capture &&
      !['localhost', '127.0.0.1'].includes(new URL(endpoint).hostname)
    )
      throw new Error(
        'Capture the expected contract from the local build only',
      );
    const expected = values.expected
      ? JSON.parse(await readFile(values.expected, 'utf8'))
      : undefined;
    const { evidence, snapshot } = await runCanary({
      endpoint,
      expected,
      sourceSha: values.sha,
      attempts: numeric[0],
      timeoutMs: numeric[1],
      budgetMs: numeric[2],
    });
    report = evidence;
    if (snapshot && values.capture) await writeJson(values.capture, snapshot);
  } catch (error) {
    report = {
      formatVersion: 1,
      sourceSha: values.sha,
      status: 'failed',
      error: error.message,
    };
  }
  await writeJson(values.evidence, report);
  console.log(`MCP canary ${report.status}; evidence: ${values.evidence}`);
  if (report.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
