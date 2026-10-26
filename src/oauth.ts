import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Config } from './config.js';
import { randomId, sha256b64url, signClaims, verifyClaims, safeEqual } from './crypto.js';
import type { Store } from './store.js';

// Self-contained OAuth 2.1 for a "guest" grant: the Muse user is identified by a random id and
// shares nothing but that id. State is carried in signed tokens, so there is nothing to host.
//   client_id      signed, holds the registered redirect URIs        (purpose "client")
//   authreq        signed form state on the consent page             (purpose "authreq", 10 min)
//   code           signed, single-use, PKCE-bound                    (purpose "code", 5 min)
//   access token   signed, 1 hour                                    (purpose "access")
//   refresh token  signed, 30 days                                   (purpose "refresh")

const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 86400;
const CODE_TTL = 300;
const SCOPE = 'audit';

export interface Principal {
  sub: string;
  /** Short hash of the registered client, safe to log. */
  clientId: string;
  /** Which surface the user came from, for lead attribution. */
  source: string;
}

export function sourceFromClientName(name: string): string {
  if (/claude|anthropic/i.test(name)) return 'claude';
  if (/chatgpt|openai/i.test(name)) return 'chatgpt';
  if (/muse|meta/i.test(name)) return 'muse';
  return 'other';
}

interface Deps {
  config: Config;
  store: Store;
  now: () => Date;
}

const nowSec = (d: Deps) => Math.floor(d.now().getTime() / 1000);

