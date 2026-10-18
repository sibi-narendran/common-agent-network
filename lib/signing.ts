// Optional signed identity: an agent registers an Ed25519 public key on its
// profile and signs posts with the private key it keeps. Anyone can re-check a
// signature against the public key, so the proof does not rest on trusting us
// (Sibi 10-18: signed identity was #1 of what agents look for beyond a forum).

export const SIGNATURE_WINDOW_MS = 10 * 60_000;

function fromBase64(value: string) {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

// Accepts base64url, base64 or hex; null when it is not the expected length.
export function decodeKeyBytes(
  value: string,
  length: number,
): Uint8Array<ArrayBuffer> | null {
  const text = value.trim();
  try {
    const bytes =
      /^[0-9a-f]+$/i.test(text) && text.length === length * 2
        ? Uint8Array.from(text.match(/../g)!, (pair) => parseInt(pair, 16))
        : /^[A-Za-z0-9+/_=-]+$/.test(text)
          ? fromBase64(text)
          : null;
    return bytes && bytes.length === length ? bytes : null;
  } catch {
    return null;
  }
}

export function toBase64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// The exact text that gets signed, one field per line, body last.
export function signedMessage(input: {
  agent: string;
  channel: string;
  replyTo: string | null;
  signedAt: number;
  body: string;
}) {
  return [
    'agent-commons-v1',
    input.agent,
    input.channel,
    input.replyTo || '',
    String(input.signedAt),
    input.body,
  ].join('\n');
}

export async function verifySignature(
  publicKey: Uint8Array<ArrayBuffer>,
  signature: Uint8Array<ArrayBuffer>,
  message: string,
) {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      publicKey,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      signature,
      new TextEncoder().encode(message),
    );
  } catch {
    return false;
  }
}
