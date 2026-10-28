# Gate-pack authoring guide

How to write a `GatePack`: structure, gate fields, the outcome lattice,
floors and ceilings, rule linkage, and validation. Parent overview:
[the gates capability](gates.md). The shared lattice (`#2829`), rule
`enforcedBy`, and `aiwg gates coverage` are documented below as they exist.

## Pack structure

A pack is declarative data (YAML or JSON, `*.gatepack.yaml|yml|json`), closed
against [`GatePack.v1alpha1`](../../schemas/gates/GatePack.v1alpha1.schema.json):
no code, no network, no expressions beyond `DecisionPredicate`. Shipped
examples: `agentic/code/addons/decision-engine/gate-packs/` (`absolute-screening`
with parameters, metrics and fourteen gates; `integrity-ceiling` with a single
`upstream-ceiling` floor gate).

```yaml
apiVersion: gates.aiwg.io/v1alpha1
kind: GatePack
metadata:
  id: extension:example/counter   # aiwg:|framework:|addon:|extension:|project:
  version: 1.0.0
  description: What this pack checks.
spec:
  parameters:                     # optional named, directed bounds (see below)
    falseReadyMaxBps:
      type: bps                   # bps|count|level|value
      direction: lower-is-stricter
      default: 100
  metrics:                        # every gate metric must be declared here
    false-ready:
      provider: decision.screening/v1
      kind: proportion            # proportion|paired|scalar|differences|evidence
  gates:                          # minItems 1; ids unique, kebab-case
    - id: false-ready-upper
      kind: interval-bound
      metric: { provider: decision.screening/v1, name: false-ready }
      statistic: { kind: interval-bound, method: wilson, bound: upper, levelBps: 9500 }
      threshold: { op: lte, param: falseReadyMaxBps }   # or { op: lte, value: 100 }
      scope: { mode: all }        # all|each|listed|pooled
      direction: lower-is-stricter
      onFail: HOLD                # HOLD|ROLLBACK, never PROMOTE
  combine: { rule: max-severity } # the only combine rule
```

A complete minimal pack lives at
`test/fixtures/gates/example-extension-pack/example-counter.gatepack.yaml`
(fixture, not shipped): one Wilson upper-bound gate plus one `count-max`
`ROLLBACK` gate on a `listed` blocking slice.

## Gate and check fields

Closed gate kinds (`src/gates/registry.ts:194`, `validateResolvedPack`):

| kind | needs | metric kind |
|---|---|---|
| `interval-bound` | `statistic` (wilson/clopper-pearson, upper/lower, `levelBps`), `threshold` | proportion |
| `paired-difference` | `statistic` (newcombe/tango, non-inferiority needs `marginBps <= 0`), no `bound` | paired |
| `bootstrap-bound` | `statistic` (bootstrap + `seed`, `resamples`, `bounds`), `threshold` | differences |
| `count-max` / `count-min` | `threshold` | proportion |
| `value-threshold` | `threshold` | scalar |
| `minimum-n` | `minimumN >= 1` (literal or `{param}` over a `count` parameter) | any non-evidence |
| `evidence` | `evidence.required` (nonempty attestation ids) | evidence |
| `predicate` | `predicate` (three-valued `DecisionPredicate`; `unknown` is insufficient) | none |
| `upstream-ceiling` | nothing (mirrors the trusted upstream verdict; no `metric`) | none |

Field rules that bite: `threshold` takes exactly one of `value`/`param`
(`schemas/gates/GatePack.v1alpha1.schema.json:138`); `levelBps` is a literal
integer or `{param}` over a `level` parameter; `scope.listed`/`pooled` need a
nonempty `slices` list, and `except` is allowed only with `mode: each`
(`src/gates/registry.ts:261`); `onInsufficient` may only be `HOLD`
(`src/gates/registry.ts:214`); `bps` defaults stay in `0..10000`, `level`
defaults are integers strictly between 5000 and 9999
(`src/gates/registry.ts:177`). Thresholds move only in their declared
`direction`, and a child pack (`spec.extends`, a full `{id, version, digest}`
pin) may only tighten: literals never become `{param}` references, parameters
are never renamed, `minimumN`/`levelBps` only rise, `onFail` only
HOLD-to-ROLLBACK, scopes narrow per kind, `floor: true` gates cannot be
removed (`src/gates/registry.ts:337`, `assertGateTightens`).

