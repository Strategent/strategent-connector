import type { Config } from './config.js';
import { SchedulerConflictError, SchedulerUnavailableError, type SchedulerApi } from './scheduler.js';
import {
  callConfirmation,
  callPendingConfirmation,
  LOCAL_LINE,
  waitlistConfirmation,
  writtenConfirmation,
} from './copy.js';
import type { Notifier } from './notify.js';
import { slackSafe } from './notify.js';
import type { Principal } from './oauth.js';
import { normalizeRegion, type Region } from './region.js';
import type { AuditRequest, RequestType, Store } from './store.js';
import {
  confirmationMoment,
  inPartOfDay,
  normalizeTimezone,
  pickSlots,
  resolveWindow,
  slotLabel,
  type PartOfDay,
} from './time.js';
import { signSlot, verifySlot } from './token.js';

export interface ToolDeps {
  config: Config;
  scheduler: SchedulerApi;
  store: Store;
  notifier: Notifier;
  now: () => Date;
}

export interface ToolResult {
  text: string;
  isError?: boolean;
  /** Short machine-readable outcome for the call log. */
  outcome: string;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CONTACT = 'info@strategent.app';

// ---------- input cleaning ----------

const clean = (v: unknown, max = 200): string =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normalizeWebsite(v: unknown): string {
  const raw = clean(v, 200);
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withScheme);
    return u.hostname.includes('.') ? u.toString().replace(/\/$/, '') : '';
  } catch {
    return '';
  }
}

const INDUSTRY_LABELS: Record<string, string> = {
  hospitality: 'Hospitality',
  real_estate: 'Real estate',
  legal: 'Legal',
  wealth: 'Wealth',
  professional_services: 'Professional services',
  restaurant: 'Restaurant',
  medical: 'Medical',
  other: 'Other',
};

export function normalizeIndustry(v: unknown): string {
  const t = clean(v, 80).toLowerCase();
  if (!t) return 'other';
  if (t in INDUSTRY_LABELS) return t;
  if (/hotel|motel|hospitality|lodging|inn\b|resort/.test(t)) return 'hospitality';
  if (/real.?estate|realtor|realty|property|brokerage/.test(t)) return 'real_estate';
  if (/law|legal|attorney|lawyer/.test(t)) return 'legal';
  if (/wealth|financial|advis|invest|insurance/.test(t)) return 'wealth';
  if (/restaurant|cafe|food|bar\b|catering/.test(t)) return 'restaurant';
  if (/medical|dental|clinic|health|doctor|therap/.test(t)) return 'medical';
  if (/consult|account|professional|agency|services/.test(t)) return 'professional_services';
  return 'other';
}

const CHANNEL_LABELS: Record<string, string> = {
  calls: 'Calls',
  inbox: 'Inbox',
  intake: 'Intake',
  back_office: 'Back office',
  all: 'All of it',
};

export function normalizeChannel(v: unknown): string {
  const t = clean(v, 40).toLowerCase().replace(/[\s-]+/g, '_');
  if (t in CHANNEL_LABELS) return t;
  if (/call|phone|reception/.test(t)) return 'calls';
  if (/inbox|email|mail/.test(t)) return 'inbox';
  if (/intake|form|lead/.test(t)) return 'intake';
  if (/back|admin|operation/.test(t)) return 'back_office';
  return 'all';
}

function normalizePart(v: unknown): PartOfDay {
  const t = clean(v, 20).toLowerCase();
  return t === 'morning' || t === 'afternoon' || t === 'evening' ? t : 'any';
}

// ---------- shared helpers ----------

function missingText(fields: string[]): string {
  return `Still needed from the user: ${fields.join(', ')}. Ask for only that, then call this tool again with every detail you already have.`;
}

async function safely<T>(label: string, deps: ToolDeps, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    console.error(`[store] ${label}: ${(e as Error).message}`);
    await deps.notifier.slack(`Connector warning: ${label} failed (${slackSafe((e as Error).message, 120)}). Check Supabase.`);
    return fallback;
  }
}

