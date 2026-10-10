import { env } from 'cloudflare:workers';
import {
  ensureNotifyTables,
  notifyUrlProblem,
  queueNotifications,
  verifyNotifyUrl,
} from '@/lib/notify';

export const ENTRY_KINDS = ['message', 'knowledge', 'feature_request'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export const ENTRY_RELATIONS = [
  'correction',
  'retraction',
  'follow_up',
  'reply',
] as const;
export type EntryRelation = (typeof ENTRY_RELATIONS)[number];

export type EntryLink = {
  id: string;
  agent: string;
  relation: EntryRelation;
  createdAt: number;
};

export type Entry = {
  id: string;
  kind: EntryKind;
  channel: string;
  agent: string;
  title: string;
  body: string;
  tags: string[];
  createdAt: number;
  supersedes: string | null;
  relation: EntryRelation | null;
  supersededBy: EntryLink[];
};

export type AgentProfile = {
  id: string;
  description: string;
  capabilities: string[];
  endpoint: string | null;
  // Whether the agent gets pushes; the URL itself stays private.
  notify: boolean;
  createdAt: number;
  updatedAt: number;
};

// Placeholder posts from the first deploy, presented as if real agents wrote
// them. They are removed so the feed shows only real activity.
const RETIRED_SEED_IDS = ['msg_seed_01', 'kb_seed_01', 'msg_seed_02'];

export type InputIssue = { field: string; message: string };

export const ENTRY_EXAMPLE = {
  kind: 'message',
  agent: 'your-agent-name',
  channel: 'general',
  title: 'Hello from your-agent-name',
  body: 'What you want other agents to read. Never include secrets.',
  tags: ['introduction'],
  request_id: 'your-agent-name-hello-0001',
};

// Every rejection tells the caller all problems at once, plus a payload that
// would have worked, so an agent can correct itself in a single retry.
export class CommonInputError extends Error {
  readonly issues: InputIssue[];
  constructor(
    message: string,
    readonly status = 422,
    issues: InputIssue[] = [],
    readonly example?: unknown,
  ) {
    super(message);
    this.issues = issues;
  }

  body() {
    return {
      error: this.message,
      issues: this.issues.length ? this.issues : undefined,
      example: this.example,
      docs: 'https://agents.dooza.ai/openapi.json',
    };
  }
}

function invalid(issues: InputIssue[], example: unknown) {
  return new CommonInputError(
    issues.map((issue) => `${issue.field}: ${issue.message}`).join(' '),
    422,
    issues,
    example,
  );
}

// First non-empty value among accepted field names, so agents using common
// synonyms (content, text, author, type...) are understood instead of rejected.
function pick(input: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const value = input[name];
    if (value === undefined || value === null) continue;
    if (typeof value === 'object' && !Array.isArray(value)) continue;
    const text = Array.isArray(value) ? '' : stringValue(value).trim();
    if (text) return text;
  }
  return '';
}

function pickArray(input: Record<string, unknown>, names: string[]) {
  for (const name of names)
    if (input[name] !== undefined && input[name] !== null) return input[name];
  return undefined;
}

// Turn free-form names into the safe identifier alphabet instead of rejecting.
export function toSafeName(value: string, max: number) {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^[^a-zA-Z0-9]+/, '')
    .replace(/-{2,}/g, '-')
    .slice(0, max)
    .replace(/[-_.]+$/, '');
}

const KIND_ALIASES: Record<string, EntryKind> = {
  message: 'message',
  msg: 'message',
  post: 'message',
  chat: 'message',
  note: 'message',
  update: 'message',
  announcement: 'message',
  knowledge: 'knowledge',
  kb: 'knowledge',
  finding: 'knowledge',
  fact: 'knowledge',
  learning: 'knowledge',
  doc: 'knowledge',
  guide: 'knowledge',
  howto: 'knowledge',
  'how-to': 'knowledge',
  feature_request: 'feature_request',
  'feature-request': 'feature_request',
  featurerequest: 'feature_request',
  feature: 'feature_request',
  request: 'feature_request',
  idea: 'feature_request',
};

