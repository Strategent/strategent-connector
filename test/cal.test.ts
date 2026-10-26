import { describe, expect, it, vi } from 'vitest';
import { createCalClient, errorText, fillTemplate } from '../src/cal.js';
import { SchedulerConflictError, SchedulerUnavailableError } from '../src/scheduler.js';
import { testConfig } from './helpers.js';

const DAY = 86_400_000;
const config = testConfig({ RESCHEDULE_URL_TEMPLATE: 'https://cal.com/reschedule/{uid}', CANCEL_URL_TEMPLATE: 'https://cal.com/booking/{uid}?cancel=true' });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

const input = {
  start: new Date('2026-10-27T18:00:00Z'),
  name: 'Dana Patel',
  email: 'dana@harborinn.test',
  timezone: 'America/Chicago',
  source: 'muse',
  fields: { 'business-name': 'Harbor Inn', website: 'Not provided' },
};

const created = (data: Record<string, unknown> = {}) =>
  json(201, { status: 'success', data: { uid: 'bk_abc123', status: 'accepted', location: 'https://meet.google.com/xyz-abcd-efg', ...data } });

describe('availableTimes', () => {
  it('asks /v2/slots for the event type with the pinned version and bearer key', async () => {
    const seen: { url: URL; headers: Record<string, string> }[] = [];
    const client = createCalClient(config, (async (url: string, init: RequestInit) => {
      seen.push({ url: new URL(url), headers: init.headers as Record<string, string> });
      return json(200, { status: 'success', data: {} });
    }) as never);
    await client.availableTimes(new Date(Date.now() + DAY), new Date(Date.now() + 2 * DAY));
    const { url, headers } = seen[0]!;
    expect(url.origin + url.pathname).toBe('https://api.cal.com/v2/slots');
    expect(url.searchParams.get('eventTypeId')).toBe('4242');
    expect(headers['cal-api-version']).toBe('2024-09-04');
    expect(headers.Authorization).toBe('Bearer cal_test_key');
  });

  it('splits 14 days into contiguous windows of at most 7 days, then merges, de-duplicates and sorts', async () => {
    const windows: [number, number][] = [];
    const client = createCalClient(config, (async (url: string) => {
      const u = new URL(url);
      const s = new Date(u.searchParams.get('start')!).getTime();
      const e = new Date(u.searchParams.get('end')!).getTime();
      windows.push([s, e]);
      if (e - s > 7 * DAY) return json(400, { message: 'range too large' });
      const day = new Date(s + 3600_000).toISOString().slice(0, 10);
      // Same boundary slot in every window, as a string and as { start }, to prove de-duplication.
      return json(200, { status: 'success', data: { [day]: [new Date(e - 3600_000).toISOString(), { start: new Date(s + 3600_000).toISOString() }] } });
    }) as never);
    const start = new Date(Date.now() + DAY);
    const times = await client.availableTimes(start, new Date(start.getTime() + 14 * DAY));

    expect(windows.length).toBeGreaterThanOrEqual(2);
    for (const [s, e] of windows) expect(e - s).toBeLessThanOrEqual(7 * DAY);
    for (let i = 1; i < windows.length; i++) expect(windows[i]![0]).toBe(windows[i - 1]![1]);
    expect(times.length).toBeGreaterThan(0);
    expect([...times].sort((a, b) => a.getTime() - b.getTime())).toEqual(times);
    expect(new Set(times.map((t) => t.getTime())).size).toBe(times.length);
  });

  it('reads both slot shapes and offset timestamps', async () => {
    const client = createCalClient(config, (async () =>
      json(200, { status: 'success', data: { '2033-09-05': ['2033-09-05T09:00:00.000+02:00', { start: '2033-09-05T10:00:00.000+02:00' }], '2033-09-06': [] } })) as never);
    const from = new Date('2033-09-04T00:00:00Z');
    const clientNow = vi.spyOn(Date, 'now').mockReturnValue(from.getTime());
    const times = await client.availableTimes(from, new Date('2033-09-07T00:00:00Z'));
    clientNow.mockRestore();
    expect(times.map((t) => t.toISOString())).toEqual(['2033-09-05T07:00:00.000Z', '2033-09-05T08:00:00.000Z']);
  });

  it('never asks for a start time in the past', async () => {
    const starts: string[] = [];
    const client = createCalClient(config, (async (url: string) => {
      starts.push(new URL(url).searchParams.get('start')!);
      return json(200, { status: 'success', data: {} });
    }) as never);
    await client.availableTimes(new Date(Date.now() - DAY), new Date(Date.now() + 2 * DAY));
    expect(new Date(starts[0]!).getTime()).toBeGreaterThan(Date.now());
  });

  it('retries a read once on a server error, then reports kind=server', async () => {
    const fetchMock = vi.fn(async () => json(503, {}));
    await expect(createCalClient(config, fetchMock as never).availableTimes(new Date(), new Date(Date.now() + DAY))).rejects.toMatchObject({ kind: 'server' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate_limit'],
    [400, 'bad_request'],
    [404, 'bad_request'],
  ])('maps HTTP %i to kind=%s', async (status, kind) => {
    const client = createCalClient(config, (async () => json(status, { message: 'x' })) as never);
    await expect(client.availableTimes(new Date(), new Date(Date.now() + DAY))).rejects.toMatchObject({ kind });
  });

  it('maps a network failure to kind=network', async () => {
    const client = createCalClient(config, (async () => {
      throw new Error('ECONNRESET');
    }) as never);
    await expect(client.availableTimes(new Date(), new Date(Date.now() + DAY))).rejects.toBeInstanceOf(SchedulerUnavailableError);
  });
});

describe('createBooking', () => {
  it('posts the documented body with the pinned booking version', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = createCalClient(config, (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return created();
    }) as never);
    const res = await client.createBooking(input);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.cal.com/v2/bookings');
    expect(calls[0]!.init.method).toBe('POST');
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h['cal-api-version']).toBe('2026-02-25');
    expect(h.Authorization).toBe('Bearer cal_test_key');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      start: '2026-10-27T18:00:00.000Z',
      eventTypeId: 4242,
      attendee: { name: 'Dana Patel', email: 'dana@harborinn.test', timeZone: 'America/Chicago', language: 'en' },
      bookingFieldsResponses: { 'business-name': 'Harbor Inn', website: 'Not provided' },
      metadata: { source: 'muse', connector: 'strategent' },
      location: { type: 'integration', integration: 'google-meet' },
    });
    expect(res).toEqual({
      uid: 'bk_abc123',
      meetLink: 'https://meet.google.com/xyz-abcd-efg',
      rescheduleUrl: 'https://cal.com/reschedule/bk_abc123',
      cancelUrl: 'https://cal.com/booking/bk_abc123?cancel=true',
    });
  });

  it('uses the event type default location when CAL_LOCATION is blank', async () => {
    let body: any;
    const client = createCalClient(testConfig({ CAL_LOCATION: '' }), (async (_u: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return created();
    }) as never);
    await client.createBooking(input);
    expect(body).not.toHaveProperty('location');
  });

  it('finds the meeting link in location or the older meetingUrl, and tolerates neither', async () => {
    const link = async (data: Record<string, unknown>) =>
      (await createCalClient(config, (async () => created(data)) as never).createBooking(input)).meetLink;
    expect(await link({ location: 'integrations:google:meet', meetingUrl: 'https://meet.google.com/old' })).toBe('https://meet.google.com/old');
    expect(await link({ location: 'integrations:google:meet' })).toBeNull();
    expect(await link({ location: undefined })).toBeNull();
  });

  it('takes the first booking when Cal.com returns a list', async () => {
    const client = createCalClient(config, (async () => json(201, { status: 'success', data: [{ uid: 'first', status: 'accepted' }, { uid: 'second' }] })) as never);
    expect((await client.createBooking(input)).uid).toBe('first');
  });

  it('rejects a response with no uid or a cancelled booking', async () => {
    await expect(createCalClient(config, (async () => json(201, { status: 'success', data: {} })) as never).createBooking(input)).rejects.toMatchObject({ kind: 'bad_request' });
    await expect(createCalClient(config, (async () => created({ status: 'cancelled' })) as never).createBooking(input)).rejects.toMatchObject({ kind: 'bad_request' });
  });

  it('encodes the uid in the reschedule and cancel links', () => {
    expect(fillTemplate('https://x.test/r/{uid}?a={uid}', 'a b/c')).toBe('https://x.test/r/a%20b%2Fc?a=a%20b%2Fc');
  });

  describe('a taken slot', () => {
    const slotsBody = (present: boolean) => json(200, { status: 'success', data: present ? { '2026-10-27': [input.start.toISOString()] } : {} });

    it('is a conflict on HTTP 409', async () => {
      const client = createCalClient(config, (async () => json(409, {})) as never);
      await expect(client.createBooking(input)).rejects.toBeInstanceOf(SchedulerConflictError);
    });

    it('is a conflict when the error message says so', async () => {
      const client = createCalClient(config, (async () => json(400, { status: 'error', error: { message: 'User either already has booking at this time or is not available' } })) as never);
      await expect(client.createBooking(input)).rejects.toBeInstanceOf(SchedulerConflictError);
    });

    it('is a conflict when the error is undocumented but the slot has vanished from availability', async () => {
      const client = createCalClient(config, (async (url: string) => (url.includes('/v2/slots') ? slotsBody(false) : json(400, { message: 'Something unexpected' }))) as never);
      await expect(client.createBooking(input)).rejects.toBeInstanceOf(SchedulerConflictError);
    });

    it('is a request problem, not a conflict, when the slot is still open', async () => {
      const client = createCalClient(config, (async (url: string) => (url.includes('/v2/slots') ? slotsBody(true) : json(400, { message: 'bookingFieldsResponses: website is required' }))) as never);
      await expect(client.createBooking(input)).rejects.toMatchObject({ kind: 'bad_request', message: expect.stringContaining('website is required') });
    });

    it('is a request problem when availability cannot be checked either', async () => {
      const client = createCalClient(config, (async (url: string) => (url.includes('/v2/slots') ? json(500, {}) : json(400, { message: 'odd' }))) as never);
      await expect(client.createBooking(input)).rejects.toMatchObject({ kind: 'bad_request' });
    });
  });

  it('never retries a failed write, and classifies auth, rate limit and server errors', async () => {
    for (const [status, kind] of [[401, 'auth'], [403, 'auth'], [429, 'rate_limit'], [500, 'server']] as const) {
      const fetchMock = vi.fn(async () => json(status, {}));
      await expect(createCalClient(config, fetchMock as never).createBooking(input)).rejects.toMatchObject({ kind });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('treats a network failure during booking as unavailable, without retrying', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('timeout');
    });
    await expect(createCalClient(config, fetchMock as never).createBooking(input)).rejects.toMatchObject({ kind: 'network' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats status:"error" in a 2xx body as a failure', async () => {
    const client = createCalClient(config, (async (url: string) => (url.includes('/v2/slots') ? json(200, { data: { d: [input.start.toISOString()] } }) : json(200, { status: 'error', message: 'nope' }))) as never);
    await expect(client.createBooking(input)).rejects.toMatchObject({ kind: 'bad_request' });
  });
});

describe('errorText', () => {
  it('reads the common error shapes', () => {
    expect(errorText({ error: { message: 'a' } })).toBe('a');
    expect(errorText({ message: 'b' })).toBe('b');
    expect(errorText({ error: 'c' })).toBe('c');
    expect(errorText({ weird: true })).toBe('{"weird":true}');
    expect(errorText(undefined)).toBe('{}');
  });
});
