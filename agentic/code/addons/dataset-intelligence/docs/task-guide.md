# Dataset task guide

> "Check this CSV source, preview ten records, then plan an ingest I can review before anything writes."

Your assistant runs `check`, `preview`, and `plan` with explicit limits and redaction, then binds the reviewed digest at `ingest`.

> "The preview looks wrong. Re-check the source revision and schema before planning."

Your assistant re-verifies source revision and schema evidence and inspects the exact plan digest before any write.

This guide starts from a user outcome. It does not assume that the user knows
which schema, adapter, index, or provenance vocabulary to choose.

## Delivery status

The dataset contracts, source-adapter SDK, projections, declarative addon, and
thirteen-action orchestration CLI are shipped. Local file, directory, JSONL,
and CSV adapters are stable; local orchestration, offline, provenance,
standards, and prior-stable migration cells are qualified. Fortemi Core and
live Fortemi Server evidence remain mode-dependent as described in
[support status](#support-status).

| Task | Required evidence | Safe outcome |
|---|---|---|
| Source | locator, policy, credential locator, adapter version | immutable source definition; no secret value |
| Check | bounded connectivity and schema evidence | diagnostics without durable writes |
| Preview | explicit record/byte limits and redaction | representative, non-authoritative sample |
| Plan | source revision, schemas, reads/writes, degradation | immutable digest for human review |
| Ingest | approved digest and idempotency key | receipt, rejections, and checkpoint reference |
| Monitor | run identity and backend capability evidence | state report; polling never grants authority |
| Verify | canonical revision, artifact digests, receipts | verified, degraded, unverifiable, or failed |
| Query | bounded result count and privacy policy | results with revision and evidence references |
| Trace | assertion basis, evidence locator, confidence | lineage without upgrading inference to fact |
| Export | named versioned profile | portable output plus mapping/loss report |
| Resume | committed checkpoint and unchanged plan binding | a new attempt, never silent replay |
| Retire | complete inventory, holds, threshold and rollback | tombstones/reconciliation before deletion |

The exact CLI mappings are: monitor → `status` and `show`; trace → `lineage`;
resume → `retry`; retirement preparation → `plan`, inspection, and `cancel` as
needed. There is no `monitor`, `trace`, `resume`, or `retire` CLI action.

## Exact CLI surface

> "Show me the exact dataset commands for source through retry so I can copy them."

Your assistant lists the thirteen `aiwg dataset` actions with their required files, digests, and keys.

### Command reference

```bash
aiwg dataset source --file source.json --json
aiwg dataset check source:example --json
aiwg dataset preview source:example --count 10 --offline --json
aiwg dataset plan --file plan-input.json --json
aiwg dataset ingest plan:example --digest <sha256> --idempotency-key <key> --approve <approval-id> --json
aiwg dataset status run:example --json
aiwg dataset show run:example --json
aiwg dataset verify run:example --json
aiwg dataset query dataset:example --json
aiwg dataset lineage dataset:example --json
aiwg dataset export dataset:example --json
aiwg dataset cancel run:example --json
aiwg dataset retry run:example --json
```

`source` and `plan` require JSON input files. `ingest` binds the exact plan
digest and idempotency key; reconciliation additionally uses
`--reconciliation-digest` and `--reconciliation-threshold`. Every action can
emit the `aiwg.dataset-orchestration/v1` envelope with `--json`.

## Support status

> "Which dataset evidence cells are stable, and what stays mode-dependent?"

Your assistant reports stable, qualified, and mode-dependent cells with their claim boundaries.

| Evidence cell | Status | Claim boundary |
|---|---|---|
| local JSONL and CSV real sources | stable | bounded reference adapters only |
| local plan/replay/checkpoint/security/offline/provenance/standards | qualified | checked-in deterministic fixtures; not live-server evidence |
| prior-stable migration | qualified | exact `v2026.9.17` schema, checkpoint, plan, receipt, and profile fixture |
| Fortemi Core parity | mode-dependent | passes only with the pinned compatible Fortemi checkout |
| Fortemi Server live persistence | mode-dependent | passes only with an authorized, verified live receipt |

The local receipt reports 13 pass and 2 mode-dependent pending cells. The
pinned cross-repository receipt reports 14 pass and 1 experimental live pending
cell and is stable-eligible; live qualification remains separately evidence-bound.

## Default routing

> "Brief a worker to ingest this source without letting it touch connectors or checkpoints directly."

Your assistant routes assessment through the `dataset-intelligence` skill and bounded addon skills, which may only delegate operations to `aiwg dataset`.

**Conductor-to-worker brief (example):**

```brief
Objective: ingest the reviewed plan for source:example; nothing else.
Inputs: plan-input.json at the current revision; approved digest and idempotency key attached. Must not touch: connectors, checkpoints, indexes, or deletes.
Acceptance: ingest receipt with the bound digest plus rejection report.
Limits: explicit record/byte limits; redaction on. Uncertainty policy: stop-and-report.
Return: receipt and checkpoint reference for review; search success is not verification.
```

Start with the `dataset-intelligence` skill. It delegates assessment to the
bounded addon skills, which in turn may only delegate operations to `aiwg
dataset`. Agents and skills never open a connector, mutate a checkpoint, write
an index, or delete data themselves.

Before a write, verify the source revision and schema, inspect the exact plan
digest, and confirm privacy, locality, network, retention, and expected writes.
After a write, retain the receipt and rejection report. Search success is not
verification.

## Terms that must remain distinct

- A **canonical source** is the authoritative input selected by policy.
- An **immutable revision** binds that input to identity and digest evidence.
- A **derived artifact** is produced from a revision and may not be reversible.
- A **regenerable index** can be rebuilt from available canonical inputs.
- A **static cache** answers reads but is neither canonical nor live storage.
- A **portable export** is a versioned projection with an explicit loss report.

See [offline and troubleshooting](offline-troubleshooting.md) for diagnostics
and [migration](migration-guide.md) before changing an existing workflow. Use
the [standards profile matrix](https://github.com/jmagly/aiwg/blob/main/docs/dataset/standards-profiles.md) to
distinguish tested profiles from descriptor-only plans.
