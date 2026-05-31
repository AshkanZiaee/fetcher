-- jobnow Supabase storage migration
-- Tables back lib/store.ts (jobs) and lib/cache.ts (analysis_cache).
-- Personal single-user app: RLS enabled with wide-open anon policies.

-- jobs: one row per RawJob.id. StoredJob fields are split across columns.
--   id         = RawJob.id (StoredJob has no id of its own)
--   job        = RawJob jsonb
--   analysis   = Analysis | null jsonb
--   state      = JobState jsonb
--   draft      = Draft | null jsonb
--   first_seen = StoredJob.firstSeen
--   last_seen  = StoredJob.lastSeen
create table if not exists jobs (
  id text primary key,
  job jsonb not null,
  analysis jsonb,
  state jsonb not null,
  draft jsonb,
  first_seen timestamptz not null,
  last_seen timestamptz not null,
  updated_at timestamptz not null default now()
);

-- analysis_cache: keyed by RawJob.id -> Analysis jsonb.
create table if not exists analysis_cache (
  id text primary key,
  analysis jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Enable Row Level Security.
alter table jobs enable row level security;
alter table analysis_cache enable row level security;

-- Permissive policies: anon (and authenticated) may do everything.
-- Intentionally wide open for this personal, no-auth app. The server-side
-- SUPABASE_SERVICE_ROLE_KEY bypasses RLS; these policies keep the
-- NEXT_PUBLIC anon key working for reads/writes too.
drop policy if exists "anon all" on jobs;
create policy "anon all" on jobs
  for all
  to anon, authenticated
  using (true)
  with check (true);

drop policy if exists "anon all" on analysis_cache;
create policy "anon all" on analysis_cache
  for all
  to anon, authenticated
  using (true)
  with check (true);
