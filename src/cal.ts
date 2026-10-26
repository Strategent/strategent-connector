import type { Config } from './config.js';
import {
  SchedulerConflictError,
  SchedulerUnavailableError,
  type BookingInput,
  type BookingResult,
  type SchedulerApi,
} from './scheduler.js';

// Cal.com versions each endpoint separately. Pin them here so an upstream default change cannot
// silently alter behaviour. Values are from Cal.com's OpenAPI spec.
export const CAL_VERSIONS = {
  slots: '2024-09-04',
  bookings: '2026-02-25',
  eventTypes: '2026-06-12',
} as const;

// Cal.com does not document a maximum slots range, so stay conservative and ask a week at a time.
const WINDOW_MS = 7 * 86_400_000;
const MIN_FUTURE_MS = 15_000;

type Fetch = typeof fetch;

export interface CalResponse {
  status: number;
  json: any;
}

/** Shared HTTP plumbing: auth, per-endpoint version header, timeout, error classification. */
export function createCalHttp(config: Config, fetchImpl: Fetch = fetch) {
  return async function call(path: string, version: string, init: RequestInit = {}): Promise<CalResponse> {
    let res: Response;
    try {
      res = await fetchImpl(`${config.calApiBase}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${config.calApiKey}`,
          'cal-api-version': version,
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(8000),
      });
    } catch (e) {
      throw new SchedulerUnavailableError(`Cal.com request failed: ${(e as Error).message}`, 'network');
    }
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  };
}

/** Best-effort short description of an error body, whatever shape Cal.com returns. */
export function errorText(json: any): string {
  const parts: unknown[] = [json?.error?.message, json?.error?.details, json?.message, json?.error];
  const text = parts.find((p) => typeof p === 'string' && p) ?? JSON.stringify(json ?? {});
  return String(text).slice(0, 300);
}

/** Throws the right SchedulerUnavailableError for the status codes shared by every endpoint. */
export function throwForStatus(r: CalResponse, what: string): void {
  if (r.status === 401 || r.status === 403) {
    throw new SchedulerUnavailableError(`Cal.com rejected the API key (${r.status}) during ${what}`, 'auth');
  }
  if (r.status === 429) throw new SchedulerUnavailableError(`Cal.com rate limit hit during ${what}`, 'rate_limit');
  if (r.status >= 500) throw new SchedulerUnavailableError(`Cal.com server error (${r.status}) during ${what}`, 'server');
}

export function fillTemplate(template: string, uid: string): string {
  return template.replace(/\{uid\}/g, encodeURIComponent(uid));
}

export function createCalClient(config: Config, fetchImpl: Fetch = fetch): SchedulerApi {
  const call = createCalHttp(config, fetchImpl);

  async function slotsChunk(start: Date, end: Date): Promise<Date[]> {
    const qs = new URLSearchParams({
      eventTypeId: String(config.calEventTypeId),
      start: start.toISOString(),
      end: end.toISOString(),
    });
    const path = `/v2/slots?${qs}`;
    let r = await call(path, CAL_VERSIONS.slots);
    if (r.status >= 500) r = await call(path, CAL_VERSIONS.slots); // reads are safe to retry once
    throwForStatus(r, 'availability');
    if (r.status >= 400) {
      throw new SchedulerUnavailableError(`Cal.com rejected the availability request (${r.status}): ${errorText(r.json)}`, 'bad_request');
    }
    // Slots come grouped by date. Each slot is either an ISO string or { start }.
    const byDate: Record<string, unknown[]> = r.json?.data && typeof r.json.data === 'object' ? r.json.data : {};
    const out: Date[] = [];
    for (const slots of Object.values(byDate)) {
      for (const slot of Array.isArray(slots) ? slots : []) {
        const iso = typeof slot === 'string' ? slot : (slot as { start?: string })?.start;
        const d = iso ? new Date(iso) : null;
        if (d && !Number.isNaN(d.getTime())) out.push(d);
      }
    }
    return out;
  }

  async function availableTimes(start: Date, end: Date): Promise<Date[]> {
    const from = new Date(Math.max(start.getTime(), Date.now() + MIN_FUTURE_MS));
    const chunks: [Date, Date][] = [];
    for (let t = from.getTime(); t < end.getTime(); ) {
      const upper = Math.min(t + WINDOW_MS, end.getTime());
      if (upper - t >= 60_000) chunks.push([new Date(t), new Date(upper)]);
      t = upper;
    }
    const results = await Promise.all(chunks.map(([s, e]) => slotsChunk(s, e)));
    const unique = new Map<number, Date>();
    for (const d of results.flat()) if (d >= from && d < end) unique.set(d.getTime(), d);
    return [...unique.values()].sort((a, b) => a.getTime() - b.getTime());
  }

  async function createBooking(input: BookingInput): Promise<BookingResult> {
    const body: Record<string, unknown> = {
      start: input.start.toISOString(),
      eventTypeId: config.calEventTypeId,
      attendee: { name: input.name, email: input.email, timeZone: input.timezone, language: 'en' },
      bookingFieldsResponses: input.fields,
      metadata: { source: input.source, connector: 'strategent' },
    };
    if (config.calLocation) body.location = { type: 'integration', integration: config.calLocation };

    const r = await call('/v2/bookings', CAL_VERSIONS.bookings, { method: 'POST', body: JSON.stringify(body) });
    throwForStatus(r, 'booking'); // never retried: a repeated POST could double book

    if (r.status === 409) throw new SchedulerConflictError('That time is no longer available');
    if (r.status >= 400 || r.json?.status === 'error') {
      const message = errorText(r.json);
      if (/(no longer|not available|unavailable|already|conflict|taken|booked)/i.test(message)) {
        throw new SchedulerConflictError('That time is no longer available');
      }
      // Cal.com does not document its "slot taken" error, so decide by looking: if the slot has
      // disappeared from availability it was taken, otherwise the request itself was wrong.
      const around = await availableTimes(new Date(input.start.getTime() - 60_000), new Date(input.start.getTime() + 60_000)).catch(() => null);
      if (around && !around.some((d) => d.getTime() === input.start.getTime())) {
        throw new SchedulerConflictError('That time is no longer available');
      }
      throw new SchedulerUnavailableError(`Cal.com rejected the booking (${r.status}): ${message}`, 'bad_request');
    }

    const data = Array.isArray(r.json?.data) ? r.json.data[0] : r.json?.data;
    const uid: string = data?.uid ?? '';
    if (!uid || ['cancelled', 'rejected'].includes(data?.status)) {
      throw new SchedulerUnavailableError(`Cal.com returned an unusable booking (status ${data?.status ?? 'unknown'})`, 'bad_request');
    }
    const link = [data.location, data.meetingUrl].find((v) => typeof v === 'string' && /^https?:\/\//.test(v)) as string | undefined;
    return {
      uid,
      rescheduleUrl: fillTemplate(config.rescheduleUrlTemplate, uid),
      cancelUrl: fillTemplate(config.cancelUrlTemplate, uid),
      meetLink: link ?? null,
    };
  }

  return { availableTimes, createBooking };
}
