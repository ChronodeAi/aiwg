# SDLC evidence readiness screening

Status: experimental, default-off. Issue: #2622 / D29.

The SDLC screening pack is an advisory layer over existing deterministic
artifact, citation and phase-gate checks. It never retrieves evidence, creates
locators, approves publications, waives failed tests, or changes a gate result.
Hosts must opt in by calling the `aiwg/decision` SDLC screening APIs and then
decide separately whether to show the advisory receipt to a reviewer.

## Runtime boundary

`evaluateSdlcEvidenceScreening()` accepts exactly one subject:

- one citation claim/source/locator pair; or
- one phase-gate criterion with its enumerated evidence bundle.

The subject is checked against a caller-owned inventory of known claim,
requirement, source, locator, criterion and evidence IDs. In shadow/advisory
mode, unknown IDs, subject mismatches, unsupported observation fields and
non-finite values produce fail/review receipts rather than throwing through the
gate path. A model observation must point back to the exact same subject and
evidence IDs; it cannot introduce a citation, locator, artifact, criterion,
approval or requirement.

Deterministic preflight runs before model evidence is considered. Missing or
unretrieved sources, unverified provenance, missing artifacts, failed tests,
absent approvals, invalid signatures/schemas and expired evidence produce
`REVIEW` or `FAIL` regardless of model output or confidence. For phase-gate
criteria, required evidence is read from the trusted pinned gate policy map,
not from caller-supplied bundle flags. Evidence owned by another criterion is
non-pass, and evidence expiring exactly at the screening clock is expired.
Prompt-injection or authority-like semantic evidence also routes to review;
source text is data, not configuration.

D10 projection policy validation is applied to citation content before it can be
model-visible. Untrusted, restricted or content-digest-mismatched evidence
cannot yield `ADVISORY_READY`; restricted source content is kept out of the
model-visible projection. Semantic observations are routed through the published
closed rulesets with primitive-aware D08 acceptance. Low-margin or D09
calibration-incompatible observations go to review.

`applySdlcScreeningToGateOutcome()` preserves the incumbent gate outcome and
publication state in both `disabled` and `shadow` modes. In `shadow` mode it
attaches the alternate screening receipt only as audit evidence. Disabling the
feature restores the deterministic outcome byte-for-byte for the outcome
payload while preserving caller-supplied audit receipt pins.

## Durable review

High-risk, unclear, contradictory, injection-flagged or deterministic non-pass
receipts are converted with `sdlcScreeningReviewInputFromReceipt()` whenever
screening is enabled; the legacy `enabled` flag is retained in metadata only and
does not suppress required review creation. The presentation sent to D13 is
metadata-only and carries a digest of any requester presentation instead of raw
content. This is only a D13 `CreateReviewInput`; the caller still creates the
review with `DecisionReviewService`, authorization, retention and resume
handling. The review effect remains idempotent through D13 continuation identity
and cannot be dispatched twice by repeated resume.

## Qualification scaffold

The repository includes closed schemas for:

- `SdlcEvidenceScreening.v1`
- `SdlcScreeningPreregistration.v1`
- `SdlcScreeningRelease.v1`

`evaluateSdlcScreeningPreregistration()` requires preregistered maximum
false-support and false-ready rates, minimum total and gate-blocking-slice
support, confidence-interval method/level, quality non-inferiority and any
efficiency claim. Missing held-out data or insufficient slice support produces
`INSUFFICIENT_EVIDENCE`; NaN, negative values, zero-support slices/classes or a
held-out report that predates the frozen preregistration fail closed. The
offline report remains advisory-only and cannot promote.

`buildSdlcScreeningReleaseReport()` carries #2037/#2048 eval-integrity metadata
unchanged and preserves `PROMOTE`/`HOLD`/`ROLLBACK`. D29 cannot upgrade an
upstream `HOLD` or `ROLLBACK`, standard/unverified/local-unverified integrity,
missing uncertainty, weak signal, sample_n 0 or an unverified required fresh
workspace. An efficiency claim cannot pass without positive total economics.

## Offline examples

The focused unit suite in `test/unit/decision/sdlc-screening.test.ts` covers:

- a supported citation with verified locator/provenance;
- a fabricated or unverified citation that remains review even when the model
  says it is supported;
- prompt-injection flagged semantic evidence;
- spoofed `required:false`, omitted required evidence, wrong-criterion evidence,
  D10 trust/sensitivity and expiry-boundary cases;
- every bounded criterion observation/confidence against a failed required
  test, proving no advisory-ready route is possible;
- disabled and shadow mode preserving the real qualification gate result and
  publication behavior;
- preregistration and release HOLD/ROLLBACK behavior;
- D13 restart/resume idempotency through the real file review store.

## Pending live inputs

The implementation does not claim live Jev quality, human reviewer agreement,
held-out false-support/false-ready bounds, production latency/cost, or reviewer
time savings. Those require a frozen held-out corpus, adjudication guide,
reviewer identities/rationales, live provider credentials, deployment egress
approval and positive total-economics evidence.
