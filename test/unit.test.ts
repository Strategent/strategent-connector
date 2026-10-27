import { describe, expect, it } from 'vitest';
import { normalizeRegion } from '../src/region.js';
import { SLOT_TTL_SECONDS, signSlot, verifySlot } from '../src/token.js';
import {
  confirmationMoment,
  inPartOfDay,
  normalizeTimezone,
  pickSlots,
  resolveWindow,
  slotLabel,
  zonedToUtc,
} from '../src/time.js';
import { slackSafe } from '../src/notify.js';
import { normalizeChannel, normalizeIndustry } from '../src/tools.js';
import { NOW } from './helpers.js';

describe('timezones', () => {
  it('maps abbreviations and keeps IANA names', () => {
    expect(normalizeTimezone('CST').tz).toBe('America/Chicago');
    expect(normalizeTimezone('America/Toronto').tz).toBe('America/Toronto');
  });
  it('falls back to Pacific with a note when unknown or missing', () => {
    expect(normalizeTimezone('Mars/Olympus').tz).toBe('America/Los_Angeles');
    expect(normalizeTimezone('Mars/Olympus').note).toMatch(/not recognised/);
    expect(normalizeTimezone(undefined).note).toMatch(/Pacific/);
  });
  it('converts local wall time to UTC across DST', () => {
    // 10:00 Pacific is UTC-7 in October (PDT) and UTC-8 in December (PST).
    expect(zonedToUtc(2026, 10, 27, 10, 0, 'America/Los_Angeles').toISOString()).toBe('2026-10-27T17:00:00.000Z');
    expect(zonedToUtc(2026, 12, 8, 10, 0, 'America/Los_Angeles').toISOString()).toBe('2026-12-08T18:00:00.000Z');
    // The DST change itself: Nov 1 2026, 1:30 AM Pacific happens, and 10:00 after it is UTC-8.
    expect(zonedToUtc(2026, 11, 2, 10, 0, 'America/Los_Angeles').toISOString()).toBe('2026-11-02T18:00:00.000Z');
  });
});

describe('date window', () => {
  it('clamps a past start to now and says so', () => {
    const w = resolveWindow('2020-01-01', undefined, 'America/Los_Angeles', NOW);
    expect(w.start.getTime()).toBe(NOW.getTime());
    expect(w.notes.join(' ')).toMatch(/in the past/);
  });
  it('limits the range to 14 days and says so', () => {
    const w = resolveWindow('2026-10-27', '2026-12-31', 'America/Los_Angeles', NOW);
    expect((w.end.getTime() - w.start.getTime()) / 86_400_000).toBeCloseTo(14, 5);
    expect(w.notes.join(' ')).toMatch(/limited to 14 days/);
  });
  it('reads a bare end date as the end of that day in the user timezone', () => {
    const w = resolveWindow('2026-10-27', '2026-10-27', 'America/Chicago', NOW);
    expect(w.end.toISOString()).toBe('2026-10-28T05:00:00.000Z'); // midnight Chicago (CDT, UTC-5)
  });
  it('survives unparseable input', () => {
    const w = resolveWindow('tomorrow', 'next week', 'America/Chicago', NOW);
    expect(w.notes.length).toBe(2);
    expect(w.start.getTime()).toBe(NOW.getTime());
  });
});

describe('time labels', () => {
  const t = new Date('2026-10-27T18:00:00Z'); // 11:00 AM PDT, 1:00 PM CDT
  it('shows Pacific only for Pacific users', () => {
    expect(slotLabel(t, 'America/Los_Angeles')).toBe('Tue Oct 27, 11:00 AM PDT');
  });
  it('shows local time and Pacific for other zones', () => {
    expect(slotLabel(t, 'America/Chicago')).toBe('Tue Oct 27, 1:00 PM CDT (11:00 AM PDT)');
    expect(confirmationMoment(t, 'America/Chicago')).toEqual({
      day: 'Tuesday',
      date: 'October 27',
      time: '1:00 PM',
      timezone: 'CDT (11:00 AM PDT)',
    });
  });
  it('filters by part of day in the user timezone', () => {
    expect(inPartOfDay(t, 'America/Chicago', 'afternoon')).toBe(true);
    expect(inPartOfDay(t, 'America/Los_Angeles', 'afternoon')).toBe(false);
  });
});

