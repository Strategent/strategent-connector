import { TOOL_DESCRIPTIONS } from './copy.js';
import type { Config } from './config.js';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const TOOLS: { name: string; inputs: string; returns: string }[] = [
  {
    name: 'check_audit_availability',
    inputs: 'start, end, timezone, part_of_day (all optional)',
    returns: 'Open call times in the requester\'s time zone, each with a slot_token for booking. Searches up to 14 days ahead.',
  },
  {
    name: 'book_audit_call',
    inputs: 'slot_token, name, email, business_name, plus optional phone, website, city, industry, pain_point, channel_interest',
    returns: 'A booking confirmation with the Google Meet link and reschedule and cancel links. If the time was just taken, the next open times. If the same person already has that call, the existing booking.',
  },
  {
    name: 'request_written_audit',
    inputs: 'name, email, business_name, website, plus optional city, industry, pain_point',
    returns: 'A confirmation that Strategent will email a written audit within three business days.',
  },
  {
    name: 'get_audit_request_status',
    inputs: 'email',
    returns: 'Whether a call or written audit request from this email went through, and what happens next. Only requests made from the same connection are shown.',
  },
];

export function docsPage(config: Config): string {
  const tools = TOOLS.map(
    (t) => `<section><h3><code>${t.name}</code></h3>
<p>${esc(TOOL_DESCRIPTIONS[t.name as keyof typeof TOOL_DESCRIPTIONS])}</p>
<p><strong>Inputs:</strong> ${esc(t.inputs)}</p>
<p><strong>Returns:</strong> ${esc(t.returns)}</p></section>`,
  ).join('\n');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Strategent AI Readiness Audit connector</title>
<meta name="description" content="Documentation for the Strategent AI Readiness Audit MCP connector: endpoint, sign-in, tools and limits.">
<style>body{font:16px/1.6 system-ui,sans-serif;margin:0;background:#f6f6f4;color:#1a1a1a}main{max-width:720px;margin:6vh auto;padding:24px 24px 40px;background:#fff;border-radius:12px}
h1{font-size:1.5rem;margin:0 0 8px}h2{font-size:1.15rem;margin:28px 0 8px}h3{font-size:1rem;margin:20px 0 4px}p,li{margin:0 0 10px}ul{padding-left:20px}
code{background:#f0f0ee;padding:1px 5px;border-radius:4px;font-size:.92em}a{color:inherit}</style></head>
<body><main>
<h1>Strategent AI Readiness Audit connector</h1>
<p>A remote MCP connector that lets an AI assistant (Meta Muse, Claude, ChatGPT) find open times for Strategent's complimentary AI Readiness Audit and book one for the user, or request a written audit by email.</p>

<h2>Connect</h2>
<ul>
<li>MCP endpoint (streamable HTTP): <code>${esc(config.baseUrl)}/mcp</code></li>
<li>Authorization server metadata: <code>${esc(config.baseUrl)}/.well-known/oauth-authorization-server</code></li>
<li>Protected resource metadata: <code>${esc(config.baseUrl)}/.well-known/oauth-protected-resource</code></li>
</ul>

<h2>Sign-in</h2>
<p>OAuth 2.1 authorization code flow with PKCE (S256). Clients register themselves at <code>/oauth/register</code> (dynamic client registration). The user sees one consent screen the first time they connect, and access renews silently afterwards. No Strategent account and no payment are needed.</p>

<h2>Tools</h2>
${tools}

<h2>Limits and behavior</h2>
<ul>
<li>Call times come from Strategent's live calendar, up to 14 days ahead. Requests outside that range are adjusted and the reply says so.</li>
<li>A call is 30 minutes on Google Meet. Times are shown in the user's time zone and in Pacific Time.</li>
<li>Up to ${config.perEmailDailyCap} requests per email address per day, ${config.bookingHourlyCap} bookings per hour overall, and ${config.writtenOpenCap} open written-audit requests at a time.</li>
<li>If scheduling is unavailable, the assistant is steered to a written audit instead of failing.</li>
<li>Reschedules and cancellations made through the calendar links are kept in sync on our side.</li>
</ul>

<h2>Data</h2>
<p>Strategent receives only what the user shares in the chat, such as name, email and business details, and uses it to run the audit and contact them about it. Tool activity is logged without email addresses or free text. See the <a href="${esc(config.privacyUrl)}">privacy policy</a> and <a href="${esc(config.termsUrl)}">terms of service</a>.</p>

<h2>Support</h2>
<p><a href="mailto:${esc(config.notifyEmailTo)}">${esc(config.notifyEmailTo)}</a></p>
</main></body></html>`;
}
