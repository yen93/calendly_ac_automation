-- Run log for the calendly-source-sync edge function: one row per run (Mon-Fri 06:00 PHT),
-- capturing totals, per-booking actions, anomaly flags and errors for durable history.
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
  written             int not null default 0,  -- contacts whose Src fields 77-83 were written
  skipped_existing    int not null default 0,  -- field 77 already had a value
  no_ac_contact       int not null default 0,  -- booking email had no AC contact
  flags               text[] not null default '{}',   -- anomalies (e.g. no tracking after 5 Oct)
  report              jsonb  not null default '[]',    -- per-booking lines (masked name, domain, date, action)
  errors              text[] not null default '{}'
);

create index if not exists calendly_src_sync_runs_ran_at_idx on public.calendly_src_sync_runs (ran_at desc);

-- RLS on with no policies: the edge function writes with the service role (bypasses RLS),
-- the anon key is kept out. Same convention as public.ac_new_leads.
alter table public.calendly_src_sync_runs enable row level security;
