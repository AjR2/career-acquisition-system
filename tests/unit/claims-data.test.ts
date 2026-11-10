import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT } from "../../src/config/env.js";
import { loadClaims } from "../../src/evidence/claims.js";

// Checks on the user's own claims file (git-ignored). Skipped when it is absent.
const file = path.join(PROJECT_ROOT, "career-evidence", "approved-claims.yaml");
const claims = existsSync(file) ? loadClaims(file) : [];
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];

describe("approved claims data", () => {
  const tenures = claims.filter((c) => c.tenure_since);
  it.skipIf(!tenures.length)("every stated tenure matches elapsed time since its start (fails when one goes stale)", () => {
    for (const c of tenures) {
      const [y, m] = c.tenure_since!.split("-").map(Number);
      const years = (Date.now() - Date.UTC(y!, m! - 1, 1)) / (365.25 * 24 * 3600 * 1000);
      expect(c.claim_text.toLowerCase(), `claim ${c.id}`).toMatch(new RegExp(`^${WORDS[Math.round(years)]} years`));
    }
  });

  it("every always_include claim is usable on a resume, and no project uses the role- prefix", () => {
    for (const c of claims.filter((c) => c.always_include)) {
      expect(["VERIFIED", "USER_CONFIRMED"]).toContain(c.status);
      expect(c.permitted_use).toContain("resume");
    }
    expect(claims.filter((c) => c.id.startsWith("role-") && /website|project/i.test(c.id))).toEqual([]);
  });
});
