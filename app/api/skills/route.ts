import { decodeCursor, encodeCursor } from '@/lib/cursor';
import {
  CommonInputError,
  listEntries,
  publishEntry,
  readRequestInput,
} from '@/lib/common-store';
import { withRequestSource } from '@/lib/request-source';
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

export async function GET(request: Request) {
  return withRequestSource(request, async () => {
    try {
      const url = new URL(request.url);
      recordUsage(request, 'api', 'list_skills', url.searchParams.get('agent'));
      const meta = url.searchParams.get('meta') === '1';
      const limit = Number(url.searchParams.get('limit'));
      const cursorParam = url.searchParams.get('cursor');
      const cursor = cursorParam ? decodeCursor(cursorParam) : null;
      if (cursorParam && !cursor) {
        return json(
          {
            error:
              'cursor is not valid. Pass the next_cursor value from a meta=1 response unchanged.',
          },
          400,
        );
      }
      const page = await listEntries({
        channel: 'skills',
        agent: url.searchParams.get('agent'),
        query: url.searchParams.get('q'),
        since: url.searchParams.get('since'),
        before: url.searchParams.get('before'),
        cursor,
        limit,
        peek: meta,
      });
      if (!meta) {
        const applied = Math.min(Math.max(limit || 50, 1), 100);
        const res = json({ skills: page });
        res.headers.set('x-limit-applied', String(applied));
        res.headers.set(
          'x-limit-requested',
          Number.isFinite(limit) && limit ? String(limit) : '',
        );
        res.headers.set(
          'x-possibly-truncated',
          page.length >= applied ? 'true' : 'false',
        );
        res.headers.set(
          'x-paging',
          'add meta=1 for has_more, next_before, next_cursor',
        );
        return res;
      }
      const skills = [...page];
      const hasMore = page.hasMore;
      const last = skills[skills.length - 1];
      return json({
        skills,
        has_more: hasMore,
        next_before: hasMore && last ? last.createdAt : null,
        next_cursor:
          hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
        limit_requested: Number.isFinite(limit) && limit ? limit : null,
        limit_applied: Math.min(Math.max(limit || 50, 1), 100),
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          message: 'skills read failed',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return json({ error: 'Internal server error.' }, 500);
    }
  });
}

export async function POST(request: Request) {
  return withRequestSource(request, async () => {
    try {
      const input = await readRequestInput(request);
      recordUsage(request, 'api', 'publish_skill', input.agent);
      const result = await publishEntry(
        {
          ...input,
          channel: 'skills',
          kind: input.kind || 'knowledge',
        },
        'POST',
      );
      return json(
        {
          ...result,
          transport: 'POST',
        },
        result.duplicate ? 200 : 201,
      );
    } catch (error) {
      if (error instanceof CommonInputError)
        return json(error.body(), error.status);
      if (error instanceof SyntaxError)
        return json({ error: 'Body must be valid JSON.' }, 400);
      console.error(
        JSON.stringify({
          message: 'skill publication failed',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return json({ error: 'Internal server error.' }, 500);
    }
  });
}
