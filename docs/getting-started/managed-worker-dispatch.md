# Operate managed worker dispatch

Managed dispatch is opt-in: `parallelism.worker_dispatch=true` and
`parallelism.worker_mode="managed"`. Mission/MC, Flow and Ralph keep completion,
verification and supervision ownership. They share `SharedHostScheduler` and
`FileAdmissionStore`; no additional scheduling service is needed. Read the
[direct guide](worker-dispatch.md) for installation, qualification and exact
command rendering, and the [admission contract](../contracts/shared-host-admission.v1.md)
for the trusted-owner APIs.

This guide documents the implemented interface. Offline fixtures demonstrate
mechanics; they do not qualify a provider, authorize inference, or establish that
the managed pilot has passed. The live pilot is on hold pending an operator decision.

## Configure two groups

Merge this example into `.aiwg/aiwg.config`, preserving other settings. Replace
the model IDs with exact qualified IDs and the opaque account/quota references
with authority-approved bindings. These examples carry no credential values and
do not change a CLI's defaults. Installations sharing an upstream quota must
share its canonical quota binding, even across different groups or accounts' aliases.

```json
{
  "version": "1",
  "parallelism": {
    "worker_dispatch": true,
    "worker_mode": "managed",
    "max_parallel_subagents": 2,
    "max_parallel_mc_missions": 2,
    "max_parallel_ralph_loops": 2,
    "clis": {
      "codex": { "adapter": "providers:codex", "accountScope": "approved-codex-account", "quotaScope": "approved-openai-quota" },
      "claude": { "adapter": "providers:claude", "accountScope": "approved-claude-account", "quotaScope": "approved-anthropic-quota" }
    },
    "groups": {
      "coding": { "maxParallel": 1, "members": [{ "id": "implementer", "cli": "codex", "model": "gpt-6.1-sol", "roles": ["coding"] }] },
      "review": { "maxParallel": 1, "members": [{ "id": "reviewer", "cli": "claude", "model": "claude-sonnet-5", "roles": ["reasoning"] }] }
    },
    "admission": {
      "authorityRef": "project",
      "maxQueued": 4,
      "queueTimeoutSeconds": 60,
      "leaseSeconds": 60,
      "groupCaps": { "coding": 1, "review": 1 },
      "cliCaps": { "codex": 1, "claude": 1 },
      "memberCaps": { "coding/implementer": 1, "review/reviewer": 1 },
      "modelCaps": { "openai/gpt-6.1-sol": 1, "anthropic/claude-sonnet-5": 1 },
      "quotaCaps": { "approved-openai-quota": 1, "approved-anthropic-quota": 1 }
    },
    "budgets": {
      "perRun": { "tokens": 100000, "costUsd": 10, "wallSeconds": 1200 },
      "perTask": { "tokens": 40000, "costUsd": 5, "wallSeconds": 600 },
      "enforcement": "observed", "unknownCost": "reserve", "reservationUsd": 5
    },
    "retry": { "maxAttempts": 2, "on": ["rate-limit", "unavailable", "timeout"], "baseDelaySeconds": 1, "maxDelaySeconds": 60 }
  }
}
```

Project-root `models.json` supplies role preferences. Explicit inherited
restrictions still intersect; a task or project preference cannot relax them.
An unavailable required reviewer blocks acceptance. A different CLI using the
same model family cannot satisfy required family independence.

```json
{
  "defaults": {
    "workerSelection": {
      "roleGuidance": {
        "coding": { "groups": ["coding"], "tier": "standard", "initialEffort": "medium", "effortLadder": ["medium", "high"] },
        "reasoning": { "groups": ["review"], "tier": "standard", "initialEffort": "medium", "effortLadder": ["medium", "high"] }
      },
      "guards": { "deniedEfforts": ["ultra"], "denySelfDelegation": true, "requireExactModel": true },
      "dataPolicy": { "allowUnknown": false }
    }
  }
}
```

