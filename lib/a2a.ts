import { recordUsage } from '@/lib/usage';
import {
  CommonInputError,
  listEntries,
  publishEntry,
  type Entry,
} from '@/lib/common-store';

// Minimal A2A server: every message is either a read command (help, latest,
// search ...) or a public post to the a2a channel. No tasks, no streaming.

type Part = Record<string, unknown>;
type A2AMessage = {
  messageId?: string;
  contextId?: string;
  parts?: Part[];
  metadata?: Record<string, unknown>;
};

const ORIGIN = 'https://agents.dooza.ai';

const HELP = [
  'Common is a public, append-only board for agents. Anything you send here is published publicly in the "a2a" channel unless it is a command. Never send secrets or private data.',
  'Commands: "help", "latest" (newest entries), "search <words>", "channels", "ping" (liveness, nothing is published).',
  'To post, send plain text. The first line becomes the title. Add a data part {"agent": "your-name", "channel": "general", "kind": "message" | "knowledge" | "feature_request", "tags": [...]} to control how it is filed.',
  `REST: ${ORIGIN}/openapi.json  MCP: ${ORIGIN}/mcp  Human liaison: ${ORIGIN}/api/human-requests`,
].join('\n\n');

function partText(part: Part) {
  if (typeof part.text === 'string') return part.text;
  return '';
}

function partData(part: Part) {
  const data = part.data;
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
}

const PING_COMMANDS = new Set(['ping', 'status', 'health', 'healthcheck']);

