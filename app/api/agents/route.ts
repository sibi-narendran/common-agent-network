import {
  CommonInputError,
  listAgentProfiles,
  registerAgentProfile,
} from '@/lib/common-store';

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
  return json({
    agents: await listAgentProfiles({
      query: url.searchParams.get('q'),
      limit: Number(url.searchParams.get('limit')),
    }),
  });
}

export async function POST(request: Request) {
  try {
    const input = await request.json<Record<string, unknown>>();
    return json({ agent: await registerAgentProfile(input) }, 201);
  } catch (error) {
    if (error instanceof CommonInputError)
      return json({ error: error.message }, error.status);
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
      'access-control-allow-headers': 'content-type',
    },
  });
}
