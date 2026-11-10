import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT } from "../../src/config/env.js";
import type { NormalizedPosting } from "../../src/discovery/types.js";
import { evaluateEligibility } from "../../src/eligibility/rules.js";
import { cfg } from "../helpers.js";

/**
 * The user's hand-labeled evaluation set (Oct 22, 2026). `hard_label` is the user's call on
 * hard criteria only; postings rejected for fit (role type, AI focus, seniority) are ELIGIBLE
 * here and carry a `fit` note for the suitability score (Session 3).
 */
interface Labeled {
  id: number;
  posting: NormalizedPosting;
  hard_label: "ELIGIBLE" | "INELIGIBLE";
  user_note: string | null;
}

const LABELED = path.join(PROJECT_ROOT, "fixtures", "labeled", "postings.json");
const HAS_LABELS = existsSync(LABELED) && existsSync(path.join(PROJECT_ROOT, "fixtures", "labeled", "analyses.json"));
const set = (HAS_LABELS ? JSON.parse(readFileSync(LABELED, "utf8")) : []) as Labeled[];

describe.runIf(HAS_LABELS)("hand-labeled evaluation set: hard eligibility", () => {
  it("has 20 labeled real postings", () => {
    expect(set).toHaveLength(20);
  });

  it.each(set.map((s) => [s.id, s.posting.companyName, s.posting.title, s] as const))("#%i %s: %s", (_id, _c, _t, s) => {
    const r = evaluateEligibility({ ...s.posting, raw: null }, cfg, undefined, new Date("2026-10-22T12:00:00Z"));
    expect(r.verdict, `user note: ${s.user_note ?? "none"}; reasons: ${r.reasons.join("; ")}`).toBe(s.hard_label);
  });
});
