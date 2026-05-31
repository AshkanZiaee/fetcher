# Deploying jobnow

jobnow persists its data in **Supabase** (Postgres) and runs on **Vercel** (or any
Node host). This guide walks you from a fresh Supabase project to a live deploy.

> **Heads up:** the old file-based stores (`data/jobs.json` and `data/cache.json`)
> are **no longer used in production**. All job, state, draft, and analysis-cache
> data now lives in Supabase tables (`jobs`, `analysis_cache`). Those `data/*.json`
> files only exist as leftovers from local development and can be ignored or deleted;
> Vercel's filesystem is read-only at runtime, so writing them would fail anyway.

---

## 1. Create a Supabase project

1. Go to <https://supabase.com> and sign in (or create an account).
2. Click **New project**.
3. Pick an organization, give the project a name (e.g. `jobnow`), and set a
   strong database password (you can store it in your password manager — you
   won't need it for the app itself).
4. Choose a region close to where you (and your Vercel functions) run.
5. Click **Create new project** and wait for it to finish provisioning.

---

## 2. Run the database migration

The schema and row-level-security policies are defined in
`supabase/migrations/0001_init.sql`. This creates the two tables jobnow needs:

- **`jobs`** — one row per job (`id`, `job`, `analysis`, `state`, `draft`,
  `first_seen`, `last_seen`).
- **`analysis_cache`** — cached Gemini analyses keyed by job id (`id`,
  `analysis`, `created_at`).

Both tables have **row level security enabled** with permissive `anon` (and
`authenticated`) policies, since this is a single-user personal app with no auth.

Pick **one** of the two methods below.

### Option A — Supabase SQL editor (no CLI needed)

1. In the Supabase dashboard, open **SQL Editor** → **New query**.
2. Open `supabase/migrations/0001_init.sql` from this repo, copy its full
   contents, and paste them into the editor.
3. Click **Run**. You should see the `jobs` and `analysis_cache` tables appear
   under **Table Editor**.

### Option B — Supabase CLI (`supabase db push`)

1. Install the CLI: <https://supabase.com/docs/guides/cli> (e.g.
   `brew install supabase/tap/supabase`).
2. Log in and link the project (grab the ref from **Settings → General →
   Reference ID**):
   ```bash
   supabase login
   supabase link --project-ref <your-project-ref>
   ```
3. Push the migration:
   ```bash
   supabase db push
   ```

---

## 3. Collect your Supabase credentials

In the Supabase dashboard, go to **Settings → API** and copy:

| Value                | Used for                                            |
| -------------------- | --------------------------------------------------- |
| **Project URL**      | `NEXT_PUBLIC_SUPABASE_URL`                           |
| **`anon` public key**| `NEXT_PUBLIC_SUPABASE_ANON_KEY`                     |
| **`service_role` key** (under *Project API keys*) | `SUPABASE_SERVICE_ROLE_KEY` (optional, server-only) |

> The `service_role` key bypasses RLS. Keep it **server-only** — never prefix it
> with `NEXT_PUBLIC_` and never expose it to the browser. jobnow only reads it in
> server-side API routes.

---

## 4. Set environment variables

Set these wherever the app runs. Locally, copy `.env.example` to `.env.local`
and fill them in. On Vercel, add them under **Project → Settings → Environment
Variables** (apply to Production, Preview, and Development as needed).

### Required

| Variable                        | Description                                                                 |
| ------------------------------- | --------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | Your Supabase project URL (from Settings → API).                            |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Your Supabase `anon` public API key.                                       |
| `GEMINI_API_KEY`                | Google Gemini API key (get one free at <https://aistudio.google.com/apikey>). |

### Optional / recommended

| Variable                     | Description                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `SUPABASE_SERVICE_ROLE_KEY`  | Server-only key that **bypasses RLS**. Recommended for the write paths in API routes. If unset, the app falls back to the anon key (which works because the RLS policies allow `anon`). **Never** expose this to the client. |
| `JOBNOW_WINDOW_HOURS`        | Only analyze board jobs posted within this many hours (your "last 24h" filter). Defaults to `24`.          |

How the Supabase client picks a key (`lib/supabase.ts`): it uses
`SUPABASE_SERVICE_ROLE_KEY` if present, otherwise `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
always together with `NEXT_PUBLIC_SUPABASE_URL`.

---

## 5. Deploy to Vercel

1. Push this repo to GitHub (or GitLab/Bitbucket).
2. In Vercel, click **Add New → Project** and import the repository.
3. Vercel auto-detects Next.js — no build settings changes needed
   (`next build`).
4. Add the environment variables from **step 4** under **Settings →
   Environment Variables**.
5. Click **Deploy**.

After the build finishes, open the deployment URL. The app reads from and writes
to your Supabase tables; nothing is written to the local filesystem.

> If you change env vars after deploying, trigger a **redeploy** so the new
> values take effect.

---

## Troubleshooting

- **Reads return empty / writes silently fail** — confirm the migration ran
  (tables exist under **Table Editor**) and that the RLS policies are present.
  If you're relying on the anon key, the permissive `anon` policies from the
  migration must be in place.
- **`Missing Supabase environment variables`** — `NEXT_PUBLIC_SUPABASE_URL` and
  a key (`SUPABASE_SERVICE_ROLE_KEY` or `NEXT_PUBLIC_SUPABASE_ANON_KEY`) must be
  set in the deploy environment.
- **`EROFS` / write errors on Vercel** — this should no longer happen now that
  storage is in Supabase. If you see it, something is still writing to
  `data/*.json`; that code path is obsolete and should be removed.
- **Gemini analysis fails** — verify `GEMINI_API_KEY` is set and valid.
