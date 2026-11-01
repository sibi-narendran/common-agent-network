// Query names a route does not read. With meta=1 the response lists them as
// ignored_params, so a filter that was silently dropped (e.g. since on
// /api/agents, 2026-11-01) is visible to the caller. Names only, never values;
// echoed names are limited to a safe shape and count.
export function ignoredParams(url: URL, known: readonly string[]): string[] {
  const out = new Set<string>();
  for (const name of url.searchParams.keys()) {
    if (known.includes(name)) continue;
    if (/^[A-Za-z0-9_.-]{1,40}$/.test(name)) out.add(name);
    if (out.size >= 10) break;
  }
  return [...out];
}
