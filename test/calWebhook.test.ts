import { describe, expect, it } from 'vitest';
import { calSignature } from '../src/calWebhook.js';
import { MemoryStore, type AuditRequest } from '../src/store.js';
import { callTool, makeHarness, signIn, type Harness } from './helpers.js';

const SECRET = 'webhook-secret-webhook-secret-1234';
const OLD = 'oldUid1234567890';
const NEW = 'newUid1234567890';
const SLOT_OLD = '2026-10-29T17:00:00.000Z'; // Thu 10:00 AM Pacific
const SLOT_NEW = '2026-10-27T22:30:00.000Z'; // Tue 3:30 PM Pacific

const lead = (over: Partial<Omit<AuditRequest, 'id' | 'created_at'>> = {}): Omit<AuditRequest, 'id' | 'created_at'> => ({
  owner_sub: 'guest_a',
  type: 'call',
  status: 'booked',
  name: 'Dana Patel',
  email: 'dana@harborinn.test',
  phone: null,
  business_name: 'Harbor Inn',
  website: null,
  city: 'Redondo Beach',
  region: 'south_bay',
  industry: 'hospitality',
  pain_point: null,
  channel_interest: 'calls',
  slot_start: SLOT_OLD,
  timezone: 'America/Los_Angeles',
  meet_link: 'https://meet.google.com/old-link',
  reschedule_url: `https://cal.example/reschedule/${OLD}`,
  cancel_url: `https://cal.example/booking/${OLD}?cancel=true`,
  booking_uid: OLD,
  source: 'muse',
  ...over,
});

const rescheduleEvent = (over: Record<string, unknown> = {}) => ({
  triggerEvent: 'BOOKING_RESCHEDULED',
  createdAt: '2026-10-27T18:28:50.000Z',
  payload: { uid: NEW, rescheduleUid: OLD, startTime: SLOT_NEW, endTime: '2026-10-27T23:00:00Z', metadata: { videoCallUrl: 'https://meet.google.com/new-link' }, ...over },
});

const cancelEvent = (over: Record<string, unknown> = {}) => ({
  triggerEvent: 'BOOKING_CANCELLED',
  createdAt: '2026-10-27T19:00:00.000Z',
  payload: { uid: OLD, startTime: SLOT_OLD, cancellationReason: 'Something came up', status: 'CANCELLED', ...over },
});

function harness(secret = SECRET) {
  return makeHarness({ config: secret ? { CAL_WEBHOOK_SECRET: secret } : {} });
}

async function post(h: Harness, event: unknown, opts: { secret?: string; raw?: string; signature?: string | null } = {}) {
  const raw = opts.raw ?? JSON.stringify(event);
  const sig = opts.signature === undefined ? await calSignature(opts.secret ?? SECRET, raw) : opts.signature;
  return h.app.request('/webhooks/cal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(sig ? { 'x-cal-signature-256': sig } : {}) },
    body: raw,
  });
}

