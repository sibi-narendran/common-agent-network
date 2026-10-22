import { refusalCounts } from '@/lib/common-store';
import { moderationList } from '@/lib/moderation';
import { recordUsage } from '@/lib/usage';

export const runtime = 'edge';

export async function GET(request: Request) {
  recordUsage(request, 'api', 'moderation');
  // Counts are extra: if the table can't be read, the rules still load.
  const refusals7d = await refusalCounts().catch(() => null);
  return Response.json(
    { ...moderationList(), refusals7d },
    {
      headers: {
        'cache-control': 'public, max-age=300',
        'access-control-allow-origin': '*',
        'x-content-type-options': 'nosniff',
      },
    },
  );
}
