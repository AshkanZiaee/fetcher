import { NextResponse } from "next/server";
import { gatherJobs, readConfig } from "@/lib/pipeline";
import { createLogger, newRunId } from "@/lib/log";
import { getStateByKey, getStateMap } from "@/lib/store";
import { normKey } from "@/lib/normalize";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Phase 1: fetch + dedupe + enrich (NO Gemini). Fast — the UI renders this
// immediately, then asks /api/jobs/analyze to score each card live.
export async function GET(req: Request) {
  const runId = newRunId();
  const log = createLogger("list", runId);
  const stop = log.timer("list total");

  let cfg;
  try {
    cfg = await readConfig();
  } catch (e: any) {
    log.error("config load failed", { error: e.message });
    return NextResponse.json({ error: `config: ${e.message}`, runId }, { status: 500 });
  }

  const params = new URL(req.url).searchParams;
  const windowHours = Number(params.get("windowHours") ?? cfg.search.windowHours ?? 24);
  const maxAnalyze = Number(params.get("limit") ?? cfg.search.maxAnalyze ?? 40);
  log.info("config loaded", {
    keywords: cfg.search.keywords.length,
    regions: cfg.search.regions.map((r) => r.label),
    sources: cfg.search.sources,
    windowHours,
    maxAnalyze,
  });

  const result = await gatherJobs(cfg.search, cfg.companies, { windowHours, maxAnalyze }, log);
  // Merge saved status by job id, and — for cross-platform duplicates — by
  // normalized company+title, so "already applied" follows the job everywhere.
  const [stateMap, stateByKey] = await Promise.all([getStateMap(), getStateByKey()]);
  const totalMs = stop();
  log.info("LIST RESULT", { totalFound: result.totalFound, returned: result.jobs.length, totalMs });

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    runId,
    windowHours,
    sources: cfg.search.sources,
    regions: cfg.search.regions.map((r) => r.label),
    totalFound: result.totalFound,
    cappedAt: result.cappedAt,
    timings: { listMs: totalMs },
    jobs: result.jobs.map((j) => ({
      ...j,
      postedAtKnown: !!j.postedAt,
      state: stateMap[j.id] ?? stateByKey[normKey(j.company, j.title)] ?? null,
    })),
    errors: result.errors,
  });
}
