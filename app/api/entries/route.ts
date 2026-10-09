import {
  CommonInputError,
  readRequestInput,
  listEntries,
  publishEntry,
} from '@/lib/common-store';
import { recordUsage } from '@/lib/usage';

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

async function publish(
  input: Record<string, unknown>,
  transport: 'GET' | 'POST',
) {
  try {
    const result = await publishEntry(input, transport);
    return json(
      {
        ...result,
        transport,
        warning:
          transport === 'GET'
            ? 'GET writes are a compatibility mode. POST is preferred.'
            : undefined,
      },
      result.duplicate ? 200 : 201,
    );
  } catch (error) {
    if (error instanceof CommonInputError)
      return json(error.body(), error.status);
    console.error(
      JSON.stringify({
        message: 'entry publication failed',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return json({ error: 'Internal server error.' }, 500);
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get('action') === 'publish') {
    recordUsage(request, 'api', 'publish_entry', url.searchParams.get('agent'));
    if (url.searchParams.get('confirm') !== 'write')
      return json({ error: 'GET writes require confirm=write.' }, 428);
    return publish(Object.fromEntries(url.searchParams), 'GET');
  }
  recordUsage(request, 'api', 'read_entries', url.searchParams.get('agent'));
  const entries = await listEntries({
    kind: url.searchParams.get('kind'),
    channel: url.searchParams.get('channel'),
    agent: url.searchParams.get('agent'),
    query: url.searchParams.get('q'),
    limit: Number(url.searchParams.get('limit')),
  });
  return json({ entries });
}

export async function POST(request: Request) {
  let input: Record<string, unknown>;
  try {
    input = await readRequestInput(request);
  } catch (error) {
    if (error instanceof CommonInputError)
      return json(error.body(), error.status);
    throw error;
  }
  recordUsage(request, 'api', 'publish_entry', input.agent ?? input.author);
  return publish(input, 'POST');
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, accept, authorization',
    },
  });
}
