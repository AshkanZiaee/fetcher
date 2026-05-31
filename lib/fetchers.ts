import { XMLParser } from "fast-xml-parser";
import type { CompanyConfig, RawJob } from "./types";
import { getJson, getText, htmlToText } from "./html";

/**
 * One fetcher per ATS. Each returns postings normalized to RawJob[].
 * All of these are public, documented JSON/XML endpoints — no scraping.
 */

async function greenhouse(c: CompanyConfig): Promise<RawJob[]> {
  const data = await getJson(
    `https://boards-api.greenhouse.io/v1/boards/${c.id}/jobs?content=true`
  );
  return (data.jobs ?? []).map((j: any) => ({
    id: `gh-${c.id}-${j.id}`,
    company: c.name,
    title: j.title,
    location: j.location?.name ?? "—",
    url: j.absolute_url,
    postedAt: j.updated_at ?? j.first_published ?? null,
    description: htmlToText(j.content ?? ""),
  }));
}

async function lever(c: CompanyConfig): Promise<RawJob[]> {
  const data = await getJson(
    `https://api.lever.co/v0/postings/${c.id}?mode=json`
  );
  return (data ?? []).map((j: any) => ({
    id: `lv-${c.id}-${j.id}`,
    company: c.name,
    title: j.text,
    location: j.categories?.location ?? "—",
    url: j.hostedUrl,
    postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
    description: htmlToText(j.descriptionPlain ?? j.description ?? ""),
  }));
}

async function ashby(c: CompanyConfig): Promise<RawJob[]> {
  const data = await getJson(
    `https://api.ashbyhq.com/posting-api/job-board/${c.id}?includeCompensation=true`
  );
  return (data.jobs ?? []).map((j: any) => ({
    id: `ash-${c.id}-${j.id}`,
    company: c.name,
    title: j.title,
    location: j.location ?? j.address?.postalAddress?.addressLocality ?? "—",
    url: j.jobUrl,
    postedAt: j.publishedAt ?? null,
    description: htmlToText(j.descriptionPlain ?? j.descriptionHtml ?? ""),
  }));
}

async function recruitee(c: CompanyConfig): Promise<RawJob[]> {
  const data = await getJson(`https://${c.id}.recruitee.com/api/offers/`);
  return (data.offers ?? []).map((j: any) => ({
    id: `rec-${c.id}-${j.id}`,
    company: c.name,
    title: j.title,
    location: j.location ?? j.city ?? "—",
    url: j.careers_url ?? j.careers_apply_url,
    postedAt: j.published_at ?? null,
    description: htmlToText(j.description ?? ""),
  }));
}

// Hessen + Rheinland-Pfalz city/region matcher — used to keep big global
// employer feeds (SmartRecruiters, Amazon) down to in-region postings only.
const REGION_RE =
  /hesse|hessen|rheinland|rhineland|frankfurt|eschborn|wiesbaden|darmstadt|mainz|kassel|hanau|offenbach|wetzlar|bad homburg|bad hersfeld|rüsselsheim|ruesselsheim|weiterstadt|gießen|giessen|fulda|marburg|limburg|ludwigshafen|koblenz|kaiserslautern|trier|frankenthal|worms|speyer|montabaur|zweibrücken/i;

async function smartrecruiters(c: CompanyConfig): Promise<RawJob[]> {
  // ?country=de narrows giant global accounts (Bosch has 4500+ jobs); then we
  // keep only Hessen/RLP cities client-side.
  const data = await getJson(
    `https://api.smartrecruiters.com/v1/companies/${c.id}/postings?limit=100&country=de`
  );
  return (data.content ?? [])
    .filter((j: any) => {
      const where = `${j.location?.city ?? ""} ${j.location?.region ?? ""}`;
      return REGION_RE.test(where);
    })
    .map((j: any) => ({
      id: `sr-${c.id}-${j.id}`,
      company: c.name,
      title: j.name,
      location: [j.location?.city, j.location?.country].filter(Boolean).join(", "),
      url: j.ref ?? `https://jobs.smartrecruiters.com/${c.id}/${j.id}`,
      postedAt: j.releasedDate ?? null,
      description: j.jobAd?.sections?.jobDescription?.text
        ? htmlToText(j.jobAd.sections.jobDescription.text)
        : `${j.name} — ${j.typeOfEmployment?.label ?? ""}`,
    }));
}

