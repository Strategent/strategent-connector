import { describe, expect, it, vi } from 'vitest';
import { monthsAgo } from '../src/retention.js';
import { SupabaseStore } from '../src/store.js';
import { makeHarness, NOW, testConfig } from './helpers.js';

const SECRET = 'cron-secret-for-tests';
const auth = { Authorization: `Bearer ${SECRET}` };
const call = (h: ReturnType<typeof makeHarness>, headers: Record<string, string> = auth) => h.app.request('/cron/retention', { headers });

const base = {
  owner_sub: 'g', type: 'written' as const, status: 'requested' as const, name: 'D', email: 'd@x.test', phone: null, business_name: 'B',
  website: null, city: null, region: 'other', industry: null, pain_point: null, channel_interest: null, slot_start: null,
  timezone: null, meet_link: null, reschedule_url: null, cancel_url: null, booking_uid: null, source: 'muse',
};

describe('monthsAgo', () => {
  it.each([
    ['2026-10-27T03:17:00Z', 12, '2025-10-27T03:17:00.000Z'],
    ['2026-01-15T00:00:00Z', 2, '2025-11-15T00:00:00.000Z'],
    ['2026-03-31T00:00:00Z', 1, '2026-02-28T00:00:00.000Z'],
    ['2024-02-29T00:00:00Z', 12, '2023-02-28T00:00:00.000Z'],
  ])('%s minus %i months', (from, n, want) => {
    expect(monthsAgo(new Date(from), n).toISOString()).toBe(want);
  });
});

describe('GET /cron/retention', () => {
  it('is off until CRON_SECRET is set, and rejects a missing or wrong secret', async () => {
    expect((await call(makeHarness())).status).toBe(503);
    const h = makeHarness({ config: { CRON_SECRET: SECRET } });
    expect((await call(h, {})).status).toBe(401);
    expect((await call(h, { Authorization: 'Bearer nope' })).status).toBe(401);
    expect((await call(h, { Authorization: SECRET.slice(0, -1) })).status).toBe(401);
  });

  it('deletes requests and logs older than 12 months and keeps everything newer', async () => {
    const h = makeHarness({ config: { CRON_SECRET: SECRET } });
    const at = async (iso: string, run: () => Promise<unknown>) => {
      h.clock.now = new Date(iso);
      await run();
    };
    await at('2025-09-01T00:00:00Z', async () => {
      await h.store.insertRequest({ ...base, email: 'old@x.test' });
      await h.store.log({ tool: 'old', client_id: null, inputs: {}, outcome: 'ok', latency_ms: 1 });
    });
    // Created just inside 12 months: cutoff on NOW (2026-10-26) is 2025-10-26.
    await at('2025-10-27T00:00:00Z', async () => {
      await h.store.insertRequest({ ...base, email: 'edge@x.test' });
      await h.store.log({ tool: 'edge', client_id: null, inputs: {}, outcome: 'ok', latency_ms: 1 });
    });
    await at('2026-10-01T00:00:00Z', async () => {
      await h.store.insertRequest({ ...base, email: 'new@x.test' });
      await h.store.log({ tool: 'new', client_id: null, inputs: {}, outcome: 'ok', latency_ms: 1 });
    });
    h.clock.now = NOW;

    const res = await call(h);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.deleted).toEqual({ audit_requests: 1, tool_logs: 1, oauth_used_ids: 0 });
    expect(body.requests_before).toBe('2025-10-26T20:00:00.000Z');
    expect(h.store.rows.map((r) => r.email)).toEqual(['edge@x.test', 'new@x.test']);
    expect(h.store.logs.map((l) => l.tool)).toEqual(['edge', 'new']);
    expect(JSON.stringify(body)).not.toContain('@');

    // Running again is harmless.
    expect(((await (await call(h)).json()) as any).deleted).toEqual({ audit_requests: 0, tool_logs: 0, oauth_used_ids: 0 });
  });

  it('keeps an old request whose call is still in the future', async () => {
    const h = makeHarness({ config: { CRON_SECRET: SECRET } });
    h.clock.now = new Date('2025-01-01T00:00:00Z');
    await h.store.insertRequest({ ...base, type: 'call', status: 'booked', email: 'future@x.test', slot_start: '2026-11-02T18:00:00.000Z' });
    h.clock.now = NOW;
    expect(((await (await call(h)).json()) as any).deleted.audit_requests).toBe(0);
    expect(h.store.rows).toHaveLength(1);
  });

  it('removes expired OAuth code ids only', async () => {
    const h = makeHarness({ config: { CRON_SECRET: SECRET } });
    await h.store.claimOnce('expired', 60);
    await h.store.claimOnce('live', 3600 * 24);
    h.clock.now = new Date(NOW.getTime() + 3600 * 1000);
    expect(((await (await call(h)).json()) as any).deleted.oauth_used_ids).toBe(1);
    expect(await h.store.claimOnce('live', 60)).toBe(false);
  });

  it('emails the team and returns 500 when the purge fails', async () => {
    const h = makeHarness({ config: { CRON_SECRET: SECRET } });
    h.store.purge = async () => {
      throw new Error('boom');
    };
    const res = await call(h);
    expect(res.status).toBe(500);
    expect(h.notifier.emails.at(-1)?.subject).toBe('Retention cleanup failed');
  });
});

