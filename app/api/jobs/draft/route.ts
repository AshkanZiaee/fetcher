import { promises as fs } from "fs";
import path from "path";
import { NextResponse } from "next/server";
import type { RawJob } from "@/lib/types";
import { draftApplication } from "@/lib/gemini";
import { ensureDescription } from "@/lib/pipeline";
import { loadStore, saveDraft } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function getProfile(): Promise<string> {
  return fs.readFile(path.join(process.cwd(), "config", "profile.md"), "utf8");
}

// POST { id, job?, force? } → generate (or return cached) a tailored application draft.
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const { id, force } = body;
  if (!id) return NextResponse.json({ error: "missing id" }, { status: 400 });

  const store = await loadStore();
  const rec = store[id];
  // Prefer the stored job (has full description); fall back to the posted job.
  const job: RawJob | undefined = rec?.job ?? body.job;
  if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });

  if (rec?.draft && !force) return NextResponse.json({ id, draft: rec.draft, cached: true });

  try {
    await ensureDescription(job);
    const draft = await draftApplication(job, await getProfile());
    if (rec) await saveDraft(id, draft);
    return NextResponse.json({ id, draft, cached: false });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? String(e) }, { status: 502 });
  }
}
