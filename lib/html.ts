/** Strip HTML to readable plain text and cap the length for the LLM. */
export function htmlToText(html: string, maxChars = 6000): string {
  if (!html) return "";
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|br|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
  return text.length > maxChars ? text.slice(0, maxChars) + "…" : text;
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 jobnow/0.1";

const FETCH_TIMEOUT_MS = 15000;

async function timedFetch(url: string, accept?: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, ...(accept ? { Accept: accept } : {}) },
      // career-page APIs are public; no caching so "last 24h" stays fresh
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    return res;
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error(`timeout after ${FETCH_TIMEOUT_MS}ms for ${url}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson(url: string): Promise<any> {
  return (await timedFetch(url, "application/json")).json();
}

export async function getText(url: string): Promise<string> {
  return (await timedFetch(url)).text();
}
