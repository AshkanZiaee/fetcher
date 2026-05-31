import { NextResponse } from "next/server";
import type { AppStatus, JobState } from "@/lib/types";
import { updateState } from "@/lib/store";

export const dynamic = "force-dynamic";

const VALID: AppStatus[] = [
  "new",
  "saved",
  "applied",
  "interviewing",
  "offer",
  "rejected",
  "dismissed",
];

// POST { id, status?, notes?, appliedAt?, followUpAt? } → updates application state.
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const { id } = body;
  if (!id) return NextResponse.json({ error: "missing id" }, { status: 400 });
  if (body.status && !VALID.includes(body.status))
    return NextResponse.json({ error: `bad status ${body.status}` }, { status: 400 });

  const now = new Date().toISOString();
  const patch: Partial<JobState> = {};
  if (body.status !== undefined) {
    patch.status = body.status;
    // auto-stamp the applied date the first time it moves to "applied"
    if (body.status === "applied" && !body.appliedAt) patch.appliedAt = now;
  }
  if (body.notes !== undefined) patch.notes = body.notes;
  if (body.appliedAt !== undefined) patch.appliedAt = body.appliedAt;
  if (body.followUpAt !== undefined) patch.followUpAt = body.followUpAt;

  const state = await updateState(id, patch, now);
  if (!state) return NextResponse.json({ error: "job not found in store" }, { status: 404 });
  return NextResponse.json({ id, state });
}