const xml = new XMLParser({ ignoreAttributes: false });

async function personio(c: CompanyConfig): Promise<RawJob[]> {
  const tld = c.tld ?? "de";
  const body = await getText(`https://${c.id}.jobs.personio.${tld}/xml`);
  const parsed = xml.parse(body);
  let positions = parsed?.["workzag-jobs"]?.position ?? parsed?.jobs?.position ?? [];
  if (!Array.isArray(positions)) positions = positions ? [positions] : [];
  return positions.map((j: any) => {
    const descParts = j.jobDescriptions?.jobDescription;
    const descArr = Array.isArray(descParts) ? descParts : descParts ? [descParts] : [];
    const description = descArr
      .map((d: any) => `${d.name ?? ""}\n${d.value ?? ""}`)
      .join("\n\n");
    return {
      id: `per-${c.id}-${j.id}`,
      company: c.name,
      title: j.name,
      location: j.office ?? "—",
      url: `https://${c.id}.jobs.personio.${tld}/job/${j.id}`,
      postedAt: j.createdAt ?? null,
      description: htmlToText(description),
    } as RawJob;
  });
}

async function custom(c: CompanyConfig): Promise<RawJob[]> {
  if (!c.url) return [];
  const html = await getText(c.url);
  // We can't reliably parse arbitrary career pages into discrete jobs, so we
  // hand the whole page to Gemini as one "posting" flagged date-unknown.
  return [
    {
      id: `cust-${c.id ?? c.name}`,
      source: "career",
      company: c.name,
      title: `${c.name} — careers page`,
      location: "—",
      url: c.url,
      postedAt: null,
      description: htmlToText(html, 9000),
    },
  ];
}

/**
 * Amazon's public jobs API (amazon.jobs/search.json). Unlike the ATS fetchers
 * this is location-filtered to Hessen/RLP and sorted by recency, so it behaves
 * like a "newly posted jobs" feed for one big employer. Ignores c.id.
 */
async function amazon(c: CompanyConfig): Promise<RawJob[]> {
  const regions = ["Hesse", "Rhineland-Palatinate"];
  const out: RawJob[] = [];
  const seen = new Set<string>();
  for (const loc of regions) {
    const data = await getJson(
      `https://www.amazon.jobs/en/search.json?loc_query=${encodeURIComponent(
        loc
      )}&country=DEU&result_limit=100&sort=recent`
    );
    for (const j of data.jobs ?? []) {
      const id = `amz-${j.id_icims ?? j.id ?? j.job_path}`;
      if (seen.has(id)) continue;
      // amazon.jobs loc_query is fuzzy — keep only real Hessen/RLP locations.
      if (!REGION_RE.test(j.normalized_location ?? j.location ?? "")) continue;
      seen.add(id);
      out.push({
        id,
        company: c.name,
        title: j.title,
        location: j.normalized_location ?? j.location ?? loc,
        url: j.job_path ? `https://www.amazon.jobs${j.job_path}` : "https://www.amazon.jobs",
        postedAt: j.posted_date ? new Date(j.posted_date).toISOString() : null,
        description: htmlToText(
          [j.description, j.basic_qualifications, j.preferred_qualifications].filter(Boolean).join("\n\n")
        ),
      } as RawJob);
    }
  }
  return out;
}

/**
 * Deutsche Börse careers — a Nuxt SPA backed by my-job-shop's Typesense search.
 * The scoped search key is embedded in the page's __NUXT_DATA__ (and could
 * rotate), so we fetch it dynamically and cache it. Region-filtered to Hessen/RLP.
 */
