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
  // sort=2 = newest first (default is relevance, which buries fresh jobs and
  // makes the 24h window look empty). Pull 2 pages for better coverage.
  const pages = await Promise.all(
    [1, 2].map((page) =>
      getHtml(
        `https://www.stepstone.de/jobs/${encodeURIComponent(kw)}/in-${regionSlug}?sort=2&page=${page}`
      ).catch(() => "")
    )
  );

  const jobs: RawJob[] = [];
  const seen = new Set<string>();
  const cards = pages
    .flatMap((html) => html.split(/<article/).map((c) => "<article" + c))
    .filter((c) => c.includes('data-at="job-item"') && c.includes("/stellenangebote--"));

  let droppedOld = 0;
  for (const card of cards) {
    const link = card.match(/href="(\/stellenangebote--[^"?]+)/)?.[1];
    const title = cardField(card, "job-item-title");
    if (!link || !title || seen.has(link)) continue;
    seen.add(link);
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

// ─────────────────────────── Xing ───────────────────────────

/**
 * Xing public job search. The logged-out HTML search page is server-side
 * rendered (no JS/login wall — the "Anmelden" strings are just nav chrome) and
 * returns ~20 listings per page as <article data-testid="job-search-result">
 * with title/company/location and only a RELATIVE posted date ("Vor 2 Tagen").
 * Exact ISO dates live on each detail page's application/ld+json JobPosting, so
 * we optionally enrich a bounded number of cards for an absolute datePosted.
 *
 * CAVEAT: Xing may rate-limit / serve an anti-bot challenge from datacenter IPs
 * (Vercel/AWS) even though it didn't in testing. Detail enrichment is throttled
 * and capped, and any failure is non-fatal (the relative-date listing is kept).
 */

/** Region keywords we accept in a Xing listing's location string. */
const XING_REGION_HINTS: Record<string, string[]> = {
  Hessen: [
    "hessen", "frankfurt", "wiesbaden", "darmstadt", "kassel", "offenbach",
    "gießen", "giessen", "fulda", "marburg", "hanau", "rüsselsheim", "russelsheim",
  ],
  "Rheinland-Pfalz": [
    "rheinland-pfalz", "rhineland-palatinate", "mainz", "ludwigshafen", "koblenz",
    "trier", "kaiserslautern", "worms", "speyer", "neuwied", "bad kreuznach",
  ],
};

// Big cities/states clearly OUTSIDE Hessen + Rheinland-Pfalz — used to drop
// obvious noise while keeping every in-state town (the search is state-wide).
const XING_OTHER_REGIONS =
  /berlin|münchen|munich|hamburg|köln|cologne|stuttgart|düsseldorf|dusseldorf|hannover|hanover|leipzig|dresden|bremen|nürnberg|nuremberg|essen|dortmund|bonn|münster|muenster|bielefeld|bochum|wuppertal|karlsruhe|mannheim|augsburg|chemnitz|kiel|magdeburg|freiburg|saarbrücken|saarbrucken|erfurt|rostock|österreich|austria|schweiz|switzerland|wien|zürich/i;

/**
 * Keep listings across ALL of the target state. Since the Xing search is now
 * state-wide ("Hessen"/"Rheinland-Pfalz"), we accept everything EXCEPT listings
 * that clearly name a different big city/state — so small towns in-state aren't
 * wrongly dropped.
 */
function inTargetRegion(location: string, regionLabel: string): boolean {
  const loc = location.toLowerCase();
  if (/remote|deutschlandweit|homeoffice|home office|home-office/.test(loc)) return true;
  const hints = XING_REGION_HINTS[regionLabel] ?? [];
  if (hints.some((h) => loc.includes(h))) return true; // explicitly in-state
  if (loc.includes("hessen") || loc.includes("rheinland") || loc.includes("pfalz")) return true;
  // Unknown small town: keep it unless it's clearly another region.
  return !XING_OTHER_REGIONS.test(loc);
}

