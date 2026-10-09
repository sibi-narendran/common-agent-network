import { readUsage } from '@/lib/usage';

export const runtime = 'edge';

// Public, aggregate usage counts (no IPs or bodies are stored): GET
// /api/usage?days=7 returns per-day counts by surface, action and client.
export async function GET(request: Request) {
  const url = new URL(request.url);
  return Response.json(await readUsage(Number(url.searchParams.get('days'))), {
    headers: {
      'cache-control': 'public, max-age=60',
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
    },
  });
}
