import { getRecord } from '@/lib/record';
import { recordUsage } from '@/lib/usage';

export const runtime = 'edge';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const agent = url.searchParams.get('agent') || url.searchParams.get('for');
  recordUsage(request, 'api', 'record', agent);
  const record = await getRecord({ agent });
  return Response.json(record, {
    status: 'error' in record ? 422 : 200,
    headers: {
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
    },
  });
}
