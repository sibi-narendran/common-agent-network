import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  contract,
  diffContract,
  McpClient,
  runCanary,
  validateEntries,
  writeJson,
} from './mcp-canary.mjs';

const sha = 'a'.repeat(40);
const tools = [
  {
    name: 'read_entries',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', default: 25 } },
      additionalProperties: false,
    },
  },
];
const expected = {
  formatVersion: 1,
  sourceSha: sha,
  tools: contract(tools),
  toolsSha256: createHash('sha256')
    .update(JSON.stringify(contract(tools)))
    .digest('hex'),
};
const entries = {
  content: [{ type: 'text', text: '{"entries":[]}' }],
  structuredContent: { result: { entries: [] } },
};

async function server(t, handler) {
  const calls = [];
  const instance = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const call = JSON.parse(body);
    calls.push({ ...call, headers: request.headers });
    const result = await handler(call, response, calls);
    if (response.headersSent || result === null) return;
    if (call.method === 'notifications/initialized') {
      response.writeHead(202);
      response.end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
  });
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        instance.close(resolve);
        instance.closeAllConnections();
      }),
  );
  return { endpoint: `http://127.0.0.1:${instance.address().port}/mcp`, calls };
}

function responseFor(call) {
  if (call.method === 'initialize')
    return {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'fixture', version: '1' },
    };
  if (call.method === 'tools/list') return { tools };
  if (call.method === 'tools/call') return entries;
  return {};
}

const options = (endpoint) => ({
  endpoint,
  expected,
  sourceSha: sha,
  attempts: 1,
  timeoutMs: 500,
  budgetMs: 2000,
  delayMs: 1,
});

test('compare tool names and full input schemas independent of object/tool order', () => {
  const other = {
    name: 'other',
    inputSchema: { type: 'object', properties: {} },
  };
  assert.deepEqual(diffContract([other, ...tools], [...tools, other]), {
    missing: [],
    unexpected: [],
    changed: [],
  });
  const changed = structuredClone(tools);
  changed[0].inputSchema.properties.limit.default = 1;
  assert.deepEqual(diffContract(tools, [other, ...changed]), {
    missing: [],
    unexpected: ['other'],
    changed: ['read_entries'],
  });
  assert.deepEqual(diffContract([other, ...tools], tools).missing, ['other']);
  assert.throws(() => contract([...tools, ...tools]), /duplicate/);
  assert.throws(() => contract([{ name: 'bad' }]), /Invalid/);
});

test('JSON handshake, negotiated headers, pagination and only read_entries; evidence omits entries/session', async (t) => {
  const fixture = await server(t, (call, res) => {
    if (call.method === 'initialize')
      res.setHeader('mcp-session-id', 'private-session');
    if (call.method === 'tools/list' && !call.params.cursor)
      return { tools: [], nextCursor: 'page-2' };
    if (call.method === 'tools/call')
      return {
        ...entries,
        structuredContent: {
          result: { entries: [{ id: 'entry-1', body: 'private-sentinel' }] },
        },
      };
    return responseFor(call);
  });
  const { evidence } = await runCanary(options(fixture.endpoint));
  assert.equal(evidence.status, 'passed');
  assert.deepEqual(
    fixture.calls.map((call) => call.method),
    [
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/list',
      'tools/call',
    ],
  );
  assert.equal(fixture.calls[1].id, undefined);
  assert.equal(fixture.calls[2].headers['mcp-protocol-version'], '2025-06-18');
  assert.equal(fixture.calls[2].headers['mcp-session-id'], 'private-session');
  assert.deepEqual(fixture.calls.at(-1).params, {
    name: 'read_entries',
    arguments: { limit: 1 },
  });
  assert.equal(evidence.attempts[0].call.entriesCount, 1);
  assert.doesNotMatch(
    JSON.stringify(evidence),
    /private-sentinel|private-session|entry-1/,
  );
});

