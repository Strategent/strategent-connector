import { describe, expect, it } from 'vitest';
import { sha256b64url } from '../src/crypto.js';
import { callTool, makeHarness, rpc, signIn } from './helpers.js';

describe('discovery', () => {
  it('serves both metadata documents', async () => {
    const h = makeHarness();
    const as = await (await h.app.request('/.well-known/oauth-authorization-server')).json();
    expect(as).toMatchObject({
      issuer: 'https://connect.example.test',
      registration_endpoint: 'https://connect.example.test/oauth/register',
      code_challenge_methods_supported: ['S256'],
    });
    const pr = await (await h.app.request('/.well-known/oauth-protected-resource')).json();
    expect(pr).toMatchObject({ resource: 'https://connect.example.test/mcp', authorization_servers: ['https://connect.example.test'] });
  });
  it('redirects /privacy and /terms to the site', async () => {
    const h = makeHarness();
    const p = await h.app.request('/privacy');
    expect(p.status).toBe(302);
    expect(p.headers.get('location')).toBe('https://www.strategent.app/privacy-policy');
    expect((await h.app.request('/terms')).headers.get('location')).toBe('https://www.strategent.app/terms-of-service');
  });
  it('links the same pages from the sign-in page and the OAuth metadata', async () => {
    const h = makeHarness();
    const redirect = 'https://muse.example.test/callback';
    const reg = (await (await h.app.request('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirect] }) })).json()) as any;
    const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, code_challenge: await sha256b64url('v'.repeat(64)), code_challenge_method: 'S256' });
    const html = await (await h.app.request(`/oauth/authorize?${q}`)).text();
    expect(html).toContain('href="https://www.strategent.app/privacy-policy"');
    expect(html).toContain('href="https://www.strategent.app/terms-of-service"');
    const as = (await (await h.app.request('/.well-known/oauth-authorization-server')).json()) as any;
    expect(as.service_documentation).toBe('https://www.strategent.app/privacy-policy');
  });
});

describe('registration', () => {
  const post = (h: ReturnType<typeof makeHarness>, body: unknown) =>
    h.app.request('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('registers a public client', async () => {
    const res = await post(makeHarness(), { client_name: 'Meta Muse', redirect_uris: ['https://muse.example.test/cb'] });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] });
  });
  it.each([
    ['no uris', { client_name: 'x' }],
    ['plain http', { redirect_uris: ['http://evil.test/cb'] }],
    ['javascript scheme', { redirect_uris: ['javascript:alert(1)'] }],
    ['fragment', { redirect_uris: ['https://a.test/cb#x'] }],
  ])('rejects %s', async (_n, body) => {
    expect((await post(makeHarness(), body)).status).toBe(400);
  });
  it('allows http only for localhost', async () => {
    expect((await post(makeHarness(), { redirect_uris: ['http://localhost:8080/cb'] })).status).toBe(201);
  });
  it('honours an allowlist of redirect hosts', async () => {
    const h = makeHarness({ config: { ALLOWED_REDIRECT_HOSTS: 'meta.com' } });
    expect((await post(h, { redirect_uris: ['https://muse.meta.com/cb'] })).status).toBe(201);
    expect((await post(h, { redirect_uris: ['https://evil.test/cb'] })).status).toBe(400);
  });
});

