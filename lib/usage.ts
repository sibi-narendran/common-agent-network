import { env, waitUntil } from 'cloudflare:workers';

// Aggregate, public usage counts: how often each surface is used per day and
// by which kind of client. No IP addresses, request bodies or headers beyond a
// coarse client label are stored, so the counts can be published as they are.

export const USAGE_SURFACES = ['api', 'mcp', 'a2a'] as const;
export type UsageSurface = (typeof USAGE_SURFACES)[number];

export type UsageRow = {
  day: string;
  surface: UsageSurface;
  action: string;
  client: string;
  count: number;
};

function label(value: string, max = 40) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
}

// A self-asserted agent name when the caller gave one, otherwise the product
// token from the user agent ("python-httpx", "curl", "ziwei-recontact").
export function usageClient(request: Request, agent?: unknown) {
  if (typeof agent === 'string') {
    const name = label(agent);
    if (name && name !== 'anonymous') return `agent:${name}`;
  }
  const ua = request.headers.get('user-agent') || '';
  const compatible = ua.match(/compatible;\s*([a-zA-Z0-9_.-]{2,40})\//)?.[1];
  if (compatible) return label(compatible);
  const product = ua.match(/^([a-zA-Z0-9_.-]{2,40})\//)?.[1];
  if (!product) return 'unknown';
  return product === 'Mozilla' ? 'browser' : label(product);
}

let tableReady: Promise<unknown> | undefined;

function ensureUsageTable(db: D1Database) {
  tableReady ??= db
    .prepare(
      `CREATE TABLE IF NOT EXISTS usage_daily (
        day TEXT NOT NULL,
        surface TEXT NOT NULL,
        action TEXT NOT NULL,
        client TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, surface, action, client)
      )`,
    )
    .run()
    .catch((error) => {
      tableReady = undefined;
      throw error;
    });
  return tableReady;
}

async function increment(
  surface: UsageSurface,
  action: string,
  client: string,
) {
  const db = env.DB;
  await ensureUsageTable(db);
  await db
    .prepare(
      `INSERT INTO usage_daily (day, surface, action, client, count)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT (day, surface, action, client)
       DO UPDATE SET count = count + 1`,
    )
    .bind(
      new Date().toISOString().slice(0, 10),
      surface,
      label(action) || 'unknown',
      client,
    )
    .run();
}

// Counting must never slow down or break a request: it runs after the
// response and swallows its own errors.
export function recordUsage(
  request: Request,
  surface: UsageSurface,
  action: string,
  agent?: unknown,
) {
  const work = increment(surface, action, usageClient(request, agent)).catch(
    (error) =>
      console.error(
        JSON.stringify({
          message: 'usage count failed',
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

export async function readUsage(days: number) {
  const db = env.DB;
  await ensureUsageTable(db);
  const span = Math.min(Math.max(Math.trunc(days) || 7, 1), 90);
  const since = new Date(Date.now() - (span - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const { results } = await db
    .prepare(
      `SELECT day, surface, action, client, count FROM usage_daily
       WHERE day >= ? ORDER BY day DESC, count DESC LIMIT 2000`,
    )
    .bind(since)
    .all<UsageRow>();
  const clients = new Set(results.map((row) => row.client));
  return {
    since,
    days: span,
    totals: {
      calls: results.reduce((sum, row) => sum + row.count, 0),
      distinctClients: clients.size,
    },
    rows: results,
  };
}
