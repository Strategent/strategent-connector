import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TOOL_DESCRIPTIONS } from './copy.js';
import type { Principal } from './oauth.js';
import { createTools, type ToolDeps, type ToolResult } from './tools.js';

// Fields that are safe to log with their values. Everything else is logged as "provided" only.
const LOGGED_VALUES = new Set(['timezone', 'part_of_day', 'industry', 'channel_interest', 'start', 'end', 'wants_call_time']);

function redact(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const provided: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null || v === '') continue;
    provided.push(k);
    if (LOGGED_VALUES.has(k)) out[k] = v;
  }
  out.provided = provided;
  return out;
}

export function createMcpServer(deps: ToolDeps, who: Principal): McpServer {
  const server = new McpServer({ name: 'strategent-audit', version: '0.1.0' });
  const tools = createTools(deps);

  /** Runs a handler, logs it without personal data, and turns any crash into a safe message. */
  function wrap<A extends Record<string, unknown>>(name: string, run: (args: A) => Promise<ToolResult>) {
    return async (args: A) => {
      const started = Date.now();
      let result: ToolResult;
      try {
        result = await run(args);
      } catch (e) {
        console.error(`[tool] ${name} crashed: ${(e as Error).stack ?? (e as Error).message}`);
        result = {
          text: 'Something went wrong on our side. Nothing was booked. Try again in a moment, or offer a written audit with request_written_audit.',
          isError: true,
          outcome: 'error',
        };
      }
      await deps.store
        .log({ tool: name, client_id: who.clientId, inputs: redact(args), outcome: result.outcome, latency_ms: Date.now() - started })
        .catch(() => undefined);
      return { content: [{ type: 'text' as const, text: result.text }], isError: result.isError ?? false };
    };
  }

  server.registerTool(
    'check_audit_availability',
    {
      title: 'Find audit times',
      description: TOOL_DESCRIPTIONS.check_audit_availability,
      inputSchema: {
        start: z.string().optional().describe('Earliest date or date-time to search, ISO 8601, for example 2026-10-27. Defaults to now.'),
        end: z.string().optional().describe('Latest date or date-time to search, ISO 8601. At most 14 days after start. Defaults to 14 days.'),
        timezone: z.string().optional().describe("The user's IANA timezone, for example America/Chicago. Defaults to Pacific."),
        part_of_day: z.string().optional().describe('Optional preference: morning, afternoon or evening, in the user timezone.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap('check_audit_availability', tools.checkAvailability),
  );

  server.registerTool(
    'book_audit_call',
    {
      title: 'Book the audit call',
      description: TOOL_DESCRIPTIONS.book_audit_call,
      inputSchema: {
        slot_token: z.string().optional().describe('The slot_token of the time the user chose, from check_audit_availability.'),
        name: z.string().optional().describe("The user's full name."),
        email: z.string().optional().describe("The user's email address."),
        phone: z.string().optional().describe('Optional phone number.'),
        business_name: z.string().optional().describe('Name of the business.'),
        website: z.string().optional().describe('Business website, if any.'),
        city: z.string().optional().describe('City where the business operates.'),
        industry: z.string().optional().describe('One of: hospitality, real_estate, legal, wealth, professional_services, restaurant, medical, other.'),
        pain_point: z.string().optional().describe('The task taking the most time right now, in the user own words.'),
        channel_interest: z.string().optional().describe('One of: calls, inbox, intake, back_office, all.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    wrap('book_audit_call', (a) => tools.bookCall(a, who)),
  );

  server.registerTool(
    'request_written_audit',
    {
      title: 'Request a written audit',
      description: TOOL_DESCRIPTIONS.request_written_audit,
      inputSchema: {
        name: z.string().optional().describe("The user's full name."),
        email: z.string().optional().describe('Email address the audit is sent to.'),
        business_name: z.string().optional().describe('Name of the business.'),
        website: z.string().optional().describe('Business website. Needed unless the business has none.'),
        city: z.string().optional().describe('City where the business operates.'),
        industry: z.string().optional().describe('One of: hospitality, real_estate, legal, wealth, professional_services, restaurant, medical, other.'),
        pain_point: z.string().optional().describe('The task taking the most time right now, in the user own words.'),
        wants_call_time: z.boolean().optional().describe('Set to true only if scheduling is unavailable and the user wants a call time sent by email instead of a written audit.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    wrap('request_written_audit', (a) => tools.requestWrittenAudit(a, who)),
  );

  server.registerTool(
    'get_audit_request_status',
    {
      title: 'Check request status',
      description: TOOL_DESCRIPTIONS.get_audit_request_status,
      inputSchema: {
        email: z.string().optional().describe('The email address used for the request.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    wrap('get_audit_request_status', (a) => tools.auditRequestStatus(a, who)),
  );

  return server;
}