describe('authorization code flow', () => {
  it('completes with PKCE and the token works on /mcp', async () => {
    const h = makeHarness();
    const t = await signIn(h);
    expect(t.state).toBe('xyz');
    expect(t.access_token).toBeTruthy();
    const res = await callTool(h, t.access_token, 'get_audit_request_status', { email: 'a@b.test' });
    expect(res.text).toMatch(/No request found/);
  });

  it('refuses to redirect for an unknown client or a redirect_uri that was not registered', async () => {
    const h = makeHarness();
    const res = await h.app.request('/oauth/authorize?client_id=nope&redirect_uri=https://evil.test/cb&response_type=code');
    expect(res.status).toBe(400);
    const reg = await (await h.app.request('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://ok.test/cb'] }) })).json();
    const bad = await h.app.request(`/oauth/authorize?client_id=${encodeURIComponent((reg as any).client_id)}&redirect_uri=https://evil.test/cb&response_type=code`);
    expect(bad.status).toBe(400);
  });

  it('requires PKCE', async () => {
    const h = makeHarness();
    const reg = (await (await h.app.request('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://ok.test/cb'] }) })).json()) as any;
    const res = await h.app.request(`/oauth/authorize?client_id=${encodeURIComponent(reg.client_id)}&redirect_uri=https://ok.test/cb&response_type=code`);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');
  });

  it('rejects a wrong code_verifier', async () => {
    const h = makeHarness();
    const t = await signIn(h);
    // Reuse a fresh code is impossible, so run a second flow and tamper with the verifier.
    const t2 = await signInRaw(h);
    const res = await tokenRequest(h, { grant_type: 'authorization_code', code: t2.code, client_id: t2.clientId, redirect_uri: t2.redirect, code_verifier: 'x'.repeat(64) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe('invalid_grant');
    expect(t.access_token).toBeTruthy();
  });

  it('makes codes single-use', async () => {
    const h = makeHarness();
    const t = await signIn(h);
    const again = await tokenRequest(h, { grant_type: 'authorization_code', code: t.code, client_id: t.clientId, redirect_uri: t.redirect, code_verifier: t.verifier });
    expect(again.status).toBe(400);
    expect(((await again.json()) as any).error_description).toMatch(/already used/);
  });

  it('refreshes silently, and the new token works', async () => {
    const h = makeHarness();
    const t = await signIn(h);
    h.clock.now = new Date(h.clock.now.getTime() + 10_000);
    const res = await tokenRequest(h, { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId });
    expect(res.status).toBe(200);
    const fresh = (await res.json()) as any;
    expect(fresh.access_token).not.toBe(t.access_token);
    const out = await callTool(h, fresh.access_token, 'get_audit_request_status', { email: 'a@b.test' });
    expect(out.isError).toBe(false);
  });

  it('rejects a refresh token from a different client', async () => {
    const h = makeHarness();
    const a = await signIn(h);
    const b = await signIn(h, 'Other');
    const res = await tokenRequest(h, { grant_type: 'refresh_token', refresh_token: a.refresh_token, client_id: b.clientId });
    expect(res.status).toBe(400);
  });
});

describe('/mcp authentication', () => {
  it('returns 401 with discovery metadata when there is no token', async () => {
    const h = makeHarness();
    const res = await rpc(h, null, 'tools/list', {});
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata="https://connect.example.test/.well-known/oauth-protected-resource"');
  });

  it('returns 401 invalid_token once the access token expires, so the client refreshes', async () => {
    const h = makeHarness();
    const t = await signIn(h);
    h.clock.now = new Date(h.clock.now.getTime() + 3601 * 1000);
    const res = await rpc(h, t.access_token, 'tools/list', {});
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
    // The refresh token is still good, and the new access token works.
    const r = await tokenRequest(h, { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId });
    const fresh = (await r.json()) as any;
    expect((await rpc(h, fresh.access_token, 'tools/list', {})).status).toBe(200);
  });

  it('rejects a forged or foreign token', async () => {
    const h = makeHarness();
    const other = makeHarness({ config: { SIGNING_SECRET: 'a-completely-different-secret-value-99' } });
    const foreign = await signIn(other);
    expect((await rpc(h, foreign.access_token, 'tools/list', {})).status).toBe(401);
    expect((await rpc(h, 'garbage', 'tools/list', {})).status).toBe(401);
  });

  it('does not accept a refresh token as an access token', async () => {
    const h = makeHarness();
    const t = await signIn(h);
    expect((await rpc(h, t.refresh_token, 'tools/list', {})).status).toBe(401);
  });
});

function tokenRequest(h: ReturnType<typeof makeHarness>, body: Record<string, string>) {
  return h.app.request('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
}

/** Like signIn, but stops before the token exchange so a test can tamper with it. */
async function signInRaw(h: ReturnType<typeof makeHarness>) {
  const redirect = 'https://muse.example.test/callback';
  const reg = (await (await h.app.request('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirect] }) })).json()) as any;
  const verifier = 'v'.repeat(64);
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, code_challenge: await sha256b64url(verifier), code_challenge_method: 'S256' });
  const html = await (await h.app.request(`/oauth/authorize?${q}`)).text();
  const authreq = /name="authreq" value="([^"]+)"/.exec(html)![1]!;
  const consent = await h.app.request('/oauth/authorize', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ authreq }) });
  return { code: new URL(consent.headers.get('location')!).searchParams.get('code')!, clientId: reg.client_id as string, redirect };
}
