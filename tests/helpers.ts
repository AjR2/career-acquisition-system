import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../src/config/env.js";
import { loadEligibilityConfig } from "../src/config/files.js";
import { openDb } from "../src/db/index.js";
import type { Fetcher, NormalizedPosting } from "../src/discovery/types.js";

// Tests use a frozen config so a user can change config/eligibility.yaml without breaking them.
export const cfg = loadEligibilityConfig(path.join(PROJECT_ROOT, "tests", "config", "eligibility.yaml"));
export const TEST_PREFERENCES = path.join(PROJECT_ROOT, "tests", "config", "preferences.yaml");

export function testDb() {
  return openDb({ path: ":memory:", env: { CAS_ENV: "test" } });
}

const FIX = path.join(PROJECT_ROOT, "fixtures", "ats");

export function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIX, name), "utf8"));
}

/** Serves recorded ATS responses. Unknown URLs return 404. Overrides win. */
export function fixtureFetcher(overrides: Record<string, { status: number; json: unknown }> = {}): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    for (const [k, v] of Object.entries(overrides)) if (url.includes(k)) return v;
    let file: string | null = null;
    let m: RegExpMatchArray | null;
    if ((m = url.match(/boards-api\.greenhouse\.io\/v1\/boards\/([^/]+)\/jobs\/(\d+)/))) file = `greenhouse-${m[1]}-${m[2]}.json`;
    else if ((m = url.match(/boards-api\.greenhouse\.io\/v1\/boards\/([^/]+)\/jobs/))) file = `greenhouse-${m[1]}-list.json`;
    else if ((m = url.match(/api\.lever\.co\/v0\/postings\/([^?]+)/))) file = `lever-${m[1]}.json`;
    else if ((m = url.match(/api\.ashbyhq\.com\/posting-api\/job-board\/([^?]+)/))) file = `ashby-${m[1]}.json`;
    if (file && existsSync(path.join(FIX, file))) return { status: 200, json: readFixture(file) };
    return { status: 404, json: { error: "not found" } };
  }) as Fetcher & { calls: string[] };
  f.calls = calls;
  return f;
}

export function posting(over: Partial<NormalizedPosting> = {}): NormalizedPosting {
  return {
    ats: "greenhouse",
    companyToken: "acme",
    companyName: "Acme AI",
    atsJobId: "1",
    title: "Software Engineer, AI Products",
    url: "https://example.com/jobs/1",
    applyUrl: "https://example.com/jobs/1",
    sourceUrl: "https://example.com/list",
    locationRaw: "Remote - US",
    locations: ["Remote - US"],
    workplaceType: null,
    country: null,
    employmentTypeRaw: null,
    descriptionText: "We build agents. The base salary range for this role is $160,000 - $210,000.",
    structuredPay: [],
    aiDisclaimer: null,
    questions: null,
    hasDemographicQuestions: false,
    deadline: null,
    publishedAt: null,
    raw: {},
    ...over,
  };
}
