# Probabilistic Feature Export

`decision-feature-export/v1` turns normalized decision evidence into deterministic, governed features for
offline statistical workflows. It exports evidence only. The exported rows and any downstream prediction remain
probabilistic signals and cannot authorize an action without the ordinary AIWG policy and review path.

The TypeScript API is exported from `aiwg/decision`:

- `generateDecisionFeatureSet()` creates a versioned `DecisionFeatureSet` from immutable ruleset, binding and
  definition pins.
- `createDecisionFeatureObservation()` creates one governed row from a `DecisionResult` or `RulesetResult`.
- `DecisionFeatureExportService` scopes create/read/list/export/share/delete operations to tenant, project, actor,
  recipient, purpose, dataset policy and lifecycle state.
- `serializeDecisionFeatureJsonl()` and `serializeDecisionFeatureCsv()` write byte-stable JSON Lines and CSV payloads
  with a manifest.
- `validateDecisionFeatureTrainServe()` rejects feature-set, column, domain, served-model and stale-calibration drift
  before downstream inference.

Feature-set changes are explicit. Changing declared Choice options, Score levels, primitive, adapter,
served-model compatibility, derivation, calibration pin or missingness policy changes the feature-set digest and must
become a new feature-set version. Runtime object key order is ignored; Choice options and Score levels follow the
immutable definition order.

Uncertainty semantics stay visible in both schema and column names. Native Jev distributions use `raw.provider.*`;
one-hot adapter compatibility fields use `compat.one_hot.*`; local metrics such as margin, entropy, concentration,
expected score and variance use `derived.*`; LLM self-reported confidence uses `model_self_report.*`; calibrated risk
uses `calibrated.*`. Missing values remain null with an explicit missing reason and are never converted to zero or one.
Noul exports a single truth probability without fabricating a two-class provider distribution.

Each observation binds tenant, project, actor, recipient, purpose and dataset policy. The authorization policy is checked
for create/list/read/export/delete/share operations, refuses raw state and outcome-label export, and can be paired with
`decision-lifecycle/v1` so the `export` surface supplies retention, deletion, legal-hold and backup semantics.
`DecisionFeatureExportService` rejects cross-project substitution, cross-feature-set rows, revoked rows, tombstones and
expired rows before returning or serializing data. When a lifecycle store is supplied, service reads and exports require
an authoritative host `resolveReference()` status so source tombstones and legal holds propagate through the existing D10
export surface rather than a separate feature-store lifecycle. Running without a lifecycle store is offline interchange
mode only; governed active exports need the host lifecycle source.

Batch accounting is request scoped. If a ruleset result carries native batch usage, the observation records batch owner
references, request IDs, question IDs and usage digests plus a derived allocation labeled
`largest-remainder-weighted/v1`; serialized rows keep `authoritativeUsage` null. The export manifest reconciles
authoritative usage once per unique request owner, preserves run/invocation/group/request/ordinal owner identity, and
rejects conflicting totals for the same owner. Persisted rows can be re-exported by supplying `batchAccountingEvidence`
to the serializer; otherwise missing authoritative evidence fails closed. Durable batch receipt references stay
references; feature rows do not create a second provider-cost owner or put token/cost fields in feature cells.

JSON Lines and CSV exports share the same `semanticContentDigest`. CSV includes paired `__state`, `__source`,
`__missing`, `__calibration` and `__derivation` columns next to every value column plus a canonical semantic row, so
tabular interchange preserves authorization, lifecycle, times, lineage and feature meaning. The CSV loader validates
exact header order and visible cells before returning rows.

Feature export manifests do not invent evaluation-integrity outcomes. Callers use `buildDecisionFeatureEvalIntegrity()`
to carry an actual `decision-qualification-release/v1` #2037/#2048 `QualificationReleaseRecord` into the manifest. The
builder verifies the shared release digest, preserves the upstream `PROMOTE`/`HOLD`/`ROLLBACK` decision, rejects any
upgrade such as `ROLLBACK` to `PROMOTE`, and binds the feature-export integrity wrapper to its own digest.

The offline reference smoke is `tools/decision/feature-export-offline-smoke.mjs`. It runs without credentials, records a
deterministic split, exports JSONL and CSV, reloads the tabular form, trains a tiny deterministic one-dimensional logistic
model on the train partition, and evaluates untouched test rows against frozen synthetic labels retained outside the
exported features. It reports held-out accuracy/Brier and a label digest only to prove interchange and provenance; it is
not production model-quality evidence.

The installed-artifact smoke is `tools/decision/feature-export-package-smoke.mjs`. It packs the current project, installs
the tarball into a temporary consumer, imports the public `aiwg/decision` export, creates and serializes one feature
observation, then runs the shipped offline smoke from `node_modules/aiwg`.

Schemas:

- `schemas/decision/DecisionFeatureSet.v1.schema.json`
- `schemas/decision/DecisionFeatureObservation.v1.schema.json`