/** Pull the schema.org JobPosting datePosted (ISO) from a detail page. */
function xingDetailDate(html: string): string | null {
  const blocks = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g);
  if (!blocks) return null;
  for (const block of blocks) {
    const json = block.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    try {
      const data = JSON.parse(json);
      const nodes = Array.isArray(data) ? data : [data];
      for (const n of nodes) {
        if (n && n["@type"] === "JobPosting" && typeof n.datePosted === "string") {
          const d = new Date(n.datePosted);
          if (!isNaN(d.getTime())) return d.toISOString();
        }
      }
    } catch {
      // ignore malformed blocks
    }
  }
  return null;
}

const XING_ENRICH_CAP = 10; // bound detail-page fetches per query (politeness)

export async function xingSearch(
  keyword: string,
  location: string,
  region: string,
  windowHours: number,
  log?: Logger
): Promise<RawJob[]> {
  const url =
    `https://www.xing.com/jobs/search?` +
    `keywords=${encodeURIComponent(keyword)}&location=${encodeURIComponent(location)}&page=1`;
  const html = await getHtml(url); // getHtml follows redirects (→ /jobs/search/ki)

  const cards = html
    .split(/<article/)
    .map((c) => "<article" + c)
    .filter((c) => c.includes('data-testid="job-search-result"') && /\/jobs\/[a-z0-9-]+-\d+/.test(c));

  const now = Date.now();
  const seen = new Set<string>();
  const parsed: { job: RawJob; detailUrl: string; ageKnown: boolean }[] = [];
  let droppedRegion = 0;

  for (const card of cards) {
    const link = card.match(/href="(\/jobs\/[a-z0-9-]+-\d+)/)?.[1];
    if (!link) continue;
    const id = link.match(/-(\d+)$/)?.[1];
    if (!id || seen.has(id)) continue;

    const title =
      card.match(/data-testid="job-teaser-list-title"[^>]*>([\s\S]*?)<\/[^>]+>/)?.[1] ??
      card.match(/data-testid="job-teaser-list-title"[^>]*>([\s\S]*?)(?=<)/)?.[1];
    if (!title) continue;

    const company =
      card.match(/data-testid="job-teaser-list-company"[^>]*>([\s\S]*?)<\/[^>]+>/)?.[1] ??
      card.match(/data-testid="job-teaser-company"[^>]*>([\s\S]*?)<\/[^>]+>/)?.[1];
    const loc =
      card.match(/data-testid="job-teaser-list-location"[^>]*>([\s\S]*?)<\/[^>]+>/)?.[1] ??
      card.match(/data-testid="job-teaser-location"[^>]*>([\s\S]*?)<\/[^>]+>/)?.[1];
    const locText = loc ? decode(clean(loc)) : region;

    if (!inTargetRegion(locText, region)) {
      droppedRegion++;
      continue;
    }

    const ageStr = card.match(/Vor\s+\d+\s+(?:Minute|Stunde|Tag|Woche|Monat)[a-zäöü]*/i)?.[0] ?? null;
    const ageHours = germanAgeToHours(ageStr);

    seen.add(id);
    parsed.push({
      detailUrl: `https://www.xing.com${link}`,
      ageKnown: ageHours !== null,
      job: {
        id: `xing-${id}`,
        source: "xing",
        region,
        company: company ? decode(clean(company)) : "—",
        title: decode(clean(title)),
        location: locText,
        url: `https://www.xing.com${link}`,
        postedAt: ageHours !== null ? new Date(now - ageHours * 3600 * 1000).toISOString() : null,
        description: "",
      },
    });
  }

  // Enrich a bounded set with exact ld+json datePosted, then enforce the window.
  let droppedOld = 0;
  const enrichable = parsed
    .filter((p) => {
      if (!p.ageKnown) return true;
      const ageH = (now - new Date(p.job.postedAt!).getTime()) / 3600000;
      return ageH <= windowHours;
    })
    .slice(0, XING_ENRICH_CAP);

  // Parallel (capped) detail fetches — was sequential w/ 400ms throttle.
  await Promise.all(
    enrichable.map(async (p) => {
      try {
        const detail = await getHtml(p.detailUrl);
        const iso = xingDetailDate(detail);
        if (iso) p.job.postedAt = iso;
      } catch {
        // keep the relative-date approximation on failure
      }
    })
  );

  const jobs: RawJob[] = [];
  for (const p of parsed) {
    if (p.job.postedAt) {
      const ageH = (now - new Date(p.job.postedAt).getTime()) / 3600000;
      if (ageH > windowHours) {
        droppedOld++;
        continue;
      }
    }
    jobs.push(p.job);
  }

  log?.debug(`xing "${keyword}" / ${region}`, {
    cards: cards.length,
    parsed: parsed.length,
    enriched: enrichable.length,
    kept: jobs.length,
    droppedRegion,
    droppedOlderThanWindow: droppedOld,
  });
  return jobs;
}

// ─────────────────────────── Indeed ───────────────────────────

/**
 * Indeed via its MOBILE-APP GraphQL endpoint (apis.indeed.com/graphql) — the
 * technique used by the JobSpy library. Unlike indeed.com (Cloudflare-walled,
 * 403 from datacenter IPs), this app API returns structured JSON and works from
 * Vercel. Sorted by date, filtered to the region + window.
 *
 * CAVEAT: relies on Indeed's embedded mobile app API key, which is gray-area and
 * could be rotated/revoked by Indeed. Failures are non-fatal (caught upstream),
 * and Indeed can be toggled off via search.json `sources.indeed`.
 */
const INDEED_API_KEY = "161092c2017b5bbab13edb12461a62d5a833871e7cad6d9d475304573de67ac8";

export async function indeedSearch(
  keyword: string,
  location: string,
  region: string,
  windowHours: number,
  log?: Logger
): Promise<RawJob[]> {
  const esc = (s: string) => s.replace(/"/g, '\\"');
  const query = `query { jobSearch(what: "${esc(keyword)}", location: {where: "${esc(
    location
  )}", radius: 75, radiusUnit: KILOMETERS}, limit: 25, sort: DATE) { results { job { key title datePublished description { html } url employer { name } location { city formatted { long } } } } } }`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let data: any;
  try {
    const res = await fetch("https://apis.indeed.com/graphql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "indeed-api-key": INDEED_API_KEY,
        "indeed-locale": "en-US",
        "indeed-co": "DE",
        "user-agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Indeed App 193.1",
      },
      body: JSON.stringify({ query }),
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error(`timeout after ${FETCH_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (data?.errors?.length) throw new Error(`indeed: ${data.errors[0]?.message ?? "graphql error"}`);

  const results = data?.data?.jobSearch?.results ?? [];
  const now = Date.now();
  const seen = new Set<string>();
  const jobs: RawJob[] = [];
  let droppedRegion = 0;
  let droppedOld = 0;

  for (const r of results) {
    const j = r.job;
    if (!j?.key || seen.has(j.key)) continue;
    const loc = j.location?.formatted?.long ?? j.location?.city ?? region;
    if (!inTargetRegion(loc, region)) {
      droppedRegion++;
      continue;
    }
    const postedAt = j.datePublished ? new Date(Number(j.datePublished)).toISOString() : null;
    if (postedAt) {
      const ageH = (now - new Date(postedAt).getTime()) / 3600000;
      if (ageH > windowHours) {
        droppedOld++;
        continue;
      }
    }
    seen.add(j.key);
    jobs.push({
      id: `indeed-${j.key}`,
      source: "indeed",
      region,
      company: j.employer?.name ? decode(clean(j.employer.name)) : "—",
      title: decode(clean(j.title)),
      location: loc,
      url: j.url ?? `https://de.indeed.com/viewjob?jk=${j.key}`,
      postedAt,
      description: htmlToText(j.description?.html ?? ""),
    });
  }

  log?.debug(`indeed "${keyword}" / ${region}`, {
    results: results.length,
    kept: jobs.length,
    droppedRegion,
    droppedOlderThanWindow: droppedOld,
  });
  return jobs;
}
