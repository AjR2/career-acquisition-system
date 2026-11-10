import { describe, expect, it } from "vitest";
import { draftResume, type DraftDeps } from "../../src/drafting/draft.js";
import type { ResumeDraft } from "../../src/drafting/schemas.js";
import type { Claim } from "../../src/evidence/claims.js";
import { loadApprovedWording, saveApprovedWording, wordingKey } from "../../src/evidence/wording.js";
import { FakeLlm } from "../../src/llm/client.js";
import { loadTechTerms } from "../../src/validate/claims-validator.js";
import { loadBannedConfig } from "../../src/validate/linter.js";
import { testDb } from "../helpers.js";

const claims: Claim[] = [
  { id: "cas", claim_text: "Directed a TypeScript pipeline that narrowed 6,341 postings to 239 qualified.", evidence: "", source_location: "", status: "VERIFIED", dates: "2026-10-present", permitted_use: ["resume"] },
  { id: "role-founder", claim_text: "Founder and engineer, Example Labs LLC, 2023 to present.", evidence: "", source_location: "", status: "USER_CONFIRMED", dates: "2023-present", permitted_use: ["resume"] },
  { id: "role-teach", claim_text: "Computer Science Teacher, Example County Schools, 2023 to present.", evidence: "", source_location: "", status: "USER_CONFIRMED", dates: "2023-present", permitted_use: ["resume"] },
  { id: "skills", claim_text: "TypeScript.", evidence: "", source_location: "", status: "USER_CONFIRMED", dates: "", permitted_use: ["resume"] },
];
const draft = (casText: string): ResumeDraft => ({
  summary: [{ text: "Engineer who directs coding agents.", kind: "fact", claim_ids: ["cas"] }],
  experience: [
    { heading: "Founder and Engineer | Example Labs LLC | 2023 – Present", heading_claim_ids: ["role-founder"], bullets: [{ text: casText, kind: "fact", claim_ids: ["cas"] }] },
    { heading: "Computer Science Teacher | Example County Schools | 2023 – Present", heading_claim_ids: ["role-teach"], bullets: [{ text: "Teach computer science", kind: "fact", claim_ids: ["role-teach"] }] },
  ],
  projects: [],
  skills: { text: "TypeScript", kind: "fact", claim_ids: ["skills"] },
});
const APPROVED = "Directed a TypeScript pipeline that narrowed 6,341 postings to 239 qualified";
const REWORDED = "Directed a TypeScript pipeline cutting 6,341 postings to 239 qualified";
const pass = { verdict: "pass", issues: [] };
const deps = (script: unknown[], extra: Partial<Omit<DraftDeps, "llm">> = {}): DraftDeps & { llm: FakeLlm } => ({
  llm: new FakeLlm(script), claims, banned: loadBannedConfig(), techTerms: loadTechTerms(), voiceProfile: "Terse.",
  profile: { name: "Jordan Lee", location: "X", email: "a@b.c", phone: "0", linkedin: "https://linkedin.com/in/x", github: "https://github.com/x" },
  draftModel: "m", reviewModel: "m", ...extra,
});
const target = { company: "Acme", title: "AI Engineer", text: "Build agents." };

describe("approved wording library", () => {
  it("saves approved bullets and skips text that breaks the pronoun rule", () => {
    const db = testDb();
    const d = draft(APPROVED);
    d.experience[1]!.bullets[0]!.text = "Teach computer science at my school";
    expect(saveApprovedWording(db, d, claims, 1)).toBe(1);
    const w = loadApprovedWording(db, claims);
    expect(w.get(wordingKey(["cas"]))?.text).toBe(APPROVED);
    expect(w.has(wordingKey(["role-teach"]))).toBe(false);
  });

  it("an entry goes stale when its claim text changes", () => {
    const db = testDb();
    saveApprovedWording(db, draft(APPROVED), claims, 1);
    const edited = claims.map((c) => (c.id === "cas" ? { ...c, claim_text: c.claim_text + " Edited." } : c));
    expect(loadApprovedWording(db, edited).has(wordingKey(["cas"]))).toBe(false);
  });

  it("new drafts must reuse approved wording verbatim; the prompt lists it", async () => {
    const db = testDb();
    saveApprovedWording(db, draft(APPROVED), claims, 1);
    const d = deps([draft(REWORDED), pass, draft(APPROVED + "."), pass], { approvedWording: loadApprovedWording(db, claims) });
    const out = await draftResume(d, target, null);
    expect(out.ok).toBe(true);
    expect(out.attempts[0]!.validation.structure.join(" ")).toMatch(/has approved wording; use it exactly/);
    expect(out.attempts[1]!.validation.structure).toEqual([]); // trailing period and spacing are ignored
    expect(d.llm.calls[0]!.user).toMatch(/APPROVED WORDING[\s\S]*\[cas\] Directed a TypeScript pipeline/);
  });

  it("revisions may change approved wording (prefer mode)", async () => {
    const db = testDb();
    saveApprovedWording(db, draft(APPROVED), claims, 1);
    const d = deps([draft(REWORDED), pass], { approvedWording: loadApprovedWording(db, claims), wordingMode: "prefer" });
    const out = await draftResume(d, target, null, undefined, "Shorten the pipeline bullet");
    expect(out.ok).toBe(true);
    expect(d.llm.calls[0]!.user).toMatch(/unless the candidate's change request/);
  });

  it("latest approval replaces earlier wording for the same claims", () => {
    const db = testDb();
    saveApprovedWording(db, draft(APPROVED), claims, 1);
    saveApprovedWording(db, draft(REWORDED), claims, 2);
    expect(loadApprovedWording(db, claims).get(wordingKey(["cas"]))?.text).toBe(REWORDED);
  });
});
