import { handle } from 'hono/vercel';
import { createAppFromEnv } from '../src/app.js';

export const config = { runtime: 'nodejs' };

let app: ReturnType<typeof createAppFromEnv> | undefined;

// Built on first request so a bad configuration shows up in the function logs, not at deploy time.
export default handle({
  fetch: (req: Request) => (app ??= createAppFromEnv(process.env)).fetch(req),
} as never);
