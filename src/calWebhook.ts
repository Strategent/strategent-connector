import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { fillTemplate } from './cal.js';
import type { Config } from './config.js';
import { safeEqual } from './crypto.js';
import { slackSafe, type Notifier } from './notify.js';
import { isBookingUid, type AuditRequest, type Store } from './store.js';
import { confirmationMoment } from './time.js';

export interface CalWebhookDeps {
  config: Config;
  store: Store;
  notifier: Notifier;
}

const enc = new TextEncoder();

/** Cal.com signs the raw request body with HMAC-SHA256 and sends the hex digest in `x-cal-signature-256`. */
export async function calSignature(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type WebhookOutcome = 'rescheduled' | 'cancelled' | 'already_applied' | 'unknown_booking' | 'ignored';

class BadPayload extends Error {}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

function when(iso: string | null, tz: string | null): string {
  if (!iso) return 'unknown time';
  const m = confirmationMoment(new Date(iso), tz ?? 'America/Los_Angeles');
  return `${m.day}, ${m.date} at ${m.time} ${m.timezone}`;
}

function detailsBlock(row: AuditRequest): string {
  return [
    `Name: ${row.name}`,
    `Email: ${row.email}`,
    `Phone: ${row.phone ?? 'not given'}`,
    `Business: ${row.business_name}`,
    `Region: ${row.region}`,
    `Source: ${row.source}`,
  ].join('\n');
}

async function rescheduled(deps: CalWebhookDeps, p: Record<string, unknown>): Promise<WebhookOutcome> {
  const newUid = str(p.uid);
  const oldUid = str(p.rescheduleUid);
  const start = new Date(str(p.startTime));
  if (!isBookingUid(newUid) || Number.isNaN(start.getTime())) throw new BadPayload('reschedule without a new uid or start time');

  const row = isBookingUid(oldUid) ? await deps.store.findByBookingUid(oldUid) : null;
  if (!row) {
    // Cal.com redelivers webhooks, and a row already moved to the new uid is not a problem.
    return (await deps.store.findByBookingUid(newUid)) ? 'already_applied' : 'unknown_booking';
  }

  const was = when(row.slot_start, row.timezone);
  const video = str((p.metadata as Record<string, unknown> | undefined)?.videoCallUrl);
  const updated = await deps.store.updateRequest(row.id, {
    booking_uid: newUid,
    slot_start: start.toISOString(),
    status: 'booked',
    reschedule_url: fillTemplate(deps.config.rescheduleUrlTemplate, newUid),
    cancel_url: fillTemplate(deps.config.cancelUrlTemplate, newUid),
    meet_link: /^https?:\/\//.test(video) ? video : row.meet_link,
  });
  if (!updated) return 'unknown_booking';

  const now = when(updated.slot_start, updated.timezone);
  await Promise.all([
    deps.notifier.slack(
      `Audit rescheduled · ${updated.region} · ${slackSafe(updated.business_name, 80)} · was ${was} · now ${now} · ${slackSafe(updated.email, 80)} · via ${updated.source}`,
    ),
    deps.notifier.email(
      `Audit rescheduled: ${updated.business_name} (${updated.region})`,
      `Rescheduled\nWas: ${was}\nNow: ${now}\n${updated.meet_link ? `Meet: ${updated.meet_link}\n` : ''}\n${detailsBlock(updated)}`,
    ),
  ]);
  return 'rescheduled';
}

async function cancelled(deps: CalWebhookDeps, p: Record<string, unknown>): Promise<WebhookOutcome> {
  const uid = str(p.uid);
  if (!isBookingUid(uid)) throw new BadPayload('cancellation without a uid');

  const row = await deps.store.findByBookingUid(uid);
  if (!row || row.type !== 'call') return 'unknown_booking';
  if (row.status === 'cancelled') return 'already_applied';

  const was = when(row.slot_start, row.timezone);
  const updated = await deps.store.updateRequest(row.id, { status: 'cancelled' });
  if (!updated) return 'unknown_booking';

  const reason = str(p.cancellationReason).trim();
  await Promise.all([
    deps.notifier.slack(
      `Audit cancelled · ${updated.region} · ${slackSafe(updated.business_name, 80)} · was ${was} · ${slackSafe(updated.email, 80)}${reason ? ` · "${slackSafe(reason, 120)}"` : ''} · via ${updated.source}`,
    ),
    deps.notifier.email(
      `Audit cancelled: ${updated.business_name} (${updated.region})`,
      `Cancelled\nWas: ${was}\n${reason ? `Reason: ${reason}\n` : ''}\n${detailsBlock(updated)}`,
    ),
  ]);
  return 'cancelled';
}

/** Applies one verified Cal.com webhook event to the matching request. Other triggers (PING and so on) are ignored. */
export async function handleCalEvent(deps: CalWebhookDeps, event: { triggerEvent?: unknown; payload?: unknown }): Promise<WebhookOutcome> {
  const payload = (event.payload && typeof event.payload === 'object' ? event.payload : {}) as Record<string, unknown>;
  switch (event.triggerEvent) {
    case 'BOOKING_RESCHEDULED':
      return rescheduled(deps, payload);
    case 'BOOKING_CANCELLED':
      return cancelled(deps, payload);
    default:
      return 'ignored';
  }
}

export function createCalWebhookRoutes(deps: CalWebhookDeps): Hono {
  const app = new Hono();

  app.post(
    '/webhooks/cal',
    bodyLimit({ maxSize: 512 * 1024, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }),
    async (c) => {
      const secret = deps.config.calWebhookSecret;
      if (!secret) return c.json({ error: 'webhook_not_configured' }, 503);

      const raw = await c.req.text();
      const received = (c.req.header('x-cal-signature-256') ?? '').trim().toLowerCase().replace(/^sha256=/, '');
      if (!received || !safeEqual(await calSignature(secret, raw), received)) {
        console.warn('[cal-webhook] rejected: bad or missing signature');
        return c.json({ error: 'invalid_signature' }, 401);
      }

      let event: { triggerEvent?: unknown; payload?: unknown };
      try {
        event = JSON.parse(raw);
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }

      try {
        const outcome = await handleCalEvent(deps, event);
        console.log(`[cal-webhook] ${String(event.triggerEvent)} -> ${outcome}`);
        return c.json({ ok: true, outcome });
      } catch (e) {
        if (e instanceof BadPayload) return c.json({ error: 'invalid_payload', message: e.message }, 400);
        const message = (e as Error).message;
        console.error(`[cal-webhook] ${String(event.triggerEvent)} failed: ${message}`);
        // A change we could not apply is never silent: the team updates the lead by hand.
        await deps.notifier.email(
          'Cal.com change not synced',
          `A ${String(event.triggerEvent)} webhook could not be applied (${message}).\nBooking uid: ${str((event.payload as Record<string, unknown> | undefined)?.uid)}\nUpdate the lead in Supabase by hand.`,
        );
        return c.json({ error: 'sync_failed' }, 500);
      }
    },
  );

  return app;
}