All applicable caps reserve atomically, using the minimum ceiling. Native workers
also count. Container/mission caps do not buy additional worker slots. Model keys
are `<inference-provider>/<RFC3986-encoded-exact-model-id>`; member cap keys are
`group/member`. Unknown native dimensions count conservatively. Reservations,
reported usage, estimates and unknown usage remain separate. Retries, effort
changes, fallback and reviews consume the original run/task allowance and deadline.
`enforcement="hard"` is rejected with `OG_BUDGET_UNMEASURABLE`; these counters
cannot promise an upstream provider will stop spending at a dollar amount.

## Validate, qualify and activate

Run from the project root. `aiwg config validate --project` validates offline;
`aiwg models resolve` previews a particular request. Both can explain missing
qualification without launching inference. Installation probes are a separate,
explicit step:

```bash
aiwg config validate --project
aiwg doctor --probe-workers --json
aiwg doctor --probe-workers --qualify
```

The qualification command records installation/control evidence. Check each exact
version/account/profile/transport and current catalog/policy observations. A
present binary, compatible banner, documentation, or successful fake CLI test
alone does not qualify execution. Keep denied and missing routes visible,
including Codex, Muse, Claude, Hermes and local inference. Local synthesis needs
whole-path local qualification and egress controls; a text endpoint does not
provide coding tools, and local-only tasks cannot fall back to cloud providers.

Managed activation is a trusted embedding/config-owner operation. There is no
`mc activate`, host-install, migration, or forced-settlement CLI. The generic
config setter validates and synchronizes an existing compatibility copy; it
does **not** implement a coherent activation transaction. A JSON example without
an activation marker is deliberately unable to launch managed work.

The trusted owner must serialize writers and pause submissions while it:

1. Inventories canonical config, existing compatibility copies, project/user/bundled
   model inputs (`workerActivationCopyInventory`), and retains the previous pair.
2. Validates the complete pair and current restrictions with `ConfigLoader`.
   Builds a revisioned marker from `workerActivationDigests(config)` plus the
   loader's exact `getInputDigests()`, and a retained immutable `snapshotRef`.
3. Writes and checks the same marker and candidate bytes in all inventoried config
   copies. Rechecks inputs before binding the authority. An interrupted or mismatched
   activation stays closed; a partially written pair is never a legacy fallback.
4. Builds `managedProjectAdmissionPolicy(root, resolvedParallelism,
   workerConfigDigest(activation), resolvedParallelism.max_parallel_subagents)` and
   initializes the existing project store with `bindManagedAdmissionPolicy`.
   A nonempty authority requires reconciliation, not rebinding over its history.

`createMcAdmissionScheduler(root, config)` opens that same authority at canonical
`<project>/.aiwg/ralph-external/mc/admission.json`. Both conductors must use the
same current binding. Editing config, user defaults or an installation can
invalidate activation; obtain a reviewed new pair rather than fabricating hashes.
An operator without a trusted activation/bootstrap integration should remain in
direct mode until that integration is provided.

## Dispatch through the existing owner

These are launch instructions for an authorized deployment, not instructions to
run the held pilot. The parent first prepares schema-valid, digest-bound intent,
brief and dispatch artifacts in its bounded project workspace. Intent identifies
the original Mission/Flow parent and task; brief binds the selected tuple,
policy/catalog, isolated worktree, output and admission generation. It grants zero
worker delegation by default. No worker-returned artifact can grant authority.

```bash
aiwg mc start --name "bounded work" --max-missions 2
aiwg mc dispatch SESSION "bounded objective" --completion "protected checks pass" --request-id REQUEST --worker-dispatch /absolute/project/dispatch.json
aiwg mc run SESSION --accept-cost
aiwg mc status SESSION --json
```

`dispatch` queues only. `run` revalidates policy, qualification, pins and artifact
digests before admission and a durable launch claim. Managed MC one-shot capture
currently requires a qualified Linux shell route. `mission-dispatch` in the
existing MCP toolset forwards `worker_dispatch` to this same MC handler. Public
shell `models resolve` and MCP `worker-resolve` can show managed eligibility but
cannot supply trusted parent authority or turn it into a direct launch command.
`worker-invoke` remains the independent direct tool.

