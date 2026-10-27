# Strategent AI Readiness Audit connector

A remote MCP server that lets Meta Muse (and, with the same code, Claude and ChatGPT) book Strategent's free
AI Readiness Audit. Scheduling runs on Cal.com. Every lead lands in one Supabase table and in Slack.

```
Muse  ->  POST /mcp  (OAuth bearer)  ->  4 tools  ->  Cal.com API    (availability, booking)
                                                  ->  Supabase       (audit_requests, tool_logs)
                                                  ->  Slack + email  (lead alert)
```

Status: code complete and tested against fakes and a mocked Cal.com (130 tests). **The Cal.com client has been run
live** (27 Oct 2026): `npm run cal:setup` and one real test booking, made through the same `src/cal.ts` client the
server uses. **Not yet run live:** the deployed server, OAuth, Supabase, Slack, email, or Muse.

## Tools

| Tool | What it does | Writes |
|---|---|---|
| `check_audit_availability` | Up to 8 open 30-minute slots in the next 14 days, in the user's timezone | nothing |
| `book_audit_call` | Books a slot in Cal.com, saves the lead, alerts the team | Cal.com, Supabase, Slack, email |
| `request_written_audit` | Saves a written-audit request, alerts the team | Supabase, Slack, email |
| `get_audit_request_status` | Status of requests made through the same connection | nothing |

Descriptions are in `src/copy.ts`, verbatim from the brief. All brand copy lives in that one file.

## Endpoints

- `POST /mcp` streamable HTTP, stateless, JSON responses
- `GET /.well-known/oauth-authorization-server`, `GET /.well-known/oauth-protected-resource`
- `POST /oauth/register` (dynamic client registration), `GET|POST /oauth/authorize`, `POST /oauth/token`
- `GET /privacy`, `GET /terms` redirect to the privacy policy and terms of service on strategent.app (`/privacy-policy`
  and `/terms-of-service`). The sign-in page and the OAuth metadata link to the same pages.
- `POST /webhooks/cal` Cal.com webhook receiver for reschedules and cancellations (signed; off until `CAL_WEBHOOK_SECRET` is set)
- `GET /health`
- `GET /docs`: public documentation page (endpoint, sign-in, tools, limits). Give this URL to Muse as the API or MCP documentation link.

## Go live

1. **Cal.com (Ruchi).** Create the event type **AI Readiness Audit**: 30 minutes, URL slug `audit`, location Google
   Meet (install and connect the Google Calendar app first so Meet is available). In the event's Limits settings:
   buffer after 15 minutes, minimum notice 4 hours, max 3 bookings per day. Set the availability schedule to the hours
   you and Nico actually hold. Host: you alone. Then create an API key (Settings, Developer, API keys) and share it
   through 1Password only.
   Menu names are from memory; Cal.com moves things around.

   **Already done for the Strategent account (26 Oct 2026, through the Cal.com connector):** event type
   `AI Readiness Audit` exists with id **7650820**, slug `audit`, 30 minutes, Google Meet, 15 minute buffer after,
   4 hour minimum notice, max 3 per day, and all seven booking questions as optional text fields. It uses a new
   schedule, "Audit calls" (id 2556615): Mon, Tue, Thu, Fri, 10am to 4pm Pacific. The account username was renamed
   from `strategent-eykb5a` to `strategent` on 27 Oct 2026, so the public page is `cal.com/strategent/audit` (the old
   URL now returns 404). The API key exists; it still needs to go into the host's environment variables.
2. **First live check.** `CAL_API_KEY=... npm run cal:setup` confirms the key and lists event types with their ids.
   Set `CAL_EVENT_TYPE_ID` and `BOOKING_PAGE_URL` (your public booking page, for example `cal.com/yourname/audit`) and
   run it again. Then:
   - `npm run cal:setup -- --create-fields` adds the seven booking questions to the event type (all optional), through
     Cal.com's API, so nobody has to click them in. They are: business name, website, city, industry, what is taking
     the most time, phone, and where to start with AI.
   - `npm run cal:setup -- --book you@example.com` makes **one real test booking**. Check three things: the booking
     succeeds, the Meet link appears, and the printed **reschedule and cancel links open** (see "Not verified"). Cancel
     the test booking afterwards.
3. **Supabase.** Run `supabase/schema.sql` in the SQL editor. Copy the project URL and service-role key.
4. **Slack and email.** Create `#leads` and add an incoming webhook. Create a Resend key and verify the sending domain.
5. **Deploy.** Vercel: import the repo, set the variables from `.env.example`, add the domain `connect.strategent.app`.
   `vercel.json` routes everything to `api/index.ts` and sets `"framework": null` (the "Other" preset). Without that,
   Vercel auto-detects Hono and the build fails with `TS2688: Cannot find type definition file for 'node'`.
   `tsconfig.json` pins `typeRoots` to `./node_modules/@types`, which also keeps that line out of the build log.
   Any Node host also works: `npm start` serves on `PORT`.
   Generate `SIGNING_SECRET` with `openssl rand -base64 48`.
