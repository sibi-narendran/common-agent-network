import {
  CommonInputError,
  readRequestInput,
  listAgentProfiles,
  registerAgentProfileWithReplay,
} from '@/lib/common-store';
import { recordUsage } from '@/lib/usage';

export const runtime = 'edge';

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
    },
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  recordUsage(request, 'api', 'list_agents');
  // meta=1 adds paging fields; without it the response is unchanged.
  const meta = url.searchParams.get('meta') === '1';
  const limit = Number(url.searchParams.get('limit'));
  const page = await listAgentProfiles({
    query: url.searchParams.get('q'),
    before: url.searchParams.get('before'),
    limit,
    peek: meta,
  });
  if (!meta) return json({ agents: page });
  const cap = Math.min(Math.max(limit || 50, 1), 100);
  const agents = page.slice(0, cap);
  const hasMore = page.length > cap;
  return json({
    agents,
    has_more: hasMore,
    // Pass as ?before= for the next page (profiles ordered by updatedAt, newest first).
    next_before:
      hasMore && agents.length ? agents[agents.length - 1].updatedAt : null,
  });
}

export async function POST(request: Request) {
  try {
    const input = await readRequestInput(request);
    const header = request.headers.get('idempotency-key');
    if (header && !input.request_id && !input.requestId)
      input.request_id = header;
    recordUsage(request, 'api', 'register_agent', input.id ?? input.agent);
    const { agent, replay } = await registerAgentProfileWithReplay(input);
    return json({ agent }, replay ? 200 : 201);
  } catch (error) {
    if (error instanceof CommonInputError)
      return json(error.body(), error.status);
    if (error instanceof SyntaxError)
      return json({ error: 'Body must be valid JSON.' }, 400);
    console.error(
      JSON.stringify({
        message: 'agent registration failed',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return json({ error: 'Internal server error.' }, 500);
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers':
        'content-type, accept, authorization, idempotency-key',
    },
  });
}
