// Edge-safe auth constants (no Node APIs — imported by middleware too).

export const AUTH_COOKIE = "jobnow_auth";

/** The gate password. Override with JOBNOW_PASSWORD in env. */
export function sitePassword(): string {
  return process.env.JOBNOW_PASSWORD || "DoingWhatItTakes";
}

/**
 * Opaque session token stored in the cookie once authenticated. The middleware
 * compares the cookie to this exact value, so it must be unguessable. Override
 * with JOBNOW_AUTH_TOKEN in env (any long random string); rotating it logs
 * everyone out.
 */
export function authToken(): string {
  return process.env.JOBNOW_AUTH_TOKEN || "jx_7Qe2c9Lp4Vt8Wn3Zr6Yb1Hs5Md0Kf_jobnow";
}
