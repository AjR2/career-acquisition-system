import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { PROJECT_ROOT } from "../config/env.js";

export const CLAIM_STATUSES = ["VERIFIED", "USER_CONFIRMED", "INTERPRETATION", "UNVERIFIED", "PROHIBITED"] as const;
export const DOC_USES = ["resume", "cover_letter", "application_answer", "recruiter_message", "interview_prep"] as const;
export type DocUse = (typeof DOC_USES)[number];

const ClaimSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  claim_text: z.string().min(1),
  evidence: z.string(),
  source_location: z.string(),
  status: z.enum(CLAIM_STATUSES),
  dates: z.string(),
  permitted_use: z.array(z.enum(DOC_USES)),
  note: z.string().optional(),
  interview_question: z.string().optional(),
  interview_prep: z.string().optional(),
  /** true = every resume must cite this claim (the strongest evidence the user wants on every page). */
  always_include: z.boolean().optional(),
  /** YYYY-MM start of a tenure the claim_text states in words ("Ten years at ..."); a test fails when it goes stale. */
  tenure_since: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});
export type Claim = z.infer<typeof ClaimSchema>;

export function loadClaims(file = path.join(PROJECT_ROOT, "career-evidence", "approved-claims.yaml")): Claim[] {
  const parsed = z.object({ claims: z.array(ClaimSchema) }).parse(YAML.parse(readFileSync(file, "utf8")));
  const ids = new Set<string>();
  for (const c of parsed.claims) {
    if (ids.has(c.id)) throw new Error(`Duplicate claim id: ${c.id}`);
    ids.add(c.id);
  }
  return parsed.claims;
}

/** Only VERIFIED and USER_CONFIRMED claims may appear as fact, and only where permitted. */
export function isUsable(c: Claim, use: DocUse): boolean {
  return (c.status === "VERIFIED" || c.status === "USER_CONFIRMED") && c.permitted_use.includes(use);
}

export function usableClaims(claims: Claim[], use: DocUse): Claim[] {
  return claims.filter((c) => isUsable(c, use));
}