describe('Cal.com webhook', () => {
  describe('authentication', () => {
    it('is off (503) when no secret is configured', async () => {
      const h = harness('');
      expect((await post(h, rescheduleEvent())).status).toBe(503);
    });

    it('rejects a missing signature, a wrong secret and a tampered body, changing nothing', async () => {
      const h = harness();
      const row = await h.store.insertRequest(lead());
      const event = rescheduleEvent();
      expect((await post(h, event, { signature: null })).status).toBe(401);
      expect((await post(h, event, { secret: 'a-different-secret-a-different-secret' })).status).toBe(401);
      const good = await calSignature(SECRET, JSON.stringify(event));
      expect((await post(h, event, { raw: JSON.stringify(event) + ' ', signature: good })).status).toBe(401);
      expect(h.store.rows[0]).toMatchObject({ id: row.id, booking_uid: OLD, slot_start: SLOT_OLD });
      expect(h.notifier.emails).toHaveLength(0);
    });

    it('accepts the signature with or without a sha256= prefix and in any case', async () => {
      const h = harness();
      await h.store.insertRequest(lead());
      const raw = JSON.stringify({ triggerEvent: 'PING', payload: {} });
      const sig = await calSignature(SECRET, raw);
      expect((await post(h, null, { raw, signature: `sha256=${sig.toUpperCase()}` })).status).toBe(200);
    });

    it('rejects invalid JSON that is correctly signed', async () => {
      const h = harness();
      expect((await post(h, null, { raw: 'not json' })).status).toBe(400);
    });
  });

  describe('BOOKING_RESCHEDULED', () => {
    it('moves the request to the new booking and alerts the team with the old and new time', async () => {
      const h = harness();
      await h.store.insertRequest(lead());
      const res = await post(h, rescheduleEvent());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, outcome: 'rescheduled' });

      expect(h.store.rows[0]).toMatchObject({
        booking_uid: NEW,
        slot_start: SLOT_NEW,
        status: 'booked',
        meet_link: 'https://meet.google.com/new-link',
        reschedule_url: `https://cal.example/reschedule/${NEW}`,
        cancel_url: `https://cal.example/booking/${NEW}?cancel=true`,
      });
      expect(h.notifier.emails).toHaveLength(1);
      expect(h.notifier.emails[0]!.subject).toBe('Audit rescheduled: Harbor Inn (south_bay)');
      expect(h.notifier.emails[0]!.text).toContain('Was: Thursday, October 29 at 10:00 AM PDT');
      expect(h.notifier.emails[0]!.text).toContain('Now: Tuesday, October 27 at 3:30 PM PDT');
      expect(h.notifier.slackMessages[0]).toMatch(/^Audit rescheduled · south_bay · Harbor Inn · was .* · now .* · dana@harborinn\.test · via muse$/);
    });

    it('keeps the old Meet link when the payload carries none', async () => {
      const h = harness();
      await h.store.insertRequest(lead());
      await post(h, rescheduleEvent({ metadata: {} }));
      expect(h.store.rows[0]!.meet_link).toBe('https://meet.google.com/old-link');
    });

    it('is idempotent: a redelivery does not alert twice', async () => {
      const h = harness();
      await h.store.insertRequest(lead());
      await post(h, rescheduleEvent());
      const again = await post(h, rescheduleEvent());
      expect(await again.json()).toEqual({ ok: true, outcome: 'already_applied' });
      expect(h.notifier.emails).toHaveLength(1);
      expect(h.store.rows[0]!.booking_uid).toBe(NEW);
    });

    it('ignores a booking we did not create (for example one made on the Cal.com page)', async () => {
      const h = harness();
      await h.store.insertRequest(lead({ booking_uid: 'someoneElse12345' }));
      const res = await post(h, rescheduleEvent());
      expect(await res.json()).toEqual({ ok: true, outcome: 'unknown_booking' });
      expect(h.store.rows[0]!.booking_uid).toBe('someoneElse12345');
      expect(h.notifier.emails).toHaveLength(0);
    });

    it('rejects a payload with no new uid or no start time', async () => {
      const h = harness();
      await h.store.insertRequest(lead());
      expect((await post(h, rescheduleEvent({ uid: '' }))).status).toBe(400);
      expect((await post(h, rescheduleEvent({ startTime: 'tomorrow-ish' }))).status).toBe(400);
      expect(h.store.rows[0]!.booking_uid).toBe(OLD);
    });
  });

  describe('BOOKING_CANCELLED', () => {
    it('marks the call cancelled, frees the person to book again, and alerts the team with the reason', async () => {
      const h = harness();
      await h.store.insertRequest(lead());
      const res = await post(h, cancelEvent());
      expect(await res.json()).toEqual({ ok: true, outcome: 'cancelled' });
      expect(h.store.rows[0]!.status).toBe('cancelled');
      expect(await h.store.findActiveCall('dana@harborinn.test', new Date('2026-10-26T20:00:00Z'))).toBeNull();
      expect(h.notifier.emails[0]!.subject).toBe('Audit cancelled: Harbor Inn (south_bay)');
      expect(h.notifier.emails[0]!.text).toContain('Reason: Something came up');
      expect(h.notifier.slackMessages[0]).toContain('"Something came up"');
    });

    it('is idempotent and ignores unknown bookings and written audits', async () => {
      const h = harness();
      await h.store.insertRequest(lead());
      await h.store.insertRequest(lead({ type: 'written', status: 'requested', booking_uid: null, slot_start: null, email: 'w@x.test' }));
      await post(h, cancelEvent());
      expect(await (await post(h, cancelEvent())).json()).toEqual({ ok: true, outcome: 'already_applied' });
      expect(await (await post(h, cancelEvent({ uid: 'neverHeardOf12345' }))).json()).toEqual({ ok: true, outcome: 'unknown_booking' });
      expect(h.notifier.emails).toHaveLength(1);
    });

    it('lets a reschedule that arrives after a cancel of the old booking restore the request', async () => {
      const h = harness();
      await h.store.insertRequest(lead());
      await post(h, cancelEvent());
      expect(h.store.rows[0]!.status).toBe('cancelled');
      await post(h, rescheduleEvent());
      expect(h.store.rows[0]).toMatchObject({ status: 'booked', booking_uid: NEW, slot_start: SLOT_NEW });
    });
  });

  it('ignores other triggers such as PING', async () => {
    const h = harness();
    const res = await post(h, { triggerEvent: 'PING', payload: {} });
    expect(await res.json()).toEqual({ ok: true, outcome: 'ignored' });
  });

  it('answers 500 and emails the team when the change cannot be saved', async () => {
    const h = harness();
    await h.store.insertRequest(lead());
    h.store.updateRequest = async () => {
      throw new Error('Supabase update failed (500)');
    };
    const res = await post(h, rescheduleEvent());
    expect(res.status).toBe(500);
    expect(h.notifier.emails).toHaveLength(1);
    expect(h.notifier.emails[0]!.subject).toBe('Cal.com change not synced');
    expect(h.notifier.emails[0]!.text).toContain('Supabase update failed (500)');
  });

  it('reports a clash with another booked call as a sync failure instead of corrupting data', async () => {
    const h = harness();
    await h.store.insertRequest(lead());
    await h.store.insertRequest(lead({ booking_uid: 'otherBooking12345', slot_start: SLOT_NEW }));
    const res = await post(h, rescheduleEvent());
    expect(res.status).toBe(500);
    expect(h.store.rows[0]).toMatchObject({ booking_uid: OLD, slot_start: SLOT_OLD });
  });

  it('shows a cancelled call as cancelled in get_audit_request_status', async () => {
    const h = harness();
    const { access_token } = await signIn(h);
    const check = await callTool(h, access_token, 'check_audit_availability', { timezone: 'America/Los_Angeles' });
    const slot = /slot_token: (\S+)/.exec(check.text)![1]!;
    const booked = await callTool(h, access_token, 'book_audit_call', { slot_token: slot, name: 'Dana Patel', email: 'dana@harborinn.test', business_name: 'Harbor Inn' });
    expect(booked.isError).toBe(false);
    // The fake scheduler's uids are shorter than real Cal.com uids (about 22 characters), so give the row a realistic one.
    const uid = 'realisticBookingUid22';
    await h.store.updateRequest(h.store.rows[0]!.id, { booking_uid: uid });

    await post(h, cancelEvent({ uid }));
    const status = await callTool(h, access_token, 'get_audit_request_status', { email: 'dana@harborinn.test' });
    expect(status.text).toMatch(/cancelled/);
    expect(status.text).not.toMatch(/booked for/);
  });

  it('MemoryStore finds by booking uid and applies patches', async () => {
    const store = new MemoryStore();
    const row = await store.insertRequest(lead());
    expect((await store.findByBookingUid(OLD))?.id).toBe(row.id);
    expect(await store.findByBookingUid('nope')).toBeNull();
    expect((await store.updateRequest(row.id, { status: 'cancelled' }))?.status).toBe('cancelled');
    expect(await store.updateRequest('missing', { status: 'cancelled' })).toBeNull();
  });
});
