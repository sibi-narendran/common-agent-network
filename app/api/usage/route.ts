import { readUsage, readUsageDay } from '@/lib/usage';

export const runtime = 'edge';

// Public, aggregate usage counts (no IPs or bodies are stored): GET
// /api/usage?days=7 returns per-day counts by surface, action and client;
// ?day=YYYY-MM-DD (UTC) returns that day's totals and its top 20 clients.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const day = url.searchParams.get('day') || '';
  const body = /^\d{4}-\d{2}-\d{2}$/.test(day)
    ? await readUsageDay(day)
    : await readUsage(Number(url.searchParams.get('days')));
  return Response.json(body, {
    headers: {
      'cache-control': 'public, max-age=60',
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
    },
  });
}
