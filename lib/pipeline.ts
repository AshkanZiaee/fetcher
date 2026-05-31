import { promises as fs } from "fs";
import path from "path";
import type { CompanyConfig, RawJob } from "./types";
import { fetchAll, withinWindow } from "./fetchers";
import { linkedinSearch, stepstoneSearch, enrichLinkedin } from "./sources";
import type { Logger } from "./log";

/** Lazily fill in a posting's description if a source left it empty (LinkedIn). */
export async function ensureDescription(job: RawJob): Promise<RawJob> {
  if (job.description || job.source !== "linkedin") return job;
  job.description = await enrichLinkedin(job);
  return job;
}

export interface SearchConfig {
  keywords: string[];
  regions: { label: string; linkedin: string; stepstone: string }[];
  sources: { linkedin: boolean; stepstone: boolean; xing: boolean };
  windowHours: number;
  /** Career pages post rarely, so they get their own wider window. */
  careerWindowHours?: number;
  maxAnalyze: number;
  includeCareerPages: boolean;
}

export async function readConfig() {
  const dir = path.join(process.cwd(), "config");
  const [searchRaw, profile] = await Promise.all([
    fs.readFile(path.join(dir, "search.json"), "utf8"),
    fs.readFile(path.join(dir, "profile.md"), "utf8"),
  ]);
  const search = JSON.parse(searchRaw) as SearchConfig;
  let companies: CompanyConfig[] = [];
  if (search.includeCareerPages) {
    companies = JSON.parse(await fs.readFile(path.join(dir, "companies.json"), "utf8"));
  }
  return { search, profile, companies };
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Round-robin jobs across groups so the maxAnalyze cap represents everything.
 * Career pages group PER COMPANY (so one big employer like Amazon can't eat all
 * the career slots); boards group per source.
 */
function interleaveBySource(jobs: RawJob[]): RawJob[] {
  const key = (j: RawJob) => (j.source === "career" ? `career:${j.company}` : j.source);
  const groups = new Map<string, RawJob[]>();
  for (const j of jobs) {
    if (!groups.has(key(j))) groups.set(key(j), []);
    groups.get(key(j))!.push(j);
  }
  // Interleave career-company groups with the board groups for a fair mix.
  const careerGroups = [...groups.keys()].filter((k) => k.startsWith("career:"));
  const orderedKeys = [
    "linkedin",
    "stepstone",
    ...careerGroups,
    "xing",
    ...[...groups.keys()].filter((k) => !k.startsWith("career:") && !["linkedin", "stepstone", "xing"].includes(k)),
  ];
  const lists = orderedKeys.map((k) => groups.get(k) ?? []).filter((l) => l.length);

  const out: RawJob[] = [];
  let added = true;
  while (added) {
    added = false;
    for (const l of lists) {
      const next = l.shift();
      if (next) {
        out.push(next);
        added = true;
      }
    }
  }
  return out;
}

export function countBy<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const k = key(it);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export interface GatherResult {
  jobs: RawJob[]; // deduped, capped to maxAnalyze, LinkedIn descriptions enriched
  totalFound: number;
  cappedAt: number | null;
  windowHours: number;
  errors: { source: string; error: string }[];
}

/**
 * Phase 1 of the pipeline: fetch all sources, dedupe, cap, and enrich
 * descriptions. No Gemini here — this is the fast part the UI shows first.
 */
export async function gatherJobs(
  search: SearchConfig,
  companies: CompanyConfig[],
  opts: { windowHours: number; maxAnalyze: number },
  log: Logger
): Promise<GatherResult> {
  const { windowHours, maxAnalyze } = opts;
  const errors: { source: string; error: string }[] = [];

  // ── Fan out across enabled sources × keywords × regions ──
  const tasks: (() => Promise<RawJob[]>)[] = [];
  for (const region of search.regions) {
    for (const kw of search.keywords) {
      if (search.sources.linkedin)
        tasks.push(() =>
          linkedinSearch(kw, region.linkedin, region.label, windowHours, log).catch((e) => {
            log.warn(`LinkedIn query failed · ${region.label} · ${kw}`, { error: e.message });
            errors.push({ source: `LinkedIn · ${region.label} · ${kw}`, error: e.message });
            return [];
          })
        );
      if (search.sources.stepstone)
        tasks.push(() =>
          stepstoneSearch(kw, region.stepstone, region.label, windowHours, log).catch((e) => {
            log.warn(`StepStone query failed · ${region.label} · ${kw}`, { error: e.message });
            errors.push({ source: `StepStone · ${region.label} · ${kw}`, error: e.message });
            return [];
          })
        );
    }
  }
  if (search.sources.xing)
    errors.push({ source: "Xing", error: "requires login/JS — not fetchable" });

  log.info("fanning out", { queries: tasks.length });
  const stopFetch = log.timer("fetch board sources");
  // 4-wide keeps LinkedIn bursts gentler (fewer 429s) while staying fast.
  const boardResults = await mapWithConcurrency(tasks, 4, (t) => t());
  stopFetch();
  let jobs: RawJob[] = boardResults.flat();
  log.info("board fetch done", { rawJobs: jobs.length, failedQueries: errors.length });

  // ── Optional career pages (wider window — they post rarely) ──
  if (search.includeCareerPages && companies.length) {
    const careerWindow = search.careerWindowHours ?? windowHours;
    const stopCp = log.timer("fetch career pages");
    const cp = await fetchAll(companies);
    stopCp();
    cp.filter((r) => r.error).forEach((r) =>
      errors.push({ source: r.company, error: r.error! })
    );
    const careerJobs = withinWindow(cp.flatMap((r) => r.jobs), careerWindow);
    log.info("career pages done", {
      companies: companies.length,
      withinWindow: careerJobs.length,
      careerWindowHours: careerWindow,
    });
    jobs.push(...careerJobs);
  }

  // ── Dedupe: by id (same job under multiple keywords) AND by company+title
  //    (e.g. Greenhouse lists one role under several locations). ──
  const seen = new Set<string>();
  const deduped: RawJob[] = [];
  for (const j of jobs) {
    const titleKey = `${j.company.toLowerCase()}::${j.title.toLowerCase().replace(/\s+/g, " ").trim()}`;
    if (seen.has(j.id) || seen.has(titleKey)) continue;
    seen.add(j.id);
    seen.add(titleKey);
    deduped.push(j);
  }

  const totalFound = deduped.length;
  // Round-robin across sources so the maxAnalyze cap doesn't starve the
  // smaller source (e.g. direct career pages) — each gets fair representation.
  const toReturn = interleaveBySource(deduped).slice(0, maxAnalyze);
  log.info("deduped", {
    rawJobs: jobs.length,
    unique: totalFound,
    bySource: countBy(deduped, (j) => j.source),
    willReturn: toReturn.length,
    cappedAt: totalFound > maxAnalyze ? maxAnalyze : null,
  });

  // NOTE: LinkedIn descriptions are enriched lazily in the analyze step
  // (see ensureDescription) so the list renders fast.

  return {
    jobs: toReturn,
    totalFound,
    cappedAt: totalFound > maxAnalyze ? maxAnalyze : null,
    windowHours,
    errors,
  };
}
