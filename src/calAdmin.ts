// Setup helpers for the Cal.com event type. Used by scripts/cal-setup.ts, never by the live server.
import { CAL_VERSIONS, createCalHttp, errorText, throwForStatus } from './cal.js';
import type { Config } from './config.js';
import { SchedulerUnavailableError } from './scheduler.js';

type Fetch = typeof fetch;

export interface EventTypeSummary {
  id: number;
  slug: string;
  title: string;
  lengthInMinutes: number;
  locations: string[];
  minimumBookingNotice?: number;
  afterEventBuffer?: number;
  hidden?: boolean;
}

export interface BookingFieldSummary {
  slug: string;
  type: string;
  label?: string;
  required?: boolean;
  custom: boolean;
}

/** The questions the connector fills in. Order here is the order they appear on the booking page. */
export function expectedFields(config: Config): { slug: string; label: string; type: 'shortText' | 'longText' }[] {
  const f = config.calFields;
  return [
    { slug: f.business, label: 'Business name', type: 'shortText' },
    { slug: f.website, label: 'Website', type: 'shortText' },
    { slug: f.city, label: 'City', type: 'shortText' },
    { slug: f.industry, label: 'Industry', type: 'shortText' },
    { slug: f.painPoint, label: 'What is taking the most time right now?', type: 'longText' },
    { slug: f.phone, label: 'Phone', type: 'shortText' },
    { slug: f.channel, label: 'Where do you want AI first?', type: 'shortText' },
  ];
}

export function createCalAdmin(config: Config, fetchImpl: Fetch = fetch) {
  const call = createCalHttp(config, fetchImpl);

  return {
    async me(): Promise<{ username: string; email: string; timeZone: string }> {
      const r = await call('/v2/me', CAL_VERSIONS.eventTypes);
      throwForStatus(r, 'profile lookup');
      if (r.status >= 400) throw new SchedulerUnavailableError(`Profile lookup failed (${r.status}): ${errorText(r.json)}`, 'bad_request');
      const d = r.json?.data ?? {};
      return { username: d.username ?? '', email: d.email ?? '', timeZone: d.timeZone ?? '' };
    },

    async eventTypes(): Promise<EventTypeSummary[]> {
      const r = await call('/v2/event-types', CAL_VERSIONS.eventTypes);
      throwForStatus(r, 'event type list');
      if (r.status >= 400) throw new SchedulerUnavailableError(`Event type list failed (${r.status}): ${errorText(r.json)}`, 'bad_request');
      const rows: any[] = Array.isArray(r.json?.data) ? r.json.data : [];
      return rows.map((e) => ({
        id: e.id,
        slug: e.slug,
        title: e.title,
        lengthInMinutes: e.lengthInMinutes,
        locations: (e.locations ?? []).map((l: any) => [l.type, l.integration].filter(Boolean).join(':')),
        minimumBookingNotice: e.minimumBookingNotice,
        afterEventBuffer: e.afterEventBuffer,
        hidden: e.hidden,
      }));
    },

    async bookingFields(eventTypeId: number): Promise<BookingFieldSummary[]> {
      const r = await call(`/v2/event-types/${eventTypeId}/booking-fields`, CAL_VERSIONS.eventTypes);
      throwForStatus(r, 'booking field list');
      if (r.status >= 400) throw new SchedulerUnavailableError(`Booking field list failed (${r.status}): ${errorText(r.json)}`, 'bad_request');
      const rows: any[] = Array.isArray(r.json?.data?.bookingFields) ? r.json.data.bookingFields : [];
      return rows.map((f) => ({ slug: f.slug ?? f.name ?? '', type: f.type ?? '', label: f.label, required: f.required, custom: f.field === 'custom' }));
    },

    /** Adds any of the connector's questions that the event type does not have yet. Returns the slugs added. */
    async createMissingFields(eventTypeId: number): Promise<string[]> {
      const existing = new Set((await this.bookingFields(eventTypeId)).map((f) => f.slug));
      const missing = expectedFields(config).filter((f) => !existing.has(f.slug));
      if (missing.length === 0) return [];
      const bookingFields = missing.map((f) => ({ field: 'custom', slug: f.slug, label: f.label, type: f.type, required: false }));
      const r = await call(`/v2/event-types/${eventTypeId}/booking-fields`, CAL_VERSIONS.eventTypes, {
        method: 'POST',
        body: JSON.stringify({ bookingFields }),
      });
      throwForStatus(r, 'booking field creation');
      if (r.status >= 400) throw new SchedulerUnavailableError(`Creating booking fields failed (${r.status}): ${errorText(r.json)}`, 'bad_request');
      return missing.map((f) => f.slug);
    },
  };
}

/** Slugs the connector sends that the event type does not define, and required custom fields it never fills. */
export function diffFields(config: Config, actual: BookingFieldSummary[]) {
  const have = new Map(actual.map((f) => [f.slug, f]));
  const expected = expectedFields(config);
  const sent = new Set(expected.map((f) => f.slug));
  return {
    missing: expected.filter((f) => !have.has(f.slug)).map((f) => f.slug),
    requiredButUnfilled: actual.filter((f) => f.custom && f.required && !sent.has(f.slug)).map((f) => f.slug),
  };
}
