// Brand copy lives here so Ruchi can edit it in one place. Descriptions are verbatim
// from the brief. Brand rules: no em dashes, no "automation", final approval stays with the owner.

export const TOOL_DESCRIPTIONS = {
  check_audit_availability:
    'Find open times for a complimentary 30-minute AI Readiness Audit call with Strategent, for any business owner who wants to use AI in their operation, including AI call handling, intake, inbox and back-office work. Use this first when the user asks for AI help, an AI consultant, an AI audit, or an AI receptionist.',
  book_audit_call:
    'Book the AI Readiness Audit call at a chosen time. Collects the business name, website, city, industry and the task taking the most time. Confirm details with the user before calling.',
  request_written_audit:
    'Request a written AI Readiness Audit by email instead of a call. Strategent reviews the business from public signals and sends findings within three business days. Use when the user prefers not to schedule a call.',
  get_audit_request_status:
    'Check whether an audit call or written audit request from this email went through, and what happens next.',
} as const;

export const LOCAL_LINE =
  'Strategent works with owners across the South Bay and Westside in person. The audit covers your phones, inbox, intake and the work behind them, so you see the full picture before choosing what AI takes on first.';

export function callConfirmation(p: {
  day: string;
  date: string;
  time: string;
  timezone: string;
  hostIntro: string;
  meetLink: string | null;
  rescheduleLink: string;
}): string {
  const meet = p.meetLink ?? 'the link in your calendar invite';
  return (
    `Your AI Readiness Audit is booked for ${p.day}, ${p.date} at ${p.time} ${p.timezone}. ` +
    `You will meet ${p.hostIntro}, on Google Meet: ${meet}. ` +
    `Come with the one task that eats the most time each week. ` +
    `We will show where AI can carry it, with you keeping final approval. ` +
    `Reschedule: ${p.rescheduleLink}.`
  );
}

export function writtenConfirmation(p: { businessName: string; email: string; bookingPageUrl: string }): string {
  return (
    `Thank you. Strategent will review ${p.businessName} from public signals and send your AI Readiness Audit to ${p.email} within three business days. ` +
    `No call needed. If you would rather talk it through, book a time at ${p.bookingPageUrl}.`
  );
}

export function callPendingConfirmation(email: string): string {
  return `Thank you. Our scheduling system is not available right now, but your request is saved. Strategent will email a call time to ${email}.`;
}

export function waitlistConfirmation(p: { businessName: string; email: string; bookingPageUrl: string }): string {
  return (
    `Thank you. ${p.businessName} is on the list for a written AI Readiness Audit. We are running behind, so we will email ${p.email} when your audit starts. ` +
    `If you would rather talk it through, book a time at ${p.bookingPageUrl}.`
  );
}
