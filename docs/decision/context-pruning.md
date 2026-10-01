# Decision-Assisted Context Pruning

D26 is an experimental, default-off pilot for ranking context chunks as
`keep`, `drop`, `truncate`, or `summarize`. Disabled, shadow and advisory modes
do not change downstream prompts. Advisory mode records a recommendation for a
human maintainer; prompt-changing modes remain unimplemented until a promoted
report and explicit operator enablement exist.

The deterministic protected-item classifier always runs before model evidence.
It protects system, developer and project rules; security policy; current user
requirements; explicit approvals; unresolved blockers; artifact/version/digest
pins; required provenance; citations; test-gate evidence; open-decision
evidence; local-only or external-evaluation-denied data; restricted data; and
legal-review items. Dependencies of a protected item are transitively protected.
Model output cannot remove or downgrade these reasons.

## Runtime Contract

`ContextPruningCandidate.v1` is the stable candidate envelope. It carries item ID,
locator, content digest, source kind, token estimate, priority, trust,
sensitivity, dependencies, protected hints, task subject and data policy. Raw
content is optional and host-owned; the classifier uses metadata and explicit
protected hints, not instructions embedded in chunk text.

`applyContextPruningPilot()` consumes candidates plus already-recorded decision
evidence. It does not call Jev or any other provider. Invalid, uncertain,
uncalibrated, incomplete, cancelled, failed, drifted, low-margin or
disagreeing evidence resolves to the prior deterministic fallback as a receipt
proposal; the pilot still leaves the downstream item list unchanged (it returns
a copy of the input order). Null calibration or model identity digests are
treated as unknown, not compatible. Model/calibration drift and monitoring
regressions restore the prior deterministic behavior. Each receipt records the
mode that actually decided it, so a fallback inside a shadow run is recorded as
`deterministic-fallback`.

The prior deterministic fallback is the existing `ContextBudgetManager`
(`src/metrics/context-budget.ts`). When the caller passes a `budget`, the pilot
runs `computeContextBudgetManagerBaseline()` over the candidates, returns it as
`run.deterministicBaseline`, and a fallback proposes `drop` exactly for the items
the manager drops and `keep` otherwise. The manager sizes item text itself, so a
budgeted run requires every candidate's host-owned `content`; it refuses rather
than size the digest string. `ContextBudgetManager` itself spares only
system-source items, so protected and dependency-protected items it would drop
are moved to `protectedRetainedItemIds` and never appear in `droppedItemIds`;
the fallback drop list is therefore safe to apply. Because re-adding them can
exceed the manager's target (`floor(contextBudget * warningThreshold)`), the
baseline continues the manager's own rule (ascending priority, never system
items) over the remaining unprotected items until the target is met;
`tokensFreed` counts only the items finally dropped, and `withinBudget` is
false when protected items alone exceed the target. Without a `budget` the
prior behavior is "no pruning" and the fallback proposal is `keep`. The candidate envelope `priority`
is passed to the manager as its similarity input; the manager derives its own
priority from source type and similarity.

`planContextPruningEvaluations()` creates one subject per eligible chunk
(`context-item:<itemId>`). Multiple questions about the same chunk may share a
native batch; unrelated chunks cannot be co-batched. Protected, local-only,
external-evaluation-denied and restricted chunks are excluded before model
planning, and the richer planning API records sanitized exclusion reasons.

Shadow byte identity is proven against the real selection substrate, not a
prompt renderer. **AIWG has no code path that turns context items into a
downstream model prompt**: the host harness assembles its own prompt, and no
AIWG module other than this pilot consumes `ContextBudgetManager`. The
integration test `test/integration/decision-context-pruning-shadow.test.ts`
therefore feeds the disabled, shadow and advisory downstream item lists to
`ContextBudgetManager` and asserts its selection output is byte-identical to
the baseline, and it fails if another consumer of `ContextBudgetManager`
appears so the check can be moved onto that consumer.

Every destructive proposal has a `ContextPruningReceipt.v1` with the original
locator, content digest, token estimate, decision receipt digest when present,
policy reason and restoration path. `truncate` and `summarize` require a
versioned transformation artifact with source lineage and a passed quality
check before they can be accepted.

