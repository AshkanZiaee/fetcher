# jobnow

A local Next.js app that helps Ashkan apply for software jobs in **Hessen + Rheinland-Pfalz**. It scans job sources, scores each posting against his CV with Gemini, and acts as a personal application tracker (save / applied / interviewing / draft cover letters).

Mode: **analyze + rank + track + draft** — run locally, open `localhost:3000`, hit "Check today's jobs" each morning.

## Run it

```bash
npm run dev          # http://localhost:3000
```

Requires `GEMINI_API_KEY` in `.env.local`. Model is **`gemini-3.1-flash-lite`** (set in `lib/gemini.ts` — `gemini-2.5-flash` had no free quota on this key).

Node 22, Next 16 (App Router, Turbopack), React 19, TypeScript. SDK: `@google/genai`.

## How it works (data flow)

```
config/search.json  ──►  sources (LinkedIn guest API, StepStone HTML, career-page ATS)
                          fan out: keywords × regions × sources
                              │  dedupe (id + company+title), round-robin by source, cap to maxAnalyze
                              ▼
  /api/jobs/list  ── fast (~1-2s, NO Gemini) ──►  UI renders cards immediately
                              │
  UI then POSTs each card ──► /api/jobs/analyze  ── Gemini scores+tags, persists to store ──► live fill-in
                              │
  status / notes / drafts  ◄─►  data/jobs.json (the tracker)
```

Two-phase loading is deliberate: list is fast so the dashboard never feels "stuck", then scores stream in (3-wide client pool) with a progress bar.

## Sources (`lib/sources.ts`)

| Source | How | Notes |
|---|---|---|
| **LinkedIn** | guest endpoints `jobs-guest/jobs/api/seeMoreJobPostings/search` (list) + `.../jobPosting/{id}` (description) | No login. `f_TPR=r{seconds}` does the 24h filter. Descriptions enriched lazily in the analyze step (`ensureDescription`). Throttled (15s timeout + 429 retry/backoff) — it rate-limits bursts. |
| **StepStone** | parse `<article data-at="job-item">` cards | Server-side age filter is ignored → filter client-side via German relative dates ("vor X Tagen"/"Gestern"/"Heute") in `germanAgeToHours`. Descriptions are title-only. |
| **Xing** | — | **Blocked** (JS/login wall). Stub that throws; shown as unavailable. Do not try to "fix" it. |
| **Career pages** | `lib/fetchers.ts` — Greenhouse, Lever, Ashby, Recruitee, SmartRecruiters, Personio, **Amazon** public JSON/XML | Listed in `config/companies.json` (~21 verified). Wider window `careerWindowHours` (336h). **SmartRecruiters + Amazon are region-filtered** (`REGION_RE`, `?country=de`) so big global accounts (Bosch 4500+, ServiceNow) only yield Hessen/RLP jobs. Career pages interleave PER COMPANY in `interleaveBySource` so one big employer can't eat all slots. NOT YET: SuccessFactors / Workday / Microsoft / Google / SAP / bank portals — these need per-company fetchers (Workday cxs API needs exact tenant+site; Microsoft API geoblocked from the sandbox but may work locally). |

## Config files (these are the knobs)

- **`config/search.json`** — EDITABLE "what to search": `keywords`, `regions` (label + linkedin location string + stepstone slug), `sources` toggle, `windowHours` (boards, 24), `careerWindowHours` (336), `maxAnalyze` (40), `includeCareerPages`.
- **`config/profile.md`** — Ashkan's CV/preferences. This is what Gemini matches AND drafts against. Tune "What I want" / "Deal-breakers" to change scores.
- **`config/companies.json`** — career-page companies `{name, ats, id}` (+ `tld`/`url` for personio/custom). 13 VERIFIED Hessen/RLP companies.

## API routes

