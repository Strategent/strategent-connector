import { describe, expect, it, vi } from 'vitest';
import { SupabaseStore } from '../src/store.js';
import { testConfig } from './helpers.js';

const config = testConfig();
const row = {
  owner_sub: 'guest_1', type: 'call' as const, status: 'booked' as const, name: 'D', email: 'd@x.test', phone: null, business_name: 'B',
  website: null, city: null, region: 'other', industry: 'other', pain_point: null, channel_interest: 'all', slot_start: '2026-10-27T18:00:00.000Z',
  timezone: 'America/Los_Angeles', meet_link: null, reschedule_url: null, cancel_url: null, booking_uid: null, source: 'muse',
};

function store(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: new URL(url), init });
    return handler(url, init);
  });
  return { s: new SupabaseStore(config, fetchMock as never), calls };
}

describe('SupabaseStore', () => {
  it('authenticates with the service key and inserts, returning the stored row', async () => {
    const { s, calls } = store(() => Response.json([{ ...row, id: 'abc', created_at: '2026-10-26T20:00:00Z' }], { status: 201 }));
    const saved = await s.insertRequest(row);
    expect(saved.id).toBe('abc');
    const { url, init } = calls[0]!;
    expect(url.pathname).toBe('/rest/v1/audit_requests');
    expect((init.headers as Record<string, string>).apikey).toBe('k');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k');
    expect((init.headers as Record<string, string>).Prefer).toBe('return=representation');
  });

  it('turns a failed insert into an error so the caller can alert', async () => {
    const { s } = store(() => new Response('{}', { status: 500 }));
    await expect(s.insertRequest(row)).rejects.toThrow(/insert failed/);
  });

  it('looks up the active call case-insensitively and escapes wildcards in the email', async () => {
    const { s, calls } = store(() => Response.json([]));
    await s.findActiveCall('Dana_%@X.test', new Date('2026-10-26T20:00:00Z'));
    const q = calls[0]!.url.searchParams;
    expect(q.get('email')).toBe('ilike.Dana\\_\\%@X.test');
    expect(q.get('type')).toBe('eq.call');
    expect(q.get('status')).toBe('eq.booked');
    expect(q.get('slot_start')).toBe('gt.2026-10-26T20:00:00.000Z');
  });

  it('scopes status lookups to the owner', async () => {
    const { s, calls } = store(() => Response.json([]));
    await s.findByOwner('d@x.test', 'guest_9');
    expect(calls[0]!.url.searchParams.get('owner_sub')).toBe('eq.guest_9');
  });

  it('reads counts from the Content-Range header', async () => {
    const { s, calls } = store(() => new Response(null, { status: 200, headers: { 'content-range': '0-0/7' } }));
    expect(await s.countCreatedSince(new Date('2026-10-26T19:00:00Z'))).toBe(7);
    expect(calls[0]!.init.method).toBe('HEAD');
    expect((calls[0]!.init.headers as Record<string, string>).Prefer).toBe('count=exact');
    expect(await s.countOpenWritten()).toBe(7);
  });

  it('claims an id once: 201 first time, 409 afterwards, and fails closed on other errors', async () => {
    expect(await store(() => new Response(null, { status: 201 })).s.claimOnce('code:1', 600)).toBe(true);
    expect(await store(() => new Response('{}', { status: 409 })).s.claimOnce('code:1', 600)).toBe(false);
    await expect(store(() => new Response('{}', { status: 500 })).s.claimOnce('code:1', 600)).rejects.toThrow();
  });
});
