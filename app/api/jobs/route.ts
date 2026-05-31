import { NextResponse } from "next/server";
import type { AnalyzedJob } from "@/lib/types";
import { analyzeJob } from "@/lib/gemini";
import { loadCache, saveCache } from "@/lib/cache";
import { createLogger, newRunId } from "@/lib/log";
import { countBy, ensureDescription, gatherJobs, mapWithConcurrency, readConfig } from "@/lib/pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Combined one-shot: fetch + analyze everything, sorted. Handy for CLI/testing.
// The dashboard uses /api/jobs/list + /api/jobs/analyze for live progress.
export async function GET(req: Request) {
  const runId = newRunId();
  const log = createLogger("jobs", runId);
  const stopAll = log.timer("run total");

  let cfg;
  try {
    cfg = await readConfig();
  } catch (e: any) {
    log.error("config load failed", { error: e.message });
    return NextResponse.json({ error: `config: ${e.message}`, runId }, { status: 500 });
  }
  const { search, profile, companies } = cfg;

  const params = new URL(req.url).searchParams;
  const windowHours = Number(params.get("windowHours") ?? search.windowHours ?? 24);
  const maxAnalyze = Number(params.get("limit") ?? search.maxAnalyze ?? 40);
  log.info("config loaded", { windowHours, maxAnalyze });

  const gathered = await gatherJobs(search, companies, { windowHours, maxAnalyze }, log);

  const cache = await loadCache();
  let analysisError: string | null = null;
  let cacheHits = 0;
  let geminiCalls = 0;
  let geminiFails = 0;
  const stopAnalyze = log.timer("gemini analysis");
  const results = await mapWithConcurrency(gathered.jobs, 3, async (job) => {
    try {
      let analysis = cache[job.id];
      if (analysis) {
        cacheHits++;
      } else {
        await ensureDescription(job);
        analysis = await analyzeJob(job, profile);
        geminiCalls++;
        cache[job.id] = analysis;
      }
      return { ...job, postedAtKnown: !!job.postedAt, analysis } as AnalyzedJob;
    } catch (e: any) {
      geminiFails++;
      log.warn("analysis failed", { id: job.id, error: e.message });
      if (!analysisError) analysisError = e.message ?? String(e);
      return null;
    }
  });
  await saveCache(cache);
  stopAnalyze();
  log.info("analysis done", { cacheHits, geminiCalls, geminiFails });

  const analyzed = results.filter((j): j is AnalyzedJob => j !== null);
  analyzed.sort((a, b) => b.analysis.matchScore - a.analysis.matchScore);

  const totalMs = stopAll();
  log.info("RESULT", {
    totalFound: gathered.totalFound,
    analyzed: analyzed.length,
    recommend: countBy(analyzed, (j) => j.analysis.recommend),
    failedQueries: gathered.errors.length,
    totalMs,
  });

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    runId,
    windowHours,
    sources: search.sources,
    regions: search.regions.map((r) => r.label),
    totalFound: gathered.totalFound,
    analyzedCount: analyzed.length,
    cappedAt: gathered.cappedAt,
    timings: { totalMs },
    jobs: analyzed,
    errors: gathered.errors,
    analysisError,
  });
}
