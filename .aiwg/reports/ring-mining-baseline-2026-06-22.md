# Ring Mining Baseline

**Date:** 2026-06-22  
**Status:** report-only baseline for future AIWG addon design  
**Source workspace:** `/Users/base/ring`  
**Target integration home:** `/Users/base/my-aiwg`  

## Executive Summary

This report inventories the Ring workspace before any archive/reset/rebuild decision. It is intentionally
not an addon scaffold and does not port Ring code. Ring has accumulated a large amount of valuable design
work, but the working shape is too broad to migrate directly into AIWG without reintroducing the same
overengineering risks.

The strongest migration candidate is a future AIWG addon focused on **governing untrusted agent/evolution
work without letting the producer edit the judge**. The first addon should start as rules, skills, templates,
and review workflows. Executable primitives should be reimplemented only after their contracts are validated
against AIWG conventions.

The mined thesis is:

- Ring's reusable contribution is the boundary discipline: protected evaluator, signed verdict, candidate-tree
  verification, earned promotion, and memory-as-context-not-proof.
- Ring's main failure mode is capability outpacing documentation and earned gates: many ideas exist as code,
  ADRs, reports, and research packets before they are wired into a narrow product surface.
- The future addon should preserve the good ideas while refusing the old habit of building a new autonomous
  loop before the governance surface is mechanically auditable.

## Workspace Inventory

Read-only inspection of `/Users/base/ring` showed:

- Tracked inventory: `.aiwg` 558 files, `src` 281, `tests` 231, `bench` 19, `contracts` 17, plus CLI,
  docs, deployment, and provider files.
- Untracked inventory: `.aiwg` 495 files, `exports` 32, `scripts` 8, `SECURITY.md`, and one untracked
  `.github` path.
- Size signals: `.aiwg` 147M, `src` 6.1M, `tests` 11M, `contracts` 100K, `bench` 336K, `state` 102M.
- Dirty working tree includes modified governance/evolution files such as `bin/ring`, `genome_engine.py`,
  `evo_bridge.py`, `harness_control_surface.py`, `selfpatch/guard.py`, `write_queue.py`, and ADR-0149/0150.
- The ignored/runtime `state` tree is large and should be treated as a separate opt-in evidence pass, not
  mined by default.

This report therefore treats source, tests, contracts, docs, `.aiwg` ADRs/reports/research/planning, and
untracked project artifacts as the primary baseline. Bulk runtime state is summarized but not consumed.

## Migration Families

### 1. Trusted Core Guards

Candidate files include `selfpatch/guard.py`, `harness_control_surface.py`, `armed_boundary.py`,
`guard_change.py`, `kpis.py`, `merge_gate.py`, `threshold_shadow.py`, and the `improvements/*_guard.py`
family.

Reusable ideas:

- Protected-set checks must be explicit, centralized, and tested.
- Governance-defining files must not be editable by the governed agent.
- Thresholds, arming floors, criteria, evaluator code, and policy files are sacred inputs.
- Duplicate protected lists are dangerous unless cross-checked.

Migration disposition: **migrate-candidate as rules/templates first; no direct code port.**

### 2. Candidate Verification and Grader Boundary

Candidate files include `candidate_tree.py`, `grader_wedge.py`, `grader_wedge_remote.py`,
`grader_isolation.py`, `fire_worktree.py`, `ring_eval_runner.py`, `eval_adapters.py`, and criterion contracts.

Reusable ideas:

- Candidate changes must be materialized in isolated trees.
- Verification should be base-must-fail and candidate-must-pass where applicable.
- Producer and grader must be structurally separated, not separated by honor system.
- Signed verdicts and deployment isolation are real requirements, not decoration.

Known cautions:

- Same-user local subprocess mode is spike-only, not production isolation.
- Criterion adequacy is a first-class problem; a single criterion is easy to overfit.
- Grader key rotation, liveness, and rate limiting remain important open surfaces.

Migration disposition: **reference-only for v1; future executable extraction after addon doctrine is stable.**

### 3. Evolution, Genome, and evo-hq Adapter

Candidate files include `genome_engine.py`, `genome_engine_types.py`, `evo_bridge.py`,
`proposers/evo_hq.py`, `population_registry.py`, `provenance_store.py`, `failure_pattern_miner.py`,
`route_predict.py`, and `harness_reward.py`.

Reusable ideas:

- The optimizer/proposer should be untrusted.
- evo-hq or another optimizer can own search strategy; the governance layer owns integrity gates.
- Population/frontier state should be ring/governance-owned, not optimizer-owned.
- Provenance needs a purpose-specific, bounded representation rather than unbounded narrative logs.

Known cautions:

- The evolution surface is distinct from architecture evolution in AIWG's SDLC framework.
- "Autoresearch" naming collided with an existing literature-research orchestrator and should not be reused.
- Reward signals can invite evaluator gaming if the evaluator/corpus is mutable.

Migration disposition: **separate future adapter track; do not blend into general governance prose.**

### 4. Self-Harness Controller

Candidate files include `self_harness_controller*.py`, `harness_decision_trace.py`,
`harness_usage_benchmark.py`, `harness_usage_benchmark_corpus.py`, `hub_evaluate_external.py`,
`runner_hub_bypass.py`, and controller tests.

