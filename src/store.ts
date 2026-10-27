import type { Config } from './config.js';
import { randomId } from './crypto.js';

export type RequestType = 'call' | 'written' | 'call_pending';
export type RequestStatus = 'booked' | 'requested' | 'waitlist' | 'cancelled' | 'completed';

export interface AuditRequest {
  id: string;
  created_at: string;
  owner_sub: string;
  type: RequestType;
  status: RequestStatus;
  name: string;
  email: string;
  phone: string | null;
  business_name: string;
  website: string | null;
  city: string | null;
  region: string;
  industry: string | null;
  pain_point: string | null;
  channel_interest: string | null;
  slot_start: string | null;
  timezone: string | null;
  meet_link: string | null;
  reschedule_url: string | null;
  cancel_url: string | null;
  booking_uid: string | null;
  source: string;
}

export interface ToolLog {
  tool: string;
  client_id: string | null;
  inputs: Record<string, unknown>;
  outcome: string;
  latency_ms: number;
}

/** The fields a Cal.com reschedule or cancellation can change on an existing request. */
export type RequestPatch = Partial<
  Pick<AuditRequest, 'status' | 'slot_start' | 'booking_uid' | 'meet_link' | 'reschedule_url' | 'cancel_url'>
>;

/** Cal.com booking uids are short URL-safe strings. Anything else is never looked up. */
export const isBookingUid = (uid: string) => /^[A-Za-z0-9_-]{6,64}$/.test(uid);

/** What a retention run removed. Counts only, never row contents. */
export interface PurgeResult {
  audit_requests: number;
  tool_logs: number;
  oauth_used_ids: number;
}

export interface Store {
  insertRequest(row: Omit<AuditRequest, 'id' | 'created_at'>): Promise<AuditRequest>;
  /** The request that holds this Cal.com booking uid, whatever its status. */
  findByBookingUid(uid: string): Promise<AuditRequest | null>;
  /** Applies a patch and returns the updated row, or null if the id no longer exists. */
  updateRequest(id: string, patch: RequestPatch): Promise<AuditRequest | null>;
  /** Upcoming booked call for this email, if any. */
  findActiveCall(email: string, now: Date): Promise<AuditRequest | null>;
  /** Open written or pending-call requests for this email. */
  findOpenRequests(email: string): Promise<AuditRequest[]>;
  /** All requests for this email created by this guest. */
  findByOwner(email: string, ownerSub: string): Promise<AuditRequest[]>;
  countCreatedSince(since: Date): Promise<number>;
  countCreatedSinceByEmail(email: string, since: Date): Promise<number>;
  countOpenWritten(): Promise<number>;
  /** True the first time an id is seen, false after. Used to make OAuth codes single-use. */
  claimOnce(id: string, ttlSeconds: number): Promise<boolean>;
  log(entry: ToolLog): Promise<void>;
  /**
   * Deletes audit requests created before `requestsBefore`, tool logs created before `logsBefore`, and OAuth code ids
   * that have expired. A request with a call still in the future is kept. Every delete is filtered by date, so a
   * bad cutoff cannot widen it past what the caller asked for.
   */
  purge(cutoffs: { requestsBefore: Date; logsBefore: Date; now: Date }): Promise<PurgeResult>;
}

function assertDate(name: string, d: Date) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) throw new Error(`purge: ${name} is not a valid date`);
}

const norm = (e: string) => e.trim().toLowerCase();

export class MemoryStore implements Store {
  rows: AuditRequest[] = [];
  logs: ToolLog[] = [];
  private logAt: number[] = [];
  private claimed = new Map<string, number>();
  constructor(private now: () => Date = () => new Date()) {}

