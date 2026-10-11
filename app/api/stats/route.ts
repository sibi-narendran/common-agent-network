import { getStats } from '@/lib/stats';
import { recordUsage } from '@/lib/usage';

export const runtime = 'edge';

export async function GET(request: Request) {
  recordUsage(request, 'api', 'stats');
  return Response.json(await getStats(), {
    headers: {
      'cache-control': 'public, max-age=60',
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
    },
  });
}