Reusable ideas:

- Decision traces should bind chosen action, available actions, and frozen-floor behavior.
- Promotion should require more than "candidate passed one benchmark."
- A controller can be armed separately from a self-improvement flywheel; those boundaries must not blur.

Critical risk:

- Existing assessment found a latent reward-hacking path: the controller patch proposer can prefer a HUB
  oracle/corpus rewrite when the patchable surface is widened. The current default blocks it, but the safety
  relies on configuration shape. This is exactly the governance-loophole class the future addon must audit.

Migration disposition: **archive/reference; extract only the escape-hatch audit and promotion-boundary lessons.**

### 5. AIWG Bridge and Policy

Candidate files include `aiwg_provider.py`, `aiwg_policy_engine.py`, `aiwg_executor.py`,
`aiwg_gateway_adapter.py`, and `aiwg_daemon_bridge.py`.

Reusable ideas:

- AIWG can be the orchestration layer, but Ring-like proof must remain mechanically verifiable.
- Runtime policy should enforce producer/grader separation and capability boundaries.
- Policy files themselves must be protected from autonomous edits.

Known cautions:

- Some ADRs describing AIWG executor/policy seams are proposed while code exists and has been proven in slices.
- Status drift creates a loophole where prose claims more authority than the ratified contract grants.

Migration disposition: **high-value AIWG-native design input; no direct Ring code port.**

### 6. Fortemi Memory Boundary

Candidate files include `fortemi/*`, `write_queue.py`, `sleep.py`, `reflect.py`, `kernel_recall.py`,
`de_amplify.py`, `semantic.py`, and lifecycle/feed hooks.

Reusable ideas:

- Fortemi is valuable as memory, retrieval, context, provenance, and archive.
- Fortemi must never mint verdicts, acceptance, promotion, or proof.
- Recall needs de-amplification so injected memory does not get re-retained as fresh evidence.
- Async write queues must not make memory availability a correctness dependency.

Migration disposition: **migrate as boundary rules and integration templates; executable integration later.**

### 7. Execution, Supervisor, Routing, Hooks, and Observability

These include `bounded_loop.py`, `work_supervisor.py`, `runner.py`, `invoke*.py`, `domain_*`,
`skill_*`, hooks, sidecar/heartbeat, dashboard/session, browser/research/video-ingest, and supply-chain
surfaces.

Reusable ideas:

- Bounded loops, audit chains, and work sources are good primitives.
- Routing, skill economy, browser capture, video ingest, dashboards, and sidecars are too broad for the first
  addon.

Migration disposition: **archive/reference; future extraction only after governance/evolution boundaries are stable.**

## Archive Classification

Use these dispositions during Ring archive planning:

| Disposition | Meaning | Examples |
|---|---|---|
| `migrate-candidate` | Re-express as AIWG addon rules/skills/templates first | protected-set doctrine, no-self-grading, Fortemi boundary |
| `reference-only` | Keep as evidence; do not port code in v1 | candidate-tree verifier, grader wedge, evo-hq adapter |
| `defer` | Valid idea but too broad for addon v1 | self-harness controller, skill economy, async sidecar |
| `archive-only` | Preserve for traceability, not product direction | stale ADR wiring, historical vocabulary, proof-only fire branch reports |
| `discard-candidate` | Candidate for later deletion after explicit review | no-ADR zero-import modules, stale generated packets |

The existing rebuild reports are themselves important archive evidence. They identify:

- proof-only `ring/fire` branch state that should not be merged directly;
- ADR-0149 stale wiring references;
- missing/incorrect ADR references;
- 2167 LOC of zero-import built-but-unwired code;
- proposed ADRs whose code became live ahead of documentation;
- the need to split active, deferred, historical, and retired vocabulary.

## Future Addon Recommendation

The future branch should be `feat/ring-governance-addon` and should scaffold:

`agentic/code/addons/ring-governance/`

V1 should contain only content artifacts:

- rules: `no-self-grading`, `governance-boundary`, `memory-is-not-proof`, `evaluator-immutability`;
- skills: `governance-escape-hatch-audit`, `mine-ring-corpus`, `evolution-surface-review`;
- templates: protected-surface inventory, criterion-set review, evolution adapter card, Fortemi boundary card;
- optional agent: `governance-skeptic`.

Do not include Python/TypeScript executable ports in v1. Reimplementation candidates must first pass a
contract review that proves the primitive is still needed once AIWG's native workflow, RLM, semantic-memory,
agent-loop, and eval addon surfaces are considered.

## Non-Goals for This Branch

- Do not scaffold `ring-governance`.
- Do not run `aiwg use all`.
- Do not port Ring modules.
- Do not archive, reset, delete, or mutate `/Users/base/ring`.
- Do not mine bulk ignored `state/` data unless a later pass explicitly opts in.
- Do not let Fortemi, AIWG prose, or generated reports become proof authorities.

## Next Step

Review this baseline, then create the addon branch only after the archive classifications are accepted.
The addon should begin as a small governance/evolution boundary pack, not as Ring 2.0.
