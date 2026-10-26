import { describe, expect, it } from 'vitest';
import { SchedulerUnavailableError } from '../src/scheduler.js';
import { TOOL_DESCRIPTIONS } from '../src/copy.js';
import { verifySlot } from '../src/token.js';
import { GOOD, NOW, callTool, makeHarness, rpc, signIn, tokensFrom, type Harness } from './helpers.js';

async function setup(opts?: Parameters<typeof makeHarness>[0]) {
  const h = makeHarness(opts);
  const t = await signIn(h);
  const call = (name: string, args: Record<string, unknown> = {}) => callTool(h, t.access_token, name, args);
  return { h, t, call };
}

async function firstSlots(call: (n: string, a?: Record<string, unknown>) => ReturnType<typeof callTool>, args: Record<string, unknown> = {}) {
  const out = await call('check_audit_availability', args);
  return { ...out, tokens: tokensFrom(out.text) };
}

describe('tool listing', () => {
  it('exposes four tools with the approved descriptions and safe annotations', async () => {
    const { h, t } = await setup();
    const res = (await (await rpc(h, t.access_token, 'tools/list', {})).json()) as any;
    const tools = res.result.tools as any[];
    expect(tools.map((x) => x.name).sort()).toEqual(['book_audit_call', 'check_audit_availability', 'get_audit_request_status', 'request_written_audit']);
    for (const tool of tools) expect(tool.description).toBe(TOOL_DESCRIPTIONS[tool.name as keyof typeof TOOL_DESCRIPTIONS]);
    expect(tools.find((x) => x.name === 'check_audit_availability').annotations.readOnlyHint).toBe(true);
    expect(tools.find((x) => x.name === 'book_audit_call').annotations.readOnlyHint).toBe(false);
  });
});

describe('check_audit_availability', () => {
  it('returns up to 8 slots with tokens, never books, and searches 14 days by default', async () => {
    const { h, call } = await setup();
    const out = await firstSlots(call);
    expect(out.isError).toBe(false);
    expect(out.tokens.length).toBeGreaterThan(0);
    expect(out.tokens.length).toBeLessThanOrEqual(8);
    expect(h.scheduler.bookings).toHaveLength(0);
    const [s, e] = h.scheduler.availabilityCalls[0]!;
    expect((e.getTime() - s.getTime()) / 86_400_000).toBeCloseTo(14, 5);
  });

  it('[checklist] shows Central time with Pacific for a Chicago user asking for tomorrow afternoon', async () => {
    const { call } = await setup();
    const out = await firstSlots(call, { start: '2026-10-27', end: '2026-10-27', timezone: 'America/Chicago', part_of_day: 'afternoon' });
    expect(out.tokens.length).toBeGreaterThan(0);
    const lines = out.text.split('\n').filter((l) => /^\d+\. /.test(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l).toMatch(/CDT/);
      expect(l).toMatch(/\(\d{1,2}:\d{2} [AP]M PDT\)/);
      expect(l).toMatch(/Oct 27/);
    }
  });

  it('[checklist] clamps ranges that are past or longer than 14 days, and says so', async () => {
    const { h, call } = await setup();
    const out = await call('check_audit_availability', { start: '2020-01-01', end: '2099-01-01' });
    expect(out.text).toMatch(/in the past/);
    expect(out.text).toMatch(/limited to 14 days/);
    const latest = Math.max(...h.scheduler.availabilityCalls.map(([, e]) => e.getTime()));
    expect(latest - NOW.getTime()).toBeLessThanOrEqual(14 * 86_400_000 + 1000);
  });

  it('says when nothing is open and points to the written audit', async () => {
    const { h, call } = await setup();
    h.scheduler.slots = [];
    const out = await call('check_audit_availability');
    expect(out.text).toMatch(/No open times/);
    expect(out.text).toMatch(/request_written_audit/);
  });

  it('[checklist] steers to the written audit when the scheduler is down', async () => {
    const { h, call } = await setup();
    h.scheduler.down = new SchedulerUnavailableError('boom', 'server');
    const out = await call('check_audit_availability');
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/request_written_audit/);
    expect(out.text).not.toMatch(/boom|stack|at \w+\.\w+/i);
  });

  it('pages the team when the scheduler rejects our credentials', async () => {
    const { h, call } = await setup();
    h.scheduler.down = new SchedulerUnavailableError('401 key', 'auth');
    await call('check_audit_availability');
    expect(h.notifier.slackMessages.join('\n')).toMatch(/Scheduling problem/);
  });
});

