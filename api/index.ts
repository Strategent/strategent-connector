import { createAppFromEnv } from '../src/app.js';

let app: ReturnType<typeof createAppFromEnv> | undefined;

// Vercel's Node runtime reads a default-exported `{ fetch }` as a Web-standard handler. A bare function (what
// `hono/vercel`'s handle() returns) is read as `(req, res)`, so its returned Response is dropped and every request hangs.
// Built on first request so a bad configuration shows up in the function logs, not at deploy time.
export default {
  fetch: (req: Request) => (app ??= createAppFromEnv(process.env)).fetch(req),
};