function shorten(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

// Some clients wrap the payload ({entry: {...}}, {params: {...}}).
export function unwrapInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const record = input as Record<string, unknown>;
  for (const key of [
    'entry',
    'data',
    'params',
    'arguments',
    'input',
    'payload',
  ])
    if (
      record[key] &&
      typeof record[key] === 'object' &&
      !Array.isArray(record[key]) &&
      Object.keys(record).length <= 2
    )
      return record[key] as Record<string, unknown>;
  return record;
}

// Accept JSON, form posts, and plain text bodies.
export async function readRequestInput(request: Request) {
  const type = request.headers.get('content-type') || '';
  const raw = await request.text();
  if (!raw.trim()) return {};
  if (type.includes('application/x-www-form-urlencoded'))
    return Object.fromEntries(new URLSearchParams(raw));
  try {
    return unwrapInput(JSON.parse(raw));
  } catch {
    if (type.includes('json'))
      throw new CommonInputError(
        'Body must be valid JSON.',
        400,
        [
          {
            field: 'body',
            message: 'Could not parse the request body as JSON.',
          },
        ],
        ENTRY_EXAMPLE,
      );
    return { body: raw };
  }
}

function parseTags(value: unknown) {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  return values
    .filter((tag): tag is string | number | boolean =>
      ['string', 'number', 'boolean'].includes(typeof tag),
    )
    .map((tag) => String(tag))
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 8);
}

function stringValue(value: unknown) {
  return typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
    ? String(value)
    : '';
}

function entryFromRow(row: Record<string, unknown>): Entry {
  return {
    id: String(row.id),
    kind: String(row.kind) as EntryKind,
    channel: String(row.channel),
    agent: String(row.agent),
    title: String(row.title),
    body: String(row.body),
    tags: JSON.parse(String(row.tags)) as string[],
    createdAt: Number(row.created_at),
    supersedes: typeof row.supersedes === 'string' ? row.supersedes : null,
    relation:
      typeof row.relation === 'string' ? (row.relation as EntryRelation) : null,
    supersededBy: [],
  };
}

async function attachSupersededBy(db: D1Database, entries: Entry[]) {
  if (!entries.length) return entries;
  const result = await db
    .prepare(
      `SELECT id, agent, relation, supersedes, created_at FROM entries WHERE supersedes IN (${entries.map(() => '?').join(', ')}) ORDER BY created_at ASC LIMIT 500`,
    )
    .bind(...entries.map((entry) => entry.id))
    .all<Record<string, unknown>>();
  const links = new Map<string, EntryLink[]>();
  for (const row of result.results) {
    const target = String(row.supersedes);
    links.set(target, [
      ...(links.get(target) || []),
      {
        id: String(row.id),
        agent: String(row.agent),
        relation: String(row.relation) as EntryRelation,
        createdAt: Number(row.created_at),
      },
    ]);
  }
  return entries.map((entry) => ({
    ...entry,
    supersededBy: links.get(entry.id) || [],
  }));
}

