import { NextRequest, NextResponse } from "next/server";

/**
 * Best-effort ATS detector. Give it a careers URL or company domain; it probes
 * the common ATS endpoints and tells you the companies.json entry to paste.
 */
export const dynamic = "force-dynamic";

function slugGuesses(input: string): string[] {
  const clean = input
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[\/.]/)[0]
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
  return Array.from(new Set([clean, clean.replace(/-/g, "")]));
}

const PROBES = (slug: string) => [
  { ats: "greenhouse", id: slug, url: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`, ok: (d: any) => Array.isArray(d.jobs) },
  { ats: "lever", id: slug, url: `https://api.lever.co/v0/postings/${slug}?mode=json`, ok: (d: any) => Array.isArray(d) },
  { ats: "ashby", id: slug, url: `https://api.ashbyhq.com/posting-api/job-board/${slug}`, ok: (d: any) => Array.isArray(d.jobs) },
  { ats: "recruitee", id: slug, url: `https://${slug}.recruitee.com/api/offers/`, ok: (d: any) => Array.isArray(d.offers) },
  // SmartRecruiters returns 200 + empty list for ANY slug, so require >0 to
  // avoid false positives (require a real, posting company).
  { ats: "smartrecruiters", id: slug, url: `https://api.smartrecruiters.com/v1/companies/${slug}/postings`, ok: (d: any) => Array.isArray(d.content) && d.content.length > 0 },
];

export async function GET(req: NextRequest) {
  const input = req.nextUrl.searchParams.get("url") ?? req.nextUrl.searchParams.get("q");
  if (!input) return NextResponse.json({ error: "pass ?url=acme.com" }, { status: 400 });

  for (const slug of slugGuesses(input)) {
    for (const probe of PROBES(slug)) {
      try {
        const res = await fetch(probe.url, { cache: "no-store" });
        if (!res.ok) continue;
        const data = await res.json();
        if (probe.ok(data)) {
          const count = data.jobs?.length ?? data.offers?.length ?? data.content?.length ?? data.length ?? 0;
          return NextResponse.json({
            detected: true,
            entry: { name: slug, ats: probe.ats, id: probe.id },
            openJobs: count,
          });
        }
      } catch {
        /* try next */
      }
    }
    // personio uses a per-company subdomain; check both TLDs
    for (const tld of ["de", "com"]) {
      try {
        const res = await fetch(`https://${slug}.jobs.personio.${tld}/xml`, { cache: "no-store" });
        if (res.ok && (await res.text()).includes("position")) {
          return NextResponse.json({
            detected: true,
            entry: { name: slug, ats: "personio", id: slug, ...(tld === "com" ? { tld } : {}) },
          });
        }
      } catch {
        /* try next */
      }
    }
  }

  return NextResponse.json({
    detected: false,
    hint: "No known ATS matched. Use ats:\"custom\" with the full careers URL.",
  });
}
