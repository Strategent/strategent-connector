export const PACIFIC = 'America/Los_Angeles';
export const MAX_RANGE_DAYS = 14;
const DAY_MS = 86_400_000;

const ABBREVIATIONS: Record<string, string> = {
  pst: 'America/Los_Angeles',
  pdt: 'America/Los_Angeles',
  pt: 'America/Los_Angeles',
  pacific: 'America/Los_Angeles',
  mst: 'America/Denver',
  mdt: 'America/Denver',
  mt: 'America/Denver',
  mountain: 'America/Denver',
  cst: 'America/Chicago',
  cdt: 'America/Chicago',
  ct: 'America/Chicago',
  central: 'America/Chicago',
  est: 'America/New_York',
  edt: 'America/New_York',
  et: 'America/New_York',
  eastern: 'America/New_York',
  akst: 'America/Anchorage',
  akdt: 'America/Anchorage',
  hst: 'Pacific/Honolulu',
  ast: 'America/Halifax',
  adt: 'America/Halifax',
  nst: 'America/St_Johns',
  ndt: 'America/St_Johns',
};

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface TzResult {
  tz: string;
  note?: string;
}

/** Accepts IANA names and common US/Canada abbreviations. Falls back to Pacific with a note. */
export function normalizeTimezone(input: string | undefined): TzResult {
  const raw = (input ?? '').trim();
  if (!raw) return { tz: PACIFIC, note: 'No timezone was given, so times are shown in Pacific.' };
  const mapped = ABBREVIATIONS[raw.toLowerCase()];
  if (mapped) return { tz: mapped };
  if (isValidTimezone(raw)) return { tz: raw };
  return { tz: PACIFIC, note: `Timezone "${raw.slice(0, 40)}" was not recognised, so times are shown in Pacific.` };
}

/** Offset in ms of `tz` from UTC at the given instant (positive east of UTC). */
function offsetMs(utcMs: number, tz: string): number {
  const p = partsAt(utcMs, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

function partsAt(utcMs: number, tz: string) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  const o: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') o[part.type] = Number(part.value);
  }
  return { year: o.year!, month: o.month!, day: o.day!, hour: o.hour!, minute: o.minute!, second: o.second! };
}

/** Wall-clock time in `tz` to a UTC instant. Handles DST by re-checking the offset once. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - offsetMs(guess, tz);
  const second = guess - offsetMs(first, tz);
  return new Date(second);
}

export function localHour(date: Date, tz: string): number {
  return partsAt(date.getTime(), tz).hour;
}

export function localDayKey(date: Date, tz: string): string {
  const p = partsAt(date.getTime(), tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Parse an ISO date or datetime. Dates and datetimes without an offset are read in `tz`.
 * For `edge: 'end'` a bare date means the end of that day.
 */