6. **Smoke test.** `curl https://connect.strategent.app/health`, then open `/.well-known/oauth-authorization-server`.
   An unauthenticated `POST /mcp` must return 401 with a `WWW-Authenticate` header.
7. **Add to Muse.** Settings, Connectors, Add custom connector, URL `https://connect.strategent.app/mcp`. Then run the
   edge-case checklist from the brief in a live session. The automated version of that list is in
   `test/tools.test.ts` (tests marked `[checklist]`).
8. **Submit** at muse.ai/platform with the listing copy from the brief, the privacy and terms links, and a 60-second
   recording of a booking.

Optional: reminder emails (24 hours and 1 hour before) are a Cal.com setting (Workflows). Whether that needs a paid
plan is not verified.

### Keep reschedules and cancellations in sync

When someone reschedules or cancels through the Cal.com links, Cal.com tells the connector, which updates the lead in
Supabase (new time, booking uid and links, or status `cancelled`) and emails the team (and posts to Slack when that is
set up). Without this the lead keeps showing the old time.

1. Generate a secret and keep it in 1Password (for example `openssl rand -base64 48`, or in PowerShell
   `$b = New-Object byte[] 48; (New-Object System.Security.Cryptography.RNGCryptoServiceProvider).GetBytes($b); [Convert]::ToBase64String($b) | Set-Clipboard`).
2. Add it to the host as `CAL_WEBHOOK_SECRET` (Production, Sensitive) and redeploy.
3. In Cal.com, go to Settings, Developer, Webhooks (`/settings/developer/webhooks`) and create a webhook:
   subscriber URL `https://connect.strategent.app/webhooks/cal`, the same secret, and the triggers **Booking
   rescheduled** and **Booking cancelled** only. A webhook there covers all your booking links, which is fine because
   the connector ignores bookings it did not create; Cal.com can also attach one to a single event type.
4. Reschedule and cancel a test booking, and check the lead row and the email. Failed deliveries show in the Cal.com
   webhook settings, and the connector logs one `[cal-webhook]` line per delivery.

Cal.com signs each delivery with HMAC-SHA256 of the raw body in the `x-cal-signature-256` header. The connector rejects
anything without a valid signature, ignores bookings it did not create, and treats a repeated delivery as already done.
If a change cannot be saved (for example it would clash with another booked call), the team gets an email to fix the
lead by hand.

## Configuration

See `.env.example`. Required: `SIGNING_SECRET`, `CAL_API_KEY`, `CAL_EVENT_TYPE_ID`, `BOOKING_PAGE_URL`,
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`. The server refuses to start and lists what is missing.

## How Cal.com is used

- **Availability:** `GET /v2/slots` with `eventTypeId`, `start`, `end` (version `2024-09-04`). Slots come grouped by
  date. Cal.com documents no maximum range, so the client asks a week at a time and merges.
- **Booking:** `POST /v2/bookings` (version `2026-02-25`) with the attendee, the Google Meet location, and the answers in
  `bookingFieldsResponses`, keyed by question slug. The write is never retried, so a flaky response cannot double book.
- **Event types and questions** (setup script only): version `2026-06-12`.
- Each endpoint pins its own API version in `src/cal.ts`, and tests assert the exact strings. If Cal.com changes
  defaults, nothing shifts silently.
- **A taken slot.** Cal.com does not document the error for it. The client treats HTTP 409 and "already booked" style
  messages as taken, and for any other 4xx it re-reads availability: if the slot has disappeared it was taken,
  otherwise the request itself was wrong and the lead falls back to a saved request with an alert.
- **Everything outside `src/cal.ts` and `src/calAdmin.ts` talks to the scheduler through `src/scheduler.ts`.**
  Changing provider again means rewriting those files, not the tools.

## Where this differs from the brief, and why

- **OAuth is built in, not Clerk.** A guest grant has no accounts, so a small self-contained OAuth 2.1 server (dynamic
  client registration, PKCE S256, consent page, signed stateless tokens, single-use codes) was simpler than bending a
  provider. Access tokens last 1 hour, refresh tokens 30 days. If Meta later requires a real identity provider, swap
  `src/oauth.ts`; the tools only need a `Principal`.
- **The server also publishes `/.well-known/oauth-protected-resource`** and sends `WWW-Authenticate` on 401, as the MCP
  spec requires. The brief's endpoint list omitted it.
- **Availability** takes `start`, `end`, `timezone` and an optional `part_of_day` instead of one `date_range`.
- **Required fields are defined.** Booking needs `slot_token`, `name`, `email`, `business_name`. Written audit needs
  `name`, `email`, `business_name`, and `website` or `city`. Everything else is optional.
- **`industry` and `channel_interest` are free text in the schema**, normalised on the server (`channel_interest` uses
  `back_office`). A model that sends "hotel" gets "Hospitality" instead of an error. In Cal.com they are plain text
  questions rather than dropdowns, because Cal.com's select options need exact values we cannot confirm without a
  live call. Upgrade them to dropdowns later if you want cleaner data from direct bookers.
- **Phone is a text answer, not Cal.com's attendee phone field.** That field needs international format and triggers
  SMS reminders, which would need consent. A model's free-text number would otherwise fail the booking.
- **One active call per email.** Same email and same time returns the existing booking. A different time returns the
  existing booking and its reschedule link.
- **`get_audit_request_status` only sees requests made through the same connection**, so knowing an email address
  reveals nothing about anyone else. The cost: after reconnecting, earlier requests no longer show.
- **Scheduler outage.** `check_audit_availability` tells the model to offer a written audit. `book_audit_call` saves a
  `call_pending` lead and promises a call time by email. `request_written_audit` accepts `wants_call_time` for the same
  case.
- **Written audits have a cap** (`WRITTEN_OPEN_CAP`, default 10 open at a time). Beyond it, requests are waitlisted and
  the reply says so instead of promising three business days. Ruchi runs these by hand.
- **Abuse limits:** per-email daily cap, global hourly cap, 64 KB request limit, Slack text sanitised.
- **Requester acknowledgement email** for written audits exists but is off (`SEND_REQUESTER_ACK`).
- **Leads are tagged by client** (`muse`, `claude`, `chatgpt`) from the registered client name.
- **Written-audit replies link to `BOOKING_PAGE_URL`.** The brief's copy pointed at a Calendly page, so that line of
  copy changed. Ruchi should approve the new link.

## Verification status

- **Confirmed live (27 Oct 2026):**
  - Availability for event 7650820 returns `{ "<date>": [{ "start": "<ISO with offset>" }] }`, which is what
    `src/cal.ts` parses. Wednesday is correctly empty.
  - `npm run cal:setup` signs in, lists the event types, and finds all seven booking questions present, so
    `--create-fields` had nothing to add.
  - One real booking through `createBooking` succeeded: a Google Meet link was returned, the confirmation email arrived
    with the right event, time and description, and every booking answer was stored. The test booking has been cancelled.
  - The reschedule and cancel links built from the booking uid (`https://cal.com/reschedule/{uid}` and
    `https://cal.com/booking/{uid}?cancel=true`) both work, so `RESCHEDULE_URL_TEMPLATE` and `CANCEL_URL_TEMPLATE` need
    no override.
  - The Cal.com account has API keys, Google Meet, the 15 minute buffer and the 4 hour minimum notice. The max 3 per
    day limit was set but not exercised.
