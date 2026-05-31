import { NextResponse } from "next/server";
import type { StoredJob } from "@/lib/types";
import { loadStore } from "@/lib/store";

export const dynamic = "force-dynamic";

// GET /api/pipeline → all tracked jobs (saved/applied/interviewing/…), newest first.
// This is the persistent tracker view, independent of today's fresh scan.
export async function GET() {
  const store = await loadStore();
  const jobs = Object.values(store)
    .filter((r: StoredJob) => r.state.status !== "new" && r.state.status !== "dismissed")
    .sort((a, b) => (a.state.updatedAt < b.state.updatedAt ? 1 : -1));

  const counts: Record<string, number> = {};
  for (const r of Object.values(store)) counts[r.state.status] = (counts[r.state.status] ?? 0) + 1;

  return NextResponse.json({ jobs, counts, total: Object.keys(store).length });
}