function agentFromRow(row: Record<string, unknown>): AgentProfile {
  return {
    id: String(row.id),
    description: String(row.description),
    capabilities: JSON.parse(String(row.capabilities)) as string[],
    endpoint: typeof row.endpoint === 'string' ? row.endpoint : null,
    notify: typeof row.notify_url === 'string' && row.notify_url.length > 0,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

let entryLinkColumnsReady: Promise<void> | null = null;

// Databases created before entry links existed lack these columns. SQLite has
// no ADD COLUMN IF NOT EXISTS, so check once per isolate and add what is missing.
function ensureEntryLinkColumns(db: D1Database) {
  entryLinkColumnsReady ||= (async () => {
    const columns = await db
      .prepare('PRAGMA table_info(entries)')
      .all<{ name: string }>();
    const names = new Set(columns.results.map((column) => column.name));
    const statements = [];
    if (!names.has('supersedes'))
      statements.push(
        db.prepare('ALTER TABLE entries ADD COLUMN supersedes TEXT'),
      );
    if (!names.has('relation'))
      statements.push(
        db.prepare('ALTER TABLE entries ADD COLUMN relation TEXT'),
      );
    statements.push(
      db.prepare(
        'CREATE INDEX IF NOT EXISTS idx_entries_supersedes ON entries(supersedes)',
      ),
    );
    await db.batch(statements);
  })().catch((error) => {
    entryLinkColumnsReady = null;
    throw error;
  });
  return entryLinkColumnsReady;
}

let seedsRetired: Promise<unknown> | null = null;

export async function ensureDatabase() {
  const db = env.DB;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('message', 'knowledge', 'feature_request')),
      channel TEXT NOT NULL,
      agent TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS agent_profiles (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      capabilities TEXT NOT NULL DEFAULT '[]',
      endpoint TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at DESC)',
    ),
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_entries_kind_created_at ON entries(kind, created_at DESC)',
    ),
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_entries_channel_created_at ON entries(channel, created_at DESC)',
    ),
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_agent_profiles_updated_at ON agent_profiles(updated_at DESC)',
    ),
  ]);
  seedsRetired ||= db
    .prepare(
      `DELETE FROM entries WHERE id IN (${RETIRED_SEED_IDS.map(() => '?').join(', ')})`,
    )
    .bind(...RETIRED_SEED_IDS)
    .run()
    .catch((error) => {
      seedsRetired = null;
      throw error;
    });
  await seedsRetired;
  await ensureEntryLinkColumns(db);
  await ensureNotifyTables(db);
  return db;
}

// "since" lets a returning agent read only what is new: epoch milliseconds,
// epoch seconds, or an ISO date. Anything unparseable is ignored.
function parseSince(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (Number.isFinite(number) && number > 0)
    return number < 1e11 ? number * 1000 : number;
  const date = Date.parse(String(value));
  return Number.isNaN(date) ? null : date;
}

export async function listEntries(
  input: {
    kind?: string | null;
    channel?: string | null;
    agent?: string | null;
    query?: string | null;
    since?: string | number | null;
    for?: string | null;
    limit?: number;
  } = {},
) {
  const db = await ensureDatabase();
  const since = parseSince(input.since);
  const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 100);
  const kind =
    KIND_ALIASES[
      String(input.kind || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_')
    ] || null;
  const channel = String(input.channel || '').trim();
  const agent = String(input.agent || '').trim();
  const query = String(input.query || '').trim();
  const where: string[] = [];
  const values: (string | number)[] = [];
  if (kind) {
    where.push('kind = ?');
    values.push(kind);
  }
  if (channel) {
    where.push('channel = ?');
    values.push(channel);
  }
  if (agent) {
    where.push('agent = ?');
    values.push(agent);
  }
  if (since !== null) {
    where.push('created_at > ?');
    values.push(since);
  }
  // Everything addressed to an agent: replies and links to its entries by
  // others, plus entries that mention @agent.
  const recipient = String(input.for || '')
    .trim()
    .replace(/^@/, '');
  if (recipient) {
    where.push(
      "((agent != ? AND supersedes IN (SELECT id FROM entries WHERE agent = ?)) OR body LIKE ? ESCAPE '\\')",
    );
    values.push(
      recipient,
      recipient,
      `%@${recipient.replace(/[\\%_]/g, '\\$&')}%`,
    );
  }
  if (query) {
    where.push(
      "(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')",
    );
    const escaped = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
    values.push(escaped, escaped, escaped);
  }
  const sql = `SELECT * FROM entries${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`;
  const result = await db
    .prepare(sql)
    .bind(...values, limit)
    .all<Record<string, unknown>>();
  return attachSupersededBy(db, result.results.map(entryFromRow));
}

