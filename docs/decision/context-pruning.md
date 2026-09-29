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
disagreeing evidence resolves to `keep` or the supplied prior deterministic
fallback as a receipt proposal; the pilot still leaves the downstream item list
unchanged. Null calibration or model identity digests are treated as unknown,
not compatible. Model/calibration drift and monitoring regressions restore the
prior deterministic behavior.

`planContextPruningEvaluations()` creates one subject per eligible chunk
(`context-item:<itemId>`). Multiple questions about the same chunk may share a
native batch; unrelated chunks cannot be co-batched. Protected, local-only,
external-evaluation-denied and restricted chunks are excluded before model
planning, and the richer planning API records sanitized exclusion reasons.

Every destructive proposal has a `ContextPruningReceipt.v1` with the original
locator, content digest, token estimate, decision receipt digest when present,
policy reason and restoration path. `truncate` and `summarize` require a
versioned transformation artifact with source lineage and a passed quality
check before they can be accepted.

## Evaluation Scaffolding

`ContextPruningPreregistration.v1` pins promotion thresholds before holdout
access:

- 100% protected-item retention;
- confidence interval method and level;
- minimum overall and per-slice sample support or a power rule;
- numeric quality non-inferiority margin;
- positive total token and cost targets after fallbacks, cache effects and
  transformations.

`ContextPruningEvaluationReport.v1` records downstream task success,
requirement and factual coverage, citation accuracy, human preference or
adjudication, protected retention, provider usage separately from estimator
usage, total calls/cost, latency and prompt-cache effects. Share-once Jev state
accounting is not implemented in this offline pilot; reports must use
`not-applicable` until a governed shared-state receipt exists.

Economics gates compare net savings against the existing deterministic
`ContextBudgetManager` baseline: baseline total minus pruned downstream usage,
decision/fallback/transformation calls, adjusted for prompt-cache effects.

The report preserves the #2037/#2048 and #1585 gate vocabulary:
`PROMOTE`, `HOLD`, and `ROLLBACK`. It cannot upgrade an upstream `HOLD` or
`ROLLBACK`. Missing held-out data, human review, live provider evidence or
insufficient samples yields advisory-only `INSUFFICIENT EVIDENCE`.

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
and byte-identical shadow prompts. It does not claim production token savings
or quality non-inferiority. Promotion still needs representative held-out
tasks, provider usage records, human adjudication, live monitoring and rollout
approval.

Shorter context is not success by itself. D26 can move beyond shadow only when
downstream quality is non-inferior and total end-to-end economics are positive
after fallbacks, cache effects and transformations.
