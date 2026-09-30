# SDLC evidence readiness screening

Status: experimental, default-off. Issue: #2622 / D29.

The SDLC screening pack is an advisory layer over existing deterministic
artifact, citation and phase-gate checks. It never retrieves evidence, creates
locators, approves publications, waives failed tests, or changes a gate result.
Hosts must opt in by calling the `aiwg/decision` SDLC screening APIs and then
decide separately whether to show the advisory receipt to a reviewer.

## What the module trusts, and what it does not

The evidence facts in a subject are caller-asserted: `present`, `passed`,
`expiresAtEpochMs`, `locatorExists`, `retrieved`, `provenanceVerified`,
`publicationAuthorized` and the source `content`. The module cannot check them
against the real artifacts. What it guarantees is fail-closed handling of what
it is told, combined with the trusted gate policy: any reported defect, missing
item or malformed value is non-ready. A host integration must source these facts
from the deterministic validators (file/ID existence, schema, signature, test,
approval and retrieval checks) and must not let a model or a request author
supply them.

The gate policy is the other trusted input. `evaluateSdlcEvidenceScreening(request,
trust)` takes a separate `SdlcScreeningTrustContext` from host configuration:

- `gatePolicyPin` and `gatePolicies`: the criterion-to-required-evidence map and
  evidence ownership (including each citation source's trust and sensitivity)
  are an `SdlcGateEvidencePolicy` artifact. It is resolved by id/version from
  the host registry and verified against the pin with `assertArtifactPin`. The
  request may only reference it through `gatePolicyPin`; a request pin that does
  not match, a registry entry whose digest does not match, or an inline request
  policy produces a non-ready receipt.
- `calibration`: a `CalibrationRegistry`, compatibility request and policy.
  Compatibility is resolved through the D09 registry. A missing, non-`allow`,
  model-mismatched or non-registry calibration input routes to review.

## Runtime boundary

`evaluateSdlcEvidenceScreening()` accepts exactly one subject:

- one citation claim/source/locator pair; or
- one phase-gate criterion with its enumerated evidence bundle.

The subject is checked against a caller-owned inventory of known claim,
requirement, source, locator, criterion and evidence IDs. `mode` must be
`disabled`, `shadow` or `advisory`; any other value throws
`SdlcScreeningValidationError`, and `disabled` returns `null` without reading the
rest of the request. In `shadow` and `advisory` mode every other malformed input
(unknown or unsupported fields, null or missing subject/evidence/inventory,
missing requirement IDs, non-integer or non-finite numbers, broken trust
context) produces a `FAIL` or `REVIEW` receipt instead of an exception. Each
finding carries an explicit reason code. A model observation must point back to
the exact same subject and evidence IDs; it cannot introduce a citation,
locator, artifact, criterion, approval or requirement.

Deterministic preflight runs before model evidence is considered:

- Phase-gate criteria take their required evidence from the trusted policy, not
  from bundle `required` flags. Every bundle item is inspected, not only the
  required ones. A missing required item, an item owned by another criterion or
  not owned at all (`foreign-evidence`), an item that is not present or not
  passed, an expired item (expiry at exactly the screening clock counts as
  expired) or an invalid expiry is non-ready. Duplicate evidence IDs are
  rejected outright (`duplicate-evidence-id`, `FAIL`); there is no
  "latest version wins" rule.
- Citations require a policy ownership entry for the exact claim/source/locator.
  Unretrieved sources, missing locators, unverified provenance and unauthorized
  publication are non-ready. Trust and sensitivity come from the policy entry;
  a caller value that differs is `evidence-trust-mismatch`. Omitted `content`
  cannot be digest-verified and is `content-unverified`; content whose digest
  does not match is `content-digest-mismatch`. The D10 projection policy is
  validated with the policy's trust and sensitivity.

Semantic observations go through the published closed rulesets with D08
primitive acceptance. Each choice question needs a native provider distribution
over its closed options; the module never builds one from a single confidence
number. A missing or invalid distribution, low probability, low native
confidence or low margin routes to review. For injection, only an explicit
`no` with at least 8,000 bps confidence is clear: `unclear`, `yes` and a
less-confident `no` route to review, both in the published ruleset and in a
separate code guard. A supported citation also needs a support strength of at
least 8,000 bps.

## Gate outcome integration

AIWG has no programmatic SDLC phase-gate evaluator. `flow-gate-check` is an
agent-executed skill, and there is no programmatic citation-verification path
for SDLC artifacts. This pack therefore does not wire into, or make a
byte-identity claim about, an existing gate path.
`applySdlcScreeningToGateOutcome()` is a pass-through over whatever outcome
value a host supplies: in `disabled` and `shadow` modes it returns a copy of that
outcome with `publication: 'unchanged'`, keeps the host's audit receipt pins and,
in `shadow`, attaches the screening receipt as `alternateScreening`. The tests
check that the returned outcome serializes identically and that mutating it
does not touch the host's object.

## Durable review

High-risk, unclear, contradictory, injection-flagged or deterministic non-pass
receipts are converted with `sdlcScreeningReviewInputFromReceipt()` whenever
screening is enabled; the legacy `enabled` flag is retained in metadata only and
does not suppress required review creation. The trusted gate policy pin is
carried as a policy pin. The presentation sent to D13 is metadata-only and
carries a digest of any requester presentation instead of raw content. This is
only a D13 `CreateReviewInput`; the caller still creates the review with
`DecisionReviewService`, authorization, retention and resume handling. The
review effect remains idempotent through D13 continuation identity and cannot be
dispatched twice by repeated resume.

## Qualification scaffold

The repository includes closed schemas for:

- `SdlcEvidenceScreening.v1` (the request)
- `SdlcScreeningPreregistration.v1`
- `SdlcScreeningRelease.v1`

The preregistration pins the held-out test split digest, the preregistered
slices and gate-blocking slices, maximum false-support and false-ready rates,
minimum total, per-slice and gate-blocking-slice support, the
confidence-interval method/level, the paired non-inferiority margin and any
efficiency claim. `evaluateSdlcScreeningPreregistration(plan, trustedDigest,
records, nowEpochMs)` requires the plan's canonical digest
(`sdlcScreeningPreregistrationDigest`) to match a separately anchored trusted
digest, so a plan edited after freezing is a failure.

Held-out metrics are computed by `computeSdlcScreeningHeldoutReport()` from
per-sample records (adjudicated gold label, candidate route/label/probability,
usage, the paired baseline outcome and cost, and reviewer agreement). They are
never caller-asserted. Calibration/risk-coverage, latency, tokens, cost and
per-slice counts come from `evaluateBinaryHeldout` over the frozen split.
Per-class support/contradiction/unclear precision and recall and the
false-support and false-ready counts are computed from the records. False rates
are bounded by the upper limit of the Wilson score interval
(`wilsonScoreInterval`) at the preregistered level.

Quality is a paired non-inferiority test against the baseline screening path on
the same items. An item is correct when the readiness route matches gold and,
for citations, the support label also matches gold; each record's
`baseline.correct` must use the same definition. The paired table
(both / candidate-only / baseline-only / neither correct) goes to
`pairedBinaryDifferenceInterval` (Newcombe method 10, candidate minus baseline)
at the preregistered level, and `pairedNonInferiority` reads it with
`marginBps = -qualityNonInferiorityBps`: a preregistered 300 bps margin lets the
candidate be at most 3 points worse. A lower bound below the margin is
`quality-not-non-inferior` (fail).

The result is `insufficient-evidence` for missing records or missing
total/slice/class/gate-blocking support, including preregistered slices that are
absent. It is `fail` for a plan digest mismatch, a plan frozen after the
evaluation clock, a missing or unparseable `evaluatedAt`, an evaluation before
the freeze or after the clock, a split mismatch, invalid or unregistered-slice
records, an exceeded false-support or false-ready bound, a candidate that is not
non-inferior to the baseline, or non-positive net
economics against the baseline when an efficiency claim is made. Each reason is
an explicit code with a fixed disposition; unknown codes fail.

Only the `wilson` method is implemented, at levels strictly between 5,000 and
9,999 bps (the range the shared helpers accept). A preregistration that asks for
`exact-binomial` or another level gets `confidence-interval-unsupported` and
`quality-non-inferiority-insufficient` (insufficient evidence).

`buildSdlcScreeningReleaseReport()` carries #2037/#2048 eval-integrity metadata
unchanged and preserves `PROMOTE`/`HOLD`/`ROLLBACK`. Integrity is an allowlist
(`qualificationIntegrityAllowlistProblems` in `qualification/release.ts`): only
`verified` state with a strict mode (`fresh`, `locked`, `full-locked`) and that
mode's own trusted score source, plus uncertainty, a paired baseline, positive
`sample_n`, no weak signal, no compromise labels and an upstream `PROMOTE`, can
promote. Unknown or malformed values hold. D29 cannot upgrade an upstream `HOLD`
or `ROLLBACK`. The release is `PROMOTE` only when the preregistered evaluation
passes, integrity has no problems and the upstream gate is `PROMOTE`; a
not-non-inferior candidate is `HOLD`.

## Offline tests

`test/unit/decision/sdlc-screening.test.ts` and
`test/unit/decision/sdlc-screening-review-regressions.test.ts` cover:

- a supported citation with verified locator/provenance/content;
- unverified, unowned, trust-spoofed, restricted, content-omitted and
  digest-mismatched citations;
- prompt-injection `yes`/`unclear`/low-confidence `no`;
- spoofed `required:false`, omitted, duplicated, foreign, extra-failed,
  expired and invalid-expiry criterion evidence;
- a request that tries to narrow or replace the pinned gate policy;
- malformed requests that must produce receipts, not exceptions;
- calibration through the registry and native-distribution-only acceptance;
- a property check across criterion and citation evidence defects, every
  bounded model response and a range of confidence values, proving no defect
  yields `ADVISORY_READY`;
- the host-outcome pass-through in disabled and shadow modes;
- record-computed held-out metrics, post-hoc and future-dated evaluations,
  missing slices, integrity allowlisting and release HOLD/ROLLBACK;
- a report meeting every preregistered threshold reaching `PROMOTE`, and a
  candidate that regresses against the paired baseline (or fails a tighter
  margin or a wider preregistered level) held as not non-inferior;
- schema conformance for the request, preregistration and release shapes;
- D13 restart/resume idempotency through the real file review store.

## Pending live inputs

The implementation does not claim live Jev quality, human reviewer agreement,
held-out false-support/false-ready bounds, production latency/cost, or reviewer
time savings. Those require a frozen held-out corpus, adjudication guide,
reviewer identities/rationales, live provider credentials, deployment egress
approval and positive total-economics evidence.

## Synthetic study module

The [D29 study runbook](d29-heldout-study.md) describes source-only preparation,
frozen tuning/calibration/test splits, the deterministic oracle and visible-text
baseline, native receipt mapping and the additional coverage/conditional-rate
report. Its 132-item operator template is unfilled. Live model observations,
a compatible D09 artifact, protected integrity/access records and actual
operator review remain required. No measured synthetic or representative
SDLC-quality result is claimed by the module's offline fixtures.