describe('book_audit_call', () => {
  it('books, writes the lead, alerts Slack and email, and returns the approved confirmation', async () => {
    const { h, call } = await setup();
    const { tokens } = await firstSlots(call);
    const out = await call('book_audit_call', { slot_token: tokens[0], ...GOOD });
    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/^Your AI Readiness Audit is booked for \w+day, \w+ \d+ at \d+:\d\d [AP]M PDT\./);
    expect(out.text).toContain('https://meet.google.com/abc-defg-h1');
    expect(out.text).toContain('Reschedule: https://cal.example/reschedule/bk1');
    expect(out.text).toContain('Ruchi Singh, co-founder of Strategent');
    expect(out.text).toContain('with you keeping final approval');

    expect(h.scheduler.bookings).toHaveLength(1);
    expect(h.scheduler.bookings[0]).toMatchObject({ email: 'dana@harborinn.test', timezone: 'America/Los_Angeles', source: 'muse' });
    expect(h.store.rows).toHaveLength(1);
    expect(h.store.rows[0]).toMatchObject({ type: 'call', status: 'booked', region: 'south_bay', industry: 'hospitality', channel_interest: 'calls' });

    expect(h.notifier.slackMessages[0]).toContain('LOCAL · New audit call · south_bay · Harbor Inn · hospitality · Redondo Beach · Missed calls after 6pm · dana@harborinn.test · via muse');
    expect(h.notifier.emails).toHaveLength(1);
  });

  it('answers the booking questions by field slug, with normalised industry and channel', async () => {
    const { h, call } = await setup();
    const { tokens } = await firstSlots(call);
    await call('book_audit_call', { slot_token: tokens[0], ...GOOD, industry: 'I run a hotel', channel_interest: 'the phones' });
    expect(h.scheduler.bookings[0]!.fields).toEqual({
      'business-name': 'Harbor Inn',
      website: 'https://harborinn.test',
      city: 'Redondo Beach',
      industry: 'Hospitality',
      'pain-point': 'Missed calls after 6pm',
      phone: 'Not provided',
      'channel-interest': 'Calls',
    });
  });

  it('keeps the core confirmation under 60 words for a Pacific user', async () => {
    const { call } = await setup();
    const { tokens } = await firstSlots(call);
    const out = await call('book_audit_call', { slot_token: tokens[0], ...GOOD, city: 'Denver' });
    expect(out.text.split(/\s+/).length).toBeLessThan(60);
  });

  it('adds the local line only for South Bay and Westside', async () => {
    const { call } = await setup();
    const { tokens } = await firstSlots(call);
    const local = await call('book_audit_call', { slot_token: tokens[0], ...GOOD });
    expect(local.text).toContain('Strategent works with owners across the South Bay and Westside in person.');
    const far = await call('book_audit_call', { slot_token: tokens[1], ...GOOD, email: 'x@y.test', city: 'Atlanta' });
    expect(far.text).not.toContain('South Bay');
  });

  it('[checklist] shows the user time and Pacific in the confirmation for a Chicago user', async () => {
    const { call } = await setup();
    const { tokens } = await firstSlots(call, { start: '2026-10-27', end: '2026-10-28', timezone: 'America/Chicago' });
    const out = await call('book_audit_call', { slot_token: tokens[0], ...GOOD, city: 'Chicago' });
    expect(out.text).toMatch(/CDT \(\d{1,2}:\d{2} [AP]M PDT\)/);
  });

  it('[checklist] says the slot was taken and offers the next three open times', async () => {
    const { h, call } = await setup();
    const { tokens } = await firstSlots(call);
    const claim = await verifySlot(h.config.signingSecret, tokens[0]!, NOW);
    if (!claim.ok) throw new Error('bad token');
    h.scheduler.taken.add(claim.claims.start.getTime());

    const out = await call('book_audit_call', { slot_token: tokens[0], ...GOOD });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/was just taken/);
    const alternatives = tokensFrom(out.text);
    expect(alternatives).toHaveLength(3);
    expect(alternatives).not.toContain(tokens[0]);
    expect(h.store.rows).toHaveLength(0);

    // The offered alternatives actually book.
    const retry = await call('book_audit_call', { slot_token: alternatives[0], ...GOOD });
    expect(retry.isError).toBe(false);
  });

  it('[checklist] rejects malformed and expired slot tokens without a stack trace', async () => {
    const { h, call } = await setup();
    const { tokens } = await firstSlots(call);
    for (const bad of ['garbage', '', 'a.b.c.d', `${tokens[0]}x`]) {
      const out = await call('book_audit_call', { slot_token: bad, ...GOOD });
      expect(out.isError).toBe(true);
      expect(out.text).toMatch(/check_audit_availability/);
      expect(out.text).not.toMatch(/Error:|\bat \S+:\d+/);
    }
    h.clock.now = new Date(NOW.getTime() + 31 * 60_000);
    const expired = await call('book_audit_call', { slot_token: tokens[0], ...GOOD });
    expect(expired.isError).toBe(true);
    expect(expired.text).toMatch(/no longer valid/);
    expect(h.scheduler.bookings).toHaveLength(0);
  });

  it('[checklist] returns the existing booking when the same user books the same slot twice', async () => {
    const { h, call } = await setup();
    const { tokens } = await firstSlots(call);
    const first = await call('book_audit_call', { slot_token: tokens[0], ...GOOD });
    const second = await call('book_audit_call', { slot_token: tokens[0], ...GOOD, email: 'DANA@harborinn.test' });
    expect(second.isError).toBe(false);
    expect(second.text).toBe(first.text);
    expect(h.scheduler.bookings).toHaveLength(1);
    expect(h.store.rows).toHaveLength(1);
  });

  it('points to the reschedule link when the same user asks for a different time', async () => {
    const { h, call } = await setup();
    const { tokens } = await firstSlots(call);
    await call('book_audit_call', { slot_token: tokens[0], ...GOOD });
    const other = await call('book_audit_call', { slot_token: tokens[1], ...GOOD });
    expect(other.isError).toBe(true);
    expect(other.text).toMatch(/already has an audit booked/);
    expect(other.text).toContain('https://cal.example/reschedule/bk1');
    expect(h.scheduler.bookings).toHaveLength(1);
  });

  it('survives two simultaneous identical requests without a duplicate or a false "taken"', async () => {
    const { h, call } = await setup();
    const { tokens } = await firstSlots(call);
    const [a, b] = await Promise.all([
      call('book_audit_call', { slot_token: tokens[0], ...GOOD }),
      call('book_audit_call', { slot_token: tokens[0], ...GOOD }),
    ]);
    expect(h.scheduler.bookings).toHaveLength(1);
    expect(h.store.rows).toHaveLength(1);
    const texts = [a, b].map((x) => x.text);
    expect(texts.filter((t) => /is booked for/.test(t)).length).toBeGreaterThanOrEqual(1);
  });

  it('[checklist] asks for exactly the missing fields', async () => {
    const { h, call } = await setup();
    const { tokens } = await firstSlots(call);
    const noEmail = await call('book_audit_call', { slot_token: tokens[0], name: 'Dana', business_name: 'Harbor Inn' });
    expect(noEmail.isError).toBe(true);
    expect(noEmail.text).toMatch(/Still needed from the user: email\./);
    const two = await call('book_audit_call', { slot_token: tokens[0], name: 'Dana' });
    expect(two.text).toMatch(/Still needed from the user: email, business_name\./);
    expect(h.scheduler.bookings).toHaveLength(0);
  });

  it('[checklist] does not book on a vague request with no details', async () => {
    const { h, call } = await setup();
    const out = await call('book_audit_call', {});
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/slot_token/);
    expect(out.text).toMatch(/name, email, business_name/);
    expect(h.scheduler.bookings).toHaveLength(0);
  });

  it('rejects an invalid email before calling the scheduler', async () => {
    const { h, call } = await setup();
    const { tokens } = await firstSlots(call);
    const out = await call('book_audit_call', { slot_token: tokens[0], ...GOOD, email: 'not-an-email' });
    expect(out.text).toMatch(/does not look valid/);
    expect(h.scheduler.bookings).toHaveLength(0);
  });

  it('[checklist] saves the request and promises a call time by email when the scheduler is down at booking', async () => {
    const { h, call } = await setup();
    const { tokens } = await firstSlots(call);
    h.scheduler.down = new SchedulerUnavailableError('timeout', 'network');
    const out = await call('book_audit_call', { slot_token: tokens[0], ...GOOD });
    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/will email a call time to dana@harborinn.test/);
    expect(h.store.rows[0]).toMatchObject({ type: 'call_pending', status: 'requested' });
    expect(h.notifier.slackMessages.join('\n')).toMatch(/scheduling down/);
  });

  it('still confirms, and alerts loudly, when the database write fails after a successful booking', async () => {
    const { h, call } = await setup();
    const { tokens } = await firstSlots(call);
    h.store.insertRequest = async () => {
      throw new Error('db down');
    };
    const out = await call('book_audit_call', { slot_token: tokens[0], ...GOOD });
    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/is booked for/);
    expect(h.notifier.slackMessages.join('\n')).toMatch(/DATABASE WRITE FAILED/);
  });

  it('falls back gracefully when the Meet link is not ready yet', async () => {
    const { h, call } = await setup();
    const orig = h.scheduler.createBooking.bind(h.scheduler);
    h.scheduler.createBooking = async (i) => ({ ...(await orig(i)), meetLink: null });
    const { tokens } = await firstSlots(call);
    const out = await call('book_audit_call', { slot_token: tokens[0], ...GOOD });
    expect(out.text).toMatch(/on Google Meet: the link in your calendar invite/);
  });

  it('limits requests per email per day and across all emails per hour', async () => {
    const { h, call } = await setup({ config: { PER_EMAIL_DAILY_CAP: '1', BOOKING_HOURLY_CAP: '3' } });
    const w = { name: 'Sam', business_name: 'Biz', website: 'biz.test' };
    expect((await call('request_written_audit', { ...w, email: 'a@x.test' })).isError).toBe(false);

    const { tokens } = await firstSlots(call);
    const again = await call('book_audit_call', { slot_token: tokens[0], ...GOOD, email: 'a@x.test' });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/several requests from this email/);
    expect(h.scheduler.bookings).toHaveLength(0);

    expect((await call('request_written_audit', { ...w, email: 'b@x.test' })).isError).toBe(false);
    expect((await call('request_written_audit', { ...w, email: 'c@x.test' })).isError).toBe(false);
    const busy = await call('request_written_audit', { ...w, email: 'd@x.test' });
    expect(busy.isError).toBe(true);
    expect(busy.text).toMatch(/faster than usual/);
    expect(h.store.rows).toHaveLength(3);
  });

  it('keeps user text from injecting Slack mentions or links', async () => {
    const { h, call } = await setup();
    const { tokens } = await firstSlots(call);
    await call('book_audit_call', { slot_token: tokens[0], ...GOOD, pain_point: '<!channel> click <https://evil.test|here> @here' });
    const slack = h.notifier.slackMessages[0]!;
    expect(slack).not.toContain('<!channel>');
    expect(slack).not.toContain('<https');
    expect(slack).not.toMatch(/@here/);
  });
});

