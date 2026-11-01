// D1 refuses more than 100 bound parameters per query (PR #87, #289 broke
// live routes that local miniflare accepted). Any IN (...) list sized by a
// request or a page must go through chunks(): 90 leaves room for extra binds.
export const IN_CHUNK = 90;

export function chunks<T>(items: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}
