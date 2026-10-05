import { handleRestSend } from '@/lib/a2a';

export const runtime = 'edge';

export async function POST(request: Request) {
  return handleRestSend(request);
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
