import { createHash } from "node:crypto";

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function normalizeCompany(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\b(inc|llc|ltd|corp|corporation|co|labs?|ai|technologies|technology|hq)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Suffixes that name a place or work arrangement, not a different role.
const LOCATIONISH = /\b(remote|hybrid|on-?site|in[- ]office|us|usa|u\.s\.|united states|americas|north america|emea|apac|europe|uk|canada|nyc|new york|sf|san francisco|bay area|seattle|austin|boston|chicago|los angeles|denver|london|dublin|toronto|dc|washington|arlington|virginia|maryland|anywhere|[a-z]+,\s?[a-z]{2})\b/i;

/** Title normalized so location/arrangement suffixes do not create separate roles. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    // "(Remote)", "[NYC]" are dropped; "(Agents)" is kept.
    .replace(/\(([^)]*)\)|\[([^\]]*)\]/g, (m, a?: string, b?: string) => (LOCATIONISH.test(a ?? b ?? "") ? " " : m))
    // "Software Engineer - New York" is trimmed; "Software Engineer - Agents" is kept.
    .replace(/\s[-–—|]\s(.*)$/, (m, rest: string) => (LOCATIONISH.test(rest) ? " " : m))
    .replace(/\bsr\.?\b/g, "senior")
    .replace(/\bjr\.?\b/g, "junior")
    .replace(/\beng\b/g, "engineer")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9+#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Hash of normalized company + title. Same role posted twice (or in two locations) shares it. */
export function dedupeHash(companyName: string, title: string): string {
  return sha256(`${normalizeCompany(companyName)}|${normalizeTitle(title)}`);
}
