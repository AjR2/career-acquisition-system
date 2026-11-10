import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DecisionContext } from "../../src/apply/decide.js";
import { PROJECT_ROOT } from "../../src/config/env.js";
import type { Fetcher } from "../../src/discovery/types.js";
import { loadClaims } from "../../src/evidence/claims.js";
import { FakeLlm } from "../../src/llm/client.js";
import { defaultSetupFiles, type SetupFiles } from "../../src/ui/setup.js";
import { formAnswers, startServer } from "../../src/ui/server.js";
import { testDb } from "../helpers.js";

const fetcher: Fetcher = async (url) =>
  url.includes("greenhouse.io/v1/boards/carbonhealth/jobs") ? ({ status: 200, json: { jobs: [{}, {}] } } as never) : ({ status: 404, json: null } as never);

let F: SetupFiles;
let base = "";
let token = "";
let close = () => {};
const savedKey = process.env.ANTHROPIC_API_KEY;
const fake = new FakeLlm([]);

beforeAll(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cas-setup-ui-"));
  mkdirSync(path.join(dir, "config"));
  mkdirSync(path.join(dir, "career-evidence"));
  F = defaultSetupFiles(dir);
  copyFileSync(path.join(PROJECT_ROOT, "config", "eligibility.example.yaml"), F.eligibility);
  copyFileSync(path.join(PROJECT_ROOT, "config", "target.example.yaml"), F.target);
  copyFileSync(path.join(PROJECT_ROOT, "tests", "config", "preferences.yaml"), F.preferences);
  copyFileSync(path.join(PROJECT_ROOT, "config", "tech-terms.yaml"), F.techTerms);
  copyFileSync(path.join(PROJECT_ROOT, "config", "companies.medical.yaml"), F.companies);
  copyFileSync(path.join(PROJECT_ROOT, "config", "standard-answers.example.yaml"), F.answers);
  copyFileSync(path.join(PROJECT_ROOT, "config", "profile.example.yaml"), F.profile);
  writeFileSync(F.claims, "claims:\n  - { id: no-hand-written-code, claim_text: policy, evidence: policy, source_location: policy, status: PROHIBITED, dates: always, permitted_use: [] }\n");
  writeFileSync(F.env, "CAS_ENV=dev\nANTHROPIC_API_KEY=\n");

  const db = testDb();
  const ctx = () => ({}) as DecisionContext;
  const setup = { fetcher, files: F, llm: () => fake, installSchedule: async () => "ok" };
  const probe = startServer({ db, ctx, setup }, 0);
  await new Promise((r) => probe.server.once("listening", r));
  const port = (probe.server.address() as AddressInfo).port;
  probe.server.close();
  const s = startServer({ db, ctx, setup }, port);
  await new Promise((r) => s.server.once("listening", r));
  base = `http://127.0.0.1:${port}`;
  token = s.token;
  close = () => s.server.close();
});
afterAll(() => {
  close();
  process.env.ANTHROPIC_API_KEY = savedKey;
});

const post = (p: string, fields: Record<string, string>) => fetch(base + p, { method: "POST", body: new URLSearchParams({ csrf: token, ...fields }), redirect: "manual" });

const ANSWERS = {
  roleDescription: "Registered nurse roles in outpatient or telehealth care",
  fieldLabel: "outpatient nursing",
  primaryTitles: "registered nurse, RN",
  secondaryTitles: "care coordinator",
  excludeWords: "director, travel",
  avoidWork: "night shift",
  teamFitDescription: "they provide direct patient care",
  teamFitLabel: "Mission fit",
  skills: "BLS, ACLS, Epic",
  years: "6",
  seniority: "senior",
  partTimeOk: "y",
  minBase: "40/hr",
  targetBase: "45/hr",
  home: "Denver, CO",
  remoteOk: "y",
  commute: "denver, aurora",
  hasClearance: "n",
  companies: "Carbon Health, Mercy Hospital",
  replaceCompanies: "n",
};

