import type { Analysis, Draft, JobState, RawJob, StoredJob } from "./types";
import { defaultState } from "./types";
import { supabase, supabaseConfigured } from "./supabase";
import { normKey } from "./normalize";

/**
 * Persistent job + application-state store, backed by the Supabase `jobs` table.
 * This is what turns jobnow into a tracker: jobs and their status/notes/drafts
 * survive refreshes (and Vercel's read-only filesystem).
 *
 * Each StoredJob is split across columns:
 *   id        text  = RawJob.id (the dictionary key; StoredJob itself has no id)
 *   job       jsonb = RawJob
 *   analysis  jsonb = Analysis | null
 *   state     jsonb = JobState
 *   draft     jsonb = Draft | null
 *   first_seen timestamptz = StoredJob.firstSeen
 *   last_seen  timestamptz = StoredJob.lastSeen
 */
type Store = Record<string, StoredJob>;

interface JobRow {
  id: string;
  job: RawJob;
  analysis: Analysis | null;
  state: JobState;
  draft: Draft | null;
  first_seen: string;
  last_seen: string;
}

/** Reconstruct a StoredJob (which has no id field) from a `jobs` table row. */
function rowToStoredJob(row: JobRow): StoredJob {
  return {
    job: row.job,
    analysis: row.analysis,
    state: row.state,
    draft: row.draft ?? null,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
  };
}

function storedJobToRow(id: string, rec: StoredJob): JobRow {
  return {
    id,
    job: rec.job,
    analysis: rec.analysis,
    state: rec.state,
    draft: rec.draft ?? null,
    first_seen: rec.firstSeen,
    last_seen: rec.lastSeen,
  };
}

export async function loadStore(): Promise<Store> {
  if (!supabaseConfigured()) return {};
  const { data, error } = await supabase.from("jobs").select("*");
  if (error || !data) return {};
  const out: Store = {};
  for (const row of data as JobRow[]) out[row.id] = rowToStoredJob(row);
  return out;
}

/** Insert/refresh a job + its analysis, preserving any existing user state. */
export async function upsertJob(
  job: RawJob,
  analysis: Analysis | null,
  now: string
): Promise<StoredJob> {
  if (!supabaseConfigured())
    return { job, analysis, state: defaultState(now), draft: null, firstSeen: now, lastSeen: now };

  const { data: existingRow } = await supabase
    .from("jobs")
    .select("*")
    .eq("id", job.id)
    .maybeSingle();

  const existing = existingRow ? rowToStoredJob(existingRow as JobRow) : null;

  const record: StoredJob = existing
    ? { ...existing, job, analysis: analysis ?? existing.analysis, lastSeen: now }
    : { job, analysis, state: defaultState(now), draft: null, firstSeen: now, lastSeen: now };

  await supabase.from("jobs").upsert(storedJobToRow(job.id, record), { onConflict: "id" });
  return record;
}

export async function updateState(
  id: string,
  patch: Partial<JobState>,
  now: string
): Promise<JobState | null> {
  // Without Supabase, echo an optimistic state so the UI still responds.
  if (!supabaseConfigured()) return { ...defaultState(now), ...patch, updatedAt: now };

  const { data: existingRow } = await supabase
    .from("jobs")
    .select("state")
    .eq("id", id)
    .maybeSingle();

  if (!existingRow) return null;

  const current = (existingRow as { state: JobState }).state;
  const state: JobState = { ...current, ...patch, updatedAt: now };

  await supabase.from("jobs").update({ state }).eq("id", id);
  return state;
}

export async function saveDraft(id: string, draft: Draft): Promise<void> {
  if (!supabaseConfigured()) return;
  const { data: existingRow } = await supabase
    .from("jobs")
    .select("id")
    .eq("id", id)
    .maybeSingle();

  if (!existingRow) return;
  await supabase.from("jobs").update({ draft }).eq("id", id);
}

/** Map of jobId -> state, for merging stored status into freshly fetched jobs. */
export async function getStateMap(): Promise<Record<string, JobState>> {
  if (!supabaseConfigured()) return {};
  const { data, error } = await supabase.from("jobs").select("id, state");
  if (error || !data) return {};
  const out: Record<string, JobState> = {};
  for (const row of data as Pick<JobRow, "id" | "state">[]) out[row.id] = row.state;
  return out;
}

/**
 * Map of normalized company+title -> state, but ONLY for jobs you've actually
 * tracked (not the default "new"). Lets a cross-platform duplicate inherit an
 * "applied"/"saved" status even though its id differs.
 */
export async function getStateByKey(): Promise<Record<string, JobState>> {
  if (!supabaseConfigured()) return {};
  const { data, error } = await supabase.from("jobs").select("job, state");
  if (error || !data) return {};
  const out: Record<string, JobState> = {};
  for (const row of data as { job: RawJob; state: JobState }[]) {
    if (row.state?.status && row.state.status !== "new") {
      out[normKey(row.job.company, row.job.title)] = row.state;
    }
  }
  return out;
}