test('SSE handles chunks, CRLF, unrelated notifications and an open stream', async (t) => {
  const fixture = await server(t, (call, res) => {
    if (call.method === 'notifications/initialized') return {};
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(
      ': keepalive\r\ndata: {"jsonrpc":"2.0","method":"notifications/message"}\r',
    );
    res.write('\n\r\n');
    const message = JSON.stringify({
      jsonrpc: '2.0',
      id: call.id,
      result: responseFor(call),
    });
    res.write(`event: message\r\ndata: ${message.slice(0, 30)}`);
    res.write(`${message.slice(30)}\r\n\r\n`);
    return null;
  });
  assert.equal(
    (await runCanary(options(fixture.endpoint))).evidence.status,
    'passed',
  );
});

test('drift fails before tools/call and retries can recover a propagating deployment', async (t) => {
  const changed = structuredClone(tools);
  changed[0].inputSchema.additionalProperties = true;
  const fixture = await server(t, (call, res, calls) =>
    call.method === 'tools/list' &&
    calls.filter((item) => item.method === 'initialize').length === 1
      ? { tools: changed }
      : responseFor(call),
  );
  const { evidence } = await runCanary({
    ...options(fixture.endpoint),
    attempts: 2,
  });
  assert.equal(evidence.status, 'passed');
  assert.deepEqual(evidence.attempts[0].diff.changed, ['read_entries']);
  assert.equal(
    fixture.calls.filter((call) => call.method === 'tools/call').length,
    1,
  );
});

test('persistent name/schema drift fails without a tool call', async (t) => {
  const fixture = await server(t, (call) =>
    call.method === 'tools/list'
      ? {
          tools: [
            ...tools,
            { name: 'unexpected', inputSchema: { type: 'object' } },
          ],
        }
      : responseFor(call),
  );
  const { evidence } = await runCanary(options(fixture.endpoint));
  assert.equal(evidence.status, 'failed');
  assert.deepEqual(evidence.attempts[0].diff.unexpected, ['unexpected']);
  assert.equal(
    fixture.calls.some((call) => call.method === 'tools/call'),
    false,
  );
});

for (const { label, result } of [
  { label: 'isError', result: { ...entries, isError: true } },
  {
    label: 'missing entries',
    result: { content: [{ type: 'text', text: '{"ok":true}' }] },
  },
  {
    label: 'invalid JSON text',
    result: { content: [{ type: 'text', text: 'not json' }] },
  },
  {
    label: 'malformed entries',
    result: { ...entries, structuredContent: { result: { entries: [{}] } } },
  },
]) {
  test(`HTTP 200 with ${label} fails the call`, async (t) => {
    const fixture = await server(t, (call) =>
      call.method === 'tools/call' ? result : responseFor(call),
    );
    const { evidence } = await runCanary(options(fixture.endpoint));
    assert.equal(evidence.status, 'failed');
    assert.equal(evidence.attempts[0].stage, 'tools/call');
  });
}

test('text-only entries and an empty board are valid', () => {
  assert.equal(validateEntries({ content: entries.content }).entriesCount, 0);
});

for (const label of [
  'wrong id',
  'RPC error',
  'unsupported protocol',
  'HTTP failure',
  'repeated cursor',
]) {
  test(`${label} fails closed`, async (t) => {
    const fixture = await server(t, (call, res) => {
      if (label === 'HTTP failure') {
        res.writeHead(503);
        res.end('private-body');
        return null;
      }
      if (label === 'wrong id' || label === 'RPC error') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(
            label === 'wrong id'
              ? { jsonrpc: '2.0', id: 999, result: {} }
              : {
                  jsonrpc: '2.0',
                  id: call.id,
                  error: { code: -32603, message: 'private-body' },
                },
          ),
        );
        return null;
      }
      if (label === 'unsupported protocol' && call.method === 'initialize')
        return { ...responseFor(call), protocolVersion: 'future' };
      if (label === 'repeated cursor' && call.method === 'tools/list')
        return { tools: [], nextCursor: 'loop' };
      return responseFor(call);
    });
    const { evidence } = await runCanary(options(fixture.endpoint));
    assert.equal(evidence.status, 'failed');
    assert.doesNotMatch(JSON.stringify(evidence), /private-body/);
  });
}