- `GET /api/jobs/list` — fetch + dedupe + cap (fast, no Gemini). `?windowHours=` `?limit=` overrides. Merges saved state onto jobs.
- `POST /api/jobs/analyze` — score ONE job, persist to store, lazy-enrich LinkedIn description. Cached by job id in `data/cache.json`.
- `POST /api/jobs/state` — update `{status, notes, appliedAt, followUpAt}`. Auto-stamps appliedAt on first "applied".
- `POST /api/jobs/draft` — Gemini writes a tailored cover letter + bullets + quick-apply message (language matches posting). Cached on the record.
- `GET /api/pipeline` — tracked jobs (not new/dismissed) grouped by status, with counts.
- `GET /api/jobs` — combined one-shot (fetch+analyze sorted). For CLI/testing only; UI uses list+analyze.
- `GET /api/detect?url=SLUG` — ATS auto-detector. **Caveat: confirms a slug EXISTS on an ATS, not that it's the right company/region.** SmartRecruiters returns 200+empty for any slug (fixed to require `content.length>0`). Always verify entity + location before adding to companies.json. Personio subdomains are company-specific → reliable.
- `GET /api/logs?lines=N` / `DELETE` — read/clear the run log.

## Persistence (Supabase)

Storage is **Supabase Postgres** (was local `data/*.json`, which fails on Vercel's read-only fs). `lib/supabase.ts` is a lazy server-side client (prefers `SUPABASE_SERVICE_ROLE_KEY`, falls back to `NEXT_PUBLIC_SUPABASE_ANON_KEY`); the exported `supabase` is a Proxy so importing it never throws before env is set.

- **`jobs` table** ← `lib/store.ts`. Columns: `id` (=RawJob.id, pk), `job/analysis/state/draft` jsonb, `first_seen/last_seen`. StoredJob has NO id field — it's the dict key. Same exported signatures as before (loadStore/upsertJob/updateState/saveDraft/getStateMap).
- **`analysis_cache` table** ← `lib/cache.ts`. `id`→`analysis` jsonb. Hot path uses single-row `getAnalysis`/`putAnalysis` (the analyze route); `loadCache`/`saveCache` (whole-map) kept for the combined route.
- Migration: `supabase/migrations/20260601000000_init.sql` (RLS on + wide-open anon policies — personal app).
- **Graceful degradation**: `supabaseConfigured()` gates every call — with no env vars the app runs WITHOUT persistence (reads return empty, writes no-op, state updates echo optimistically) so it's never broken pre-setup.
- `data/jobnow.log` — run log (`lib/log.ts`); file writes skipped on Vercel (`process.env.VERCEL`). Each run has a `runId`.

Deploy: see `DEPLOY.md`. `next.config.mjs` has `outputFileTracingIncludes` so `config/**` (search.json/companies.json/profile.md, read via fs) is bundled into the Vercel functions. Repo should be PRIVATE (profile.md = CV). `.env.local`/`.env.example` hold the keys.

## Conventions / gotchas

- **Source fetches have 15s AbortController timeouts** (a hang here was the original "stuck on Scanning…"). Keep them.
- **Per-job resilience**: one throttled/failed Gemini call must not sink a run — analyze is per-job try/catch; `analyzeJob` retries 429 with backoff.
- **Round-robin `interleaveBySource`** before the maxAnalyze cap so career pages aren't starved by high-volume boards.
- **Dedupe by id AND `company+title`** (Greenhouse lists one role under several locations).
- Gemini structured output uses `responseSchema` (Type.OBJECT) — schema lives next to each function in `lib/gemini.ts`.
- Don't commit secrets. Don't re-enable Xing.

## Not yet built (offered)

- SuccessFactors / Workday fetchers (would unlock Deutsche Bank, BASF, Merck, Boehringer, etc.)
- Follow-up reminders (`followUpAt` field exists) + morning email digest
- Indeed / Glassdoor sources
- Deploy + daily cron (currently local-only)

## Owner

Ashkan Ziaee — Full-Stack Engineer (React/Next/TS), Mainz, German C1, M.Sc. at THM until 11/2026. Targeting frontend/full-stack roles in the Rhein-Main area.
