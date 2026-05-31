import { NextRequest, NextResponse } from "next/server";
import { readLogTail, clearLog } from "@/lib/log";

export const dynamic = "force-dynamic";

// GET /api/logs?lines=300  → plain-text tail of the run log
export async function GET(req: NextRequest) {
  const lines = Number(req.nextUrl.searchParams.get("lines") ?? 300);
  const text = await readLogTail(lines);
  return new NextResponse(text, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

// DELETE /api/logs → wipe the log file
export async function DELETE() {
  await clearLog();
  return NextResponse.json({ cleared: true });
}
