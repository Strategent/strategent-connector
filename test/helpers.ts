import { createApp } from '../src/app.js';
import { SchedulerConflictError, SchedulerUnavailableError, type BookingInput, type BookingResult, type SchedulerApi } from '../src/scheduler.js';
import { loadConfig, type Config } from '../src/config.js';
import { sha256b64url } from '../src/crypto.js';
import { MemoryNotifier } from '../src/notify.js';
import { MemoryStore } from '../src/store.js';
import { zonedToUtc } from '../src/time.js';

export const NOW = new Date('2026-10-26T20:00:00Z'); // Monday 1:00 PM Pacific

export function testConfig(over: Record<string, string> = {}): Config {
  return loadConfig({
    PUBLIC_BASE_URL: 'https://connect.example.test',
    SIGNING_SECRET: 'test-secret-test-secret-test-secret-123',
    CAL_API_KEY: 'cal_test_key',
    CAL_EVENT_TYPE_ID: '4242',
    BOOKING_PAGE_URL: 'https://cal.com/strategent/audit',
    RESCHEDULE_URL_TEMPLATE: 'https://cal.example/reschedule/{uid}',
    CANCEL_URL_TEMPLATE: 'https://cal.example/booking/{uid}?cancel=true',
    SUPABASE_URL: 'https://x.supabase.test',
    SUPABASE_SERVICE_KEY: 'k',
    ...over,
  });
}

/** Pacific office hours: Mon, Tue, Thu, Fri, 10:00 to 15:30, every 30 minutes, for 30 days. */
export function officeSlots(from: Date = NOW): Date[] {
  const out: Date[] = [];
  for (let d = 0; d < 30; d++) {
    const day = new Date(from.getTime() + d * 86_400_000);
    const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(day).split('-').map(Number) as [number, number, number];
    const dow = new Date(Date.UTC(ymd[0], ymd[1] - 1, ymd[2])).getUTCDay();
    if (dow === 0 || dow === 6 || dow === 3) continue;
    for (let h = 10; h < 16; h++) {
      for (const m of [0, 30]) out.push(zonedToUtc(ymd[0], ymd[1], ymd[2], h, m, 'America/Los_Angeles'));
    }
  }
  return out.filter((s) => s.getTime() > from.getTime() + 4 * 3_600_000); // 4 hour minimum notice
}

export class FakeScheduler implements SchedulerApi {
  slots = officeSlots();
  taken = new Set<number>();
  down: SchedulerUnavailableError | null = null;
  bookings: BookingInput[] = [];
  availabilityCalls: [Date, Date][] = [];
  /** Called just before a booking is processed, to simulate a race. */
  beforeBook?: (input: BookingInput) => void;

  async availableTimes(start: Date, end: Date): Promise<Date[]> {
    this.availabilityCalls.push([start, end]);
    if (this.down) throw this.down;
    return this.slots.filter((s) => s >= start && s < end && !this.taken.has(s.getTime()));
  }

  async createBooking(input: BookingInput): Promise<BookingResult> {
    this.beforeBook?.(input);
    if (this.down) throw this.down;
    if (this.taken.has(input.start.getTime()) || !this.slots.some((s) => s.getTime() === input.start.getTime())) {
      throw new SchedulerConflictError('taken');
    }
    this.taken.add(input.start.getTime());
    this.bookings.push(input);
    const n = this.bookings.length;
    return {
      uid: `bk${n}`,
      rescheduleUrl: `https://cal.example/reschedule/bk${n}`,
      cancelUrl: `https://cal.example/booking/bk${n}?cancel=true`,
      meetLink: `https://meet.google.com/abc-defg-h${n}`,
    };
  }
}

export interface Harness {
  app: ReturnType<typeof createApp>;
  scheduler: FakeScheduler;
  store: MemoryStore;
  notifier: MemoryNotifier;
  config: Config;
  clock: { now: Date };
}

export function makeHarness(opts: { scheduler?: FakeScheduler; config?: Record<string, string> } = {}): Harness {
  const clock = { now: NOW };
  const config = testConfig(opts.config);
  const scheduler = opts.scheduler ?? new FakeScheduler();
  const store = new MemoryStore(() => clock.now);
  const notifier = new MemoryNotifier();
  const app = createApp({ config, scheduler, store, notifier, now: () => clock.now });
  return { app, scheduler, store, notifier, config, clock };
}

const REDIRECT = 'https://muse.example.test/callback';

/** Runs the full OAuth flow (registration, consent, token) and returns the tokens. */
export async function signIn(h: Harness, clientName = 'Meta Muse') {
  const reg = await h.app.request('/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: clientName, redirect_uris: [REDIRECT] }),
  });
  const client = (await reg.json()) as { client_id: string };

  const verifier = 'v'.repeat(64);
  const challenge = await sha256b64url(verifier);
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
  });
  const page = await h.app.request(`/oauth/authorize?${q}`);
  const html = await page.text();
  const authreq = /name="authreq" value="([^"]+)"/.exec(html)?.[1] ?? '';

  const consent = await h.app.request('/oauth/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ authreq }),
  });
  const loc = new URL(consent.headers.get('location') ?? 'https://invalid.test');
  const code = loc.searchParams.get('code') ?? '';

  const tokenRes = await h.app.request('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier }),
  });
  const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string };
  return { ...tokens, clientId: client.client_id, code, verifier, redirect: REDIRECT, state: loc.searchParams.get('state') };
}

let rpcId = 1;

export async function rpc(h: Harness, accessToken: string | null, method: string, params: unknown) {
  const res = await h.app.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
  });
  return res;
}

export interface CallOutcome {
  text: string;
  isError: boolean;
}

export async function callTool(h: Harness, accessToken: string, name: string, args: Record<string, unknown> = {}): Promise<CallOutcome> {
  const res = await rpc(h, accessToken, 'tools/call', { name, arguments: args });
  const json = (await res.json()) as any;
  if (json.error) throw new Error(`rpc error: ${JSON.stringify(json.error)}`);
  return { text: json.result.content[0].text as string, isError: Boolean(json.result.isError) };
}

export function tokensFrom(text: string): string[] {
  return [...text.matchAll(/slot_token: (\S+)/g)].map((m) => m[1]!);
}

export const GOOD = {
  name: 'Dana Patel',
  email: 'dana@harborinn.test',
  business_name: 'Harbor Inn',
  website: 'harborinn.test',
  city: 'Redondo Beach',
  industry: 'hospitality',
  pain_point: 'Missed calls after 6pm',
  channel_interest: 'calls',
};
