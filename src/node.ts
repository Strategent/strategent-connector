import { serve } from '@hono/node-server';
import { createAppFromEnv } from './app.js';

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: createAppFromEnv(process.env).fetch, port }, (info) => {
  console.log(`Strategent connector listening on http://localhost:${info.port} (MCP at /mcp)`);
});
