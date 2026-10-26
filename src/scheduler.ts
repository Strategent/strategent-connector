// The connector talks to whichever scheduling service sits behind this interface (today, Cal.com).
// Everything outside src/cal.ts depends only on these types.

/** The slot was taken, or is no longer bookable. */
export class SchedulerConflictError extends Error {}

/** The scheduler is down, slow, or rejecting our credentials or request. Ops should look at non-transient kinds. */
export class SchedulerUnavailableError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'server' | 'rate_limit' | 'auth' | 'bad_request',
  ) {
    super(message);
  }
}

export interface BookingInput {
  start: Date;
  name: string;
  email: string;
  timezone: string;
  /** Answers to the event's booking questions, keyed by field slug. */
  fields: Record<string, string>;
  source: string;
}

export interface BookingResult {
  uid: string;
  rescheduleUrl: string;
  cancelUrl: string;
  meetLink: string | null;
}

export interface SchedulerApi {
  /** Open start times in [start, end). Callers may ask for any range; the client splits it as needed. */
  availableTimes(start: Date, end: Date): Promise<Date[]>;
  createBooking(input: BookingInput): Promise<BookingResult>;
}
