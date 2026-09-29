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
  response naming an unlisted issue ID fails validation.
- `projectIssueTriageModelState()` builds the model-visible replay state and
  omits final labels, final duplicate decisions, resolution, and close data.
- `runIssueTriageShadow()` returns only a shadow artifact with
  `actionAuthorization: not-authorized` and `trackerMutations: 0`.
- `DecisionIssueTriageEvaluationManifest.v1` preregisters minimum support,
  insufficient-slice behavior, promotion thresholds, confidence interval method,
  sample rules, and a positive benefit requirement before holdout access.
- `buildIssueTriageEvaluationReport()` reports class counts, macro/per-class
  precision/recall/F1, urgency ordinal error, completeness/clarification
  metrics, duplicate recall/nDCG/top-k, false-duplicate rate, `none` recall,
  accepted/risk coverage, review load, override rate, latency, tokens, cost,
  retry/fallback rate, cache effects, Jev and fallback call counts, and
  baseline-versus-cascade economics.
- The report carries upstream eval-integrity `PROMOTE`/`HOLD`/`ROLLBACK` and can
  only preserve or tighten it. It cannot upgrade a `HOLD` or `ROLLBACK`.
- Alias/model or uncertainty-profile incompatibility disables accepted shadow
  scoring and records a defer/drift event while preserving the raw suggestion.
- `applyIssueTriagePilot(false, previous, shadow)` returns the previous workflow
  object unchanged and does not call the shadow runner.

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

Until those inputs exist, promotion remains unavailable. Any live or advisory
mode requires a separate approved decision using the preregistered manifest and
the resulting evaluation report.
