import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT } from "../../src/config/env.js";
import type { NormalizedPosting } from "../../src/discovery/types.js";
import { evaluateEligibility } from "../../src/eligibility/rules.js";
import { loadClaims } from "../../src/evidence/claims.js";
import { candidateStack, loadLlmConfig, loadPreferences } from "../../src/run/pipeline.js";
import type { PostingAnalysis } from "../../src/suitability/analyze.js";
import { scoreSuitability } from "../../src/suitability/score.js";
import { loadTechTerms } from "../../src/validate/claims-validator.js";
import { cfg, TEST_PREFERENCES } from "../helpers.js";

/**
 * Ranking check on the user's hand-labeled set (2026-10-22), using recorded Haiku analyses.
 * Fit rejections: roles the user marked INELIGIBLE for fit. Clean positives: ELIGIBLE with no doubt.
 */
const HAS_LABELS = existsSync(path.join(PROJECT_ROOT, "fixtures/labeled/postings.json")) && existsSync(path.join(PROJECT_ROOT, "fixtures/labeled/analyses.json"));
const set = (HAS_LABELS ? JSON.parse(readFileSync(path.join(PROJECT_ROOT, "fixtures/labeled/postings.json"), "utf8")) : []) as { id: number; posting: NormalizedPosting; user_label: string; user_doubt: boolean; fit: { user_rejected_for_fit?: boolean } | null }[];
const analyses = (HAS_LABELS ? JSON.parse(readFileSync(path.join(PROJECT_ROOT, "fixtures/labeled/analyses.json"), "utf8")) : {}) as Record<string, PostingAnalysis>;
const w = loadLlmConfig().suitability.weights;
const prefs = loadPreferences(TEST_PREFERENCES);
const stack = candidateStack(loadClaims(), loadTechTerms());

const scored = set
  .filter((s) => analyses[s.id])
  .map((s) => ({ ...s, score: scoreSuitability(analyses[s.id]!, evaluateEligibility({ ...s.posting, raw: null }, cfg, undefined, new Date("2026-10-22")), stack, w, 150000, s.posting.title, prefs).score }));
const rejects = scored.filter((s) => s.fit?.user_rejected_for_fit);
const positives = scored.filter((s) => s.user_label === "ELIGIBLE" && !s.user_doubt && !s.fit?.user_rejected_for_fit);
const median = (xs: number[]) => {
  const v = [...xs].sort((a, b) => a - b);
  return v.length % 2 ? v[(v.length - 1) / 2]! : (v[v.length / 2 - 1]! + v[v.length / 2]!) / 2;
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe.runIf(HAS_LABELS)("suitability ranking vs the user's labels", () => {
  it("has enough labeled cases", () => {
    expect(rejects.length).toBeGreaterThanOrEqual(4);
    expect(positives.length).toBeGreaterThanOrEqual(4);
  });
  it("every fit rejection scores below the median clean positive", () => {
    const m = median(positives.map((p) => p.score));
    for (const r of rejects) expect(r.score, `${r.posting.companyName}: ${r.posting.title}`).toBeLessThan(m);
  });
  it("fit rejections average below clean positives", () => {
    expect(mean(rejects.map((r) => r.score))).toBeLessThan(mean(positives.map((p) => p.score)));
  });
  it("regression: LangChain design systems ranks below ElevenLabs full-stack", () => {
    const ds = scored.find((s) => s.id === 6015)!;
    const el = scored.find((s) => s.id === 4726)!;
    expect(ds.score).toBeLessThan(el.score);
  });
});
