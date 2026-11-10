import type { Ats, Fetcher } from "../discovery/types.js";

export interface ProbeResult {
  name: string;
  found: { ats: Ats; token: string; openPostings: number; guessed?: boolean } | null;
  tried: string[];
}

/** Likely job-board tokens for a company name: "Scale AI" -> scaleai, scale-ai, scale. */
export function slugCandidates(name: string): string[] {
  const base = name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9\s-]/g, "").trim();
  const words = base.split(/[\s-]+/).filter(Boolean);
  const core = words.filter((w, i) => !(i > 0 && /^(ai|inc|labs?|technologies|technology|hq|co|corp|corporation|io)$/.test(w)));
  const out = [words.join(""), words.join("-"), core.join(""), core.join("-"), words[0] ?? ""];
  return [...new Set(out.filter((s) => s.length >= 2))];
}

const count = (ats: Ats, r: { status: number; json: unknown }): number | null => {
  if (r.status !== 200) return null;
  const j = r.json as { jobs?: unknown[] } | unknown[] | null;
  if (ats === "lever") return Array.isArray(j) ? j.length : null;
  return j && !Array.isArray(j) && Array.isArray(j.jobs) ? j.jobs.length : null;
};

/**
 * Finds which public job board (Greenhouse, Lever, Ashby) a company uses. Read-only GET requests.
 * Companies sometimes leave an old board up, so all three are checked and the one with the most
 * open postings wins.
 */
export async function probeCompany(name: string, fetcher: Fetcher): Promise<ProbeResult> {
  const tried: string[] = [];
  for (const slug of slugCandidates(name)) {
    tried.push(slug);
    const urls: [Ats, string][] = [
      ["greenhouse", `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`],
      ["lever", `https://api.lever.co/v0/postings/${slug}?mode=json`],
      ["ashby", `https://api.ashbyhq.com/posting-api/job-board/${slug}`],
    ];
    let best: ProbeResult["found"] = null;
    for (const [ats, url] of urls) {
      const n = count(ats, await fetcher(url));
      if (n !== null && (best === null || n > best.openPostings)) best = { ats, token: slug, openPostings: n };
    }
    if (best) {
      // A board found only by a shortened name ("oak" for Oak Street Health) may belong to another company.
      const full = slugCandidates(name).slice(0, 2);
      if (!full.includes(slug)) best.guessed = true;
      return { name, found: best, tried };
    }
  }
  return { name, found: null, tried };
}
