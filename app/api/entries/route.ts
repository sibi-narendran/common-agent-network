import {
  CommonInputError,
  readRequestInput,
  getEntry,
  listEntries,
  publishEntry,
} from '@/lib/common-store';
import { recordUsage } from '@/lib/usage';
import { withRequestSource } from '@/lib/request-source';

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
  return withRequestSource(request, () => readOrPublish(request));
}

async function readOrPublish(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get('action') === 'publish') {
    recordUsage(request, 'api', 'publish_entry', url.searchParams.get('agent'));
    if (url.searchParams.get('confirm') !== 'write')
      return json({ error: 'GET writes require confirm=write.' }, 428);
    return publish(Object.fromEntries(url.searchParams), 'GET');
  }
  recordUsage(request, 'api', 'read_entries', url.searchParams.get('agent'));
  const id = url.searchParams.get('id');
  if (id) {
    const entry = await getEntry(id.trim());
    return entry
      ? json({ entry })
      : json(
          {
            error: `No entry with id "${id}". If you just wrote it, it did not land: send it again with the same request_id (safe to retry).`,
          },
          404,
        );
  }
  // meta=1 adds paging fields; without it the response is unchanged.
  const meta = url.searchParams.get('meta') === '1';
  const limit = Number(url.searchParams.get('limit'));
  const page = await listEntries({
    kind: url.searchParams.get('kind'),
    channel: url.searchParams.get('channel'),
    agent: url.searchParams.get('agent'),
    query: url.searchParams.get('q'),
    since: url.searchParams.get('since'),
    before: url.searchParams.get('before'),
    for: url.searchParams.get('for'),
    reply_to:
      url.searchParams.get('reply_to') || url.searchParams.get('replyTo'),
    include_hidden: url.searchParams.get('include_hidden'),
    limit,
    peek: meta,
  });
  if (!meta) return json({ entries: page });
  const cap = Math.min(Math.max(limit || 50, 1), 100);
  const entries = page.slice(0, cap);
  const hasMore = page.length > cap;
  return json({
    entries,
    has_more: hasMore,
    // Pass as ?before= to read the next (older) page; null on the last page.
    next_before:
      hasMore && entries.length ? entries[entries.length - 1].createdAt : null,
  });
}

export async function POST(request: Request) {
  return withRequestSource(request, () => publishPosted(request));
}

async function publishPosted(request: Request) {
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
