import { describe, expect, it, vi } from 'vitest';
import { createNotifier } from '../src/notify.js';
import { testConfig } from './helpers.js';

const ok = () => new Response('ok', { status: 200 });

describe('notifier', () => {
  it('posts the alert text to the Slack webhook', async () => {
    const fetchMock = vi.fn(async () => ok());
    const n = createNotifier(testConfig({ SLACK_WEBHOOK_URL: 'https://hooks.slack.test/T/B/X' }), fetchMock as never);
    await n.slack('New audit call');
    expect(fetchMock).toHaveBeenCalledWith('https://hooks.slack.test/T/B/X', expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'New audit call' }) }));
  });

  it('does nothing when Slack or email are not configured', async () => {
    const fetchMock = vi.fn(async () => ok());
    const n = createNotifier(testConfig(), fetchMock as never);
    await n.slack('x');
    await n.email('s', 't');
    await n.emailRequester('a@b.test', 's', 't');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws when Slack or the email provider fail', async () => {
    const boom = vi.fn(async () => {
      throw new Error('network down');
    });
    const bad = vi.fn(async () => new Response('no', { status: 500 }));
    for (const f of [boom, bad]) {
      const n = createNotifier(testConfig({ SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x', RESEND_API_KEY: 'k' }), f as never);
      await expect(n.slack('x')).resolves.toBeUndefined();
      await expect(n.email('s', 't')).resolves.toBeUndefined();
    }
  });

  it('sends the ops email to info@strategent.app through Resend', async () => {
    const fetchMock = vi.fn(async () => ok());
    const n = createNotifier(testConfig({ RESEND_API_KEY: 'rk' }), fetchMock as never);
    await n.email('New audit call: Harbor Inn', 'details');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer rk');
    expect(JSON.parse(init.body as string)).toMatchObject({ to: ['info@strategent.app'], subject: 'New audit call: Harbor Inn', text: 'details' });
  });

  it('only emails the requester when SEND_REQUESTER_ACK=true', async () => {
    const off = vi.fn(async () => ok());
    await createNotifier(testConfig({ RESEND_API_KEY: 'rk' }), off as never).emailRequester('sam@x.test', 's', 't');
    expect(off).not.toHaveBeenCalled();

    const on = vi.fn(async () => ok());
    await createNotifier(testConfig({ RESEND_API_KEY: 'rk', SEND_REQUESTER_ACK: 'true' }), on as never).emailRequester('sam@x.test', 's', 't');
    expect(JSON.parse((on.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).to).toEqual(['sam@x.test']);
  });
});