  async insertRequest(row: Omit<AuditRequest, 'id' | 'created_at'>) {
    if (row.type === 'call' && row.slot_start) {
      const dup = this.rows.find(
        (r) => r.type === 'call' && r.status === 'booked' && norm(r.email) === norm(row.email) && r.slot_start === row.slot_start,
      );
      if (dup) throw new Error('duplicate booking');
    }
    const full: AuditRequest = { ...row, id: randomId(9), created_at: this.now().toISOString() };
    this.rows.push(full);
    return full;
  }
  // Like the database, these hand back copies, so a caller never sees a row change underneath it.
  async findByBookingUid(uid: string) {
    const row = this.rows.find((r) => r.booking_uid === uid);
    return row ? { ...row } : null;
  }
  async updateRequest(id: string, patch: RequestPatch) {
    const i = this.rows.findIndex((r) => r.id === id);
    if (i < 0) return null;
    const next = { ...this.rows[i]!, ...patch };
    // Same rule as the unique index in schema.sql: one booked call per person and time.
    const clash = this.rows.find(
      (r, j) =>
        j !== i && next.type === 'call' && next.status === 'booked' && r.type === 'call' && r.status === 'booked' &&
        norm(r.email) === norm(next.email) && r.slot_start === next.slot_start,
    );
    if (clash) throw new Error('duplicate booking');
    this.rows[i] = next;
    return { ...next };
  }
  async findActiveCall(email: string, now: Date) {
    return (
      this.rows.find(
        (r) => r.type === 'call' && r.status === 'booked' && norm(r.email) === norm(email) && r.slot_start && new Date(r.slot_start) > now,
      ) ?? null
    );
  }
  async findOpenRequests(email: string) {
    return this.rows.filter(
      (r) => (r.type === 'written' || r.type === 'call_pending') && ['requested', 'waitlist'].includes(r.status) && norm(r.email) === norm(email),
    );
  }
  async findByOwner(email: string, ownerSub: string) {
    return this.rows.filter((r) => norm(r.email) === norm(email) && r.owner_sub === ownerSub);
  }
  async countCreatedSince(since: Date) {
    return this.rows.filter((r) => new Date(r.created_at) >= since).length;
  }
  async countCreatedSinceByEmail(email: string, since: Date) {
    return this.rows.filter((r) => norm(r.email) === norm(email) && new Date(r.created_at) >= since).length;
  }
  async countOpenWritten() {
    return this.rows.filter((r) => r.type === 'written' && r.status === 'requested').length;
  }
  async claimOnce(id: string, ttlSeconds = 600) {
    if (this.claimed.has(id)) return false;
    this.claimed.set(id, this.now().getTime() + ttlSeconds * 1000);
    return true;
  }
  async log(entry: ToolLog) {
    this.logs.push(entry);
    this.logAt.push(this.now().getTime());
  }
  async purge(c: { requestsBefore: Date; logsBefore: Date; now: Date }) {
    assertDate('requestsBefore', c.requestsBefore);
    assertDate('logsBefore', c.logsBefore);
    assertDate('now', c.now);
    const before = { requests: this.rows.length, logs: this.logs.length, ids: this.claimed.size };
    this.rows = this.rows.filter(
      (r) => !(new Date(r.created_at) < c.requestsBefore && !(r.slot_start && new Date(r.slot_start) >= c.now)),
    );
    const keep = this.logAt.map((t) => t >= c.logsBefore.getTime());
    this.logs = this.logs.filter((_, i) => keep[i]);
    this.logAt = this.logAt.filter((_, i) => keep[i]);
    for (const [id, exp] of this.claimed) if (exp < c.now.getTime()) this.claimed.delete(id);
    return {
      audit_requests: before.requests - this.rows.length,
      tool_logs: before.logs - this.logs.length,
      oauth_used_ids: before.ids - this.claimed.size,
    };
  }
}

/** PostgREST over fetch, so no extra dependency and it runs anywhere. Uses the service-role key. */
export class SupabaseStore implements Store {
  constructor(
    private config: Config,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async rest(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.fetchImpl(`${this.config.supabaseUrl}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: this.config.supabaseServiceKey,
        Authorization: `Bearer ${this.config.supabaseServiceKey}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(6000),
    });
    return res;
  }

  private async rows(path: string): Promise<AuditRequest[]> {
    const res = await this.rest(path);
    if (!res.ok) throw new Error(`Supabase read failed (${res.status})`);
    return (await res.json()) as AuditRequest[];
  }

  private async count(path: string): Promise<number> {
    const res = await this.rest(path, { method: 'HEAD', headers: { Prefer: 'count=exact' } });
    if (!res.ok) throw new Error(`Supabase count failed (${res.status})`);
    const range = res.headers.get('content-range') ?? '*/0';
    return Number.parseInt(range.split('/')[1] ?? '0', 10) || 0;
  }

