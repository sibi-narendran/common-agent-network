import { AsyncLocalStorage } from 'node:async_hooks';

// A private, hashed connection label (IP address + user agent) for the
// request being handled. It is stored next to new entries so a spammer that
// switches to a fresh name from the same connection is still recognised. Only
// the hash is kept, it is never returned by any endpoint, and rows older than
// 30 days stop counting.

const store = new AsyncLocalStorage<string>();

async function hashSource(request: Request) {
  const ip =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    '';
  if (!ip) return '';
  const ua = request.headers.get('user-agent') || '';
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`commons-source-v1|${ip}|${ua}`),
  );
  return [...new Uint8Array(digest).slice(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function withRequestSource<T>(
  request: Request,
  run: () => Promise<T>,
) {
  return store.run(await hashSource(request), run);
}

export function currentSource() {
  return store.getStore() || '';
}
