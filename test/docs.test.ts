import { describe, expect, it } from 'vitest';
import { makeHarness } from './helpers.js';

describe('/docs', () => {
  it('serves a public page with the endpoint, sign-in, tools and policy links', async () => {
    const h = makeHarness();
    const res = await h.app.request('/docs');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('https://connect.example.test/mcp');
    expect(html).toContain('/.well-known/oauth-authorization-server');
    for (const tool of ['check_audit_availability', 'book_audit_call', 'request_written_audit', 'get_audit_request_status']) {
      expect(html).toContain(tool);
    }
    expect(html).toContain('PKCE');
    expect(html).toContain('href="https://www.strategent.app/privacy-policy"');
    expect(html).toContain('href="https://www.strategent.app/terms-of-service"');
  });
  it('shows the configured limits and has no em dashes', async () => {
    const h = makeHarness({ config: { PER_EMAIL_DAILY_CAP: '5', BOOKING_HOURLY_CAP: '7', WRITTEN_OPEN_CAP: '4' } });
    const html = await (await h.app.request('/docs')).text();
    expect(html).toContain('Up to 5 requests per email address per day, 7 bookings per hour overall, and 4 open');
    expect(html).not.toContain('—');
  });
});