describe('request_written_audit', () => {
  const W = { name: 'Sam Lee', email: 'sam@leelaw.test', business_name: 'Lee Law', website: 'leelaw.test', city: 'Santa Monica', industry: 'law firm', pain_point: 'Intake' };

  it('records the request, alerts the team, and returns the approved confirmation', async () => {
    const { h, call } = await setup();
    const out = await call('request_written_audit', W);
    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/^Thank you\. Strategent will review Lee Law from public signals and send your AI Readiness Audit to sam@leelaw.test within three business days\. No call needed\./);
    expect(out.text).toContain('book a time at cal.com/strategent/audit.');
    expect(h.store.rows[0]).toMatchObject({ type: 'written', status: 'requested', region: 'westside', industry: 'legal' });
    expect(h.notifier.slackMessages[0]).toBe('LOCAL · New audit written · westside · Lee Law · legal · Santa Monica · Intake · sam@leelaw.test · via muse');
    expect(h.notifier.emails[0]!.subject).toMatch(/New audit written: Lee Law/);
  });

  it('[checklist] accepts requests from outside the US and Canada and flags region=other', async () => {
    const { h, call } = await setup();
    const out = await call('request_written_audit', { ...W, city: 'London', email: 'u@uk.test' });
    expect(out.isError).toBe(false);
    expect(h.notifier.slackMessages[0]).toContain('New audit written · other ·');
    expect(h.notifier.slackMessages[0]).not.toContain('LOCAL');
  });

  it('asks for exactly what is missing, and accepts city when there is no website', async () => {
    const { call } = await setup();
    const out = await call('request_written_audit', { name: 'Sam', email: 'sam@x.test', business_name: 'Lee Law' });
    expect(out.text).toMatch(/Still needed from the user: website \(or the city, if the business has no website\)\./);
    expect((await call('request_written_audit', { name: 'Sam', email: 'sam@x.test', business_name: 'Lee Law', city: 'Torrance' })).isError).toBe(false);
  });

  it('does not create a duplicate for the same email', async () => {
    const { h, call } = await setup();
    const a = await call('request_written_audit', W);
    const b = await call('request_written_audit', W);
    expect(b.text).toBe(a.text.replace(/\n\n.*/s, ''));
    expect(h.store.rows).toHaveLength(1);
    expect(h.notifier.slackMessages).toHaveLength(1);
  });

  it('waitlists honestly once too many written audits are open', async () => {
    const { h, call } = await setup({ config: { WRITTEN_OPEN_CAP: '1' } });
    await call('request_written_audit', W);
    const out = await call('request_written_audit', { ...W, email: 'two@leelaw.test' });
    expect(out.text).toMatch(/on the list/);
    expect(out.text).not.toMatch(/within three business days/);
    expect(h.store.rows[1]!.status).toBe('waitlist');
  });

  it('wants_call_time records a pending call instead of a written audit', async () => {
    const { h, call } = await setup();
    const out = await call('request_written_audit', { ...W, wants_call_time: true });
    expect(out.text).toMatch(/will email a call time/);
    expect(h.store.rows[0]!.type).toBe('call_pending');
  });

  it('asks the notifier to send the requester an acknowledgement (the notifier decides whether it is enabled)', async () => {
    const { h, call } = await setup();
    await call('request_written_audit', W);
    const ack = h.notifier.emails.find((e) => e.to === 'sam@leelaw.test');
    expect(ack?.subject).toBe('Your Strategent AI Readiness Audit request');
    expect(ack?.text).toMatch(/within three business days/);
  });
});

