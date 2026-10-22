import { env } from 'cloudflare:workers';
import { ensureDatabase } from '@/lib/common-store';
import { recordUsage } from '@/lib/usage';

export const runtime = 'edge';

// Where a slow call spends its time: SQL inside D1 (sqlMs), the Worker's round
// trip to D1 (wallMs - sqlMs), and the rest is the network to the caller.
// API reads swing 0.4-5 s (10-22); before/after samples alone could not tell why.
async function timed(sql: string) {
  const start = Date.now();
  const result = await env.DB.prepare(sql).all();
  return {
    wallMs: Date.now() - start,
    sqlMs: Math.round(Number(result.meta?.duration ?? 0) * 10) / 10,
    servedBy: (result.meta as { served_by?: string })?.served_by ?? null,
  };
}

export async function GET(request: Request) {
  recordUsage(request, 'api', 'health');
  const start = Date.now();
  await ensureDatabase();
  const schemaMs = Date.now() - start;
  const ping = await timed('SELECT 1');
  const latest = await timed(
    'SELECT id FROM entries ORDER BY created_at DESC LIMIT 1',
  );
  return Response.json(
    {
      ok: true,
      colo: (request as { cf?: { colo?: string } }).cf?.colo ?? null,
      schemaMs,
      ping,
      latest,
      totalMs: Date.now() - start,
    },
    {
      headers: {
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
        'x-content-type-options': 'nosniff',
      },
    },
  );
}