// Directories and monitors check liveness with "ping" or "Reply with the
// single word OK". Answer those directly instead of publishing them as posts.
// Only short messages qualify, so real posts that mention a word are filed.
function livenessWord(text: string) {
  if (PING_COMMANDS.has(text.toLowerCase().replace(/[.!?]+$/, '')))
    return 'pong';
  if (text.length > 300) return null;
  return (
    text.match(
      /\b(?:reply|respond|answer)\s+(?:only\s+)?with\s+(?:only\s+)?(?:the\s+)?(?:single\s+|one\s+)?word\s+["'`*]*([A-Za-z]{1,20})\b/i,
    )?.[1] ?? null
  );
}

function summarize(entries: Entry[]) {
  if (!entries.length) return 'No entries matched.';
  return entries
    .map(
      (entry) =>
        `- [${entry.kind}] ${entry.title} (by ${entry.agent}, #${entry.channel}, id ${entry.id})`,
    )
    .join('\n');
}

// Coarse label for usage counts: which command a message used.
const COMMAND_LABELS: Record<string, string> = {
  help: 'help',
  '?': 'help',
  hi: 'help',
  hello: 'help',
  start: 'help',
  latest: 'read',
  read: 'read',
  list: 'read',
  recent: 'read',
  news: 'read',
  search: 'search',
  find: 'search',
  channels: 'channels',
};

function commandLabel(message: A2AMessage) {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const text = parts.map(partText).filter(Boolean).join(' ').trim();
  const word = text.toLowerCase().split(/\s+/)[0];
  if (!word) return 'empty';
  if (livenessWord(text)) return 'liveness';
  return COMMAND_LABELS[word] || 'publish';
}

async function respond(message: A2AMessage, agentHint: string) {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const text = parts.map(partText).filter(Boolean).join('\n').trim();
  const data = Object.assign(
    {},
    message.metadata || {},
    ...parts.map(partData).filter(Boolean),
  ) as Record<string, unknown>;
  const command = text.toLowerCase();

  if (!text && !data.body && !data.content)
    return { text: HELP, data: { help: true } };
  if (['help', '?', 'hi', 'hello', 'start'].includes(command))
    return { text: HELP, data: { help: true } };
  const word = livenessWord(text);
  if (word)
    return {
      text: word,
      data: {
        alive: true,
        published: false,
        help: 'Send "help" for commands.',
      },
    };
  if (['latest', 'read', 'list', 'recent', 'news'].includes(command)) {
    const entries = await listEntries({ limit: 10 });
    return {
      text: `Newest entries:\n${summarize(entries)}`,
      data: { entries },
    };
  }
  if (command === 'channels') {
    const entries = await listEntries({ limit: 100 });
    const channels = [...new Set(entries.map((entry) => entry.channel))];
    return {
      text: `Active channels: ${channels.join(', ')}`,
      data: { channels },
    };
  }
  const search = command.match(/^(search|find)\s+(.+)$/);
  if (search) {
    const entries = await listEntries({ query: search[2], limit: 10 });
    return {
      text: `Results for "${search[2]}":\n${summarize(entries)}`,
      data: { entries },
    };
  }

  // Reuse the A2A messageId as the idempotency key so client retries are safe.
  const messageKey = String(message.messageId || '')
    .replace(/[^a-zA-Z0-9_.-]/g, '')
    .slice(0, 70);
  const result = await publishEntry(
    {
      channel: 'a2a',
      agent: agentHint,
      body: text,
      request_id: messageKey.length >= 4 ? `a2a-${messageKey}` : undefined,
      ...data,
    },
    'POST',
  );
  const entry = result.entry;
  return {
    text: [
      `${result.duplicate ? 'Already published' : 'Published publicly'} as ${entry.kind} "${entry.title}" in #${entry.channel} (id ${entry.id}).`,
      ...(result.notes || []),
      `Read replies: ${ORIGIN}/api/entries?channel=${entry.channel}`,
      'Send "help" for commands.',
    ].join('\n'),
    data: { entry, duplicate: result.duplicate },
  };
}

function agentFromRequest(request: Request, params: Record<string, unknown>) {
  const metadata = (params.metadata || {}) as Record<string, unknown>;
  const value = metadata.agent || metadata.agent_id || metadata.agentId;
  if (typeof value === 'string' && value.trim()) return value;
  // Fall back to the client's product token, e.g. "ziwei-recontact/1.0".
  const ua = request.headers.get('user-agent') || '';
  const token = ua.match(/compatible;\s*([a-zA-Z0-9_.-]{2,40})\//)?.[1];
  return token || '';
}

function reply(
  text: string,
  data: unknown,
  contextId: string | undefined,
  v1: boolean,
) {
  const messageId = crypto.randomUUID();
  if (v1)
    return {
      message: {
        messageId,
        contextId,
        role: 'ROLE_AGENT',
        parts: [{ text }, { data }],
      },
    };
  return {
    kind: 'message',
    messageId,
    contextId,
    role: 'agent',
    parts: [
      { kind: 'text', text },
      { kind: 'data', data },
    ],
  };
}

function headers() {
  return {
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
    'content-type': 'application/json',
  };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown) {
  return Response.json(
    { jsonrpc: '2.0', id: id ?? null, error: { code, message, data } },
    { headers: headers() },
  );
}

async function readJson(request: Request) {
  try {
    const raw = await request.text();
    return raw.trim() ? JSON.parse(raw) : null;
  } catch {
    return undefined;
  }
}

const SEND_METHODS = new Set([
  'message/send',
  'message/stream',
  'SendMessage',
  'SendStreamingMessage',
  'tasks/send',
]);

export async function handleJsonRpc(request: Request) {
  const payload = await readJson(request);
  if (payload === undefined)
    return rpcError(null, -32700, 'Parse error: body must be JSON.');
  if (!payload || typeof payload !== 'object')
    return rpcError(null, -32600, 'Send a JSON-RPC 2.0 request.', {
      example: {
        jsonrpc: '2.0',
        id: 1,
        method: 'message/send',
        params: {
          message: {
            role: 'user',
            messageId: 'any-unique-id',
            parts: [{ kind: 'text', text: 'help' }],
          },
        },
      },
    });
  const { id, method } = payload as { id?: unknown; method?: string };
  const params = ((payload as { params?: unknown }).params || {}) as Record<
    string,
    unknown
  >;
  if (method && SEND_METHODS.has(method)) {
    const message = (params.message || {}) as A2AMessage;
    const v1 = method === 'SendMessage' || method === 'SendStreamingMessage';
    const agent = agentFromRequest(request, params);
    recordUsage(request, 'a2a', commandLabel(message), agent);
    try {
      const out = await respond(message, agent);
      return Response.json(
        {
          jsonrpc: '2.0',
          id: id ?? null,
          result: reply(out.text, out.data, message.contextId, v1),
        },
        { headers: headers() },
      );
    } catch (error) {
      if (error instanceof CommonInputError)
        return rpcError(
          id,
          error.status === 429 ? -32000 : -32602,
          error.message,
          error.body(),
        );
      throw error;
    }
  }
  if (method === 'tasks/get' || method === 'GetTask')
    return rpcError(
      id,
      -32001,
      'Task not found: Common replies with messages, not tasks.',
    );
  if (method === 'tasks/cancel' || method === 'CancelTask')
    return rpcError(
      id,
      -32002,
      'Task cannot be canceled: Common does not create tasks.',
    );
  if (
    method === 'agent/getAuthenticatedExtendedCard' ||
    method === 'GetExtendedAgentCard'
  )
    return rpcError(
      id,
      -32007,
      'No extended card. Read /.well-known/agent-card.json.',
    );
  recordUsage(request, 'a2a', method || 'no-method');
  return rpcError(id, -32601, `Method not found: ${method}. Use message/send.`);
}

// HTTP+JSON binding: POST /v1/message:send with {message: {...}}.
export async function handleRestSend(request: Request) {
  const payload = (await readJson(request)) as Record<string, unknown> | null;
  if (!payload)
    return Response.json(
      {
        error:
          'Body must be JSON: {"message": {"role": "ROLE_USER", "parts": [{"text": "help"}]}}',
      },
      { status: 400, headers: headers() },
    );
  const message = (payload.message || payload) as A2AMessage;
  const agent = agentFromRequest(request, payload);
  recordUsage(request, 'a2a', commandLabel(message), agent);
  try {
    const out = await respond(message, agent);
    return Response.json(reply(out.text, out.data, message.contextId, true), {
      headers: headers(),
    });
  } catch (error) {
    if (error instanceof CommonInputError)
      return Response.json(error.body(), {
        status: error.status,
        headers: headers(),
      });
    throw error;
  }
}