Flow uses `createMcFlowAdapter` / `createManagedCompositionAdapter` with its trusted
execution callback, retaining graph approvals, actual input/output schema checks,
checkpoints and original run ceilings. A qualified MCP descriptor can go to that
callback; that does not enable MCP capture in MC. Ralph remains the supervisor.
Successful worker output leaves MC paused for the original parent's independent
completion checks; process settlement alone never accepts the deliverable.

## Observe, cancel and recover uncertainty

`mc status` synchronizes durable state; it is not a purely nonmutating diagnostic.
Inspect the project's scheduler `snapshot()` through the trusted owner for
request/generation, state, dimensions, accounting, cooldowns and stop evidence.
Keep snapshots sanitized and project-scoped. Renewals extend ownership, never
semantic progress. A task can be paused/completed in a UI while its capacity
remains uncertain. Export measured and estimated subsets separately and report
unknown totals explicitly, including failed attempts and reviews.

```bash
aiwg mc abort SESSION MISSION --expected-updated-at TIMESTAMP --request-id CANCEL_REQUEST
aiwg mc pause SESSION
aiwg mc stop SESSION --drain
```

Cancel first records uncertainty, then attempts an owned-process signal. Queued
work can cancel without an execution reservation. For admitted work, expiry,
cancel delivery, disconnection, a final result, and a status string **never** prove
termination. Managed preemption cannot release capacity. Unfenced Ralph abort,
resume and cleanup reject managed entries; use their owning MC path.

For an uncertain request:

1. Pause submissions and retain its brief, dirty worktree, capture, launch claim,
   generation and process birth identity. Do not retry or start a replacement writer.
2. Have the supervision owner reconcile the bound OS process group or authoritative
   remote session, including descendants. PID existence/absence alone is insufficient;
   PID reuse, observer loss and missing execution identity remain uncertain.
3. Supply current-generation health and bound execution identity to
   `acceptFinal` (evidence only) and `settle` (proof-checked release). Only trusted,
   confirmed termination checked by that owner can settle. Do not hand-edit a
   `confirmed` status into the store. Repeated matching settlement is idempotent.
4. Recheck present policy, effects, artifacts, pins, quota reset/backoff and original
   run/task deadlines before any separately identified next attempt. Unknown usage
   retains its reservation; it is not refunded when the process stops.

Missing proof means keep capacity and request trusted operator disposition.
Preserve stale/late finals as evidence without allowing them to replace stop proof.
Disk-full, a stale lock or a failed write blocks admission. Do not delete locks,
store files or partial artifacts as a recovery shortcut.

## Migrate project authority to a shared host

Migration is a single-host trusted-owner API procedure. It does not create another
store family or scheduler. Choose private canonical owner paths outside **all**
worker-writable mounts, including the old project authority. Reject symlinks,
hardlinks and group/world-writable files/directories. Private Unix modes alone
cannot isolate an unrestricted same-uid process: qualify the actual sandbox/ACL
boundary or use a separate protected service uid.

1. Retain config/activation and source/target revisions and history. Approve the
   candidate `host:<id>` config pair. Build each approved project policy with
   `authorityRef="project"` for normalization while retaining the actual host
   activation digest. Record `migrationFrom` for the exact prior project policy
   when the authority change changes the activation digest.
2. Call `bindTrustedHostAdmissionPolicy(targetStore, binding)` with host identity,
   positive revision, intersecting ceilings, queue bound, approved project hashes
   and trusted installation → canonical upstream account/quota/model allowlists.
   Projects cannot install these mappings by editing local config.
3. Call `migrateProjectAdmissionToHost(sourceStore, targetStore, projectId,
   { id, expectedSourceRevision, expectedTargetRevision })`. Use a stable migration
   ID. It closes the old route, freezes both, and drains admitted/uncertain work.
   Renew/stop/settle remain available while draining; launch claims/submissions do not.
