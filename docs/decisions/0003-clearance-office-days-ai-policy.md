Decision: Add security clearance as a hard eligibility field, surface in-office days per week, and lock the AI-policy handling.

Context: User corrections before Session 2 (Oct 21, 2026). DC-area employers often require an active clearance, which the spec did not cover. Some DC-listed roles require 4-5 office days a week: inside the commuting rule but outside the user's capacity. The per-posting AI-policy decision from Session 1 must not drift in later sessions.

Alternatives considered:
- Clearance: treat as a suitability factor (rejected: it is binary and hard); ignore (rejected: wastes approvals).
- Office days: hard cap at N days (rejected: user wants to decide case by case); ignore (rejected: passes silently).

Trade-offs: Text extraction of clearance and office days is heuristic. False negatives (missed requirement) waste an approval; false positives on clearance drop a real opportunity, so the clearance rule only fires on explicit "required" language.

Selected approach:
1. Clearance (hard, deterministic):
   - Extract one of: REQUIRED, PREFERRED, SPONSORSHIP_AVAILABLE, NONE_MENTIONED.
   - REQUIRED without sponsorship language → INELIGIBLE, reason "active clearance required".
   - REQUIRED with sponsorship ("able to obtain", "willing to sponsor", "eligible to obtain") → eligible, flag CLEARANCE_SPONSORABLE.
   - PREFERRED → eligible, flag CLEARANCE_PREFERRED.
   - The candidate holds no clearance (`candidate.has_active_clearance: false` in config). A pending background check is NOT a clearance. Background-check language in a posting is not clearance language and never satisfies a clearance requirement.
2. Office days:
   - Extract in-office days per week (0-5) with the evidence snippet, from description and structured fields.
   - Never a hard rule by itself. Stored on the posting and shown in the approval queue for every hybrid or onsite DC-metro role. Flag OFFICE_DAYS_HIGH at 4+ days so it stands out.
   - Roles labeled remote whose text requires regular attendance outside the DC metro remain INELIGIBLE (spec section 3).
3. AI-use policy: detected policies route to NEEDS_ATTENTION with the policy text; the user decides each posting. **No session may change this to an automatic skip or an automatic apply.** Any change requires an explicit user decision recorded as a new decision record.

Reasoning: Clearance is a hard gate the user cannot meet; office days are a capacity judgment only the user can make; AI-policy honesty with employers is non-negotiable.

Risks: Phrasing variety ("TS/SCI with poly", "must be clearable", "US citizenship required"). US-citizenship-only requirements are not clearance; recorded as flag CITIZENSHIP_REQUIRED for the user (the user's citizenship is not recorded in config yet).

Verification: Unit tests for each clearance phrasing class, background-check negative case, office-day phrasings, and a regression test that asserts the AI-policy flag never auto-resolves.

Date: 2026-10-21