describe('SupabaseStore.purge', () => {
  function store(handler: (url: URL) => Response) {
    const calls: { url: URL; init: RequestInit }[] = [];
    const fetchMock = vi.fn(async (u: string, init: RequestInit) => {
      const url = new URL(u);
      calls.push({ url, init });
      return handler(url);
    });
    return { s: new SupabaseStore(testConfig(), fetchMock as never), calls };
  }
  const cutoffs = { requestsBefore: new Date('2025-10-26T20:00:00Z'), logsBefore: new Date('2025-10-26T20:00:00Z'), now: NOW };

  it('sends one date-filtered DELETE per table and counts the returned ids', async () => {
    const { s, calls } = store((url) => Response.json(url.pathname.endsWith('audit_requests') ? [{ id: 'a' }, { id: 'b' }] : url.pathname.endsWith('tool_logs') ? [{ id: 1 }] : []));
    expect(await s.purge(cutoffs)).toEqual({ audit_requests: 2, tool_logs: 1, oauth_used_ids: 0 });
    expect(calls.map((c) => [c.init.method, c.url.pathname])).toEqual([
      ['DELETE', '/rest/v1/audit_requests'],
      ['DELETE', '/rest/v1/tool_logs'],
      ['DELETE', '/rest/v1/oauth_used_ids'],
    ]);
    const [req, logs, ids] = calls.map((c) => c.url.searchParams);
    expect(req!.get('created_at')).toBe('lt.2025-10-26T20:00:00.000Z');
    expect(req!.get('or')).toBe('(slot_start.is.null,slot_start.lt.2026-10-26T20:00:00.000Z)');
    expect(logs!.get('created_at')).toBe('lt.2025-10-26T20:00:00.000Z');
    expect(ids!.get('expires_at')).toBe('lt.2026-10-26T20:00:00.000Z');
    for (const c of calls) {
      expect(c.url.searchParams.get('select')).toBe('id');
      expect((c.init.headers as Record<string, string>).Authorization).toBe('Bearer k');
    }
  });

  it('still cleans the other tables when one fails, then reports the failure', async () => {
    const { s, calls } = store((url) => (url.pathname.endsWith('tool_logs') ? new Response('{}', { status: 500 }) : Response.json([])));
    await expect(s.purge(cutoffs)).rejects.toThrow(/tool_logs failed \(500\)/);
    expect(calls).toHaveLength(3);
  });

  it('refuses an invalid cutoff instead of sending an unfiltered delete', async () => {
    const { s, calls } = store(() => Response.json([]));
    await expect(s.purge({ ...cutoffs, requestsBefore: new Date('nope') })).rejects.toThrow(/not a valid date/);
    expect(calls).toHaveLength(0);
  });
});
