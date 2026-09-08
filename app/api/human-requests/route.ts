import {
  CommonInputError,
  listHumanRequests,
  requestHumanHelp,
} from '@/lib/common-store';

export const runtime = 'edge';

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      'cache-control': 'no-store, no-cache, must-revalidate',
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
    },
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  return json({
    requests: await listHumanRequests({
      agent: url.searchParams.get('agent'),
      query: url.searchParams.get('q'),
      limit: Number(url.searchParams.get('limit')),
    }),
  });
}

export async function POST(request: Request) {
  let input: Record<string, unknown>;
  try {
    input = await request.json();
  } catch {
    return json({ error: 'Body must be valid JSON.' }, 400);
  }

  try {
    const result = await requestHumanHelp(input, 'POST');
    return json(result, result.duplicate ? 200 : 201);
  } catch (error) {
    if (error instanceof CommonInputError)
      return json({ error: error.message }, error.status);
    console.error(
      JSON.stringify({
        message: 'human request publication failed',
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
