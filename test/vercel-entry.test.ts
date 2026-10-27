import { describe, expect, it } from 'vitest';
import entry from '../api/index.js';

describe('Vercel entrypoint', () => {
  // A bare default-exported function is run as `(req, res)` by Vercel's Node runtime, which drops the returned
  // Response and hangs every request. It has to be an object with a `fetch` method.
  it('default-exports a Web-standard { fetch } handler, not a bare function', () => {
    expect(typeof entry).toBe('object');
    expect(typeof entry.fetch).toBe('function');
  });

  it('serves /health and refuses an unauthenticated /mcp call once configured', async () => {
    Object.assign(process.env, {
      SIGNING_SECRET: 'x'.repeat(40),
      CAL_API_KEY: 'test',
      CAL_EVENT_TYPE_ID: '1',
      BOOKING_PAGE_URL: 'cal.com/test/audit',
      SUPABASE_URL: 'https://example.invalid',
      SUPABASE_SERVICE_KEY: 'test',
    });
    const health = await entry.fetch(new Request('https://connect.example/health'));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const mcp = await entry.fetch(new Request('https://connect.example/mcp', { method: 'POST', body: '{}' }));
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get('www-authenticate')).toBeTruthy();
  });
});
