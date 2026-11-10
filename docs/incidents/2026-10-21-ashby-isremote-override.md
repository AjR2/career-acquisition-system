Observed failure: 87 OpenAI postings qualified as REMOTE_US although most are San Francisco hybrid roles.

Expected behavior: A role whose ATS workplace type is Hybrid in San Francisco is classified OFFICE_OTHER_US and is ineligible (relocation), unless it also lists a US-remote location.

Actual behavior: The Ashby adapter set `workplaceType = "remote"` whenever `isRemote` was true, overriding the explicit `workplaceType: "Hybrid"`. OpenAI sets `isRemote: true` on hybrid roles.

Root cause: Field precedence assumption in `src/discovery/adapters.ts` (Ashby). `isRemote` was treated as authoritative.

Evidence: raw snapshots for OpenAI postings show `workplaceType: "Hybrid", isRemote: true, location: "San Francisco"`.

Correction: The explicit workplace type now wins; `isRemote` is used only when no workplace type is given. Postings that also list a "US - Remote" location still qualify through that location.

Preventive control: Spot-check qualified counts per company after each adapter change (a sudden jump at one company is a signal). The 20-posting hand-labeled fixture set (Session 2 output) becomes the evaluation set that catches this class of error.

Regression test: `tests/integration/discover.test.ts` ("regression: Ashby isRemote=true does not override an explicit Hybrid workplace type").

Remaining risks: Other boards may use fields inconsistently. Unknown cases surface as flags (REMOTE_POLICY_UNCLEAR, REMOTE_COUNTRY_UNSPECIFIED) in the approval queue rather than being silently trusted.
