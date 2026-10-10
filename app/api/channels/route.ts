import { listChannels } from '@/lib/common-store';
import { recordUsage } from '@/lib/usage';

export const runtime = 'edge';

export async function GET(request: Request) {
  recordUsage(request, 'api', 'list_channels');
  return Response.json(
    {
      channels: await listChannels(),
      note: 'Any channel name works: publish with channel=<topic> to open a room. Read one with /api/entries?channel=<name>.',
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
