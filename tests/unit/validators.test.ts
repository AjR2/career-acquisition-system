import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT } from "../../src/config/env.js";
const HAS_CLAIMS = existsSync(path.join(PROJECT_ROOT, "career-evidence", "approved-claims.yaml"));
import { loadClaims, usableClaims, type Claim } from "../../src/evidence/claims.js";
import { findNumbers, findTerms, loadTechTerms, validateClaims, type Block } from "../../src/validate/claims-validator.js";
import { lint, loadBannedConfig } from "../../src/validate/linter.js";

const banned = loadBannedConfig();
const terms = loadTechTerms();

const claims: Claim[] = [
  { id: "a", claim_text: "Built a pipeline in TypeScript and SQLite that narrowed 6,341 postings to 239.", evidence: "", source_location: "", status: "VERIFIED", dates: "2026-10", permitted_use: ["resume", "cover_letter"] },
  { id: "teach", claim_text: "Four years teaching computer science.", evidence: "", source_location: "", status: "USER_CONFIRMED", dates: "2023-present", permitted_use: ["resume"] },
  { id: "u", claim_text: "Unverified claim about React.", evidence: "", source_location: "", status: "UNVERIFIED", dates: "", permitted_use: [] },
  { id: "ip", claim_text: "Interview-prep only fact.", evidence: "", source_location: "", status: "USER_CONFIRMED", dates: "", permitted_use: ["interview_prep"] },
];
const ctx = { techTerms: terms, postingText: "We use Python and React to build agents." };
const fact = (text: string, ids: string[]): Block => ({ text, kind: "fact", claim_ids: ids });
const frame = (text: string): Block => ({ text, kind: "framing", claim_ids: [] });

describe("banned-phrase linter", () => {
  it("catches banned phrases case-insensitively on word boundaries", () => {
    expect(lint("I am Thrilled to apply for this role.", banned).map((v) => v.match.toLowerCase())).toContain("thrilled to apply");
    expect(lint("We leverage agents.", banned)).toHaveLength(1);
  });
  it("catches em dashes and the -- stand-in", () => {
    expect(lint("Shipped it — fast.", banned)[0]?.rule).toBe("banned_character");
    expect(lint("Shipped it -- fast.", banned)[0]?.rule).toBe("banned_character");
  });
  it("does not flag substrings inside other words or en-dash date ranges", () => {
    expect(lint("Leveraged buyouts aside, Oct 2026 – Present.", banned).filter((v) => v.match.toLowerCase() === "leverage")).toHaveLength(0);
    expect(lint("Founder & Engineer | 2023 – Present", banned)).toHaveLength(0);
  });
});

describe("claim validator", () => {
  it("accepts facts fully supported by cited claims", () => {
    expect(validateClaims([fact("Built a TypeScript and SQLite pipeline that narrowed 6,341 postings to 239", ["a"])], claims, "resume", ctx)).toEqual([]);
  });
  it("rejects a fact with no claim", () => {
    expect(validateClaims([fact("Led a team of 12 engineers", [])], claims, "resume", ctx)[0]?.problem).toBe("fact_without_claim");
  });
  it("rejects unknown, unverified, and not-permitted claims", () => {
    const issues = validateClaims([fact("x", ["nope"]), fact("y", ["u"]), fact("z", ["ip"])], claims, "resume", ctx).map((i) => i.problem);
    expect(issues).toEqual(["unknown_claim", "claim_not_usable", "claim_not_usable"]);
  });
  it("rejects numbers not in the cited claims (invented metrics)", () => {
    const i = validateClaims([fact("Narrowed 9,000 postings to 239", ["a"])], claims, "resume", ctx);
    expect(i.map((x) => x.problem)).toEqual(["number_not_in_claims"]);
  });
  it("accepts number words that match claims", () => {
    expect(validateClaims([fact("Four years teaching computer science", ["teach"])], claims, "resume", ctx)).toEqual([]);
    expect(validateClaims([fact("Nine years teaching computer science", ["teach"])], claims, "resume", ctx)[0]?.problem).toBe("number_not_in_claims");
  });
  it("rejects technologies not in the cited claims, even if the posting wants them", () => {
    const i = validateClaims([fact("Built a React and TypeScript pipeline", ["a"])], claims, "resume", ctx);
    expect(i).toHaveLength(1);
    expect(i[0]).toMatchObject({ problem: "tech_not_in_claims" });
    expect(i[0]!.detail).toMatch(/React/);
  });
  it("framing blocks cannot smuggle facts", () => {
    const p = validateClaims([frame("I built agents for 5 years"), frame("I want to work on Rust tooling"), frame("Your team's work on agents in Python interests me")], claims, "cover_letter", ctx).map((i) => i.detail);
    expect(p.some((d) => /number/.test(d))).toBe(true);
    expect(p.some((d) => /accomplishment verb/.test(d))).toBe(true);
    expect(p.some((d) => /Rust/.test(d))).toBe(true);
    expect(p.some((d) => /Python/.test(d))).toBe(false); // named in the posting, so allowed in framing
  });
  it("blocks any claim of hand-written code", () => {
    expect(validateClaims([fact("Hand-wrote the TypeScript pipeline", ["a"])], claims, "resume", ctx).some((i) => i.problem === "prohibited_statement")).toBe(true);
  });
  it("matches capitalized tech terms case-sensitively", () => {
    expect(findTerms("We go fast and render pages", terms)).toEqual([]);
    expect(findTerms("Deployed on Render, written in Go", terms).sort()).toEqual(["Go", "Render"]);
    expect(findTerms("Node.js and PostgreSQL", terms).sort()).toEqual(["Node", "Postgres"]);
  });
  it("normalizes numbers", () => {
    expect(findNumbers("6,341 postings, $150K base, 20+ reports")).toEqual(["6341", "150k", "20"]);
  });
});

describe.runIf(HAS_CLAIMS)("approved claims file", () => {
  it("loads, has unique ids, and only VERIFIED/USER_CONFIRMED claims are usable", () => {
    const all = loadClaims(); // throws on schema errors or duplicate ids
    expect(all.length).toBeGreaterThan(0);
    for (const c of usableClaims(all, "resume")) expect(["VERIFIED", "USER_CONFIRMED"]).toContain(c.status);
    expect(all.find((c) => c.id === "no-hand-written-code")?.status).toBe("PROHIBITED");
  });
});
