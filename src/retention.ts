import { Hono } from 'hono';
import type { Config } from './config.js';
import { safeEqual } from './crypto.js';
import type { Notifier } from './notify.js';
import type { Store } from './store.js';

/**
 * How long records are kept. These numbers are promised in the privacy policy (sections 3.5 and 10) and in the Muse
 * data questionnaire. Change the policy first, then these.
 */
export const RETENTION_MONTHS = { auditRequests: 12, toolLogs: 12 } as const;

/** The same day of the month `months` earlier in UTC, clamped to the last day of a shorter month. */
export function monthsAgo(from: Date, months: number): Date {
  const first = Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - months, 1, from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds(), from.getUTCMilliseconds());
  const target = new Date(first);
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(from.getUTCDate(), lastDay));
  return target;
}

export interface RetentionDeps {
  config: Config;
  store: Store;
  notifier: Notifier;
  now: () => Date;
}

/** Vercel Cron calls this daily with `Authorization: Bearer $CRON_SECRET`. */
export function createRetentionRoutes(deps: RetentionDeps): Hono {
  const app = new Hono();

  app.get('/cron/retention', async (c) => {
    const secret = deps.config.cronSecret;
    if (!secret) return c.json({ error: 'retention_not_configured' }, 503);
    const sent = (c.req.header('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!sent || !safeEqual(sent, secret)) return c.json({ error: 'unauthorized' }, 401);

    const now = deps.now();
    const cutoffs = {
      requestsBefore: monthsAgo(now, RETENTION_MONTHS.auditRequests),
      logsBefore: monthsAgo(now, RETENTION_MONTHS.toolLogs),
      now,
    };
    try {
      const deleted = await deps.store.purge(cutoffs);
      console.log(`[retention] deleted ${JSON.stringify(deleted)}`);
      return c.json({ ok: true, deleted, requests_before: cutoffs.requestsBefore.toISOString(), logs_before: cutoffs.logsBefore.toISOString() });
    } catch (e) {
      const message = (e as Error).message;
      console.error(`[retention] failed: ${message}`);
      // The policy promises deletion, so a failed run is never silent.
      await deps.notifier.email('Retention cleanup failed', `The daily retention job could not finish (${message}).\nOld records are still in the database until it succeeds. Check the Vercel logs for /cron/retention.`);
      return c.json({ error: 'retention_failed' }, 500);
    }
  });

  return app;
}
