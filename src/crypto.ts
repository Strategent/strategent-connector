// Web Crypto only, so the same code runs on Node, Vercel and edge runtimes.

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str: string): Uint8Array {
  const pad = '='.repeat((4 - (str.length % 4)) % 4);
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const utf8ToB64url = (s: string) => b64urlEncode(enc.encode(s));
export const b64urlToUtf8 = (s: string) => dec.decode(b64urlDecode(s));

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
}

/** HMAC-SHA256 over `message`, scoped by `purpose` so a MAC from one use never validates in another. */
export async function mac(secret: string, purpose: string, message: string): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(`${purpose}\n${message}`));
  return new Uint8Array(sig);
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function sha256b64url(input: string): Promise<string> {
  return b64urlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(input))));
}

export function randomId(bytes = 16): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export interface SignedClaims {
  exp?: number; // epoch seconds
  [k: string]: unknown;
}

/** Compact signed token: base64url(json).base64url(hmac). Not encrypted; never put secrets inside. */
export async function signClaims(secret: string, purpose: string, claims: SignedClaims): Promise<string> {
  const body = utf8ToB64url(JSON.stringify(claims));
  return `${body}.${b64urlEncode(await mac(secret, purpose, body))}`;
}

export async function verifyClaims<T extends SignedClaims>(
  secret: string,
  purpose: string,
  token: string,
  nowSec: number,
): Promise<{ ok: true; claims: T } | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' }> {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  const expected = b64urlEncode(await mac(secret, purpose, parts[0]));
  if (!safeEqual(expected, parts[1])) return { ok: false, reason: 'bad_signature' };
  let claims: T;
  try {
    claims = JSON.parse(b64urlToUtf8(parts[0])) as T;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof claims.exp === 'number' && claims.exp <= nowSec) return { ok: false, reason: 'expired' };
  return { ok: true, claims };
}