## Evaluation Scaffolding

`ContextPruningPreregistration.v1` pins promotion thresholds before holdout
access:

- 100% protected-item retention;
- the confidence level (`levelBps`, strictly between 5000 and 9999), the binary
  interval method (`newcombe-10` or `tango`), and the bounded-metric method
  (`percentile-bootstrap`) with a pinned `bootstrapSeed` and
  `bootstrapResamples`;
- the scale of every quality metric (`binary` 0/1 outcomes or `bounded` scores
  in [0, 1]) for downstream task success, requirement coverage, factual
  coverage, citation accuracy and human preference;
- the slice list, minimum overall n, minimum per-slice n, the minimum n for a
  zero-variance bounded read (`minimumZeroVarianceN`), and an optional power
  rule;
- an integer quality non-inferiority margin in bps (`-500` lets the candidate
  be at most 5 points worse);
- positive total token and cost targets after fallbacks, cache effects and
  transformations.

`buildContextPruningEvaluationReport()` requires a separately anchored
`trustedPreregistrationDigest` (the same rule as
`evaluatePreregisteredBinaryBenchmark`): a preregistration that does not match
it, or whose `registeredAt` is not before `holdoutAccessedAt`, is rejected. A
report with `holdoutAccessedAt: null` cannot `PROMOTE`. The preregistration
also freezes the evaluation pair set: `pairSetDigest` is
`contextPruningPairSetDigest()` of the sorted pair IDs with their slice
membership, covered by the trusted preregistration digest (as #2618 pins split
digests). The report's `pairs` must match it exactly, so removing, adding or
re-slicing pairs after holdout access is refused.

The report takes raw per-pair evidence, not aggregate deltas:

- `pairs` lists every frozen paired task with its preregistered slice. Slice
  support is counted from these records for every preregistered slice; a slice
  with no pairs counts as zero and is reported as `insufficient-slice:<name>`.
- `quality` holds, per metric, the raw `{ pairId, baseline, candidate }`
  outcomes, so each metric has its own n. Every value is range-checked for its
  preregistered scale and every `pairId` must be a known, unrepeated pair; NaN,
  out-of-range or unreconciled values throw rather than produce a report.
- Binary metrics use `pairedBinaryDifferenceInterval` and bounded metrics use
  `pairedMeanDifferenceBootstrap` from `src/decision/qualification/quality.ts`
  at the preregistered level and seed; `pairedNonInferiority` compares each
  lower bound with the margin. A metric below the minimum n is
  `INSUFFICIENT EVIDENCE`.
- Every metric's outcomes must cover every recorded pair. A metric that omits
  any recorded pair (`quality-outcomes-incomplete:<metric>`) can never pass:
  it is insufficient, unless the outcomes it does report already show
  demonstrated harm, which still triggers `ROLLBACK`. Slice support is also
  counted per metric from that metric's own outcomes, so a slice missing from
  a metric is reported as `insufficient-quality-slice:<metric>:<slice>` even
  when the pair records contain it.
- Protected retention is derived from receipts bound to the evaluated runs.
  `pruningRuns` supplies exactly one pilot run per evaluated pair: its
  candidate envelopes and receipts. Each receipt carries `runId`
  (`contextPruningRunId(pairId, candidates)`) and `pairId`, and
  `validateContextPruningReceipt(receipt, candidates)` re-derives the run
  identity and the protected-item classification from the envelopes and
  refuses any mismatch, including a protected item with a destructive
  proposal. The combined receipt set must match a separately anchored
  `trustedReceiptSetDigest` (`contextPruningReceiptSetDigest()`). Retention is
  the share of protected receipts whose proposed and applied actions are both
  `keep`; the caller's `protectedRetentionBps` must equal it or the report is
  refused, and with no protected receipts the report is
  `INSUFFICIENT EVIDENCE`. The anchors are only as trustworthy as the record
  that holds them; persisting receipts in a durable store is pending.

