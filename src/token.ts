import { b64urlEncode, b64urlToUtf8, mac, safeEqual, utf8ToB64url } from './crypto.js';

const PURPOSE = 'slot';
export const SLOT_TTL_SECONDS = 30 * 60;

export interface SlotClaims {
  start: Date;
  tz: string;
}

export type SlotVerify =
  | { ok: true; claims: SlotClaims }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

/**
 * Compact, tamper-proof slot token: <start36>.<exp36>.<tz>.<mac>. Short enough for a model to copy
 * back reliably. The server still re-checks the slot with the scheduler at booking time.
 */
export async function signSlot(secret: string, start: Date, tz: string, now: Date): Promise<string> {
  const startSec = Math.floor(start.getTime() / 1000);
  const expSec = Math.floor(now.getTime() / 1000) + SLOT_TTL_SECONDS;
  const body = `${startSec.toString(36)}.${expSec.toString(36)}.${utf8ToB64url(tz)}`;
  const sig = b64urlEncode((await mac(secret, PURPOSE, body)).slice(0, 12));
  return `${body}.${sig}`;
}

export async function verifySlot(secret: string, token: string, now: Date): Promise<SlotVerify> {
  const parts = token.trim().split('.');
  if (parts.length !== 4 || parts.some((p) => !p)) return { ok: false, reason: 'malformed' };
  const [startPart, expPart, tzPart, sig] = parts as [string, string, string, string];
  const body = `${startPart}.${expPart}.${tzPart}`;
  const expected = b64urlEncode((await mac(secret, PURPOSE, body)).slice(0, 12));
  if (!safeEqual(expected, sig)) return { ok: false, reason: 'bad_signature' };
  const startSec = Number.parseInt(startPart, 36);
  const expSec = Number.parseInt(expPart, 36);
  let tz: string;
  try {
    tz = b64urlToUtf8(tzPart);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!Number.isFinite(startSec) || !Number.isFinite(expSec)) return { ok: false, reason: 'malformed' };
  if (expSec <= Math.floor(now.getTime() / 1000)) return { ok: false, reason: 'expired' };
  return { ok: true, claims: { start: new Date(startSec * 1000), tz } };
}