test('request timeout covers headers and hanging SSE body; total budget bounds retries', async (t) => {
  for (const stream of [false, true]) {
    const fixture = await server(t, (call, res) => {
      if (stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': heartbeat\n\n');
      }
      return null;
    });
    const started = Date.now();
    const { evidence } = await runCanary({
      ...options(fixture.endpoint),
      timeoutMs: 100,
      budgetMs: 160,
      attempts: 5,
    });
    assert.equal(evidence.status, 'failed');
    assert.match(evidence.attempts[0].error, /timeout/);
    assert.ok(Date.now() - started < 1000);
  }
});

test('expected snapshot must match source commit and hash', async () => {
  await assert.rejects(
    runCanary({
      ...options('http://127.0.0.1:1/mcp'),
      sourceSha: 'b'.repeat(40),
    }),
    /provenance/,
  );
  await assert.rejects(
    runCanary({
      ...options('http://127.0.0.1:1/mcp'),
      expected: { ...expected, toolsSha256: 'tampered' },
    }),
    /provenance/,
  );
  assert.throws(
    () => new McpClient('https://user:secret@example.com/mcp'),
    /without credentials/,
  );
});

test('CLI persists failed evidence and exits nonzero', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-canary-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeJson(join(dir, 'expected.json'), expected);
  const fixture = await server(t, (call) =>
    call.method === 'tools/call'
      ? { ...entries, isError: true }
      : responseFor(call),
  );
  const child = spawn(
    process.execPath,
    [
      'scripts/mcp-canary.mjs',
      '--endpoint',
      fixture.endpoint,
      '--expected',
      join(dir, 'expected.json'),
      '--evidence',
      join(dir, 'evidence.json'),
      '--sha',
      sha,
      '--attempts',
      '1',
    ],
    { stdio: 'ignore' },
  );
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 1);
  assert.equal(
    JSON.parse(await readFile(join(dir, 'evidence.json'), 'utf8')).status,
    'failed',
  );
});

