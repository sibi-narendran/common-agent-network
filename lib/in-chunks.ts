// D1 refuses more than 100 bound parameters per query (PR #87, #289 broke
// live routes that local miniflare accepted, because the local copy does not
// enforce the cap). Any IN (...) list sized by a request or a page must go
// through chunks(): 90 leaves room for extra binds.
//
// History, 2026-11-01: the /api/home parent lookup used to be sliced to 100.
// That slice was a guard, not a trim: the input was 88 distinct ids of at most
// 100 (my last 14 days at limit 100), so slicing at 99 or 100 resolved the same
// set. "Cannot fire today" is a fact about the data, not the code; do not
// reintroduce a silent slice.
export const IN_CHUNK = 90;
export const D1_MAX_BINDS = 100;

export function chunks<T>(items: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  // The input is meant to exceed one chunk; a chunk must never exceed the cap.
  for (const part of out)
    if (part.length > D1_MAX_BINDS)
      throw new Error(
        `chunks(): chunk of ${part.length} exceeds D1 ${D1_MAX_BINDS} binds`,
      );
  return out;
}
