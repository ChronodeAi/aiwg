# Prepare and analyze a managed pilot offline

The managed study uses the frozen EVAL-OG-01 rubric: ten hand-run baseline tasks,
thirty managed tasks (including ten held out), two independent blinded reviewers
per choice, 20 reviewer hours and four adjudication hours. Inference reservations
are separate from reviewer time and actual usage. Preparation does not authorize
live inference or qualify a provider. Follow the
[operator guide](../getting-started/managed-worker-dispatch.md) for the execution
owners, migration and rollback.

`tools/testing/managed-pilot.mjs` is a read-only plan validator and result analyzer.
It launches no process, sends no provider request and writes no authority state.
Run from the source checkout, using explicit evaluation paths:

```bash
node tools/testing/managed-pilot.mjs validate /path/to/pilot/plan.json
node tools/testing/managed-pilot.mjs analyze /path/to/pilot/plan.json /path/to/results.json /path/to/routes.json
```

Both commands print JSON. Invalid inputs exit nonzero. Result/route arrays are
optional for analysis; omitted evidence remains unknown/blocked. Every frozen
task and advertised route appears in the output, including blocked/not-run tasks
and additional observed routes. Analysis retains `liveExecution="on-hold"` and
cannot release an operator hold.

The revision-1 plan contains `liveExecution:"on-hold"`, exactly forty `tasks`,
two `reviewers` with distinct `id`, `role` and `assignment`, an `adjudicator`,
`reviewHours:20`, `adjudicationHours:4`, an `inference` object and a `routes` array.
Concurrency is frozen as `maxConcurrentTasks:2` and `maxWorkersPerTask:1`.
Each task contains `id`, `cohort` (BASELINE/MANAGED), `stratum`, `conductor`
(claude/codex), `phase` (1 baseline, 2 managed, 3 held out), boolean `holdout`,
digest-bound `sourceTask`/`sourceDigest`, `maxAttempts:2`, `wallSeconds:1200`,
`workerWallSeconds:600`, positive `reservationUsd`, and a managed `scenario`.
There are ten matched strata with one baseline/three managed and two of each
conductor. Both cohorts are balanced between conductors. `inference` separately
reserves `baselineUsd`, `managedUsd`, `reviewUsd`, `smokeUsd` and `totalUsd`;
the first two equal their task reservations. Freeze the plan, exact task sources,
rubric, normalized policy and source-build references before execution.

Results are an array with one record per known task ID. A minimal record can name
only `id` and `outcome`, such as `host-gate-blocked`, `routing-blocked`,
`conductor-sandbox-blocked`, `failed`, `uncertain` or `completed`. Keep host and
sandbox outcomes separate from eligibility. The optional measurement fields are:

- `events`: monotonic `{event, elapsedMs}` setup-start/end/pause/resume entries.
  Setup begins before role/model/help/argument preparation and ends at the first
  exact command or typed stop. Exclude only recorded pauses. Invalid sequences
  are unknown. Installation, worktree setup, inference waits and wall latency are
  separate measurements. This is a conductor preparation proxy; measure human
  usability separately.
- `launches`: one `{rendered, executed}` exact string pair per attempted command
  or serialized tool descriptor. Any difference on any attempt is an edit; absent
  bytes are unknown. A later exact attempt does not erase an earlier edit.
  Zero-launch credit requires `protectedPass:true` and independently audited
  `noDispatchAudit:{independent:true,basis:"verified-typed-stop"}` (or
  `"serial-no-dispatch"`). Such tasks never count as successful launches.
- `packetDigest`, `reviews`: two distinct assigned reviewer records with matching
  approved packet digest, `independent:true`, `toolsUsed:false`, and integer 0–2
  `dimensions` keyed `task_role_fit`, `effort_proportionality`,
  `useful_decomposition`, `evidence_based_escalation`, `policy_grounded_rationale`.
  Reviewers see neutral task/qualification facts and choice only: hide identities,
  routing method, outcome, cost and latency. Test Lead approves packet hashes
  manually before review and keeps the stable randomized mapping private.
- `adjudication`: the assigned `adjudicator`, five final `dimensions`, nonempty
  `evidence` and a `reasons` entry for each differing dimension. Unresolved
  disagreements remain unscored; never average them or use majority votes.
  A score ≥8/10 fails the quality target if any dimension is zero. Deliverable
  verification remains separate.
- `gates`: pass/fail/unknown for `eligibility`, `pins`, `dataSafety`, `caps`,
  `policy`, `independentReview`, `evidenceComplete`, and `managedOwnership`
  (managed) or `noManagedState` (baseline). Missing is pending. Independent
  audit establishes these facts; worker self-assertions are not passing evidence.
- `accepted` and `protectedPass`: independent acceptance and deliverable check
  booleans, recorded separately from choice quality. Acceptance also requires all
  applicable gates to pass and no uncertain execution. `wallSeconds` records total
  latency; recorded attempts/wall time above frozen limits fail the cap gate.
- `usage`: scope conductor/worker/reviewer, worker `attempt` or reviewer and
  attempt identity, `quality` measured/estimated/unknown, nullable `tokens` and
  `costUsd`, and `source` for measured/estimated observations. Record all reviewer
  launches, including failed batches, in `reviewAttempts`. Missing per-attempt
  observations remain unknown. Provider-reported amounts require independent
  observation before normalization to measured. Subscription quota is not USD.

The analyzer reports fixed cohort denominators, setup median/missingness,
argument edits and launched-only reuse, independent quality scores/disagreements,
safety evidence, and measured/estimated subsets with unknown fractions. The setup
target is ≥50% median reduction; argument reuse is ≥27/30 managed; quality targets
are ≥32/40 overall and ≥24/30 managed at ≥8/10 with no zero dimension. No target is
declared complete while its evidence is missing. Compare cost per accepted outcome
only within comparable measured subsets; reservations and estimates never become
measured savings. Full cost stays null when incomplete or estimated.

Route observations reuse `qualificationErrors` from the existing orchestration
pack checker: `{id, qualification, result, evidence, reason}`. Missing/unsupported
rows stay blocked. A claimed pass requires qualified/passed plus live evidence
with version, opaque account reference, profile, matching transport and reportRef.
Bridge/native-mcp rows use transport `mcp`; shell/http evidence cannot qualify
them. Synthetic success does not qualify a provider. The Test Lead retains the
actual evidence; this tool checks its structure and never certifies its truth.

Unit coverage is in `test/unit/tools/managed-pilot.test.mjs`. The companion
`managed-conductor-conformance.test.ts` compares the real CLI/MCP resolver front
ends and checks visible offline readiness rows. Direct command tests cover
rollback without deleting uncertain admission history. Keep live qualification,
timed operator diagnosis and the cohort itself explicitly pending until observed.
