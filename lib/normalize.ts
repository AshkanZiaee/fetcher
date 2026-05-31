// Shared normalization for cross-platform dedup + "already applied" matching.
// The same job on LinkedIn / StepStone / Indeed / Xing has slightly different
// titles ("(m/w/d)", refs, gender markers) and company suffixes (GmbH, AG…),
// so we normalize aggressively to collapse them to one key.

export function normTitle(t: string): string {
  return (t || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ") // (m/w/d), (all genders), (Ref. …)
    .replace(/\bm\s*\/?\s*w\s*\/?\s*d\b|\bw\s*\/?\s*m\s*\/?\s*d\b|\bm\s*\/?\s*f\s*\/?\s*d\b|\bd\s*\/?\s*f\s*\/?\s*m\b|\bgn\b|all genders|divers/gi, " ")
    .replace(/[^a-z0-9äöüß ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normCompany(c: string): string {
  return (c || "")
    .toLowerCase()
    .replace(/\b(gmbh|ag|se|kgaa|kg|mbh|ohg|ug|co|inc|ltd|llc|holding|group|deutschland)\b/g, " ")
    .replace(/[^a-z0-9äöüß ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Canonical key for a posting — same across platforms. */
export function normKey(company: string, title: string): string {
  return `${normCompany(company)}::${normTitle(title)}`;
}

/** True if the job's company matches any blocklisted name (substring, normalized). */
export function isExcludedCompany(company: string, blocklist: string[]): boolean {
  if (!blocklist?.length) return false;
  const c = normCompany(company);
  const raw = (company || "").toLowerCase();
  return blocklist.some((b) => {
    const nb = normCompany(b);
    return (nb && c.includes(nb)) || raw.includes(b.toLowerCase());
  });
}
