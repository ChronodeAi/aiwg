# D23 synthetic replay operator review

Status: pending. Reviewer: roctinam (not yet attested). No review result, freeze event, or independent holdout certification is recorded by these fixtures.

## Protocol review before test access

Review `tools/decision/comparative-replay-corpus.ts`, `corpus.json`, development-only `gold.json` rows, `split.json`, and the proposed preregistration. Confirm 100 tuning, 100 calibration-membership (no model calibration), 400 test roots; 100 test roots per slice. One variant per family stays in one split. Confirm synthetic-only provenance and zero transport, token and API-dollar budgets. Record the clean source commit, generator/corpus/gold/split/preregistration digests, actual freeze time, first test-access time and approval reference in a separate immutable operator record. The fixture clock and fixture authorization fields are simulated and are not operator approval.

Reference guide: threshold equality accepts; a higher confidence threshold reviews; the greatest matching rule priority wins; changing a selected rule's loss outcome changes the outcome only. Identical policies are controls. Unobserved fallback or a changed earlier failed target is unreplayable, never evidence of no change. Loss outcomes here are finite deterministic rule costs, not a learned loss matrix or economics benefit claim. Audit the reference table against those public semantics without consulting analyzer output.

Protocol disposition: pending. Operator record/reference: ____ Actual frozen at: ____ Test first accessed at: ____

## Item assessments

Use `audit-sample.json` as an operator-only key. Review 20 development oracle scenarios before freeze. After collecting reports, prepare the selected 20 holdout gold/report pairs with A/B assignment from pairOrder; hide assignment, root IDs, split, report identity, source metadata and prior verdicts. Strip any schema/digest fields that reveal which claim is gold. Preserve status, acceptance-change, outcome-change, rule-change and unreplayable claims. Present the four repeat packets after a delay without repeat labels. Keep the mapping separately from the reviewer packet. This is one reviewer and four intra-rater repeats, not independent or inter-rater agreement.

| Assessment | Gold/claim correctness | Ambiguity | A/B agreement | Override and rationale | Reviewer | Timestamp |
| --- | --- | --- | --- | --- | --- | --- |
| audit-01 | pending | pending | pending | pending | | |
| audit-02 | pending | pending | pending | pending | | |
| audit-03 | pending | pending | pending | pending | | |
| audit-04 | pending | pending | pending | pending | | |
| audit-05 | pending | pending | pending | pending | | |
| audit-06 | pending | pending | pending | pending | | |
| audit-07 | pending | pending | pending | pending | | |
| audit-08 | pending | pending | pending | pending | | |
| audit-09 | pending | pending | pending | pending | | |
| audit-10 | pending | pending | pending | pending | | |
| audit-11 | pending | pending | pending | pending | | |
| audit-12 | pending | pending | pending | pending | | |
| audit-13 | pending | pending | pending | pending | | |
| audit-14 | pending | pending | pending | pending | | |
| audit-15 | pending | pending | pending | pending | | |
| audit-16 | pending | pending | pending | pending | | |
| audit-17 | pending | pending | pending | pending | | |
| audit-18 | pending | pending | pending | pending | | |
| audit-19 | pending | pending | pending | pending | | |
| audit-20 | pending | pending | pending | pending | | |
| audit-21 | pending | pending | pending | pending | | |
| audit-22 | pending | pending | pending | pending | | |
| audit-23 | pending | pending | pending | pending | | |
| audit-24 | pending | pending | pending | pending | | |
| audit-25 | pending | pending | pending | pending | | |
| audit-26 | pending | pending | pending | pending | | |
| audit-27 | pending | pending | pending | pending | | |
| audit-28 | pending | pending | pending | pending | | |
| audit-29 | pending | pending | pending | pending | | |
| audit-30 | pending | pending | pending | pending | | |
| audit-31 | pending | pending | pending | pending | | |
| audit-32 | pending | pending | pending | pending | | |
| audit-33 | pending | pending | pending | pending | | |
| audit-34 | pending | pending | pending | pending | | |
| audit-35 | pending | pending | pending | pending | | |
| audit-36 | pending | pending | pending | pending | | |
| audit-37 | pending | pending | pending | pending | | |
| audit-38 | pending | pending | pending | pending | | |
| audit-39 | pending | pending | pending | pending | | |
| audit-40 | pending | pending | pending | pending | | |
| audit-41 | pending | pending | pending | pending | | |
| audit-42 | pending | pending | pending | pending | | |
| audit-43 | pending | pending | pending | pending | | |
| audit-44 | pending | pending | pending | pending | | |

Any incorrect or ambiguous gold invalidates the affected preregistered analysis. Do not relabel, replace, omit or resample it after test access; revise the generator and create an independent holdout under a new protocol. Repeats do not increase independent N. Report agreement only for the audited roots.

## Final report review

Review the full comparative report, upstream eval-integrity envelope and its trusted digest, protected-artifact evidence, preregistration, all 400 test diagnostic report digests, exact reproduction result, root-level gates, four slice gates and the completed audit record. Require exact agreement for every replayable row and no false no-change claims for unreplayable rows. Require Newcombe-10 lower bound at 95% at least −100 bps, overall Wilson error upper at most 100 bps, and each slice at least 100 roots with zero known errors and Wilson upper at most 500 bps. Verify measured replay calls/tokens/cost all zero. Preserve upstream HOLD/ROLLBACK.

Final disposition: pending. Report digest: ____ Review record digest: ____ Reviewer/time: ____

No causal, model-quality, reviewer-time, live reevaluation, production promotion, durable cross-restart anti-probing or deletion/backups claim follows from this synthetic diagnostic audit.