async function alertScheduler(deps: ToolDeps, e: SchedulerUnavailableError, context: string) {
  console.error(`[scheduler] ${context}: ${e.kind} ${e.message}`);
  // Network blips and 5xx are expected now and then. Config problems are not, so those page the team.
  if (e.kind === 'network' || e.kind === 'server') return;
  await deps.notifier.slack(`Scheduling problem during ${context} (${e.kind}): ${slackSafe(e.message, 200)}. Bookings will fall back to email until this is fixed.`);
}

const UNAVAILABLE_TEXT =
  'Scheduling is temporarily unavailable. Offer the user a written AI Readiness Audit by email instead, or a call time sent by email. ' +
  'Use request_written_audit for either (set wants_call_time to true if they want a call time).';

function localLineFor(region: Region): string {
  return region === 'south_bay' || region === 'westside' ? `\n\n${LOCAL_LINE}` : '';
}

function leadAlert(type: string, r: { region: string; business: string; industry: string; city: string; pain: string; email: string; source: string }, extra?: string): string {
  const local = r.region === 'south_bay' || r.region === 'westside' ? 'LOCAL · ' : '';
  const lines = [
    `${local}New audit ${type} · ${r.region} · ${slackSafe(r.business, 80)} · ${r.industry} · ${slackSafe(r.city, 60) || 'no city'} · ${slackSafe(r.pain, 200) || 'no detail given'} · ${slackSafe(r.email, 80)} · via ${r.source}`,
  ];
  if (extra) lines.push(extra);
  return lines.join('\n');
}

function detailsBlock(row: Omit<AuditRequest, 'id' | 'created_at'>): string {
  return [
    `Type: ${row.type} (${row.status})`,
    `Region: ${row.region}`,
    `Name: ${row.name}`,
    `Email: ${row.email}`,
    `Phone: ${row.phone ?? 'not given'}`,
    `Business: ${row.business_name}`,
    `Website: ${row.website ?? 'not given'}`,
    `City: ${row.city ?? 'not given'}`,
    `Industry: ${row.industry ?? 'not given'}`,
    `Interest: ${row.channel_interest ?? 'not given'}`,
    `Taking the most time: ${row.pain_point ?? 'not given'}`,
    row.slot_start ? `Call time: ${row.slot_start} (${row.timezone})` : '',
    row.meet_link ? `Meet: ${row.meet_link}` : '',
    `Source: ${row.source}`,
  ]
    .filter(Boolean)
    .join('\n');
}

async function persistAndNotify(
  deps: ToolDeps,
  row: Omit<AuditRequest, 'id' | 'created_at'>,
  alert: string,
): Promise<AuditRequest | null> {
  let saved: AuditRequest | null = null;
  let dbError = '';
  try {
    saved = await deps.store.insertRequest(row);
  } catch (e) {
    dbError = (e as Error).message;
    console.error(`[store] insert failed: ${dbError}`);
  }
  // Alerts go out even if the database write failed, so a lead is never silently lost.
  const slackText = dbError ? `${alert}\nDATABASE WRITE FAILED (${slackSafe(dbError, 120)}). Record this lead by hand.` : alert;
  await Promise.all([
    deps.notifier.slack(slackText),
    deps.notifier.email(`New audit ${row.type}: ${row.business_name} (${row.region})`, `${detailsBlock(row)}${dbError ? `\n\nDATABASE WRITE FAILED: ${dbError}` : ''}`),
  ]);
  return saved;
}

function baseRow(
  who: Principal,
  f: { name: string; email: string; phone: string; business: string; website: string; city: string; industry: string; pain: string; channel: string },
) {
  return {
    owner_sub: who.sub,
    name: f.name,
    email: f.email,
    phone: f.phone || null,
    business_name: f.business,
    website: f.website || null,
    city: f.city || null,
    region: normalizeRegion(f.city),
    industry: f.industry,
    pain_point: f.pain || null,
    channel_interest: f.channel,
    source: who.source,
  };
}