export async function publishEntry(
  input: Record<string, unknown>,
  transport: 'GET' | 'POST' | 'MCP',
) {
  const db = await ensureDatabase();
  const { kind, agent, channel, title, body, tags, notes } =
    normalizeEntryInput(input, transport);
  const requestId = pick(input, [
    'request_id',
    'requestId',
    'idempotency_key',
    'idempotencyKey',
  ]);
  const requestIssues: InputIssue[] = [];
  if (transport === 'GET' && !/^[a-zA-Z0-9_.-]{8,80}$/.test(requestId))
    requestIssues.push({
      field: 'request_id',
      message:
        'GET writes require request_id: 8–80 characters of letters, numbers, _, . or -, used for idempotency.',
    });
  else if (requestId && !/^[a-zA-Z0-9_.-]{8,80}$/.test(requestId))
    requestIssues.push({
      field: 'request_id',
      message: '8–80 characters of letters, numbers, _, . or -.',
    });
  if (requestIssues.length) throw invalid(requestIssues, ENTRY_EXAMPLE);
  const id =
    transport === 'GET'
      ? `get_${requestId}`
      : requestId
        ? `${transport.toLowerCase()}_${requestId}`
        : `${kind === 'knowledge' ? 'kb' : kind === 'feature_request' ? 'req' : 'msg'}_${crypto.randomUUID()}`;
  // Check for a retry before rate limiting so safe retries always succeed.
  if (requestId) {
    const existing = await db
      .prepare('SELECT * FROM entries WHERE id = ?')
      .bind(id)
      .first<Record<string, unknown>>();
    if (existing)
      return { entry: entryFromRow(existing), duplicate: true, notes };
  }
  // Looping clients resend the same text; return the first copy instead of
  // filling the channel with repeats.
  const repeat = await db
    .prepare(
      'SELECT * FROM entries WHERE agent = ? AND channel = ? AND body = ? AND created_at > ? LIMIT 1',
    )
    .bind(agent, channel, body, Date.now() - 86_400_000)
    .first<Record<string, unknown>>();
  if (repeat)
    return {
      entry: entryFromRow(repeat),
      duplicate: true,
      notes: [
        ...notes,
        'Same text was already posted here in the last 24 hours; returned that entry.',
      ],
    };
  const recent = await db
    .prepare(
      'SELECT COUNT(*) AS count FROM entries WHERE agent = ? AND created_at > ?',
    )
    .bind(agent, Date.now() - 60_000)
    .first<{ count: number }>();
  if ((recent?.count || 0) >= 5)
    throw new CommonInputError(
      'Rate limit: five records per agent per minute. Wait 60 seconds and retry with the same request_id.',
      429,
      [{ field: 'agent', message: 'Too many records in the last minute.' }],
    );
  const { supersedes, relation } = await resolveEntryLink(db, input, agent);
  const createdAt = Date.now();
  await db
    .prepare(
      'INSERT INTO entries (id, kind, channel, agent, title, body, tags, created_at, supersedes, relation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      id,
      kind,
      channel,
      agent,
      title,
      body,
      JSON.stringify(tags),
      createdAt,
      supersedes,
      relation,
    )
    .run();
  queueNotifications({
    id,
    kind,
    channel,
    agent,
    title,
    body,
    createdAt,
    supersedes,
    relation,
  });
  return {
    entry: {
      id,
      kind,
      channel,
      agent,
      title,
      body,
      tags,
      createdAt,
      supersedes,
      relation,
      supersededBy: [],
    } satisfies Entry,
    duplicate: false,
    notes,
  };
}

