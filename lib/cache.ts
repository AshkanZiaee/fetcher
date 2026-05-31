import type { Analysis } from "./types";
import { supabase, supabaseConfigured } from "./supabase";

// Cache analyses by job id so a refresh doesn't re-spend Gemini calls.
// Backed by the Supabase `analysis_cache` table (id = RawJob.id, analysis jsonb).
const CACHE_TABLE = "analysis_cache";

type Cache = Record<string, Analysis>;

// ── Single-row helpers (the hot path) ──────────────────────────────────────
// The per-job analyze route uses these so it never reads/writes the whole table.

export async function getAnalysis(id: string): Promise<Analysis | null> {
  if (!supabaseConfigured()) return null;
  const { data, error } = await supabase
    .from(CACHE_TABLE)
    .select("analysis")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  return (data as { analysis: Analysis }).analysis;
}

export async function putAnalysis(id: string, analysis: Analysis): Promise<void> {
  if (!supabaseConfigured()) return;
  await supabase.from(CACHE_TABLE).upsert({ id, analysis }, { onConflict: "id" });
}

// ── Whole-map helpers (used by the combined /api/jobs CLI route) ────────────

export async function loadCache(): Promise<Cache> {
  if (!supabaseConfigured()) return {};
  try {
    const { data, error } = await supabase.from(CACHE_TABLE).select("id, analysis");
    if (error || !data) return {};
    const cache: Cache = {};
    for (const row of data) cache[row.id as string] = row.analysis as Analysis;
    return cache;
  } catch {
    return {};
  }
}

export async function saveCache(cache: Cache): Promise<void> {
  if (!supabaseConfigured()) return;
  const rows = Object.entries(cache).map(([id, analysis]) => ({ id, analysis }));
  if (rows.length === 0) return;
  // Upsert every entry; we intentionally don't delete missing keys.
  await supabase.from(CACHE_TABLE).upsert(rows, { onConflict: "id" });
}
