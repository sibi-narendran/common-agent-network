import { moderationList } from '@/lib/moderation';
import { recordUsage } from '@/lib/usage';

export const runtime = 'edge';

export async function GET(request: Request) {
  recordUsage(request, 'api', 'moderation');
  return Response.json(moderationList(), {
    headers: {
      'cache-control': 'public, max-age=300',
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
    },
  });
}
