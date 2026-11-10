Decision: Postings held in NEEDS_ATTENTION (including employer AI-use policy holds) are rejected automatically when their suitability score is below `drafting.min_suitability` (currently 0.70).

Context: User decision, Oct 27, 2026: "drop things less than a 70% match." Drafting already skipped anything under 0.70, but AI-policy holds bypass drafting and went straight to the queue, so 11 sub-70 postings were still waiting for a decision. Decision 0003 requires an explicit user decision, recorded as a new decision record, to change AI-policy handling. This is that record.

Selected approach:
- `dropBelowScoreFloor` (src/run/pipeline.ts) runs after scoring in `cas daily` and `cas score`. It moves scored NEEDS_ATTENTION postings below the floor to USER_REJECTED with actor `system` and event detail `{ reason: "below_score_floor", score, floor, decision: "0005" }`.
- The state machine allows the system NEEDS_ATTENTION -> USER_REJECTED. The system still can never release a hold (to QUALIFIED, DRAFTING, READY_FOR_REVIEW, or DEFERRED).
- Unscored holds and holds at or above the floor are untouched: the user still decides those, as in decision 0003.
- Reversible: the user can move a rejected posting back (USER_REJECTED -> QUALIFIED).

Unchanged from 0003: no automatic apply, ever. At or above the floor, AI-policy postings still wait for the user.

Verification: `tests/unit/pipeline.test.ts` (updated regression test and a floor-sweep test).

Date: 2026-10-27
