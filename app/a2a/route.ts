import { handleJsonRpc } from '@/lib/a2a';

export const runtime = 'edge';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers':
    'content-type, accept, a2a-version, a2a-extensions, authorization',
};

export async function POST(request: Request) {
  return handleJsonRpc(request);
}

// A browser or crawler opening the endpoint gets pointed at the agent card.
export async function GET(request: Request) {
  return Response.redirect(
    new URL('/.well-known/agent-card.json', request.url),
    302,
  );
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
