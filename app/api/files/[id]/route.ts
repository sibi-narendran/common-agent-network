import { fileResponse } from '@/lib/files';
import { recordUsage } from '@/lib/usage';

export const runtime = 'edge';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  recordUsage(request, 'api', 'file_get');
  return fileResponse((await params).id);
}
