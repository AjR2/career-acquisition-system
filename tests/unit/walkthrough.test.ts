import { mkdtempSync, readFileSync, copyFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { CompaniesFileSchema, EligibilityConfigSchema } from "../../src/config/files.js";
import { TargetSchema } from "../../src/config/target.js";
import type { Fetcher } from "../../src/discovery/types.js";
import { classifyRole } from "../../src/eligibility/classifiers.js";
import { classifyLocation } from "../../src/eligibility/location.js";
import { probeCompany, slugCandidates } from "../../src/setup/companies.js";
import { parseAnswers, parseMoney, runWalkthrough, type Asker } from "../../src/setup/walkthrough.js";
import { PROJECT_ROOT } from "../../src/config/env.js";

const fakeFetcher: Fetcher = async (url) => {
  if (url === "https://api.lever.co/v0/postings/acmehealth?mode=json") return { status: 200, json: [{ id: 1 }, { id: 2 }] } as never;
  if (url.includes("greenhouse.io/v1/boards/globex/jobs")) return { status: 200, json: { jobs: [{ id: 9 }] } } as never;
  return { status: 404, json: null } as never;
};

function scripted(answers: string[]): Asker & { log: string[] } {
  const log: string[] = [];
  let i = 0;
  return {
    log,
    ask: async (_q, def) => {
      const a = answers[i++] ?? "";
      return a === "" && def !== undefined ? def : a;
    },
    say: (t) => log.push(t),
  };
}

const ANSWERS = [
  "Product management roles at health-tech companies, owning a product end to end.", // 1
  "health-tech product management", // 2
  "product manager, product owner", // 3
  "technical program manager", // 4
  "intern, director, sales", // 5
  "people management", // 6
  "they build software that improves patient care", // 7
  "Mission fit", // 8
  "roadmapping, SQL, user research, Jira", // 9
  "6", // 10
  "", // 11 -> default senior
  "n", // part-time not OK
  "130k", // 12
  "145,000", // 13
  "Austin, TX", // 14
  "n", // 15 remote not OK
  "austin, round rock", // 16
  "n", // 17
  "Acme Health, Globex, Nonexistent Co", // 18
  "y", // 19 replace
  "y", // confirm
];

function tempConfig() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cas-setup-"));
  const paths = {
    target: path.join(dir, "target.yaml"),
    eligibility: path.join(dir, "eligibility.yaml"),
    preferences: path.join(dir, "preferences.yaml"),
    techTerms: path.join(dir, "tech-terms.yaml"),
    companies: path.join(dir, "companies.yaml"),
  };
  copyFileSync(path.join(PROJECT_ROOT, "config", "eligibility.example.yaml"), paths.eligibility);
  copyFileSync(path.join(PROJECT_ROOT, "tests", "config", "preferences.yaml"), paths.preferences);
  copyFileSync(path.join(PROJECT_ROOT, "config", "tech-terms.yaml"), paths.techTerms);
  copyFileSync(path.join(PROJECT_ROOT, "config", "companies.medical.yaml"), paths.companies);
  return paths;
}

describe("company probe", () => {
  it("builds likely board tokens", () => {
    expect(slugCandidates("Scale AI")).toEqual(["scaleai", "scale-ai", "scale"]);
  });
  it("prefers the board with the most open postings when a company has two", async () => {
    const f: Fetcher = async (url) =>
      url.includes("greenhouse.io/v1/boards/ramp/") ? ({ status: 200, json: { jobs: [{}] } } as never)
      : url.includes("ashbyhq.com/posting-api/job-board/ramp") ? ({ status: 200, json: { jobs: [{}, {}, {}] } } as never)
      : ({ status: 404, json: null } as never);
    expect((await probeCompany("Ramp", f)).found).toEqual({ ats: "ashby", token: "ramp", openPostings: 3 });
  });
  it("finds the board a company uses, or reports none", async () => {
    expect((await probeCompany("Acme Health", fakeFetcher)).found).toEqual({ ats: "lever", token: "acmehealth", openPostings: 2 });
    expect((await probeCompany("Nonexistent Co", fakeFetcher)).found).toBeNull();
  });
});