async function overLimit(deps: ToolDeps, email: string): Promise<string | null> {
  const now = deps.now();
  const perEmail = await safely('per-email count', deps, () => deps.store.countCreatedSinceByEmail(email, new Date(now.getTime() - DAY)), 0);
  if (perEmail >= deps.config.perEmailDailyCap) {
    return `There have been several requests from this email today already. Ask the user to email ${CONTACT} if they need to change something.`;
  }
  const hourly = await safely('hourly count', deps, () => deps.store.countCreatedSince(new Date(now.getTime() - HOUR)), 0);
  if (hourly >= deps.config.bookingHourlyCap) {
    return `Requests are coming in faster than usual right now. Ask the user to try again in a few minutes, or email ${CONTACT}.`;
  }
  return null;
}

// ---------- tools ----------

export interface AvailabilityArgs {
  start?: string;
  end?: string;
  timezone?: string;
  part_of_day?: string;
}

export interface BookArgs {
  slot_token?: string;
  name?: string;
  email?: string;
  phone?: string;
  business_name?: string;
  website?: string;
  city?: string;
  industry?: string;
  pain_point?: string;
  channel_interest?: string;
}

export interface WrittenArgs {
  name?: string;
  email?: string;
  business_name?: string;
  website?: string;
  city?: string;
  industry?: string;
  pain_point?: string;
  wants_call_time?: boolean;
}

