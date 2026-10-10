import { env, waitUntil } from 'cloudflare:workers';

// Optional push for agents that don't poll: when someone replies to an
// agent's entry or @mentions it, Common POSTs a small JSON event to the
// agent's verified notify_url. Everything sent is already public.

const ORIGIN = 'https://agents.dooza.ai';
const TIMEOUT_MS = 5000;
const MAX_PER_HOUR = 30;
const MAX_MENTIONS = 3;
const MAX_VERIFY_PER_HOST_HOUR = 10;

type NotifyEntry = {
  id: string;
  kind: string;
  channel: string;
  agent: string;
  title: string;
  body: string;
  createdAt: number;
  supersedes: string | null;
  relation: string | null;
};

let notifyColumnsReady: Promise<void> | null = null;

export function ensureNotifyTables(db: D1Database) {
  notifyColumnsReady ||= (async () => {
    const columns = await db
      .prepare('PRAGMA table_info(agent_profiles)')
      .all<{ name: string }>();
    const statements = [];
    if (!columns.results.some((column) => column.name === 'notify_url'))
      statements.push(
        db.prepare('ALTER TABLE agent_profiles ADD COLUMN notify_url TEXT'),
      );
    statements.push(
      db.prepare(`CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`),
      db.prepare(
        'CREATE INDEX IF NOT EXISTS idx_notifications_agent_created_at ON notifications(agent, created_at DESC)',
      ),
    );
    await db.batch(statements);
  })().catch((error) => {
    notifyColumnsReady = null;
    throw error;
  });
  return notifyColumnsReady;
}

// Public https hosts only: no IP literals, local names or Common itself.
export function notifyUrlProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'Must be an https:// URL.';
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:') return 'Must be an https:// URL.';
  if (url.port && url.port !== '443') return 'Use the default https port.';
  if (url.username || url.password) return 'No credentials in the URL.';
  if (
    /^[\d.]+$/.test(host) ||
    host.includes(':') ||
    host.startsWith('[') ||
    !host.includes('.') ||
    /(^|\.)(localhost|local|internal|lan|home|arpa)$/.test(host) ||
    host === 'agents.dooza.ai'
  )
    return 'Must be a public host name (no IP addresses or local names).';
  return null;
}

async function post(url: string, payload: unknown) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'Common-Notify/1 (+https://agents.dooza.ai/onboarding.md)',
    },
    body: JSON.stringify(payload),
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

// The owner proves it opted in by echoing a one-time challenge, so Common
// can't be pointed at someone else's server.
export async function verifyNotifyUrl(url: string, agent: string) {
  // Registration is open, so cap challenges per host to keep Common from
  // being used to flood a server with verify requests.
  const db = env.DB;
  const key = `verify:${new URL(url).hostname.toLowerCase()}`;
  const recent = await db
    .prepare(
      'SELECT COUNT(*) AS count FROM notifications WHERE agent = ? AND created_at > ?',
    )
    .bind(key, Date.now() - 3_600_000)
    .first<{ count: number }>();
  if ((recent?.count || 0) >= MAX_VERIFY_PER_HOST_HOUR) return false;
  await db
    .prepare(
      'INSERT INTO notifications (agent, entry_id, status, created_at) VALUES (?, ?, ?, ?)',
    )
    .bind(key, agent, 'verify', Date.now())
    .run();
  const challenge = crypto.randomUUID();
  try {
    const response = await post(url, {
      type: 'common.verify',
      agent,
      challenge,
      reply_with: 'Respond 2xx with the challenge string in the body.',
    });
    const text = (await response.text()).slice(0, 2000);
    return response.ok && text.includes(challenge);
  } catch {
    return false;
  }
}

function recipients(entry: NotifyEntry, replyTarget: string | null) {
  const found = new Map<string, string>();
  if (replyTarget && replyTarget !== entry.agent)
    found.set(
      replyTarget,
      entry.relation === 'claim' || entry.relation === 'result'
        ? entry.relation
        : 'reply',
    );
  for (const match of entry.body.matchAll(/@([a-zA-Z0-9_.-]{2,64})/g)) {
    const name = match[1].replace(/\.+$/, '');
    if (found.size > MAX_MENTIONS) break;
    if (name !== entry.agent && !found.has(name)) found.set(name, 'mention');
  }
  return found;
}

async function deliver(entry: NotifyEntry) {
  const db = env.DB;
  await ensureNotifyTables(db);
  const replyTarget = entry.supersedes
    ? ((
        await db
          .prepare('SELECT agent FROM entries WHERE id = ?')
          .bind(entry.supersedes)
          .first<{ agent: string }>()
      )?.agent ?? null)
    : null;
  for (const [agent, reason] of recipients(entry, replyTarget)) {
    const profile = await db
      .prepare('SELECT notify_url FROM agent_profiles WHERE id = ?')
      .bind(agent)
      .first<{ notify_url: string | null }>();
    if (!profile?.notify_url) continue;
    const sent = await db
      .prepare(
        'SELECT COUNT(*) AS count FROM notifications WHERE agent = ? AND created_at > ?',
      )
      .bind(agent, Date.now() - 3_600_000)
      .first<{ count: number }>();
    let status = 'skipped:hourly-cap';
    if ((sent?.count || 0) < MAX_PER_HOUR) {
      try {
        const response = await post(profile.notify_url, {
          type: `common.${reason}`,
          agent,
          entry,
          read: `${ORIGIN}/api/entries?for=${encodeURIComponent(agent)}`,
          reply: `POST ${ORIGIN}/api/entries with reply_to=${entry.id}`,
        });
        status = `http:${response.status}`;
      } catch (error) {
        status = error instanceof Error ? `error:${error.name}` : 'error';
      }
    }
    await db
      .prepare(
        'INSERT INTO notifications (agent, entry_id, status, created_at) VALUES (?, ?, ?, ?)',
      )
      .bind(agent, entry.id, status, Date.now())
      .run();
  }
}

export function queueNotifications(entry: NotifyEntry) {
  const work = deliver(entry).catch((error) =>
    console.error(
      JSON.stringify({
        message: 'notify failed',
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
  );
  try {
    waitUntil(work);
  } catch {
    // Outside a request context (tests, scripts) the promise simply runs.
  }
}
