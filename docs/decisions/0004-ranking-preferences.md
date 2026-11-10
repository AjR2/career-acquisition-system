Decision: Encode the user's fit preferences as a user-owned config file (`config/preferences.yaml`) that adjusts suitability, instead of hard-coded rules or inflating unknowns.

Context: After the hand-label pass, a frontend design-systems role the user rejected for fit scored above two roles the user liked (a full-stack role and an edge-computing role). Causes: the model labeled the role "product engineering", its stated $240k base earned full pay points, and the liked roles lose points for unadvertised pay and seniority.

Alternatives considered:
1. Score unknown pay neutral or favorable: rejected; violates "never resolve uncertainty into a favorable assumption" (spec section 9).
2. Hard eligibility exclusion for design-systems roles: rejected; it is a preference, not a hard constraint, and frontend roles can still fit.
3. More hard-coded title rules in code: rejected; preferences belong to the user and must be visible and editable.

Trade-offs: Regex preferences are blunt. Mitigated by scope (title vs. responsibilities) and a two-responsibility minimum so one passing mention does not define a role (caught on a site engineering posting).

Selected approach: `config/preferences.yaml` with `deprioritized_work` (pattern, scope, fit cap, source quote) and `target_titles` (spec section 3 primary/secondary titles add to career development). Each entry cites its source. The system never edits the file.

Reasoning: Keeps hard rules deterministic and separate, keeps unknowns unfavorable, and makes ranking tunable by the user in one place.

Risks: Preferences can over-fit a small labeled set (11 scored labels). The edge-computing role stays low (0.46) because its stack (Rust, C, C++, Linux, infrastructure) is a weak technical match; the user liked it, but raising it would require inventing alignment.

Verification: `tests/eval/suitability-labeled.test.ts` (every fit rejection below the median clean positive; design-systems role below the liked full-stack role) on recorded analyses in `fixtures/labeled/analyses.json`; unit tests for scope and single-mention behavior.

Date: 2026-10-22