export function createTools(deps: ToolDeps) {
  const { config, scheduler, store, now } = deps;

  async function slotLines(times: Date[], tz: string): Promise<string[]> {
    const t = now();
    const tokens = await Promise.all(times.map((d) => signSlot(config.signingSecret, d, tz, t)));
    return times.map((d, i) => `${i + 1}. ${slotLabel(d, tz)} | slot_token: ${tokens[i]}`);
  }

  async function checkAvailability(args: AvailabilityArgs): Promise<ToolResult> {
    const tzr = normalizeTimezone(clean(args.timezone, 60));
    const win = resolveWindow(clean(args.start, 40), clean(args.end, 40), tzr.tz, now());
    const notes = [...(tzr.note ? [tzr.note] : []), ...win.notes];

    let times: Date[];
    try {
      times = await scheduler.availableTimes(win.start, win.end);
    } catch (e) {
      if (e instanceof SchedulerUnavailableError) {
        await alertScheduler(deps, e, 'availability');
        return { text: UNAVAILABLE_TEXT, isError: true, outcome: 'scheduler_unavailable' };
      }
      throw e;
    }

    const part = normalizePart(args.part_of_day);
    let pool = times.filter((d) => inPartOfDay(d, tzr.tz, part));
    if (pool.length === 0 && times.length > 0 && part !== 'any') {
      notes.push(`No ${part} times were open in this range, so other times are shown.`);
      pool = times;
    }
    if (pool.length === 0) {
      return {
        text: `No open times in that range. Offer a later week, or offer a written AI Readiness Audit with request_written_audit.${notes.length ? ` ${notes.join(' ')}` : ''}`,
        outcome: 'no_slots',
      };
    }

    const picks = pickSlots(pool, tzr.tz);
    const lines = await slotLines(picks, tzr.tz);
    const text = [
      `Open times for the 30-minute AI Readiness Audit, shown in ${tzr.tz}:`,
      ...lines,
      ...(notes.length ? [notes.join(' ')] : []),
      'Show these times to the user and let them choose one. Then collect their name, email and business name, confirm the details with them, and call book_audit_call with the chosen slot_token. Do not book until they have picked a time.',
    ].join('\n');
    return { text, outcome: 'ok' };
  }

  async function bookCall(args: BookArgs, who: Principal): Promise<ToolResult> {
    const f = {
      name: clean(args.name, 100),
      email: clean(args.email, 120).toLowerCase(),
      phone: clean(args.phone, 40),
      business: clean(args.business_name, 120),
      website: normalizeWebsite(args.website),
      city: clean(args.city, 80),
      industry: normalizeIndustry(args.industry),
      pain: clean(args.pain_point, 500),
      channel: normalizeChannel(args.channel_interest),
    };
    const token = clean(args.slot_token, 300);

    const missing: string[] = [];
    if (!token) missing.push('slot_token (run check_audit_availability and let the user pick a time)');
    if (!f.name) missing.push('name');
    if (!f.email) missing.push('email');
    if (!f.business) missing.push('business_name');
    if (missing.length) return { text: missingText(missing), isError: true, outcome: 'missing_fields' };
    if (!EMAIL.test(f.email)) {
      return { text: 'That email address does not look valid. Ask the user to confirm it, then try again.', isError: true, outcome: 'invalid_email' };
    }

    const slot = await verifySlot(config.signingSecret, token, now());
    if (!slot.ok || slot.claims.start.getTime() <= now().getTime()) {
      return {
        text: 'That time slot is no longer valid. Run check_audit_availability again, let the user pick a time, then book with the new slot_token.',
        isError: true,
        outcome: slot.ok ? 'slot_past' : `slot_${slot.reason}`,
      };
    }
    const { start, tz } = slot.claims;
    const startIso = start.toISOString();

    // Idempotency: same email + same time returns the existing booking; a different time points to reschedule.
    const existing = await safely('active call lookup', deps, () => store.findActiveCall(f.email, now()), null);
    if (existing?.slot_start) {
      const existingStart = new Date(existing.slot_start);
      const m = confirmationMoment(existingStart, existing.timezone ?? tz);
      if (existingStart.getTime() === start.getTime()) {
        return {
          text: callConfirmation({ ...m, hostIntro: config.hostIntro, meetLink: existing.meet_link, rescheduleLink: existing.reschedule_url ?? '' }) + localLineFor(existing.region as Region),
          outcome: 'duplicate_same',
        };
      }
      return {
        text: `This email already has an audit booked for ${m.day}, ${m.date} at ${m.time} ${m.timezone}. Only one call is booked at a time. To change it, use the reschedule link: ${existing.reschedule_url ?? CONTACT}.`,
        isError: true,
        outcome: 'duplicate_other',
      };
    }

    const limited = await overLimit(deps, f.email);
    if (limited) return { text: limited, isError: true, outcome: 'rate_limited' };

    const q = config.calFields;
    const answer = (v: string) => v || 'Not provided';
    const fields: Record<string, string> = {
      [q.business]: f.business,
      [q.website]: answer(f.website),
      [q.city]: answer(f.city),
      [q.industry]: INDUSTRY_LABELS[f.industry]!,
      [q.painPoint]: answer(f.pain),
      [q.phone]: answer(f.phone),
      [q.channel]: CHANNEL_LABELS[f.channel]!,
    };

    const row = baseRow(who, f);
    try {
      const booking = await scheduler.createBooking({ start, name: f.name, email: f.email, timezone: tz, fields, source: who.source });
      const full: Omit<AuditRequest, 'id' | 'created_at'> = {
        ...row,
        type: 'call',
        status: 'booked',
        slot_start: startIso,
        timezone: tz,
        meet_link: booking.meetLink,
        reschedule_url: booking.rescheduleUrl || null,
        cancel_url: booking.cancelUrl || null,
        booking_uid: booking.uid || null,
      };
      const m = confirmationMoment(start, tz);
      await persistAndNotify(
        deps,
        full,
        leadAlert('call', { region: row.region, business: f.business, industry: f.industry, city: f.city, pain: f.pain, email: f.email, source: who.source }, `Call: ${m.day}, ${m.date} at ${m.time} ${m.timezone}`),
      );
      return {
        text: callConfirmation({ ...m, hostIntro: config.hostIntro, meetLink: booking.meetLink, rescheduleLink: booking.rescheduleUrl }) + localLineFor(row.region as Region),
        outcome: 'booked',
      };
    } catch (e) {
      if (e instanceof SchedulerConflictError) {
        // The same person may have just booked this slot with a retry, so check before saying it was taken.
        const again = await safely('active call recheck', deps, () => store.findActiveCall(f.email, now()), null);
        if (again?.slot_start && new Date(again.slot_start).getTime() === start.getTime()) {
          const m = confirmationMoment(start, tz);
          return { text: callConfirmation({ ...m, hostIntro: config.hostIntro, meetLink: again.meet_link, rescheduleLink: again.reschedule_url ?? '' }), outcome: 'duplicate_same' };
        }
        return conflictResponse(start, tz);
      }
      if (e instanceof SchedulerUnavailableError) {
        await alertScheduler(deps, e, 'booking');
        const pending: Omit<AuditRequest, 'id' | 'created_at'> = {
          ...row,
          type: 'call_pending',
          status: 'requested',
          slot_start: startIso,
          timezone: tz,
          meet_link: null,
          reschedule_url: null,
          cancel_url: null,
          booking_uid: null,
        };
        await persistAndNotify(
          deps,
          pending,
          leadAlert('call request (scheduling down)', { region: row.region, business: f.business, industry: f.industry, city: f.city, pain: f.pain, email: f.email, source: who.source }, `Wanted ${startIso}. Send a time by email, and check the calendar in case the booking went through anyway.`),
        );
        return { text: callPendingConfirmation(f.email), outcome: 'scheduler_down_pending' };
      }
      throw e;
    }
  }

  async function conflictResponse(taken: Date, tz: string): Promise<ToolResult> {
    const prefix = `That time (${slotLabel(taken, tz)}) was just taken.`;
    try {
      const from = new Date(Math.max(now().getTime(), taken.getTime() - HOUR));
      const open = (await scheduler.availableTimes(from, new Date(from.getTime() + 7 * DAY))).filter((d) => d.getTime() !== taken.getTime());
      const next = pickSlots(open, tz, 3, 2, 60);
      if (next.length) {
        const lines = await slotLines(next, tz);
        return {
          text: [prefix, 'Next open times:', ...lines, 'Ask the user to pick one, then call book_audit_call again with that slot_token and the same details.'].join('\n'),
          isError: true,
          outcome: 'slot_taken',
        };
      }
    } catch {
      // fall through to the generic message
    }
    return { text: `${prefix} Run check_audit_availability again to see current open times.`, isError: true, outcome: 'slot_taken' };
  }

  async function requestWrittenAudit(args: WrittenArgs, who: Principal): Promise<ToolResult> {
    const f = {
      name: clean(args.name, 100),
      email: clean(args.email, 120).toLowerCase(),
      phone: '',
      business: clean(args.business_name, 120),
      website: normalizeWebsite(args.website),
      city: clean(args.city, 80),
      industry: normalizeIndustry(args.industry),
      pain: clean(args.pain_point, 500),
      channel: 'all',
    };
    const wantsCall = args.wants_call_time === true;

    const missing: string[] = [];
    if (!f.name) missing.push('name');
    if (!f.email) missing.push('email');
    if (!f.business) missing.push('business_name');
    if (!f.website && !f.city) missing.push('website (or the city, if the business has no website)');
    if (missing.length) return { text: missingText(missing), isError: true, outcome: 'missing_fields' };
    if (!EMAIL.test(f.email)) {
      return { text: 'That email address does not look valid. Ask the user to confirm it, then try again.', isError: true, outcome: 'invalid_email' };
    }

    const type: RequestType = wantsCall ? 'call_pending' : 'written';
    const open = await safely('open request lookup', deps, () => store.findOpenRequests(f.email), []);
    const dup = open.find((r) => r.type === type);
    if (dup) {
      return { text: confirmationFor(dup.type, dup.status === 'waitlist', f.business, f.email), outcome: 'duplicate_same' };
    }

    const limited = await overLimit(deps, f.email);
    if (limited) return { text: limited, isError: true, outcome: 'rate_limited' };

    let status: 'requested' | 'waitlist' = 'requested';
    if (type === 'written') {
      const openCount = await safely('open written count', deps, () => store.countOpenWritten(), 0);
      if (openCount >= config.writtenOpenCap) status = 'waitlist';
    }

    const row: Omit<AuditRequest, 'id' | 'created_at'> = {
      ...baseRow(who, f),
      type,
      status,
      slot_start: null,
      timezone: null,
      meet_link: null,
      reschedule_url: null,
      cancel_url: null,
      booking_uid: null,
    };
    await persistAndNotify(
      deps,
      row,
      leadAlert(status === 'waitlist' ? 'written (waitlist)' : type === 'written' ? 'written' : 'call request', { region: row.region, business: f.business, industry: f.industry, city: f.city, pain: f.pain, email: f.email, source: who.source }),
    );
    if (type === 'written') {
      await deps.notifier.emailRequester(f.email, 'Your Strategent AI Readiness Audit request', confirmationFor(type, status === 'waitlist', f.business, f.email));
    }
    return { text: confirmationFor(type, status === 'waitlist', f.business, f.email) + localLineFor(row.region as Region), outcome: status === 'waitlist' ? 'waitlisted' : 'requested' };
  }

  function confirmationFor(type: RequestType, waitlist: boolean, business: string, email: string): string {
    if (type === 'call_pending') return callPendingConfirmation(email);
    if (waitlist) return waitlistConfirmation({ businessName: business, email, bookingPageUrl: config.bookingPageUrl });
    return writtenConfirmation({ businessName: business, email, bookingPageUrl: config.bookingPageUrl });
  }

  async function auditRequestStatus(args: { email?: string }, who: Principal): Promise<ToolResult> {
    const email = clean(args.email, 120).toLowerCase();
    if (!email) return { text: missingText(['email (the address used for the request)']), isError: true, outcome: 'missing_fields' };

    // Only requests made through this same connection are visible, so an email alone reveals nothing.
    const rows = await store.findByOwner(email, who.sub).catch(() => [] as AuditRequest[]);
    if (rows.length === 0) {
      return {
        text: `No request found for that email in this conversation's connection. If it was made another way, check the confirmation email or email ${CONTACT}.`,
        outcome: 'none',
      };
    }
    const lines = rows.slice(0, 5).map((r) => {
      if (r.type === 'call' && r.slot_start) {
        const m = confirmationMoment(new Date(r.slot_start), r.timezone ?? 'America/Los_Angeles');
        const past = new Date(r.slot_start).getTime() < now().getTime();
        return past
          ? `Audit call: was scheduled for ${m.day}, ${m.date}. Next step: Strategent will follow up by email.`
          : `Audit call: booked for ${m.day}, ${m.date} at ${m.time} ${m.timezone}. Next step: join on Google Meet. Reschedule: ${r.reschedule_url ?? CONTACT}.`;
      }
      if (r.type === 'call_pending') return 'Audit call: request received. Next step: Strategent will email a call time.';
      if (r.status === 'waitlist') return 'Written audit: on the list. Next step: Strategent will email when it starts.';
      return 'Written audit: request received. Next step: the audit arrives by email within three business days of the request.';
    });
    return { text: lines.join('\n'), outcome: 'ok' };
  }

  return { checkAvailability, bookCall, requestWrittenAudit, auditRequestStatus };
}

export type Tools = ReturnType<typeof createTools>;