4. Transfer only drained, matching history. Reservations, measured/unknown charges,
   attempts, idempotency and original deadlines survive. Cooldowns merge without
   shortening reset times. The host generation commits before reopening; the source
   redirect permanently fences old callers. Repeat the **same** migration ID after
   interruption, against matching revisions/digests. Do not restore a stale source
   file or invent a reverse migration to bypass a conflict.
5. On an existing revision-aware executor registration (`x-admission-policy-revision:1`),
   the trusted owner calls `ExecutorRegistry.installHostAdmissionAuthority(executorId,
   version, targetStore, workerWritableRoots)`. Its private persisted identity binding
   lets fresh callers resolve `host:<id>`. Public registration or capability advertisement
   alone cannot grant it. Changed/deregistered executors revoke/fence the binding.
6. Verify two participating projects see separate local request/member/run IDs while
   the same upstream model/quota consumes shared host capacity. A missing/revoked
   host binding must fail closed; never fall back to an old project file.

Read the [S4 contract](../contracts/shared-host-admission.v1.md#managed-host-authority-s4)
for path limits, history validation and recovery. No cross-host authority or automatic
stale-lock cleanup is supplied.

## Roll back to direct mode

Rollback changes future routing; it does not undo migration or erase managed
history. First stop new submissions on **every** participating conductor, drain
queues, and reconcile all launched/uncertain work through the current authority.
Freeze the authority if an old process could still submit. Retain all config pairs,
policy revisions, host redirects, usage, proofs and dirty artifacts for recovery.
Do not launch direct work against an uncertain writer's scope.

Once the trusted owner confirms quiescence, run in each project:

```bash
aiwg config set --project parallelism.worker_dispatch false
aiwg config set --project parallelism.worker_mode direct
aiwg config set --project parallelism.worker_dispatch true
```

Leave the first setting false if dispatch should remain off. Keep groups/model
restrictions and admission history; retain the old activation as evidence, never
as authority to resume managed work after edits. Recheck current direct qualification
and resolve a **fresh direct brief**. Managed intents/leases are not reusable direct
authorization. Direct resolution needs no MC state, executor registry, activation
or scheduler. The conductor again self-counts and must disclose that host-wide
admission/recovery guarantees no longer apply. Coordinate every host participant
before moving any shared workload to direct mode.

`models-direct-invocation.test.ts` exercises these config setters, existing
compatibility-copy synchronization, exact direct command restoration, and
preservation of uncertain capacity. Re-enabling managed mode requires a newly
validated activation and reconciliation against the retained current authority;
recreating the project store would lose charged history and is not rollback.

## Diagnose within fifteen minutes

Time this exercise separately from cohort setup. With two groups configured, use
offline validation and request previews to locate seeded stale defaults, contributor
mode, denied `ultra`, ambiguous account/quota aliases and missing qualification.
Record the active config/model digests, JSON pointers, affected members and proposed
remedy. Invalid candidate edits must leave the prior stored configuration intact.
No probe, paid request, rule rewrite or bypass enablement belongs in this diagnosis.
The fifteen-minute usability target requires an observed operator exercise; offline
tests do not establish human completion time.

Record conductor sandbox/network settings before any later smoke. Codex
`--sandbox workspace-write` defaults to network off; smoke must start the worker
**inside the conductor sandbox**. On titan, Claude Code's Bash sandbox currently
fails with `apply-seccomp EPERM` under
`kernel.apparmor_restrict_unprivileged_userns=1`; an operator decision is required.
Record load/core >0.8 as a host-gate outcome independently of routing. Worktrees and
installation roots must not be group-writable (titan's umask 002 needs attention).
Fixture-only `dataPolicy.allowUnknown=true` and `guards.denySelfDelegation=false`
may reuse the prior explicit approval; record those limitations and never apply
them to repository defaults or user/global configuration.
Nested CLIs also need an approved runtime-state writable boundary inside the
conductor sandbox. A later permission amendment for a different evaluation does
not authorize exposing CLI homes here; record the operator's decision without
reading or copying credentials. Direct briefs and outputs belong inside the
isolated worker tree; arbitrary JSON is not a complete direct brief.