async function runCli(t, args, options = {}) {
  const child = spawn(process.execPath, args, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { code, output };
}

for (const scenario of [
  {
    label: 'basic auth',
    endpoint: 'https://sentinel-user:sentinel-password@example.invalid/mcp',
  },
  {
    label: 'query token',
    endpoint: 'https://example.invalid/mcp?token=sentinel-query',
  },
  {
    label: 'fragment',
    endpoint: 'https://example.invalid/mcp#sentinel-fragment',
  },
  { label: 'malformed URL', endpoint: 'sentinel-invalid-url' },
  {
    label: 'capture query token',
    endpoint: 'http://127.0.0.1:1/mcp?token=sentinel-capture',
    capture: true,
  },
]) {
  test(`reject ${scenario.label} before recording endpoint evidence`, async (t) => {
    let requests = 0;
    await assert.rejects(
      runCanary({
        ...options(scenario.endpoint),
        fetchImpl: async () => {
          requests++;
          throw new Error('Unexpected network request');
        },
      }),
      (error) => {
        assert.doesNotMatch(error.message, /sentinel-/);
        return true;
      },
    );
    assert.equal(requests, 0);
    const dir = await mkdtemp(join(tmpdir(), 'mcp-endpoint-test-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeJson(join(dir, 'expected.json'), expected);
    const args = [
      'scripts/mcp-canary.mjs',
      '--endpoint',
      scenario.endpoint,
      scenario.capture ? '--capture' : '--expected',
      join(dir, scenario.capture ? 'captured.json' : 'expected.json'),
      '--evidence',
      join(dir, 'evidence.json'),
      '--sha',
      sha,
      '--attempts',
      '1',
    ];
    const result = await runCli(t, args);
    assert.equal(result.code, 1);
    const raw = await readFile(join(dir, 'evidence.json'), 'utf8');
    assert.equal(JSON.parse(raw).status, 'failed');
    assert.doesNotMatch(raw + result.output, /sentinel-/);
    assert.equal(Object.hasOwn(JSON.parse(raw), 'endpoint'), false);
  });
}

function namedStep(workflow, name) {
  const section = workflow
    .split(`      - name: ${name}\n`)[1]
    ?.split('\n      - name:')[0];
  assert.ok(section, `Missing workflow step: ${name}`);
  return section;
}

// Evaluate the workflow's actual conjunctions against step outcomes, including
// artifact-service failures after a healthy canary (the original regression).
function conditionMatches(condition, outcomes) {
  return condition.split(/\s*&&\s*/).every((term) => {
    if (term === 'always()') return true;
    if (term === 'failure()')
      return Object.values(outcomes).includes('failure');
    const match = /^steps\.([a-z_]+)\.outcome == '(\w+)'$/.exec(term);
    assert.ok(match, `Unsupported workflow condition: ${term}`);
    return outcomes[match[1]] === match[2];
  });
}

test('workflow distinguishes canary failure from evidence upload failure', async () => {
  const workflow = await readFile('.github/workflows/mcp-canary.yml', 'utf8');
  const evidenceStep = namedStep(workflow, 'Preserve MCP canary evidence');
  assert.match(evidenceStep, /^\s+id: evidence$/m);
  const recovery = /^\s+if: (.+)$/m.exec(
    namedStep(workflow, 'Report human recovery path'),
  )?.[1];
  const upload = /^\s+if: (.+)$/m.exec(
    namedStep(workflow, 'Report evidence upload failure'),
  )?.[1];
  assert.ok(recovery && upload);
  for (const scenario of [
    {
      deploy: 'success',
      canary: 'success',
      evidence: 'success',
      recovery: false,
      upload: false,
    },
    {
      deploy: 'success',
      canary: 'success',
      evidence: 'failure',
      recovery: false,
      upload: true,
    },
    {
      deploy: 'success',
      canary: 'failure',
      evidence: 'success',
      recovery: true,
      upload: false,
    },
    {
      deploy: 'success',
      canary: 'failure',
      evidence: 'failure',
      recovery: true,
      upload: true,
    },
    {
      deploy: 'failure',
      canary: 'skipped',
      evidence: 'failure',
      recovery: false,
      upload: true,
    },
    {
      deploy: 'success',
      canary: 'cancelled',
      evidence: 'success',
      recovery: false,
      upload: false,
    },
  ]) {
    assert.equal(conditionMatches(recovery, scenario), scenario.recovery);
    assert.equal(conditionMatches(upload, scenario), scenario.upload);
  }
});

test('failed local Worker startup preserves stdout/stderr in an uploaded artifact', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-startup-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'scripts'), { recursive: true });
  await mkdir(join(dir, 'node_modules/wrangler/bin'), { recursive: true });
  for (const name of ['capture-mcp-contract.mjs', 'mcp-canary.mjs']) {
    await copyFile(new URL(name, import.meta.url), join(dir, 'scripts', name));
  }
  await writeFile(
    join(dir, 'node_modules/wrangler/bin/wrangler.js'),
    'process.stdout.end("startup-stdout-diagnostic\\n");\nsetTimeout(() => { process.stderr.write("startup-stderr-root-cause\\n"); process.exitCode = 1; }, 25);\n',
  );
  const result = await runCli(t, ['scripts/capture-mcp-contract.mjs'], {
    cwd: dir,
    env: { ...process.env, GITHUB_SHA: sha },
  });
  assert.equal(result.code, 1);
  const diagnostic = JSON.parse(
    await readFile(join(dir, 'work/mcp-local-startup-error.json'), 'utf8'),
  );
  assert.equal(diagnostic.status, 'failed');
  const log = await readFile(join(dir, 'work/mcp-local-worker.log'), 'utf8');
  assert.match(log, /startup-stdout-diagnostic/);
  assert.match(log, /startup-stderr-root-cause/);
  assert.equal(diagnostic.error, 'Local Worker exited before ready');
  const workflow = await readFile('.github/workflows/mcp-canary.yml', 'utf8');
  const artifact = namedStep(workflow, 'Preserve MCP canary evidence');
  assert.match(artifact, /^\s+if: always\(\)$/m);
  assert.match(artifact, /^\s+source\/work\/mcp-local-worker\.log$/m);
});
