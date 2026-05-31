import { promises as fs } from "fs";
import path from "path";
import { NextResponse } from "next/server";
import type { RawJob } from "@/lib/types";
import { analyzeJob } from "@/lib/gemini";
import { ensureDescription } from "@/lib/pipeline";
import { getAnalysis, putAnalysis } from "@/lib/cache";
import { upsertJob } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

let profileCache: { mtime: number; text: string } | null = null;
async function getProfile(): Promise<string> {
  const p = path.join(process.cwd(), "config", "profile.md");
  const stat = await fs.stat(p);
  if (!profileCache || profileCache.mtime !== stat.mtimeMs) {
    profileCache = { mtime: stat.mtimeMs, text: await fs.readFile(p, "utf8") };
  }
  return profileCache.text;
}

// Phase 2: score ONE job. Client calls this per card (limited concurrency) so
// scores/tags fill in live. Cached by job id, so repeats are instant.
export async function POST(req: Request) {
  let job: RawJob;
  try {
    ({ job } = await req.json());
    if (!job?.id) throw new Error("missing job");
  } catch (e: any) {
    return NextResponse.json({ error: `bad request: ${e.message}` }, { status: 400 });
  }

  try {
    let analysis = await getAnalysis(job.id);
    let cached = true;
    if (!analysis) {
      await ensureDescription(job); // lazy LinkedIn description fetch
      analysis = await analyzeJob(job, await getProfile());
      await putAnalysis(job.id, analysis);
      cached = false;
    }
    // Persist into the tracker (keeps any existing user status/notes).
    const record = await upsertJob(job, analysis, new Date().toISOString());
    return NextResponse.json({ id: job.id, analysis, cached, state: record.state });
  } catch (e: any) {
    return NextResponse.json({ id: job.id, error: e.message ?? String(e) }, { status: 502 });
  }
}
