import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { createCalClient } from './cal.js';
import { createCalWebhookRoutes } from './calWebhook.js';
import { loadConfig, missingConfig, type Config } from './config.js';
import { docsPage } from './docs.js';
import { createMcpServer } from './mcp.js';
import { createNotifier, type Notifier } from './notify.js';
import { authenticate, createOAuthRoutes, unauthorizedResponse } from './oauth.js';
import type { SchedulerApi } from './scheduler.js';
import { SupabaseStore, type Store } from './store.js';

export interface AppDeps {
  config: Config;
  scheduler: SchedulerApi;
  store: Store;
  notifier: Notifier;
  now?: () => Date;
}

export function createApp(deps: AppDeps): Hono {
  const now = deps.now ?? (() => new Date());
  const { config } = deps;
  const app = new Hono();

  app.get('/', (c) => c.text('Strategent AI Readiness Audit connector. MCP endpoint: /mcp. Documentation: /docs'));
  app.get('/health', (c) => c.json({ ok: true }));
  app.get('/docs', (c) => c.html(docsPage(config)));
  app.get('/privacy', (c) => c.redirect(config.privacyUrl, 302));
  app.get('/terms', (c) => c.redirect(config.termsUrl, 302));

  app.route('/', createOAuthRoutes({ config, store: deps.store, now }));
  app.route('/', createCalWebhookRoutes({ config, store: deps.store, notifier: deps.notifier }));

  app.use('/mcp', cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type', 'Accept', 'Mcp-Session-Id', 'Mcp-Protocol-Version'], exposeHeaders: ['WWW-Authenticate', 'Mcp-Session-Id'] }));
  app.use('/mcp', bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }));

  app.all('/mcp', async (c) => {
    const auth = await authenticate({ config, store: deps.store, now }, c.req.header('Authorization'));
    if (!auth.ok) return unauthorizedResponse(config, auth.error);

    // Stateless: a fresh server and transport per request, so any instance can answer any call.
    const server = createMcpServer(
      { config, scheduler: deps.scheduler, store: deps.store, notifier: deps.notifier, now },
      auth.principal,
    );
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      // Responses are fully buffered in JSON mode, so the server can be released right away.
      await server.close().catch(() => undefined);
    }
  });

  app.onError((err, c) => {
    console.error(`[app] ${err.stack ?? err.message}`);
    return c.json({ error: 'server_error' }, 500);
  });

  return app;
}

/** Production wiring from environment variables. Fails fast with a list of what is missing. */
export function createAppFromEnv(env: Record<string, string | undefined>): Hono {
  const config = loadConfig(env);
  const missing = missingConfig(config);
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(', ')}`);
  return createApp({
    config,
    scheduler: createCalClient(config),
    store: new SupabaseStore(config),
    notifier: createNotifier(config),
  });
}