describe('get_audit_request_status', () => {
  it('reports a booked call and a written request for the same connection', async () => {
    const { call } = await setup();
    const { tokens } = await firstSlots(call);
    await call('book_audit_call', { slot_token: tokens[0], ...GOOD });
    await call('request_written_audit', { ...GOOD, email: GOOD.email });
    const out = await call('get_audit_request_status', { email: 'Dana@HarborInn.test' });
    expect(out.text).toMatch(/Audit call: booked for/);
    expect(out.text).toMatch(/Written audit: request received/);
  });

  it('shows nothing to a different connection, even with the right email', async () => {
    const { h, call } = await setup();
    const { tokens } = await firstSlots(call);
    await call('book_audit_call', { slot_token: tokens[0], ...GOOD });
    const stranger = await signIn(h);
    const out = await callTool(h, stranger.access_token, 'get_audit_request_status', { email: GOOD.email });
    expect(out.text).toMatch(/No request found/);
    expect(out.text).not.toMatch(/Harbor|booked for/);
  });

  it('asks for the email when it is missing', async () => {
    const { call } = await setup();
    expect((await call('get_audit_request_status', {})).text).toMatch(/Still needed from the user: email/);
  });
});

describe('logging and brand rules', () => {
  it('logs every call without personal data', async () => {
    const { h, call } = await setup();
    const { tokens } = await firstSlots(call, { timezone: 'America/Chicago' });
    await call('book_audit_call', { slot_token: tokens[0], ...GOOD });
    expect(h.store.logs.map((l) => l.tool)).toEqual(['check_audit_availability', 'book_audit_call']);
    const dump = JSON.stringify(h.store.logs);
    for (const secret of ['dana@harborinn.test', 'Dana Patel', 'Missed calls', 'Harbor Inn', 'Redondo']) expect(dump).not.toContain(secret);
    expect(h.store.logs[1]).toMatchObject({ outcome: 'booked', inputs: { industry: 'hospitality', channel_interest: 'calls' } });
    expect(h.store.logs[1]!.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('never uses em dashes or the word "automation" in anything a user can read', async () => {
    const { h, call } = await setup();
    const outputs: string[] = [...Object.values(TOOL_DESCRIPTIONS)];
    const { tokens, text } = await firstSlots(call);
    outputs.push(text);
    outputs.push((await call('book_audit_call', { slot_token: tokens[0], ...GOOD })).text);
    outputs.push((await call('book_audit_call', { slot_token: tokens[1], ...GOOD })).text);
    outputs.push((await call('book_audit_call', {})).text);
    outputs.push((await call('request_written_audit', { name: 'A', email: 'a@b.test', business_name: 'B', city: 'Torrance' })).text);
    outputs.push((await call('get_audit_request_status', { email: GOOD.email })).text);
    h.scheduler.down = new SchedulerUnavailableError('x', 'server');
    outputs.push((await call('check_audit_availability')).text);
    for (const o of outputs) {
      expect(o).not.toContain('—');
      expect(o).not.toMatch(/automation/i);
    }
  });

  it('turns an unexpected crash into a safe message', async () => {
    const { h, call } = await setup();
    h.scheduler.availableTimes = async () => {
      throw new TypeError('kaboom internal detail');
    };
    const out = await call('check_audit_availability');
    expect(out.isError).toBe(true);
    expect(out.text).not.toMatch(/kaboom|TypeError/);
    expect(h.store.logs.at(-1)!.outcome).toBe('error');
  });
});

describe('source attribution', () => {
  it('tags leads by the connecting client', async () => {
    const h: Harness = makeHarness();
    const claude = await signIn(h, 'Claude');
    const slots = await callTool(h, claude.access_token, 'check_audit_availability');
    await callTool(h, claude.access_token, 'book_audit_call', { slot_token: tokensFrom(slots.text)[0], ...GOOD });
    expect(h.store.rows[0]!.source).toBe('claude');
    expect(h.notifier.slackMessages[0]).toContain('via claude');
  });
});