function oauthError(error: string, description: string, status = 400) {
  return Response.json({ error, error_description: description }, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function validRedirectUri(uri: string, allowedHosts: string[]): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return false;
  if (allowedHosts.length && !local) {
    return allowedHosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
  }
  return true;
}

export function resourceMetadata(config: Config) {
  return {
    resource: `${config.baseUrl}/mcp`,
    authorization_servers: [config.baseUrl],
    bearer_methods_supported: ['header'],
    scopes_supported: [SCOPE],
    resource_name: 'Strategent AI Readiness Audit',
  };
}

export function authServerMetadata(config: Config) {
  return {
    issuer: config.baseUrl,
    authorization_endpoint: `${config.baseUrl}/oauth/authorize`,
    token_endpoint: `${config.baseUrl}/oauth/token`,
    registration_endpoint: `${config.baseUrl}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
    service_documentation: config.privacyUrl,
  };
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function consentPage(config: Config, clientName: string, authreq: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect to Strategent</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#f6f6f4;color:#1a1a1a}main{max-width:440px;margin:8vh auto;padding:24px;background:#fff;border-radius:12px}
h1{font-size:1.25rem;margin:0 0 12px}p{margin:0 0 12px}button{font:inherit;width:100%;padding:12px;border:0;border-radius:8px;background:#1a1a1a;color:#fff;cursor:pointer}a{color:inherit}</style></head>
<body><main><h1>Connect ${esc(clientName)} to Strategent</h1>
<p>This lets ${esc(clientName)} look up open times for a free AI Readiness Audit and book one for you.</p>
<p>Strategent receives only what you choose to share in the chat, such as your name, email and business details. We use it to contact you about your audit.</p>
<p><a href="${esc(config.privacyUrl)}">Privacy</a> · <a href="${esc(config.termsUrl)}">Terms</a></p>
<form method="post" action="/oauth/authorize"><input type="hidden" name="authreq" value="${esc(authreq)}"><button type="submit">Continue</button></form>
</main></body></html>`;
}

interface ClientClaims {
  ru: string[];
  nm: string;
  exp: number;
  [k: string]: unknown;
}
interface AuthReqClaims {
  cid: string;
  ru: string;
  cc: string;
  st: string;
  src: string;
  exp: number;
  [k: string]: unknown;
}
interface CodeClaims {
  cid: string;
  ru: string;
  cc: string;
  src: string;
  sub: string;
  jti: string;
  exp: number;
  [k: string]: unknown;
}
interface TokenClaims {
  sub: string;
  cid: string;
  src: string;
  exp: number;
  [k: string]: unknown;
}

export function createOAuthRoutes(deps: Deps): Hono {
  const app = new Hono();
  const { config, store } = deps;
  const secret = config.signingSecret;

  app.use('/.well-known/*', cors());
  app.use('/oauth/register', cors());
  app.use('/oauth/token', cors());

  app.get('/.well-known/oauth-authorization-server', (c) => c.json(authServerMetadata(config)));
  app.get('/.well-known/oauth-protected-resource', (c) => c.json(resourceMetadata(config)));
  app.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json(resourceMetadata(config)));

  // RFC 7591 dynamic client registration. Public clients only.
  app.post('/oauth/register', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const uris = body?.redirect_uris;
    if (!Array.isArray(uris) || uris.length < 1 || uris.length > 10 || !uris.every((u) => typeof u === 'string' && u.length < 500)) {
      return oauthError('invalid_redirect_uri', 'redirect_uris must be a list of 1 to 10 URLs');
    }
    if (!uris.every((u: string) => validRedirectUri(u, config.allowedRedirectHosts))) {
      return oauthError('invalid_redirect_uri', 'redirect_uris must be https URLs (http only for localhost)');
    }
    const name = typeof body?.client_name === 'string' ? body.client_name.slice(0, 80) : 'Your assistant';
    const issuedAt = nowSec(deps);
    const clientId = await signClaims(secret, 'client', { ru: uris, nm: name, exp: issuedAt + 365 * 86400 });
    return c.json(
      {
        client_id: clientId,
        client_id_issued_at: issuedAt,
        client_name: name,
        redirect_uris: uris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: SCOPE,
      },
      201,
    );
  });

  async function readClient(clientId: string | undefined) {
    if (!clientId) return null;
    const v = await verifyClaims<ClientClaims>(secret, 'client', clientId, nowSec(deps));
    return v.ok ? v.claims : null;
  }

  app.get('/oauth/authorize', async (c) => {
    const q = c.req.query();
    const client = await readClient(q.client_id);
    // Until the client and redirect URI are proven valid we must not redirect anywhere.
    if (!client) return c.text('Unknown or expired client. Reconnect from your assistant.', 400);
    if (!q.redirect_uri || !client.ru.includes(q.redirect_uri)) return c.text('redirect_uri does not match the registration.', 400);

    const back = (error: string, description: string) => {
      const u = new URL(q.redirect_uri!);
      u.searchParams.set('error', error);
      u.searchParams.set('error_description', description);
      if (q.state) u.searchParams.set('state', q.state);
      return c.redirect(u.toString(), 302);
    };
    if (q.response_type !== 'code') return back('unsupported_response_type', 'Only response_type=code is supported');
    if (!q.code_challenge || q.code_challenge_method !== 'S256') return back('invalid_request', 'PKCE with S256 is required');

    const authreq = await signClaims(secret, 'authreq', {
      cid: q.client_id,
      ru: q.redirect_uri,
      cc: q.code_challenge,
      st: q.state ?? '',
      src: sourceFromClientName(client.nm),
      exp: nowSec(deps) + 600,
    });
    c.header('Cache-Control', 'no-store');
    c.header('X-Frame-Options', 'DENY');
    return c.html(consentPage(config, client.nm, authreq));
  });

  app.post('/oauth/authorize', async (c) => {
    const form = await c.req.parseBody();
    const token = typeof form.authreq === 'string' ? form.authreq : '';
    const v = await verifyClaims<AuthReqClaims>(secret, 'authreq', token, nowSec(deps));
    if (!v.ok) return c.text('This page expired. Go back to your assistant and connect again.', 400);
    const a = v.claims;
    const code = await signClaims(secret, 'code', {
      cid: a.cid,
      ru: a.ru,
      cc: a.cc,
      src: a.src,
      sub: `guest_${randomId(12)}`,
      jti: randomId(12),
      exp: nowSec(deps) + CODE_TTL,
    });
    const u = new URL(a.ru);
    u.searchParams.set('code', code);
    if (a.st) u.searchParams.set('state', a.st);
    c.header('Cache-Control', 'no-store');
    return c.redirect(u.toString(), 302);
  });

  const shortId = async (clientId: string) => (await sha256b64url(clientId)).slice(0, 16);

  async function issueTokens(sub: string, cidShort: string, src: string) {
    const t = nowSec(deps);
    return {
      access_token: await signClaims(secret, 'access', { sub, cid: cidShort, src, exp: t + ACCESS_TTL }),
      token_type: 'Bearer',
      expires_in: ACCESS_TTL,
      refresh_token: await signClaims(secret, 'refresh', { sub, cid: cidShort, src, exp: t + REFRESH_TTL }),
      scope: SCOPE,
    };
  }

  app.post('/oauth/token', async (c) => {
    const f = await c.req.parseBody();
    const str = (k: string) => (typeof f[k] === 'string' ? (f[k] as string) : '');
    const noStore = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

    if (str('grant_type') === 'authorization_code') {
      const v = await verifyClaims<CodeClaims>(secret, 'code', str('code'), nowSec(deps));
      if (!v.ok) return oauthError('invalid_grant', 'The authorization code is invalid or expired');
      const k = v.claims;
      if (str('client_id') !== k.cid) return oauthError('invalid_grant', 'client_id does not match the code');
      if (str('redirect_uri') !== k.ru) return oauthError('invalid_grant', 'redirect_uri does not match the code');
      const verifier = str('code_verifier');
      if (verifier.length < 43 || verifier.length > 128) return oauthError('invalid_grant', 'code_verifier is missing or malformed');
      if (!safeEqual(await sha256b64url(verifier), k.cc)) return oauthError('invalid_grant', 'PKCE verification failed');
      let first = false;
      try {
        first = await store.claimOnce(`code:${k.jti}`, CODE_TTL * 2);
      } catch {
        return oauthError('server_error', 'Could not complete sign-in. Please try again.', 503);
      }
      if (!first) return oauthError('invalid_grant', 'The authorization code was already used');
      return new Response(JSON.stringify(await issueTokens(k.sub, await shortId(k.cid), k.src)), {
        headers: { 'Content-Type': 'application/json', ...noStore },
      });
    }

    if (str('grant_type') === 'refresh_token') {
      const v = await verifyClaims<TokenClaims>(secret, 'refresh', str('refresh_token'), nowSec(deps));
      if (!v.ok) return oauthError('invalid_grant', 'The refresh token is invalid or expired');
      if (str('client_id') && (await shortId(str('client_id'))) !== v.claims.cid) {
        return oauthError('invalid_grant', 'client_id does not match');
      }
      return new Response(JSON.stringify(await issueTokens(v.claims.sub, v.claims.cid, v.claims.src)), {
        headers: { 'Content-Type': 'application/json', ...noStore },
      });
    }

    return oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token');
  });

  return app;
}

