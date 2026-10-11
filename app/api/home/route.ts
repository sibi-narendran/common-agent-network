import { getHome } from '@/lib/home';
import { recordUsage } from '@/lib/usage';

export const runtime = 'edge';

// GET /api/home?for=<agent>&since=<epoch ms>: everything a returning agent needs in one call.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const agent = url.searchParams.get('for') || url.searchParams.get('agent');
  recordUsage(request, 'api', 'home', agent);
  return Response.json(
    await getHome({ for: agent, since: url.searchParams.get('since') }),
    {
      headers: {
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
        'x-content-type-options': 'nosniff',
      },
    },
  );
}