- **A taken slot** has not been exercised live. The 409 handling and the availability re-check in `src/cal.ts` follow
  the assumptions above, not an observed Cal.com error.
- **Running the setup script in a sandbox with an outbound proxy.** Node's built-in fetch ignores `HTTPS_PROXY`. Run with
  `NODE_USE_ENV_PROXY=1` (Node 22.21 or later). Not needed on a normal machine or on Vercel.
- **Event types that require confirmation** return a `pending` booking. It is treated as booked, but the host would
  still need to confirm. Leave "requires confirmation" off for this event.
- **A booking request that times out** may or may not have gone through. The lead is saved as `call_pending` and the
  Slack alert says to check the calendar for a duplicate.
- **Muse specifics:** redirect domain, whether it needs different consent wording, tool-call timeouts, how it presents
  `isError` results. Set `ALLOWED_REDIRECT_HOSTS` once the domain is known.
- **Cancellations and reschedules** are synced back by the Cal.com webhook (see "Keep reschedules and cancellations in
  sync") and were verified live on 27 Oct 2026 with a real booking: Cal.com's signed test ping was accepted, a
  reschedule moved the lead to the new booking uid, time and links, and a cancel marked it `cancelled`. All three alert
  emails (new call, rescheduled, cancelled) reached the inbox. On a reschedule Cal.com sends only
  `BOOKING_RESCHEDULED`, not a `BOOKING_CANCELLED` for the old booking, so there is no duplicate alert. The handler
  would still end in the right state if that ever changed (a later reschedule restores the request), but the team would
  then get one spurious "cancelled" email.
- **Cloudflare Workers** is untested. Vercel and plain Node are the supported targets.

## Open copy decisions for Ruchi

Descriptions are verbatim from the brief. Two additions are worth considering because Muse matches on this text:
- Mention missed calls, after-hours coverage and South Bay / Westside in the `check_audit_availability` description.
  Today the local intent appears only in the listing and the booking confirmation.
- Add "small business" and "hotel owner" to the listing description and keywords.

The region lists (`src/region.ts`) decide which leads get the `LOCAL` tag in Slack. Inglewood is currently `la_other`.

## Development

```
npm install
npm test            # 130 tests, no network needed
npm run typecheck
npm run dev         # needs real credentials; use the tests for offline work
```

Layout: `src/tools.ts` (all booking logic), `src/scheduler.ts` (provider interface), `src/cal.ts` (Cal.com client),
`src/calAdmin.ts` (setup helpers), `src/oauth.ts`, `src/store.ts`, `src/notify.ts`, `src/mcp.ts` (tool registration and
logging), `src/app.ts` (routes), `test/` (fakes in `test/helpers.ts`).