Economics use provider-reported usage per arm, reported separately from
estimator usage. Every provider arm (baseline downstream, pruned downstream,
decision, fallback and transformation calls) carries `cachedInputTokens`;
`promptCache.baseline` and `promptCache.prunedDownstream` must match the
provider-reported cached tokens of the same arm, and cached tokens can never
exceed input tokens. Cache credit is therefore not a caller assertion. The
report derives total-token savings, uncached-token savings (every arm with its
cached tokens removed, so pruning that loses cache hits reduces savings), cost
savings, and the signed `cachedInputTokensDelta` (negative when pruning lost
cache hits). Estimator usage must report `cachedInputTokens: null`. Share-once
Jev state accounting is not implemented; reports must use `not-applicable`.

Gate outcomes preserve the #2037/#2048 and #1585 vocabulary: `PROMOTE`,
`HOLD`, and `ROLLBACK`. The report never upgrades an upstream `HOLD` or
`ROLLBACK`. Automatic `ROLLBACK` follows the rollout plan's triggers: an
upstream `ROLLBACK`, any protected-item miss, demonstrated quality harm, or
negative net economics (total tokens, uncached tokens or cost). The quality
rule is documented and fixed: a metric whose lower bound is below the margin
fails non-inferiority (`quality-non-inferiority-failed:<metric>`); it is
**harm** (`quality-harm:<metric>`, `ROLLBACK`) only when the interval's upper
bound is below 0 or its point estimate is below the margin. Otherwise the
result is inconclusive (`quality-non-inferiority-inconclusive:<metric>`), for
example identical arms at a small n, and yields `HOLD` with
`INSUFFICIENT EVIDENCE`. A bounded metric whose per-pair differences are all
identical reads a zero-width bootstrap interval, which carries no variability
evidence: below the preregistered `minimumZeroVarianceN` it is
`INSUFFICIENT EVIDENCE` (`insufficient-quality-support:<metric>`), even when
its lower bound is at or above the margin. At or above that n an adequate
identical sample remains eligible for `PROMOTE`. Positive economics below the preregistered target,
unknown cost, unverified integrity or insufficient support yield `HOLD`; missing held-out
data, human review, holdout access, live provider evidence or sample support
also sets advisory-only `INSUFFICIENT EVIDENCE`.

## Offline Example

The fixture below runs without network access:

```ts
import {
  applyContextPruningPilot,
  contextPruningDigest,
} from 'aiwg/decision';

const candidate = {
  schemaVersion: 'decision-context-candidate/v1',
  itemId: 'ordinary-note',
  locator: 'fixture://ordinary-note',
  contentDigest: contextPruningDigest('ordinary text'),
  source: { kind: 'ordinary', addedAt: '2026-09-29T12:00:00.000Z' },
  tokenEstimate: 12,
  priority: 0.1,
  trust: 'untrusted',
  sensitivity: 'internal',
  dependencies: [],
  protectedHints: [],
  taskSubject: 'demo',
  dataPolicy: { externalEvaluation: 'allowed', localOnly: false, legalAction: 'none' },
};

const run = applyContextPruningPilot({
  candidates: [candidate],
  policy: {
    mode: 'shadow',
    minimumConfidenceBps: 8000,
    minimumMarginBps: 1000,
    allowedDestructiveActions: ['drop'],
    calibrationDigest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    modelIdentityDigest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  },
});
```

The returned receipt may contain a proposal, but the prompt-facing item list is
unchanged in shadow mode.

## Pending Evidence

This implementation proves offline protected retention, subject isolation,
receipt immutability, conservative fallback, closed schemas, preregistration
and a byte-identical `ContextBudgetManager` selection in shadow mode. There is
no AIWG downstream prompt builder to snapshot, so prompt-level byte identity in
a host harness is not proven here. It does not claim production token savings
or quality non-inferiority. Promotion still needs representative held-out
tasks, provider usage records, human adjudication, live monitoring and rollout
approval.

Shorter context is not success by itself. D26 can move beyond shadow only when
downstream quality is non-inferior and total end-to-end economics are positive
after fallbacks, cache effects and transformations.
