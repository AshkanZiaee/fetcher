import type { RawJob } from "./types";
import { htmlToText } from "./html";
import type { Logger } from "./log";

/**
 * Job-board sources. LinkedIn + StepStone are fetched via their public,
 * no-login endpoints. Xing is JS/login-walled, so it's a graceful stub.
 *
 * These are public pages a logged-out browser can see; we fetch them for the
 * user's own job search and hand the text to Gemini. Be polite: low volume,
 * one page per keyword/region.
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;

async function getHtmlOnce(url: string): Promise<string> {
  // Abort hung connections so one slow endpoint can't freeze the whole run
  // (this was the "stuck on Scanning…" cause).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "de-DE,de;q=0.9,en;q=0.8" },
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (res.status === 429) throw new Error("HTTP 429 rate limited");
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return res.text();
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error(`timeout after ${FETCH_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Retry on 429 / timeout with jittered backoff — LinkedIn throttles bursts. */
async function getHtml(url: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await getHtmlOnce(url);
    } catch (e: any) {
      lastErr = e;
      const retryable = /429|timeout/.test(String(e?.message ?? e));
      if (!retryable || attempt === MAX_RETRIES - 1) break;
      const backoff = 800 * (attempt + 1) + Math.floor(Math.random() * 400);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

function clean(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export interface SourceResult {
  source: string;
  region: string;
  jobs: RawJob[];
  error?: string;
}

// ─────────────────────────── LinkedIn ───────────────────────────

export async function linkedinSearch(
  keyword: string,
  location: string,
  region: string,
  windowHours: number,
  log?: Logger
): Promise<RawJob[]> {
  const tpr = Math.round(windowHours * 3600);
  const url =
    `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?` +
    `keywords=${encodeURIComponent(keyword)}&location=${encodeURIComponent(
      location
    )}&f_TPR=r${tpr}&start=0`;
  const html = await getHtml(url);

  const cards = html.split(/<li[ >]/).slice(1);
  const jobs: RawJob[] = [];
  for (const card of cards) {
    const title = card.match(
      /base-search-card__title[^>]*>([\s\S]*?)<\/h3>/
    )?.[1];
    const company = card.match(
      /base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/
    )?.[1];
    const loc = card.match(/job-search-card__location[^>]*>([\s\S]*?)<\/span>/)?.[1];
    const link = card.match(/href="(https:\/\/[a-z.]*linkedin\.com\/jobs\/view\/[^"?]+)/)?.[1];
    const date = card.match(/datetime="([^"]+)"/)?.[1];
    const urn = card.match(/jobPosting:(\d+)/)?.[1] ?? link?.match(/-(\d{6,})$/)?.[1];
    if (!title || !link || !urn) continue;
    jobs.push({
      id: `li-${urn}`,
      source: "linkedin",
      region,
      company: company ? decode(clean(company)) : "—",
      title: decode(clean(title)),
      location: loc ? clean(loc) : region,
      url: link,
      postedAt: date ?? null,
      description: "", // enriched on demand before analysis
    });
  }
  log?.debug(`linkedin "${keyword}" / ${region}`, {
    cards: cards.length,
    parsed: jobs.length,
  });
  return jobs;
}

/** Fetch the full description for one LinkedIn posting (best-effort). */
export async function enrichLinkedin(job: RawJob): Promise<string> {
  const id = job.id.replace(/^li-/, "");
  try {
    const html = await getHtml(
      `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`
    );
    const m = html.match(/show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/);
    return m ? htmlToText(m[1]) : "";
  } catch {
    return "";
  }
}

// ─────────────────────────── StepStone ───────────────────────────

/** Convert StepStone's German "vor X Tagen" / "Gestern" / "Heute" to hours. */
function germanAgeToHours(s: string | null): number | null {
  if (!s) return null;
  const t = s.toLowerCase();
  if (/heute|gerade|stunde/.test(t)) {
    const h = t.match(/vor\s+(\d+)\s+stunde/);
    return h ? Number(h[1]) : 1;
  }
  if (/gestern/.test(t)) return 24;
  const m = t.match(/vor\s+(\d+)\s+(minute|tag|woche|monat)/);
  if (!m) return null;
  const n = Number(m[1]);
  return { minute: n / 60, tag: n * 24, woche: n * 168, monat: n * 720 }[m[2]]!;
}

function cardField(card: string, name: string): string | null {
  const m = card.match(
    new RegExp(`data-at="${name}"[^>]*>([\\s\\S]*?)(?=data-at="job-item|</article)`)
  );
  if (!m) return null;
  const stripped = m[1]
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]*$/, ""); // drop any trailing unclosed tag fragment
  const text = decode(clean(stripped));
  return text || null;
}

export async function stepstoneSearch(
  keyword: string,
  regionSlug: string,
  region: string,
  windowHours: number,
  log?: Logger
): Promise<RawJob[]> {
  const kw = keyword.toLowerCase().replace(/\s+/g, "-");
  const html = await getHtml(
    `https://www.stepstone.de/jobs/${encodeURIComponent(kw)}/in-${regionSlug}`
  );

  const jobs: RawJob[] = [];
  const cards = html
    .split(/<article/)
    .map((c) => "<article" + c)
    .filter((c) => c.includes('data-at="job-item"') && c.includes("/stellenangebote--"));

  let droppedOld = 0;
  for (const card of cards) {
    const link = card.match(/href="(\/stellenangebote--[^"?]+)/)?.[1];
    const title = cardField(card, "job-item-title");
    if (!link || !title) continue;
    const ageStr = cardField(card, "job-item-timeago");
    const ageHours = germanAgeToHours(ageStr);
    // StepStone ignores the server-side age filter, so enforce the window here.
    if (ageHours !== null && ageHours > windowHours) {
      droppedOld++;
      continue;
    }
    jobs.push({
      id: `ss-${link.split("--")[1]?.slice(0, 48) ?? jobs.length}`,
      source: "stepstone",
      region,
      company: cardField(card, "job-item-company-name") ?? "—",
      location: cardField(card, "job-item-location") ?? region,
      title,
      url: `https://www.stepstone.de${link}`,
      // approximate a timestamp from the relative age for sorting/window
      postedAt:
        ageHours !== null
          ? new Date(Date.now() - ageHours * 3600 * 1000).toISOString()
          : null,
      description: "",
    });
  }
  log?.debug(`stepstone "${keyword}" / ${region}`, {
    cards: cards.length,
    kept: jobs.length,
    droppedOlderThanWindow: droppedOld,
  });
  return jobs;
}

// ─────────────────────────── Xing (blocked) ───────────────────────────

export async function xingSearch(): Promise<RawJob[]> {
  // Xing's job search requires JavaScript/login (DataDome-style wall); the
  // logged-out endpoint returns no parseable listings. Left as a stub so the
  // UI can show it as unavailable rather than silently dropping it.
  throw new Error("Xing requires login/JS — not fetchable without an account");
}