## The lattice: why a report can never upgrade a component

Outcomes share one ordering, `PROMOTE < HOLD < ROLLBACK`
(`src/gates/lattice.ts:4`, `GATE_RANK`). Combination is the maximum:
`maxOutcome` takes the strictest (`src/gates/lattice.ts:8`), and
`ceilingDecision` caps a decision without ever lowering it
(`src/gates/lattice.ts:14`). Per-gate outcomes come from the gate's own
`onFail` (HOLD or ROLLBACK, never PROMOTE) with `onInsufficient` always HOLD:
missing values are `insufficient`, never PROMOTE, and `evaluateGates` combines
gate outcomes with the upstream and binding ceilings by maximum. A report whose
decision sits below its worst component is refused with
`report-upgrades-component` (`src/gates/lattice.ts:18`,
`GateDecisionUpgradeError`; `assertDecisionCeiling` at `:32`). So an upstream
HOLD/ROLLBACK, a binding `HOLD` ceiling, or any failed gate can only ever pull
the report down. `upstream-ceiling` gates mirror the trusted upstream verdict
exactly (compromise rolls back, allowlist problems hold, clean promotes) and
never escalate it.

## Floors and ceilings

Floors are project policy in `.aiwg/aiwg.config` `gates`
(`src/gates/floors.ts:39`, `ProjectFloors`): `floors` (inline `project:` packs
or pins over registered packs whose composed gates all become floors) plus
`ceilings` (exact binding `metadata.id` keys, `'*'` as the project-wide
default; a per-study key may only tighten `'*'`, and any per-study key
requires `'*'` so a renamed study cannot escape, `src/gates/floors.ts:114`,
`assertCeilingDefaults`). Resolution refuses a binding that omits a floor gate
or loosens any floor threshold, parameter value, scope or outcome; a binding
whose ceiling sits below its configured ceiling is refused (tighter ceilings
resolve). The operator default floor is the shipped
`aiwg:decision-engine/integrity-ceiling` pack, applied at expansion time, never
an inline copy; a configured `integrity-ceiling` gate only suppresses it when
it is an all-scoped `upstream-ceiling` tightening the shipped gate
(`src/gates/floors.ts:74`). Invalid `gates` sections warn at config load and
fail closed in gates entry points; `evaluateGates` requires floors input
(`resolveProjectFloors(config)` or explicit `'none-explicit-opt-out'` for
tests/legacy only).

## Precedence: how multiple packs and floors combine

When a binding pins several packs, nothing votes: every gate from every
resolved pack is evaluated and the strictest outcome wins. Per-gate outcomes
combine by maximum into `packOutcome`
(`src/gates/evaluate.ts:719`), and the report decision is the ceiling over
the pack outcome, the upstream ceiling and the binding ceiling
(`src/gates/evaluate.ts:722`): each ceiling can only pull the decision down,
never up. `combine: { rule: max-severity }` is the only pack combine rule
(`src/gates/types.ts:119`), so adding a pack can only hold or roll back a
report that would otherwise promote.

Project floors outrank packs. A binding must include every floor gate and
tighten it (`src/gates/registry.ts:682`, `enforceProjectFloors`); omitting a
floor gate or loosening any floor value, scope or outcome refuses resolution.
The operator default floor (the shipped
`aiwg:decision-engine/integrity-ceiling` pack,
`src/gates/floors.ts:74`) applies unless a configured floor governs it, and
the binding ceiling may not sit below the configured per-study ceiling
(`src/gates/registry.ts:700`). Pack inheritance (`spec.extends`) tightens
the same way: a child may only narrow what its parent allows
(`src/gates/registry.ts:337`, `assertGateTightens`).

## Preregistration: pin the pack before results exist