export function parseUserInstant(input: string | undefined, tz: string, edge: 'start' | 'end'): Date | null {
  const s = (input ?? '').trim();
  if (!s) return null;
  const dateOnly = DATE_ONLY.exec(s);
  if (dateOnly) {
    const [y, m, d] = [Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3])];
    const start = zonedToUtc(y, m, d, 0, 0, tz);
    if (Number.isNaN(start.getTime())) return null;
    return edge === 'start' ? start : new Date(zonedToUtc(y, m, d + 1, 0, 0, tz).getTime());
  }
  const local = LOCAL_DATETIME.exec(s);
  if (local && !HAS_OFFSET.test(s)) {
    return zonedToUtc(Number(local[1]), Number(local[2]), Number(local[3]), Number(local[4]), Number(local[5]), tz);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface Window {
  start: Date;
  end: Date;
  notes: string[];
}

/** Clamp the requested range to [now, now + 14 days] and say what changed. */
export function resolveWindow(startIn: string | undefined, endIn: string | undefined, tz: string, now: Date): Window {
  const notes: string[] = [];
  let start = parseUserInstant(startIn, tz, 'start');
  if (startIn && !start) notes.push(`Could not read start "${startIn.slice(0, 30)}", so the search starts now.`);
  if (!start || start.getTime() < now.getTime()) {
    if (start) notes.push('The start was in the past, so the search starts now.');
    start = now;
  }
  const maxEnd = new Date(start.getTime() + MAX_RANGE_DAYS * DAY_MS);
  let end = parseUserInstant(endIn, tz, 'end');
  if (endIn && !end) notes.push(`Could not read end "${endIn.slice(0, 30)}", so the search covers ${MAX_RANGE_DAYS} days.`);
  if (!end || end.getTime() <= start.getTime()) {
    if (end) notes.push(`The end was not after the start, so the search covers ${MAX_RANGE_DAYS} days.`);
    end = maxEnd;
  }
  if (end.getTime() > maxEnd.getTime()) {
    notes.push(`The range was limited to ${MAX_RANGE_DAYS} days.`);
    end = maxEnd;
  }
  return { start, end, notes };
}

export interface Moment {
  day: string; // Tuesday
  date: string; // October 27
  time: string; // 1:00 PM
  tzName: string; // CDT
}

export function formatMoment(date: Date, tz: string, long = true): Moment {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: long ? 'long' : 'short',
    month: long ? 'long' : 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  const o: Record<string, string> = {};
  for (const part of f.formatToParts(date)) o[part.type] = part.value;
  return {
    day: o.weekday ?? '',
    date: `${o.month} ${o.day}`,
    time: `${o.hour}:${o.minute} ${o.dayPeriod ?? ''}`.trim(),
    tzName: o.timeZoneName ?? tz,
  };
}

/** "Tue, Oct 27, 1:00 PM CDT" plus the Pacific equivalent when the user is not on Pacific time. */
export function slotLabel(date: Date, tz: string): string {
  const m = formatMoment(date, tz, false);
  const base = `${m.day} ${m.date}, ${m.time} ${m.tzName}`;
  if (isSameZoneAsPacific(date, tz)) return base;
  const p = formatMoment(date, PACIFIC, false);
  return `${base} (${p.time} ${p.tzName})`;
}

function isSameZoneAsPacific(date: Date, tz: string): boolean {
  return offsetMs(date.getTime(), tz) === offsetMs(date.getTime(), PACIFIC);
}

/** Long form for confirmations, with the Pacific equivalent appended when it differs. */
export function confirmationMoment(date: Date, tz: string): { day: string; date: string; time: string; timezone: string } {
  const m = formatMoment(date, tz, true);
  if (isSameZoneAsPacific(date, tz)) return { day: m.day, date: m.date, time: m.time, timezone: m.tzName };
  const p = formatMoment(date, PACIFIC, true);
  return { day: m.day, date: m.date, time: m.time, timezone: `${m.tzName} (${p.time} ${p.tzName})` };
}

export type PartOfDay = 'morning' | 'afternoon' | 'evening' | 'any';

export function inPartOfDay(date: Date, tz: string, part: PartOfDay): boolean {
  if (part === 'any') return true;
  const h = localHour(date, tz);
  if (part === 'morning') return h >= 5 && h < 12;
  if (part === 'afternoon') return h >= 12 && h < 17;
  return h >= 17 && h < 22;
}

/** Up to `max` slots, at most `perDay` per local day and at least `gapMin` apart, earliest first. */
export function pickSlots(slots: Date[], tz: string, max = 8, perDay = 2, gapMin = 90): Date[] {
  const sorted = [...slots].sort((a, b) => a.getTime() - b.getTime());
  const out: Date[] = [];
  const perDayCount = new Map<string, number>();
  for (const s of sorted) {
    if (out.length >= max) break;
    const key = localDayKey(s, tz);
    if ((perDayCount.get(key) ?? 0) >= perDay) continue;
    const prev = out[out.length - 1];
    if (prev && localDayKey(prev, tz) === key && s.getTime() - prev.getTime() < gapMin * 60_000) continue;
    out.push(s);
    perDayCount.set(key, (perDayCount.get(key) ?? 0) + 1);
  }
  return out;
}
