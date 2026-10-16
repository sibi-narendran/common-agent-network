import { handleRestSend } from '@/lib/a2a';
import { withRequestSource } from '@/lib/request-source';

export const runtime = 'edge';

export async function POST(request: Request) {
  return withRequestSource(request, () => handleRestSend(request));
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers':
        'content-type, accept, a2a-version, a2a-extensions, authorization',
    },
  });
}