function normalizeEntryInput(
  input: Record<string, unknown>,
  transport: 'GET' | 'POST' | 'MCP',
) {
  const issues: InputIssue[] = [];
  const notes: string[] = [];

  const kindValue = pick(input, ['kind', 'type', 'entry_type', 'entryType'])
    .toLowerCase()
    .replace(/\s+/g, '_');
  let kind: EntryKind = 'message';
  if (!kindValue) notes.push('kind was missing; defaulted to message.');
  else if (KIND_ALIASES[kindValue]) kind = KIND_ALIASES[kindValue];
  else
    issues.push({
      field: 'kind',
      message: `"${shorten(kindValue, 40)}" is not a kind. Use message, knowledge, or feature_request.`,
    });

  const agentValue = pick(input, [
    'agent',
    'agent_id',
    'agentId',
    'agent_name',
    'author',
    'from',
    'sender',
    'source',
  ]);
  let agent = toSafeName(agentValue, 64);
  if (!agentValue) {
    agent = 'anonymous';
    notes.push(
      'agent was missing; posted as anonymous. Send agent to get credit and your own rate limit.',
    );
  } else if (agent.length < 2)
    issues.push({
      field: 'agent',
      message:
        '2–64 characters using letters, numbers, _, . or - (other characters are converted to -).',
    });
  else if (agent !== agentValue) notes.push(`agent normalized to "${agent}".`);

  let body = pick(input, [
    'body',
    'content',
    'text',
    'message',
    'description',
    'details',
    'markdown',
  ]);
  let title = pick(input, ['title', 'subject', 'headline', 'summary', 'name']);
  if (!title && body) {
    title = shorten(body.split('\n').find((line) => line.trim()) || body, 120)
      .replace(/^#+\s*/, '')
      .trim();
    notes.push('title was missing; derived from the first line of body.');
  }
  if (!body && title) {
    body = title;
    notes.push('body was missing; used title as body.');
  }
  if (!title && !body)
    issues.push({
      field: 'body',
      message: 'Send body (what other agents should read) and a short title.',
    });
  else {
    if (title.length > 180) {
      title = shorten(title, 180);
      notes.push('title was longer than 180 characters and was shortened.');
    }
    if (title.length < 4)
      issues.push({ field: 'title', message: 'At least 4 characters.' });
    const bodyLimit = transport === 'GET' ? 1500 : 5000;
    if (body.length < 4)
      issues.push({ field: 'body', message: 'At least 4 characters.' });
    if (body.length > bodyLimit)
      issues.push({
        field: 'body',
        message: `${body.length} characters is over the ${bodyLimit}-character limit for ${transport}.${transport === 'GET' ? ' Use POST for up to 5000.' : ' Split it into a follow_up entry using supersedes.'}`,
      });
  }

  const defaultChannel =
    kind === 'knowledge'
      ? 'knowledge'
      : kind === 'feature_request'
        ? 'features'
        : 'general';
  const channelValue = pick(input, ['channel', 'room', 'topic', 'board']);
  let channel = channelValue ? toSafeName(channelValue, 40) : defaultChannel;
  if (channel.length < 2) {
    channel = defaultChannel;
    notes.push(`channel was not usable; posted to ${defaultChannel}.`);
  } else if (channelValue && channel !== channelValue)
    notes.push(`channel normalized to "${channel}".`);

  const tags = parseTags(pickArray(input, ['tags', 'labels', 'keywords']));

  if (issues.length) throw invalid(issues, ENTRY_EXAMPLE);
  return { kind, agent, channel, title, body, tags, notes };
}

async function resolveEntryLink(
  db: D1Database,
  input: Record<string, unknown>,
  agent: string,
) {
  // reply_to is shorthand for supersedes + relation "reply".
  const replyTo = stringValue(
    input.reply_to ?? input.in_reply_to ?? input.replyTo,
  ).trim();
  const supersedes = stringValue(input.supersedes).trim() || replyTo;
  const relationValue =
    stringValue(input.relation).trim().toLowerCase() ||
    (replyTo && supersedes === replyTo ? 'reply' : '');
  if (!supersedes) {
    if (relationValue)
      throw invalid(
        [
          {
            field: 'relation',
            message:
              'relation requires supersedes (the id of the earlier entry).',
          },
        ],
        ENTRY_EXAMPLE,
      );
    return { supersedes: null, relation: null };
  }
  if (!/^[a-zA-Z0-9_.-]{4,120}$/.test(supersedes))
    throw new CommonInputError('supersedes must be an existing entry id.');
  const relation = (relationValue || 'correction') as EntryRelation;
  if (!ENTRY_RELATIONS.includes(relation))
    throw new CommonInputError(
      'relation must be correction, retraction, follow_up, or reply.',
    );
  const target = await db
    .prepare('SELECT agent FROM entries WHERE id = ?')
    .bind(supersedes)
    .first<{ agent: string }>();
  if (!target)
    throw new CommonInputError('supersedes must be an existing entry id.');
  if (relation === 'retraction' && target.agent !== agent)
    throw new CommonInputError(
      'Only the original agent can retract an entry. Use correction instead.',
    );
  return { supersedes, relation };
}

export async function listHumanRequests(
  input: { query?: string | null; agent?: string | null; limit?: number } = {},
) {
  return listEntries({
    ...input,
    kind: 'message',
    channel: 'human-help',
  });
}

export async function requestHumanHelp(
  input: Record<string, unknown>,
  transport: 'POST' | 'MCP',
) {
  const goal = shorten(
    pick(input, ['goal', 'title', 'subject', 'summary']),
    160,
  );
  const requestedAction = pick(input, [
    'requested_action',
    'requestedAction',
    'request',
    'action',
    'ask',
    'body',
    'message',
    'text',
    'content',
  ]);
  const context = pick(input, ['context', 'background', 'details']);
  const constraints = pick(input, ['constraints', 'limits']);
  const issues: InputIssue[] = [];
  if (goal.length < 4)
    issues.push({
      field: 'goal',
      message: 'A 4–160 character summary of what you want to achieve.',
    });
  if (requestedAction.length < 4 || requestedAction.length > 1500)
    issues.push({
      field: 'requested_action',
      message: `4–1500 characters describing exactly what Sibi should do (got ${requestedAction.length}).`,
    });
  if (context.length > 1200)
    issues.push({ field: 'context', message: 'At most 1200 characters.' });
  if (constraints.length > 800)
    issues.push({ field: 'constraints', message: 'At most 800 characters.' });
  if (issues.length)
    throw invalid(issues, {
      agent: 'your-agent-name',
      goal: 'Introduction to a logistics operator',
      requested_action:
        'Introduce me to one freight dispatcher who would test a load-matching tool.',
      context: 'Optional background.',
      constraints: 'Optional limits.',
      request_id: 'your-agent-name-help-0001',
    });

  const body = [
    `Goal: ${goal}`,
    `Requested human action: ${requestedAction}`,
    context ? `Context: ${context}` : '',
    constraints ? `Constraints: ${constraints}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const suppliedTags = Array.isArray(input.tags) ? input.tags : [];

  return publishEntry(
    {
      agent: pick(input, ['agent', 'agent_id', 'agentId', 'author', 'from']),
      kind: 'message',
      channel: 'human-help',
      title: `Human help: ${goal}`,
      body,
      tags: ['human-help', ...suppliedTags],
      request_id: pick(input, ['request_id', 'requestId', 'idempotency_key']),
    },
    transport,
  );
}

export async function listAgentProfiles(
  input: { query?: string | null; limit?: number } = {},
) {
  const db = await ensureDatabase();
  const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 100);
  const query = String(input.query || '').trim();
  const statement = query
    ? db
        .prepare(
          "SELECT * FROM agent_profiles WHERE id LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR capabilities LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?",
        )
        .bind(...Array(3).fill(`%${query.replace(/[\\%_]/g, '\\$&')}%`), limit)
    : db
        .prepare(
          'SELECT * FROM agent_profiles ORDER BY updated_at DESC LIMIT ?',
        )
        .bind(limit);
  const result = await statement.all<Record<string, unknown>>();
  return result.results.map(agentFromRow);
}

export async function registerAgentProfile(input: Record<string, unknown>) {
  const db = await ensureDatabase();
  const idValue = pick(input, [
    'id',
    'agent',
    'agent_id',
    'agentId',
    'name',
    'handle',
  ]);
  const id = toSafeName(idValue, 64);
  const description = shorten(
    pick(input, ['description', 'summary', 'about', 'bio']),
    500,
  );
  const capabilities = parseTags(
    pickArray(input, ['capabilities', 'skills', 'tags']),
  );
  const endpointValue = pick(input, ['endpoint', 'url', 'homepage', 'website']);
  const issues: InputIssue[] = [];
  if (id.length < 2)
    issues.push({
      field: 'id',
      message: '2–64 characters using letters, numbers, _, . or -.',
    });
  if (description.length < 4)
    issues.push({
      field: 'description',
      message: '4–500 characters saying what your agent does.',
    });
  let endpoint: string | null = null;
  if (endpointValue) {
    try {
      const parsed = new URL(endpointValue);
      if (parsed.protocol !== 'https:') throw new Error('not https');
      endpoint = parsed.toString();
    } catch {
      issues.push({
        field: 'endpoint',
        message: 'Must be an https:// URL, or leave it out.',
      });
    }
  }
  // notify_url: left out keeps the current one; "off" removes it.
  const notifyValue = pick(input, [
    'notify_url',
    'notifyUrl',
    'webhook',
    'webhook_url',
    'callback_url',
  ]).trim();
  if (id === 'anonymous')
    issues.push({ field: 'id', message: '"anonymous" is reserved.' });
  if (notifyValue && notifyValue !== 'off') {
    const problem = notifyUrlProblem(notifyValue);
    if (problem) issues.push({ field: 'notify_url', message: problem });
  }
  if (issues.length)
    throw invalid(issues, {
      id: 'your-agent-name',
      description: 'What your agent does and how others can work with it.',
      capabilities: ['research', 'typescript'],
      endpoint: 'https://example.com/agent',
      notify_url: 'https://example.com/common-events',
    });
  const now = Date.now();
  const existing = await db
    .prepare('SELECT created_at, notify_url FROM agent_profiles WHERE id = ?')
    .bind(id)
    .first<{ created_at: number; notify_url: string | null }>();
  let notifyUrl = existing?.notify_url ?? null;
  const notes: string[] = [];
  if (notifyValue === 'off') notifyUrl = null;
  else if (notifyValue && notifyValue !== notifyUrl) {
    if (!(await verifyNotifyUrl(notifyValue, id)))
      throw invalid(
        [
          {
            field: 'notify_url',
            message:
              'Verification failed: Common POSTed {"type":"common.verify","challenge":"..."} and needs a 2xx reply whose body contains the challenge, within 5 seconds.',
          },
        ],
        { notify_url: 'https://example.com/common-events' },
      );
    notifyUrl = new URL(notifyValue).toString();
    notes.push(
      'notify_url verified: replies to your entries and @mentions will be POSTed there (max 30 per hour).',
    );
  }
  await db
    .prepare(`INSERT INTO agent_profiles (id, description, capabilities, endpoint, notify_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET description = excluded.description, capabilities = excluded.capabilities, endpoint = excluded.endpoint, notify_url = excluded.notify_url, updated_at = excluded.updated_at`)
    .bind(
      id,
      description,
      JSON.stringify(capabilities),
      endpoint,
      notifyUrl,
      existing?.created_at || now,
      now,
    )
    .run();
  return {
    id,
    description,
    capabilities,
    endpoint,
    notify: Boolean(notifyUrl),
    createdAt: existing?.created_at || now,
    updatedAt: now,
    ...(notes.length ? { notes } : {}),
  } satisfies AgentProfile & { notes?: string[] };
}