describe('pickSlots', () => {
  it('spreads picks across days and caps per day', () => {
    const day = (d: number, h: number) => new Date(Date.UTC(2026, 9, d, h));
    const slots = [day(27, 17), day(27, 18), day(27, 19), day(27, 20), day(28, 17), day(28, 20), day(29, 17)];
    const picks = pickSlots(slots, 'America/Los_Angeles');
    const perDay = new Map<string, number>();
    for (const p of picks) perDay.set(p.toISOString().slice(0, 10), (perDay.get(p.toISOString().slice(0, 10)) ?? 0) + 1);
    expect(Math.max(...perDay.values())).toBeLessThanOrEqual(2);
    expect(picks.length).toBeLessThanOrEqual(8);
  });
});

describe('slot tokens', () => {
  const secret = 'secret-secret-secret-secret-secret-1';
  const start = new Date('2026-10-27T18:00:00Z');
  it('round-trips start and timezone', async () => {
    const tok = await signSlot(secret, start, 'America/Chicago', NOW);
    const v = await verifySlot(secret, tok, NOW);
    expect(v.ok && v.claims.start.toISOString()).toBe(start.toISOString());
    expect(v.ok && v.claims.tz).toBe('America/Chicago');
  });
  it('rejects tampering, junk and expiry', async () => {
    const tok = await signSlot(secret, start, 'America/Chicago', NOW);
    const [a, ...rest] = tok.split('.');
    const forged = [(Number.parseInt(a!, 36) + 1800).toString(36), ...rest].join('.');
    expect((await verifySlot(secret, forged, NOW)).ok).toBe(false);
    expect(await verifySlot(secret, 'not a token', NOW)).toEqual({ ok: false, reason: 'malformed' });
    const later = new Date(NOW.getTime() + (SLOT_TTL_SECONDS + 5) * 1000);
    expect(await verifySlot(secret, tok, later)).toEqual({ ok: false, reason: 'expired' });
    expect((await verifySlot('another-secret-another-secret-12', tok, NOW)).ok).toBe(false);
  });
});

describe('region', () => {
  it.each([
    ['Redondo Beach', 'south_bay'],
    ['Hermosa Beach, CA', 'south_bay'],
    ['manhattan beach', 'south_bay'],
    ['Torrance 90503', 'south_bay'],
    ['90277', 'south_bay'],
    ['Santa Monica', 'westside'],
    ['Culver City, California', 'westside'],
    ['Long Beach', 'la_other'],
    ['91101', 'la_other'],
    ['Woodland Hills', 'la_other'],
    ['woodland hills, CA', 'la_other'],
    ['Tarzana', 'la_other'],
    ['Calabasas', 'la_other'],
    ['Pomona', 'la_other'],
    ['Silver Lake, Los Angeles', 'la_other'],
    ['Rolling Hills Estates', 'south_bay'],
    ['Santa Monica Canyon, Pacific Palisades', 'westside'],
    ['Chicago', 'other'],
    ['', 'other'],
  ])('%s -> %s', (city, region) => {
    expect(normalizeRegion(city)).toBe(region);
  });
});

describe('normalisers', () => {
  it('maps free text to the standard industry and channel values', () => {
    expect(normalizeIndustry('I own a hotel')).toBe('hospitality');
    expect(normalizeIndustry('law firm')).toBe('legal');
    expect(normalizeIndustry('plumbing')).toBe('other');
    expect(normalizeIndustry(undefined)).toBe('other');
    expect(normalizeChannel('back office')).toBe('back_office');
    expect(normalizeChannel('the phones')).toBe('calls');
    expect(normalizeChannel('')).toBe('all');
  });
  it('neutralises Slack control sequences', () => {
    const out = slackSafe('<!channel> hi <https://evil.test|click> @here');
    expect(out).not.toContain('<');
    expect(out).not.toMatch(/@here/);
  });
});