export type AuthResult =
  | { ok: true; principal: Principal }
  | { ok: false; error: 'missing' | 'invalid' | 'expired' };

export async function authenticate(deps: Deps, header: string | undefined): Promise<AuthResult> {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!m) return { ok: false, error: 'missing' };
  const v = await verifyClaims<TokenClaims>(deps.config.signingSecret, 'access', m[1]!.trim(), nowSec(deps));
  if (!v.ok) return { ok: false, error: v.reason === 'expired' ? 'expired' : 'invalid' };
  return { ok: true, principal: { sub: v.claims.sub, clientId: v.claims.cid, source: v.claims.src ?? 'other' } };
}

export function unauthorizedResponse(config: Config, error: 'missing' | 'invalid' | 'expired'): Response {
  const meta = `${config.baseUrl}/.well-known/oauth-protected-resource`;
  const attrs =
    error === 'missing'
      ? `Bearer resource_metadata="${meta}"`
      : `Bearer resource_metadata="${meta}", error="invalid_token", error_description="${
          error === 'expired' ? 'The access token expired' : 'The access token is invalid'
        }"`;
  return Response.json(
    { error: 'unauthorized', message: 'Sign in to Strategent to continue. Reconnect the connector if this keeps happening.' },
    { status: 401, headers: { 'WWW-Authenticate': attrs } },
  );
}