describe("getting-started pages", () => {
  it("shows the checklist and refuses posts without the form token", async () => {
    const r = await fetch(`${base}/start`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toMatch(/Get started/);
    expect(html).toMatch(/48 employers on your list/);
    const bad = await fetch(`${base}/start/key`, { method: "POST", body: new URLSearchParams({ key: "x" }), redirect: "manual" });
    expect(bad.status).toBe(403);
  });

  it("saves a valid API key to .env only", async () => {
    expect((await post("/start/key", { key: "not a key\nCAS_ENV=prod" })).status).toBe(400);
    expect(readFileSync(F.env, "utf8")).not.toMatch(/prod/);
    const key = `sk-ant-test-${"a".repeat(30)}`;
    expect((await post("/start/key", { key })).status).toBe(303);
    expect(readFileSync(F.env, "utf8")).toMatch(new RegExp(`^ANTHROPIC_API_KEY=${key}$`, "m"));
  });

  it("runs the job-target form: validation, employer lookup, review, save", async () => {
    const invalid = await post("/start/target", { ...ANSWERS, minBase: "lots" });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toMatch(/amount like/);

    const review = await (await post("/start/target", ANSWERS)).text();
    expect(review).toMatch(/Review your settings/);
    expect(review).toMatch(/Carbon Health \(greenhouse, 2 open\)/);
    expect(review).toMatch(/Mercy Hospital \(no supported job board/);
    const probes = review.match(/name="probes" value="([^"]*)"/)![1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    expect((await post("/start/target/save", { ...ANSWERS, probes })).status).toBe(200);

    const elig = YAML.parse(readFileSync(F.eligibility, "utf8"));
    expect(elig.compensation.min_base_usd).toBe(83200);
    expect(elig.roles.part_time_ok).toBe(true);
    const companies = YAML.parse(readFileSync(F.companies, "utf8")).companies;
    expect(companies).toHaveLength(49);
    expect(companies.at(-1)).toMatchObject({ ats: "greenhouse", token: "carbonhealth" });
    expect(await (await fetch(`${base}/start/target`)).text()).toMatch(/value="registered nurse, rn"/);
  });

  it("refuses tampered employer data on save", async () => {
    const probes = JSON.stringify([{ name: "x", tried: [], found: { ats: "greenhouse", token: "../../etc", openPostings: 1 } }]);
    expect((await post("/start/target/save", { ...ANSWERS, probes })).status).toBe(500);
  });

  it("saves contact details and only the standard answers the user ticks", async () => {
    const r = await post("/start/profile", { p_name: "Sam Lee", p_location: "Denver, CO", p_email: "sam@example.com", p_phone: "555-0100", p_linkedin: "", a_work_authorization: "Yes", ok_work_authorization: "on", a_sponsorship: "No" });
    expect(r.status).toBe(303);
    expect(YAML.parse(readFileSync(F.profile, "utf8")).name).toBe("Sam Lee");
    const a = YAML.parse(readFileSync(F.answers, "utf8"));
    expect(a.work_authorization.status).toBe("USER_CONFIRMED");
    expect(a.sponsorship.status).toBe("PENDING");
  });

  it("adds claims the user types, and keeps resume suggestions unusable until confirmed", async () => {
    expect((await post("/start/claims/add", { text: "Worked as a registered nurse at Mercy Hospital.", dates: "2019 to 2024", evidence: "" })).status).toBe(303);
    let claims = loadClaims(F.claims);
    expect(claims.find((c) => c.claim_text.startsWith("Worked as"))?.status).toBe("USER_CONFIRMED");

    fake["script"].push({ claims: [
      { claim_text: "Holds an active Colorado RN license.", resume_quote: "RN, Colorado", dates: "not stated" },
      { claim_text: "Managed a team of 50 nurses.", resume_quote: "Charge nurse", dates: "2022" },
    ] });
    const page = await (await post("/start/claims/resume", { resume: "Registered Nurse. ".repeat(20) })).text();
    expect(page).toMatch(/2 statements suggested/);
    claims = loadClaims(F.claims);
    const [lic, team] = claims.filter((c) => c.status === "UNVERIFIED");
    expect(lic && team).toBeTruthy();
    expect((await post("/start/claims/confirm", { id: lic!.id, text: "Holds an active Colorado RN license." })).status).toBe(303);
    expect((await post("/start/claims/delete", { id: team!.id })).status).toBe(303);
    claims = loadClaims(F.claims);
    expect(claims.find((c) => c.id === lic!.id)?.status).toBe("USER_CONFIRMED");
    expect(claims.find((c) => c.id === team!.id)).toBeUndefined();
    expect((await post("/start/claims/delete", { id: "no-hand-written-code" })).status).toBe(400);
  });
});

describe("approve form", () => {
  it("matches question labels that contain line breaks (browsers send CRLF)", () => {
    const f = new URLSearchParams({ q0: "Do you live in one of the following states?\r\nAlabama, Alaska", a0: "No" });
    expect(formAnswers(f)).toEqual({ "Do you live in one of the following states?\nAlabama, Alaska": "No" });
  });
});
