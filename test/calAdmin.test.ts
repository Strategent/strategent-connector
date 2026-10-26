import { describe, expect, it, vi } from 'vitest';
import { createCalAdmin, diffFields, expectedFields } from '../src/calAdmin.js';
import { testConfig } from './helpers.js';

const config = testConfig();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('cal admin', () => {
  it('reads the profile', async () => {
    const admin = createCalAdmin(config, (async () => json(200, { status: 'success', data: { username: 'ruchi', email: 'r@x.test', timeZone: 'America/Los_Angeles' } })) as never);
    expect(await admin.me()).toEqual({ username: 'ruchi', email: 'r@x.test', timeZone: 'America/Los_Angeles' });
  });

  it('lists event types with a readable location, using the event types API version', async () => {
    const fetchMock = vi.fn(async () =>
      json(200, { status: 'success', data: [{ id: 4242, slug: 'audit', title: 'AI Readiness Audit', lengthInMinutes: 30, locations: [{ type: 'integration', integration: 'google-meet' }, { type: 'phone' }], minimumBookingNotice: 240, afterEventBuffer: 15, hidden: false }] }),
    );
    const types = await createCalAdmin(config, fetchMock as never).eventTypes();
    expect(types).toEqual([{ id: 4242, slug: 'audit', title: 'AI Readiness Audit', lengthInMinutes: 30, locations: ['integration:google-meet', 'phone'], minimumBookingNotice: 240, afterEventBuffer: 15, hidden: false }]);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)['cal-api-version']).toBe('2026-06-12');
  });

  it('reports a rejected key clearly', async () => {
    const admin = createCalAdmin(config, (async () => json(401, {})) as never);
    await expect(admin.eventTypes()).rejects.toMatchObject({ kind: 'auth' });
  });

  const systemFields = [
    { field: 'system', slug: 'name', type: 'name', required: true },
    { field: 'system', slug: 'email', type: 'email', required: true },
  ];
  const fieldsResponse = (extra: unknown[]) => json(200, { status: 'success', data: { bookingFields: [...systemFields, ...extra] } });

  it('lists booking fields and tells custom from built-in', async () => {
    const admin = createCalAdmin(config, (async () => fieldsResponse([{ field: 'custom', slug: 'city', type: 'shortText', label: 'City', required: false }])) as never);
    const fields = await admin.bookingFields(4242);
    expect(fields.find((f) => f.slug === 'city')).toMatchObject({ custom: true, type: 'shortText' });
    expect(fields.find((f) => f.slug === 'email')).toMatchObject({ custom: false });
  });

  it('creates only the missing questions, all optional, in the documented shape', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const admin = createCalAdmin(config, (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (init.method === 'POST') return json(200, { status: 'success', data: {} });
      return fieldsResponse([{ field: 'custom', slug: 'city', type: 'shortText', required: false }, { field: 'custom', slug: 'website', type: 'shortText', required: false }]);
    }) as never);
    const added = await admin.createMissingFields(4242);

    expect(added).toEqual(['business-name', 'industry', 'pain-point', 'phone', 'channel-interest']);
    const post = calls.find((c) => c.init.method === 'POST')!;
    expect(post.url).toBe('https://api.cal.com/v2/event-types/4242/booking-fields');
    expect((post.init.headers as Record<string, string>)['cal-api-version']).toBe('2026-06-12');
    const body = JSON.parse(post.init.body as string);
    expect(body.bookingFields).toHaveLength(5);
    for (const f of body.bookingFields) expect(f).toMatchObject({ field: 'custom', required: false });
    expect(body.bookingFields.find((f: any) => f.slug === 'pain-point')).toMatchObject({ type: 'longText', label: 'What is taking the most time right now?' });
    expect(body.bookingFields.find((f: any) => f.slug === 'industry').type).toBe('shortText');
  });

  it('does nothing when every question already exists', async () => {
    const all = expectedFields(config).map((f) => ({ field: 'custom', slug: f.slug, type: f.type, required: false }));
    const fetchMock = vi.fn(async () => fieldsResponse(all));
    expect(await createCalAdmin(config, fetchMock as never).createMissingFields(4242)).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed creation', async () => {
    const admin = createCalAdmin(config, (async (_u: string, init: RequestInit = {}) => (init.method === 'POST' ? json(400, { message: 'invalid slug' }) : fieldsResponse([]))) as never);
    await expect(admin.createMissingFields(4242)).rejects.toMatchObject({ kind: 'bad_request', message: expect.stringContaining('invalid slug') });
  });
});

describe('diffFields', () => {
  it('flags missing questions and required custom questions the connector would leave blank', () => {
    const d = diffFields(config, [
      { slug: 'city', type: 'shortText', custom: true, required: false },
      { slug: 'budget', type: 'shortText', custom: true, required: true },
      { slug: 'notes', type: 'notes', custom: false, required: false },
    ]);
    expect(d.missing).toEqual(['business-name', 'website', 'industry', 'pain-point', 'phone', 'channel-interest']);
    expect(d.requiredButUnfilled).toEqual(['budget']);
  });
});
