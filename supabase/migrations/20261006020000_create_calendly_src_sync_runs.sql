-- Run log for the calendly-source-sync edge function.
-- Two tables: one summary row per run, plus one child row per booking processed
-- (so per-booking detail is queryable in plain columns, not a JSON array).

-- Per-run summary (totals, anomaly flags, errors).
create table if not exists public.calendly_src_sync_runs (
  id                  bigint generated always as identity primary key,
  ran_at              timestamptz not null default now(),
  days_window         int,
  dry_run             boolean not null default false,
  bookings_processed  int not null default 0,
  total_google_ads    int not null default 0,
  total_microsoft_ads int not null default 0,
  total_organic       int not null default 0,
  total_other         int not null default 0,
  total_unknown       int not null default 0,
  created             int not null default 0,  -- new AC contacts created (tagged _new_contact)
  updated             int not null default 0,  -- existing contacts whose Src fields were written (tagged _update)
  skipped_existing    int not null default 0,  -- field 77 already had a value
  flags               text[] not null default '{}',   -- anomalies (e.g. no tracking after 5 Oct)
  errors              text[] not null default '{}'
);
create index if not exists calendly_src_sync_runs_ran_at_idx on public.calendly_src_sync_runs (ran_at desc);

-- One row per booking processed in a run.
create table if not exists public.calendly_src_sync_bookings (
  id           bigint generated always as identity primary key,
  run_id        bigint not null references public.calendly_src_sync_runs(id) on delete cascade,
  ran_at        timestamptz not null default now(),
  name          text,         -- masked (first name + last initial)
  email         text,         -- invitee email (full)
  ac_contact_id text,         -- matched or newly-created AC contact id (null if not resolved)
  domain        text,         -- email domain
  booking_date  date,         -- invitee created_at (date)
  channel       text,         -- derived lead channel
  action        text          -- created + wrote … | wrote … | skipped – already had source | create failed | would …
);
create index if not exists calendly_src_sync_bookings_run_id_idx on public.calendly_src_sync_bookings (run_id);
create index if not exists calendly_src_sync_bookings_channel_idx on public.calendly_src_sync_bookings (channel);
-- One row per unique booking email: the function UPSERTs on email (never duplicates).
create unique index if not exists calendly_src_sync_bookings_email_key on public.calendly_src_sync_bookings (email);

-- RLS on with no policies: the edge function writes with the service role (bypasses RLS),
-- the anon key is kept out. Same convention as public.ac_new_leads.
alter table public.calendly_src_sync_runs enable row level security;
alter table public.calendly_src_sync_bookings enable row level security;
