import type { Config } from './config.js';

export interface Notifier {
  slack(text: string): Promise<void>;
  email(subject: string, text: string): Promise<void>;
  /** Acknowledgement to the person who asked, when SEND_REQUESTER_ACK is on. */
  emailRequester(to: string, subject: string, text: string): Promise<void>;
}

/** Neutralise Slack control sequences and mentions in user-supplied text. */
export function slackSafe(input: string, max = 300): string {
  return input
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@(channel|here|everyone)/gi, '@​$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function createNotifier(config: Config, fetchImpl: typeof fetch = fetch): Notifier {
  async function post(url: string, init: RequestInit, label: string) {
    try {
      const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(4000) });
      if (!res.ok) console.error(`[notify] ${label} failed with ${res.status}`);
    } catch (e) {
      console.error(`[notify] ${label} error: ${(e as Error).message}`);
    }
  }

  const sendEmail = (to: string, subject: string, text: string) =>
    post(
      'https://api.resend.com/emails',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: config.notifyEmailFrom, to: [to], subject, text }),
      },
      'email',
    );

  return {
    async slack(text) {
      if (!config.slackWebhookUrl) return;
      await post(
        config.slackWebhookUrl,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) },
        'slack',
      );
    },
    async email(subject, text) {
      if (!config.resendApiKey || !config.notifyEmailTo) return;
      await sendEmail(config.notifyEmailTo, subject, text);
    },
    async emailRequester(to, subject, text) {
      if (!config.resendApiKey || !config.sendRequesterAck) return;
      await sendEmail(to, subject, text);
    },
  };
}

/** Collects messages instead of sending them. Used in tests and local runs without credentials. */
export class MemoryNotifier implements Notifier {
  slackMessages: string[] = [];
  emails: { to: string; subject: string; text: string }[] = [];
  async slack(text: string) {
    this.slackMessages.push(text);
  }
  async email(subject: string, text: string) {
    this.emails.push({ to: 'ops', subject, text });
  }
  async emailRequester(to: string, subject: string, text: string) {
    this.emails.push({ to, subject, text });
  }
}
