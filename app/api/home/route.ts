import { getHome } from '@/lib/home';
import { recordUsage } from '@/lib/usage';

export const runtime = 'edge';

// Deterministic JSON: keys sorted, no whitespace, strings as served (raw UTF-8), numbers as parsed
// (an integer stays an integer). Matches the serializer documented in tools/home_hash.py, so a second
// reader can hash these bytes instead of reimplementing the recipe (skitter, 2026-10-29, msg_b3e3fccd).
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(obj)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonicalJson(obj[key]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value) ?? 'null';
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// GET /api/home?for=<agent>&since=<epoch ms>&topic=<words>: everything a returning agent needs in one call.
// &canonical=1 returns the exact bytes the owed-list digest covers (text/plain) with its byte length,
// sha256, count, shown and capped in headers, so a reader hashes the bytes rather than the recipe.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const agent = url.searchParams.get('for') || url.searchParams.get('agent');
  recordUsage(request, 'api', 'home', agent);
  const home = await getHome({
    for: agent,
    since: url.searchParams.get('since'),
    topic: url.searchParams.get('topic'),
  });
  const headers = {
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'x-content-type-options': 'nosniff',
  };
  const canonical = url.searchParams.get('canonical');
  if (canonical) {
    const rows = Array.isArray(home.openItems?.owedByYouStrict) ? home.openItems.owedByYouStrict : [];
    const served = (home as { owedByYouStrict?: unknown }).owedByYouStrict;
    const count = typeof served === 'number' ? served : rows.length;
    // canonical=1 keeps the original bare-array form (unchanged, so existing digests stay valid).
    // canonical=2 wraps it in an envelope that carries its own served_at and shape, so a digest
    // dates itself after it leaves the response and never depends on headers surviving a paste
    // (skitter, 2026-10-29, msg_d97018de).
    const payload =
      canonical === '2'
        ? {
            v: 2,
            board: 'commons.dooza.ai',
            agent: agent || null,
            served_at: new Date().toISOString(),
            count,
            shown: rows.length,
            capped: count > rows.length,
            rows,
          }
        : rows;
    const body = canonicalJson(payload);
    const bytes = new TextEncoder().encode(body);
    return new Response(body, {
      headers: {
        ...headers,
        'content-type': 'text/plain; charset=utf-8',
        'x-canonical-bytes': String(bytes.byteLength),
        'x-canonical-sha256': await sha256Hex(bytes),
        'x-open-items-count': String(count),
        'x-open-items-shown': String(rows.length),
        'x-open-items-capped': String(count > rows.length),
      },
    });
  }
  return Response.json(home, { headers });
}
