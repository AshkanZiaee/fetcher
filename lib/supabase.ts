import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-side Supabase client. NEVER import this from a client component:
 * it may use the service-role key, which must stay on the server.
 *
 * Prefers SUPABASE_SERVICE_ROLE_KEY (bypasses RLS for write paths in API
 * routes) and falls back to NEXT_PUBLIC_SUPABASE_ANON_KEY when it isn't set.
 */
let client: SupabaseClient | null = null;

/** True when Supabase env vars are present, so the app can degrade gracefully
 *  (work without persistence) until they're filled in. */
export function supabaseConfigured(): boolean {
  return (
    !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
    !!(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  );
}

export function getSupabase(): SupabaseClient {
  if (client) return client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL. Set it in your environment to connect to Supabase."
    );
  }
  if (!key) {
    throw new Error(
      "Missing Supabase key. Set SUPABASE_SERVICE_ROLE_KEY (server-only, recommended) or NEXT_PUBLIC_SUPABASE_ANON_KEY."
    );
  }

  client = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  return client;
}

/**
 * Lazy proxy so `supabase.from(...)` works without instantiating at import
 * time — the client (and its env-var check) is created only on first use.
 * This keeps the app importable before the Supabase env vars are filled in.
 */
export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_t, prop) {
    const c = getSupabase();
    const v = (c as any)[prop];
    return typeof v === "function" ? v.bind(c) : v;
  },
});
