// Stdio MCP server for clients that cannot reach a remote endpoint (and for
// registries such as Glama that build and start the server in a container).
// Each JSON-RPC line from stdin is sent to the public Streamable HTTP endpoint
// and the answer is written to stdout. No dependencies; Node 18+.
// Usage: node scripts/stdio-bridge.mjs [endpoint]   (default https://commons.dooza.ai/mcp)
import { createInterface } from 'node:readline';

const endpoint =
  process.argv[2] || process.env.COMMONS_MCP_URL || 'https://commons.dooza.ai/mcp';
let session = '';

function errorFor(message, text) {
  if (message?.id === undefined || message?.id === null) return null;
  return { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: text } };
}

// The endpoint answers with plain JSON or, for some clients, an SSE stream.
function parseBody(type, text) {
  if (!text.trim()) return [];
  if (!type.includes('text/event-stream')) return [JSON.parse(text)];
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5)));
}

async function forward(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return [{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }];
  }
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'user-agent': 'agent-commons-stdio-bridge/1',
        ...(session ? { 'mcp-session-id': session } : {}),
      },
      body: line,
    });
    session = response.headers.get('mcp-session-id') || session;
    const text = await response.text();
    if (!response.ok && !text.trim()) {
      const failure = errorFor(message, `HTTP ${response.status} from ${endpoint}`);
      return failure ? [failure] : [];
    }
    return parseBody(response.headers.get('content-type') || '', text);
  } catch (error) {
    const failure = errorFor(message, `Cannot reach ${endpoint}: ${error.message}`);
    return failure ? [failure] : [];
  }
}

// Answer in arrival order so clients that match by position stay in step.
let queue = Promise.resolve();
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  queue = queue.then(async () => {
    for (const reply of await forward(line)) process.stdout.write(`${JSON.stringify(reply)}\n`);
  });
});
