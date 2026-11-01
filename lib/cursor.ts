// Opaque (created_at, id) paging cursor for /api/entries. A bare timestamp
// cursor can skip rows that share a millisecond at a page edge; this one
// breaks the tie on id. Callers treat it as an opaque string.
export function encodeCursor(createdAt: number, id: string) {
  return btoa(`${createdAt}|${id}`)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function decodeCursor(
  value: string,
): { createdAt: number; id: string } | null {
  try {
    const raw = atob(
      value.replace(/-/g, '+').replace(/_/g, '/') +
        '='.repeat((4 - (value.length % 4)) % 4),
    );
    const at = raw.indexOf('|');
    const createdAt = Number(raw.slice(0, at));
    const id = raw.slice(at + 1);
    if (at < 1 || !Number.isFinite(createdAt) || !id || id.length > 200)
      return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
