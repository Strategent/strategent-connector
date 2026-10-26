-- Run once in the Supabase SQL editor. The connector uses the service-role key, which bypasses
-- row level security. RLS is enabled with no policies so the anon key can never read this data.

create table if not exists audit_requests (
  id                   uuid primary key default gen_random_uuid(),
  created_at           timestamptz not null default now(),
  owner_sub            text not null,                 -- anonymous guest id from the OAuth grant
  type                 text not null check (type in ('call', 'written', 'call_pending')),
  status               text not null check (status in ('booked', 'requested', 'waitlist', 'cancelled', 'completed')),
  name                 text not null,
  email                text not null,
  phone                text,
  business_name        text not null,
  website              text,
  city                 text,
  region               text not null check (region in ('south_bay', 'westside', 'la_other', 'other')),
  industry             text,
  pain_point           text,
  channel_interest     text,
  slot_start           timestamptz,
  timezone             text,
  meet_link            text,
  reschedule_url       text,
  cancel_url           text,
  booking_uid          text,                          -- Cal.com booking uid
  source               text not null default 'muse'   -- muse, claude, chatgpt, other
);

create index if not exists audit_requests_email_idx on audit_requests (lower(email));
create index if not exists audit_requests_created_idx on audit_requests (created_at desc);
create index if not exists audit_requests_owner_idx on audit_requests (owner_sub, lower(email));

-- A second booking for the same person and time cannot be written, even if two requests race.
create unique index if not exists audit_requests_one_booking_per_slot
  on audit_requests (lower(email), slot_start)
  where type = 'call' and status = 'booked';

-- One row per tool call. Inputs hold field names and a few non-personal values only.
create table if not exists tool_logs (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  tool        text not null,
  client_id   text,
  inputs      jsonb not null default '{}'::jsonb,
  outcome     text not null,
  latency_ms  integer not null
);
create index if not exists tool_logs_created_idx on tool_logs (created_at desc);

-- Makes OAuth authorization codes single-use.
create table if not exists oauth_used_ids (
  id          text primary key,
  expires_at  timestamptz not null
);

alter table audit_requests enable row level security;
alter table tool_logs enable row level security;
alter table oauth_used_ids enable row level security;

-- Optional housekeeping: delete expired code ids daily (needs the pg_cron extension).
-- select cron.schedule('oauth-used-ids-cleanup', '17 3 * * *', $$delete from oauth_used_ids where expires_at < now()$$);