A study registers its design before it observes held-out data. The binding
pins every pack with a full `{id, version, digest, resolvedDigest}` pin
(`src/gates/types.ts:22`, `GatePackPin`), and resolution refuses any pin
whose version or authored/composed digest has moved
(`src/gates/registry.ts:797`, `:801`). Parameters are preregistered the same
way: binding values are keyed by qualified name (`<packId>.<param>`),
defaults fill what the binding leaves unset, a missing required parameter
refuses, and setting an undeclared parameter refuses
(`src/gates/registry.ts:859`, `:864`). Metric providers the gates observe
must be pinned too, and any gate-observing provider left unpinned refuses
(`src/gates/registry.ts:847`).

Time order is checked, not trusted: the binding carries `registeredAt` and
`frozenAt`, and registering after freezing refuses
(`src/gates/registry.ts:894`, `:897`). At evaluation the binding digest must
match both the caller-asserted trusted pin and the frozen-record digest
(`src/gates/evaluate.ts:600`, `:611`), and the binding must have frozen
before holdout access (`src/gates/evaluate.ts:630`). So a study that edits
its pack, thresholds or parameters after seeing results no longer matches
its pins and refuses evaluation.

## Linking rules to gates with `enforcedBy`

Rules may declare full gate references (pack id plus gate id):

```yaml
enforcedBy:
  - aiwg:decision-engine/absolute-screening#false-support-upper
```

Shape is validated by the rule frontmatter schema
(`src/rules/rule-frontmatter.schema.json:68`); rule lint resolves each
reference through the composed gate registry and unknown packs or gates fail
lint (`src/rules/gate-references.ts:12`, wired in
`src/lint/rule-activation.ts:46`). Omitted or empty lists mean
guidance-only. A declaration does not execute gates, enable a binding, or
change activation: coverage describes the named check's scope, not proof the
whole rule is mechanically enforced.

## Validating a pack and running coverage

```sh
aiwg gates validate pack test/fixtures/gates/example-extension-pack/example-counter.gatepack.yaml
aiwg gates list --namespace extension
aiwg gates show extension:example/counter
aiwg gates coverage
aiwg gates coverage --rule <rule-id-or-path> --json
```

`validate` schema-checks plus pack semantics (`validateResolvedPack`) and
reports `valid: false` (exit 2) instead of throwing
(`src/gates/driver.ts:140`, `validateGateFile`). `coverage` lists each rule
with its enforcing references, or `guidance-only`; text is default, `--json`
returns structured rows (`src/rules/gate-coverage.ts:23`,
`listRuleGateCoverage`). Single files and `--pack-dir` bundles always register
as `project:` packs: an `aiwg:` id claimed through an unverified path is
rejected (`src/gates/driver.ts:107`).

## What each error means

| error | meaning |
|---|---|
| `gate pack invalid: <file>: ...` (loader wraps schema/parse failures, `src/gates/discovery.ts:156`) | file unreadable, unparseable, symlink, over 256 KiB, or schema-invalid |
| `must NOT have additional properties` | closed schema: unknown field (packs, gates, statistics all reject extras) |
| `gate <id> onFail must be HOLD or ROLLBACK, never PROMOTE` (`src/gates/registry.ts:209`) | per-gate failure outcome can never promote |
| `gate <id> onInsufficient must be HOLD` (`src/gates/registry.ts:214`) | insufficient evidence holds; only an observed blocking failure rolls back |
| `metric <name> names unknown provider ...` / `is not computed by ...` (`src/gates/registry.ts:199`) | metric must be declared in `spec.metrics` and computed by a registered core/bundle provider |
| `gate <id> of kind <k> requires a <m> metric` (`src/gates/registry.ts:227`) | gate kind / metric-kind mismatch (table above) |
| `gate <id> minimum-n requires minimumN >= 1` (`src/gates/registry.ts:233`) | support floors need at least one observation |
| `scope except is only allowed with mode each` (`src/gates/registry.ts:261`) | `except` on `all`/`listed`/`pooled` is a load error, never silently ignored |
| `report-upgrades-component` (`src/gates/lattice.ts:18`) | report decision below its worst component: an upgrade attempt, refused |
| binding `loosens` floor / `ceiling ... refused` | binding omits a floor gate, loosens a floor value, or sits below the configured ceiling |
| `enforcedBy ... unknown gate pack/gate` (`src/rules/gate-references.ts:12`) | rule references a pack id or gate id that does not resolve |