  async insertRequest(row: Omit<AuditRequest, 'id' | 'created_at'>) {
    const res = await this.rest('audit_requests', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(row),
    });
    if (!res.ok) throw new Error(`Supabase insert failed (${res.status})`);
    return ((await res.json()) as AuditRequest[])[0]!;
  }

  async findByBookingUid(uid: string) {
    if (!isBookingUid(uid)) return null;
    const q = new URLSearchParams({ booking_uid: `eq.${uid}`, limit: '1' });
    return (await this.rows(`audit_requests?${q}`))[0] ?? null;
  }

  async updateRequest(id: string, patch: RequestPatch) {
    const q = new URLSearchParams({ id: `eq.${id}` });
    const res = await this.rest(`audit_requests?${q}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`Supabase update failed (${res.status})`);
    return ((await res.json()) as AuditRequest[])[0] ?? null;
  }

  async findActiveCall(email: string, now: Date) {
    const q = new URLSearchParams({
      email: `ilike.${encodeLike(email)}`,
      type: 'eq.call',
      status: 'eq.booked',
      slot_start: `gt.${now.toISOString()}`,
      order: 'slot_start.asc',
      limit: '1',
    });
    return (await this.rows(`audit_requests?${q}`))[0] ?? null;
  }

  async findOpenRequests(email: string) {
    const q = new URLSearchParams({
      email: `ilike.${encodeLike(email)}`,
      type: 'in.(written,call_pending)',
      status: 'in.(requested,waitlist)',
    });
    return this.rows(`audit_requests?${q}`);
  }

  async findByOwner(email: string, ownerSub: string) {
    const q = new URLSearchParams({
      email: `ilike.${encodeLike(email)}`,
      owner_sub: `eq.${ownerSub}`,
      order: 'created_at.desc',
      limit: '10',
    });
    return this.rows(`audit_requests?${q}`);
  }

  countCreatedSince(since: Date) {
    return this.count(`audit_requests?created_at=gte.${encodeURIComponent(since.toISOString())}`);
  }

  countCreatedSinceByEmail(email: string, since: Date) {
    const q = new URLSearchParams({ email: `ilike.${encodeLike(email)}`, created_at: `gte.${since.toISOString()}` });
    return this.count(`audit_requests?${q}`);
  }

  countOpenWritten() {
    return this.count('audit_requests?type=eq.written&status=eq.requested');
  }

  async claimOnce(id: string, ttlSeconds: number) {
    const res = await this.rest('oauth_used_ids', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ id, expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString() }),
    });
    if (res.status === 409) return false; // primary key conflict: already used
    if (!res.ok) throw new Error(`Supabase claim failed (${res.status})`);
    return true;
  }

  async log(entry: ToolLog) {
    await this.rest('tool_logs', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(entry) });
  }

  /** Deletes the rows matching `filter` and returns how many went. Only ids come back, never row contents. */
  private async deleteWhere(table: string, filter: URLSearchParams): Promise<number> {
    filter.set('select', 'id');
    const res = await this.rest(`${table}?${filter}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
    if (!res.ok) throw new Error(`Supabase delete from ${table} failed (${res.status})`);
    return ((await res.json()) as unknown[]).length;
  }

  async purge(c: { requestsBefore: Date; logsBefore: Date; now: Date }) {
    assertDate('requestsBefore', c.requestsBefore);
    assertDate('logsBefore', c.logsBefore);
    assertDate('now', c.now);
    const jobs = {
      audit_requests: () =>
        this.deleteWhere(
          'audit_requests',
          new URLSearchParams({
            created_at: `lt.${c.requestsBefore.toISOString()}`,
            or: `(slot_start.is.null,slot_start.lt.${c.now.toISOString()})`,
          }),
        ),
      tool_logs: () => this.deleteWhere('tool_logs', new URLSearchParams({ created_at: `lt.${c.logsBefore.toISOString()}` })),
      oauth_used_ids: () => this.deleteWhere('oauth_used_ids', new URLSearchParams({ expires_at: `lt.${c.now.toISOString()}` })),
    };
    // One table failing must not stop the others from being cleaned.
    const result: PurgeResult = { audit_requests: 0, tool_logs: 0, oauth_used_ids: 0 };
    const failures: string[] = [];
    for (const [name, run] of Object.entries(jobs)) {
      try {
        result[name as keyof PurgeResult] = await run();
      } catch (e) {
        failures.push((e as Error).message);
      }
    }
    if (failures.length) throw new Error(failures.join('; '));
    return result;
  }
}

/** ilike pattern for an exact, case-insensitive match: escape wildcard characters. */
function encodeLike(value: string): string {
  return value.trim().replace(/[\\%_*]/g, (c) => `\\${c}`);
}
