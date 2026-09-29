<!-- markdownlint-disable MD013 -->

# Issue triage shadow pilot

The issue triage pilot is an experimental, default-off D25 pack for Jev-backed
classification and duplicate reranking. It is implemented only for offline and
shadow evaluation. It does not file, edit, label, assign, comment on, close, or
merge tracker issues, and it cannot bypass issue-planner approval.

## Implemented offline

- `DecisionIssueTriagePilotPack.v1` defines closed taxonomies for issue type,
  project area, urgency, state completeness, clarification need, and duplicate
  outcomes. The duplicate outcome set is the deterministic shortlist plus
  explicit `none`.
- `validateIssueTriageBatchSubject()` rejects native batches that mix issue IDs.
  Batching is only valid for independent questions about one canonical issue
  subject.
- `deterministicIssueDuplicateCandidates()` records every duplicate candidate
  with generator identity, rank, score, source digest, and query digest. A model
  response naming an unlisted issue ID, a candidate created after the replayed
  issue, or a rank that differs from the deterministic list fails validation.
- Candidates are point-in-time inputs: each carries `revisions` and only the
  latest revision observed at or before the triaged issue's `createdAt` is
  scored or shown. A candidate with no such revision is excluded. Current-state
  fields (`title`, `body`, `labels`, `state`, and so on) on a candidate are
  refused, so a later edit such as "closed as duplicate of ..." cannot leak.
  Candidate labels and state are never model-visible. The triaged issue's own
  title and body are taken as supplied; replay corpora must provide them as
  created.
- `projectIssueTriageModelState()` routes the model-visible replay state through
  the D10 projection boundary, allowlists metadata, and omits final labels,
  final duplicate decisions, resolution, and close data. Title, body, author,
  every allowlisted metadata string, and candidate titles pass through the
  shared `redactText()` helper from `src/governance/redaction.ts` (private keys,
  `Authorization`/`Bearer` values, `ghp_`/`gho_`/`github_pat_`, `sk-`, `xox?-`,
  `AKIA` keys, JSON/YAML/`key=value` password, secret and token fields, and
  encoded secrets) plus issue-triage patterns for JWTs and `AKIA`/`ASIA` AWS
  keys. The assignment rule is deliberately broad: ordinary prose such as
  "token accounting" is also redacted.
- `validateIssueTriageModelResponse()` requires provider usage receipts.
  Caller `usage` totals, Jev and fallback call counts, and the cache flag must
  reconcile with them. Compatibility is resolved through `CalibrationRegistry`
  when a registry request is supplied; a registry result other than `allow`,
  or alias drift, disables accepted scoring. With
  `acceptance.calibration: required`, a response without a registry pin is
  never accepted.
- `runIssueTriageShadow()` returns only a shadow artifact with
  `actionAuthorization: not-authorized` and `trackerMutations: 0`. The runtime
  takes no tracker client and imports no tracker module; a test walks its
  import graph to keep it that way.
- `DecisionIssueTriageEvaluationManifest.v1` preregisters minimum support,
  insufficient-slice behavior, promotion thresholds, confidence interval method
  and level, sample rules, the digests of the frozen tuning/calibration/test
  splits, and a positive benefit requirement before holdout access.
- `buildIssueTriageEvaluationReport()` scores only the preregistered test split
  and refuses samples whose slice IDs were not preregistered or whose cascade
  duplicate answer does not match the sample's deterministic lineage (ID and
  rank) before computing top-k and nDCG. It reports class counts, macro and
  per-class precision/recall/F1, urgency ordinal error (from
  `evaluateOrdinalHeldout`), completeness and clarification metrics, duplicate
  recall/nDCG/top-k and ranking concordance (from `evaluateRankingHeldout`),
  false-duplicate rate, `none` recall, per-slice metrics, a selective-risk and
  coverage summary (from `evaluateBinaryHeldout`), review load, override rate,
  latency, receipt-derived tokens and cost, retry/fallback rate, cache hits,
  Jev and fallback call counts, and baseline-versus-cascade economics.

## Promotion gates

Every gate reads the preregistered manifest. Any finding yields `HOLD`.

| Gate | Rule |
| --- | --- |
| Sample support | Total samples at least `minimumTotalSamples`. Each slice needs `max(minimumSupport, minimumPerSliceSamples)` samples or it is `insufficient`. An insufficient `suppress-small-n` slice reports neither its count nor its metrics; an insufficient `report-supported` slice reports both. |
| Confidence interval | Only `wilson` at an integer-basis-point level strictly between 50% and 99.99% is supported. `bootstrap` and `exact` are recorded as `confidence-interval-unsupported`. Each one-sided bound below comes from the two-sided interval, so it has one-sided error (1 - level) / 2. |
| Quality non-inferiority | Per-issue paired outcomes (baseline correct vs cascade correct) go to `pairedBinaryDifferenceInterval` (Newcombe method 10), then `pairedNonInferiority`. The margin is cascade minus baseline and must be `<= 0`; for example, `-0.02` allows the cascade to be two points worse. A positive margin would be a superiority test and is rejected when the manifest is validated. |
| False-auto rate | Wilson upper bound of the error rate among accepted samples must not exceed `maximumFalseAutoRate`. No accepted samples is `false-auto-insufficient`. |
| Accepted coverage | Wilson lower bound of coverage must be at least `minimumAcceptedCoverage`. |
| False duplicates | Wilson upper bound over `none` cases must not exceed `maximumFalseDuplicateRate`. An evaluation set with no `none` cases, or with no duplicate cases, cannot promote. |
| Usage | Every arm's totals, call counts and cache flag must reconcile with its provider receipts, or the report records `usage-unreconciled` and token and cost comparisons become unknown. |
| Benefit | Computed only on the preregistered metric (`reviewer-time` or `total-task-token-cost`), from reconciled receipts that include fallback calls and cache reads. An unknown value is `benefit-insufficient`; tokens never stand in for an unknown cost. |
| Calibration | With `acceptance.calibration: required`, an accepted sample without an `allow` registry pin for its alias and served model is `calibration-required-unverified`. |
| Integrity | The upstream eval-integrity `PROMOTE`/`HOLD`/`ROLLBACK` can be preserved or tightened, never upgraded. |

- Alias/model or uncertainty-profile incompatibility disables accepted shadow
  scoring and records a defer/drift event while preserving the raw suggestion.
- `applyIssueTriagePilot(false, previous, shadow)` returns the previous workflow
  object unchanged and does not call the shadow runner. When enabled it returns
  the previous result even if the shadow runner or the artifact recorder throws
  or rejects, synchronously or asynchronously. A failed success record is
  retried once as a failure artifact; a failed failure record is dropped.

The schemas are registered in `schemas/catalog/domains/decision.json` with
experimental stability and are exported through `aiwg/decision`.

## Pending inputs

These criteria are scaffolded but not claimed complete in this offline change:

- Live Jev calls against approved synthetic issues.
- A real time-sliced historical corpus, immutable manifest, leakage review,
  labeling guide, annotator/adjudication record, and held-out labels.
- Human reviewer judgments for correctness/usefulness and reviewer-time deltas.
- Production tracker wiring and rollout approval for any later advisory display.
- Representative token, latency, cost, override, and reviewer-time measurements
  from the final holdout.

Until those inputs exist, no production or advisory promotion claim is made.
The offline report generator can return `PROMOTE` only for a complete,
preregistered evaluation report that satisfies every threshold; any live or
advisory mode still requires a separate approved decision using the manifest
and final holdout report.