let dbKeyCache: string | null = null;
async function deutscheBoerseKey(): Promise<string> {
  if (dbKeyCache) return dbKeyCache;
  const html = await getText("https://careers.deutsche-boerse.com/");
  const m = html.match(/id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("deutsche-boerse: no __NUXT_DATA__");
  const arr = JSON.parse(m[1]);
  for (const el of arr) {
    if (el && typeof el === "object" && !Array.isArray(el)) {
      for (const [k, v] of Object.entries(el)) {
        if (k.startsWith("typesenseApiKey") && typeof v === "number" && typeof arr[v] === "string" && arr[v].length > 50) {
          dbKeyCache = arr[v] as string;
          return dbKeyCache;
        }
      }
    }
  }
  throw new Error("deutsche-boerse: typesense key not found");
}

async function deutscheboerse(c: CompanyConfig): Promise<RawJob[]> {
  const key = await deutscheBoerseKey();
  const res = await fetch("https://api.my-job-shop.com/api/typesense/multi_search", {
    method: "POST",
    headers: { "x-typesense-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      searches: [{ collection: "offers", q: "*", query_by: "title", per_page: 100 }],
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    dbKeyCache = null; // force key refresh next time
    throw new Error(`HTTP ${res.status}`);
  }
  const data = await res.json();
  const hits = data?.results?.[0]?.hits ?? [];
  return hits
    .map((h: any) => h.document)
    .filter((d: any) => {
      const loc = Array.isArray(d.location) ? d.location.join(", ") : d.location ?? "";
      return REGION_RE.test(`${loc} ${d.full_address ?? ""}`);
    })
    .map((d: any) => ({
      id: `db-${d.id ?? d.offer_uuid}`,
      company: c.name,
      title: d.title,
      location: Array.isArray(d.location) ? d.location.join(", ") : d.location ?? "—",
      url: d.url || d.application_url || "https://careers.deutsche-boerse.com/",
      postedAt: d.create_date_timestamp
        ? new Date(Number(d.create_date_timestamp) * 1000).toISOString()
        : null,
      description: htmlToText(
        [d.introduction, d.about, d.expectation, d.offering, d.additional].filter(Boolean).join("\n\n")
      ),
    }));
}

const FETCHERS: Record<string, (c: CompanyConfig) => Promise<RawJob[]>> = {
  greenhouse,
  lever,
  ashby,
  recruitee,
  smartrecruiters,
  personio,
  amazon,
  deutscheboerse,
  custom,
};

export interface FetchResult {
  company: string;
  jobs: RawJob[];
  error?: string;
}

export async function fetchCompany(c: CompanyConfig): Promise<FetchResult> {
  const fn = FETCHERS[c.ats];
  if (!fn) return { company: c.name, jobs: [], error: `unknown ats "${c.ats}"` };
  try {
    const jobs = (await fn(c)).map((j) => ({ ...j, source: "career" as const }));
    return { company: c.name, jobs };
  } catch (e: any) {
    return { company: c.name, jobs: [], error: e.message ?? String(e) };
  }
}

export async function fetchAll(companies: CompanyConfig[]): Promise<FetchResult[]> {
  // modest concurrency so we don't hammer 100 endpoints at once
  const out: FetchResult[] = [];
  const batchSize = 8;
  for (let i = 0; i < companies.length; i += batchSize) {
    const batch = companies.slice(i, i + batchSize);
    out.push(...(await Promise.all(batch.map(fetchCompany))));
  }
  return out;
}

/** Keep jobs posted within `windowHours`. Date-unknown jobs are kept (flagged). */
export function withinWindow(jobs: RawJob[], windowHours: number): RawJob[] {
  const cutoff = Date.now() - windowHours * 3600 * 1000;
  return jobs.filter((j) => {
    if (!j.postedAt) return true; // unknown date — surface it, flagged
    const t = Date.parse(j.postedAt);
    return isNaN(t) ? true : t >= cutoff;
  });
}