describe("answers", () => {
  it("reads yearly and hourly pay", () => {
    expect(parseMoney("120k")).toBe(120000);
    expect(parseMoney("$95,000")).toBe(95000);
    expect(parseMoney("45/hr")).toBe(93600);
    expect(parseMoney("$40 an hour")).toBe(83200);
    expect(parseMoney("lots")).toBeNaN();
  });
  it("lists every problem in a web form submission", () => {
    expect(() => parseAnswers({ roleDescription: "", minBase: "abc" })).toThrow(/required[\s\S]*amount like/);
  });
});

describe("job target walkthrough", () => {
  it("writes valid configs for a non-engineering field, with backups", async () => {
    const paths = tempConfig();
    const a = scripted(ANSWERS);
    const r = await runWalkthrough(a, fakeFetcher, paths, "2026-10-26");
    expect(r.written).toBe(true);
    for (const p of Object.values(paths)) expect(existsSync(`${p}.bak-20261026`) || p === paths.target).toBe(true);

    const target = TargetSchema.parse(YAML.parse(readFileSync(paths.target, "utf8")));
    expect(target.goal_label).toBe("health-tech product management");
    expect(target.experience).toEqual({ preferred_seniority: "senior", years: 6 });
    expect(target.focus_categories.map((c) => c.id)).toContain("other");

    const elig = EligibilityConfigSchema.parse(YAML.parse(readFileSync(paths.eligibility, "utf8")));
    expect(elig.compensation).toMatchObject({ min_base_usd: 130000, target_base_usd: 145000 });
    expect(elig.location).toMatchObject({ home: "Austin, TX", remote_ok: false, dc_metro: ["austin", "round rock"] });
    expect(readFileSync(paths.eligibility, "utf8")).toMatch(/A pending background check is NOT a clearance/); // comments kept

    expect(classifyRole("Senior Product Manager, Care Platform", elig.roles).ok).toBe(true);
    expect(classifyRole("Product Manager Intern", elig.roles).ok).toBe(false);
    expect(classifyRole("Software Engineer", elig.roles).ok).toBe(false);

    const base = { title: "PM", locationRaw: "", workplaceType: "hybrid" as const, country: null, descriptionText: "", questionLabels: [] };
    expect(classifyLocation({ ...base, locations: ["Austin, TX"] }, elig.location).acceptable).toBe(true);
    expect(classifyLocation({ ...base, locations: ["Washington, DC"] }, elig.location).acceptable).toBe(false);
    expect(classifyLocation({ ...base, workplaceType: null, locations: ["Remote - US"] }, elig.location).acceptable).toBe(false);

    const companies = CompaniesFileSchema.parse(YAML.parse(readFileSync(paths.companies, "utf8"))).companies;
    expect(companies.map((c) => `${c.ats}:${c.token}`)).toEqual(["lever:acmehealth", "greenhouse:globex"]);

    const terms = YAML.parse(readFileSync(paths.techTerms, "utf8")).terms as string[];
    expect(terms).toContain("Jira");
    expect(terms.filter((t) => t === "SQL").length).toBeLessThanOrEqual(1);

    const prefs = YAML.parse(readFileSync(paths.preferences, "utf8"));
    expect(prefs.deprioritized_work[0].label).toBe("people management");
    expect(new RegExp(prefs.target_titles.primary.pattern, "i").test("Senior Product Owner")).toBe(true);
    expect(a.log.join("\n")).toMatch(/Nonexistent Co: no supported job board/);
  });

  it("changes nothing when the user declines", async () => {
    const paths = tempConfig();
    const before = readFileSync(paths.eligibility, "utf8");
    const r = await runWalkthrough(scripted([...ANSWERS.slice(0, -1), "n"]), fakeFetcher, paths, "2026-10-26");
    expect(r.written).toBe(false);
    expect(readFileSync(paths.eligibility, "utf8")).toBe(before);
    expect(existsSync(paths.target)).toBe(false);
  });
});
