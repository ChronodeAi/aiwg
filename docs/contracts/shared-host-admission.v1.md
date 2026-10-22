# Shared-Host Scheduling and Admission v1

Status: supported management-plane policy
Issue: AIWG #1566
Substrate boundary: `agentic-orchestration/fleet-workload/v1`

This policy coordinates independent AIWG orchestrators that share execution
hosts. AIWG owns admission, fairness, quota, priority, preemption, and recovery.
Agentic Sandbox remains the executor: it reports capacity and lifecycle state
and runs only work carrying a valid AIWG admission lease.

## Global state and leases

All orchestrators for a host group use one durable `AdmissionStore`. A store
transaction is the serialization boundary; a process-local store is valid only
for tests or a single orchestrator. Every request has a globally unique ID,
orchestrator, environment, provider, runtime kind, priority, submission time,
queue timeout, and optional preemptible flag.

An admitted request receives a renewable lease with an expiry. Dispatch must
happen only while that lease is current. A crashed controller cannot retain
capacity forever: reconciliation marks its expired lease `timed-out` and
admits the next eligible request. Exact request replay is idempotent; reuse of
an ID with different placement identity fails closed.

## State model

| State | Meaning |
|---|---|
| `queued` | Valid request waiting for global and quota capacity. |
| `admitted` | Renewable lease granted; dispatch is allowed. |
| `uncertain` | Managed execution may still be running; capacity stays reserved. |
| `settled` | Managed stop proof reconciled; capacity released and accounting retained. |
| `denied` | Policy permanently rejects the request. |
| `cancelled` | Owning orchestrator cancelled before completion. |
| `timed-out` | Queue deadline or admission lease elapsed. |
| `preempted` | Explicitly preemptible lease displaced by higher priority. |

Executor task states remain separate. Admission is permission to dispatch, not
evidence that a sandbox task started or completed.

## Capacity and quota order

Admission must satisfy all limits simultaneously:

1. host-group global concurrency;
2. environment quota;
3. provider quota;
4. runtime-tier quota.

`host` is the least-isolated tier and defaults to one concurrent lease unless
an operator explicitly sets another quota. Container, VM, microVM, and custom
tiers use configured quotas and retain their normalized runtime identity in the
fleet workload record.

## Fairness, priority, and preemption

The queue is ordered by effective priority, then submission time, then request
ID. Effective priority is base priority plus one point per configured aging
interval, so continuously arriving high-priority work cannot starve an older
request indefinitely.

Preemption is disabled unless policy enables it. Only an admitted request
declared `preemptible` may be displaced, and only by a request with strictly
higher effective priority. The victim becomes terminally `preempted`; runtime
cancellation and evidence collection are then performed by the owning Mission
controller. Non-preemptible production and host work never becomes preemptible
by inference.

## Mission and provider-native composition

Mission Control and Cockpit submit the same admission request before invoking
the fleet client or a singleton executor adapter. The returned request ID and
lease revision are recorded alongside Mission, dispatch, child, target,
executor, and runtime lineage. Provider-native loops use the same wrapper:
provider ownership of an interactive loop does not bypass shared-host quotas.

Backpressure maps as follows:

- queued capacity → fleet `blocked/capacity`, retryable;
- policy denial → fleet `blocked/policy`, not retryable;
- preemption → child `preempted`, then runtime cancellation/reconciliation;
- lease timeout → `timed-out`, retryable only under the Mission retry budget;
- approval wait → fleet `blocked/approval`, retaining the admission decision
  but requiring lease renewal while capacity remains reserved.

## Failure recovery and evidence

- Controllers renew before lease expiry and persist the new revision.
- Restarted controllers reconcile the shared store before dispatch.
- Missing or expired leases fail closed; executors are never assumed idle from
  an absent heartbeat alone.
- Queue, admission, renewal, cancellation, timeout, denial, and preemption are
  operator-decision audit events under #1567.
- Fairness tests must include independent schedulers sharing one store,
  priority aging, stable FIFO ties, quota contention, safe preemption, lease
  recovery, queue timeout, replay, and identity collision.

Implementation evidence is in `src/serve/shared-host-scheduler.ts` and
`test/unit/serve/shared-host-scheduler.test.ts`. Related work: AIWG #1546,
#1589, #1657, #1990–#1994, and `roctinam/agentic-sandbox#234` / #460.

## Managed project admission

When `parallelism.worker_dispatch=true` and `parallelism.worker_mode=managed`,
the same scheduler adds project worker dimensions. The preceding legacy lease
recovery and preemption rules continue to apply to callers without this mode.
Managed cancellation, lease expiry, and runtime status strings do not prove
termination and cannot release capacity.

Omitted `parallelism.admission.authorityRef` resolves to `project`. Its store is
`<canonical-project-root>/.aiwg/ralph-external/mc/admission.json`; project aliases
resolve through the real filesystem path. Host authorities and cross-project
aggregation require a later authority/migration capability and fail closed here.

The config/authority owner builds a policy with `managedProjectAdmissionPolicy`
and installs it once with `bindManagedAdmissionPolicy` under the existing store
lock, after validating activation. Dispatch callers use `createMcAdmissionScheduler`
and cannot initialize or replace the binding. The binding contains the activation
digest and effective admission policy. Every scheduler transaction compares both;
a stale digest, different limits with the same digest, or a legacy writer against
a bound store is rejected without changing state. Binding replacement is not
supported by this slice. The activation writer remains responsible for validating
the paired config/model snapshot; this admission API does not activate config.

Canonical reservation dimensions are:

| Dimension | Key |
|---|---|
| Project | `project/<sha256-of-canonical-root>` |
| Group | `project/<id>/group/<group>` |
| Member | `project/<id>/group/<group>/member/<member>` |
| Installation | `project/<id>/installation/<cli>` |
| Model | `model/<inference-provider>/<RFC3986-encoded-api-model-id>` |
| Quota | `quota/<percent-encoded-authority-owned-quota-scope>` |

Member IDs are group-local. Model and quota dimensions aggregate installations
within this project authority. Multiple installations of one account must bind
the same quota scope; conflicting aliases are rejected. Requests cannot override
the activated installation/quota or group/member bindings.

Each managed request supplies a `managed` reservation with `kind` (`native` or
`external`) and an optional positive integer `lowerBound` (default one slot).
External workers require group, member, CLI, canonical model, and quota identity.
Native workers use the same admission path; incomplete native identities and
pre-existing native leases conservatively count against every unknown capped
dimension. They also consume the project worker cap, which comes from
`max_parallel_subagents`. Group `maxParallel` and admission caps intersect.
All applicable dimensions reserve the lower bound in one transaction or leave
the request queued; queued records consume no execution capacity. This scheduler
does not enforce hard spend budgets, so those policies are rejected.

The managed queue defaults to 128 entries, a 300-second deadline, and 60-second
leases. A full queue denies waiting requests, including when its bound is zero;
immediate admissions remain possible. Cancelled, expired, and denied queue entries
remain terminal on replay. Reusing a request ID with any changed payload fails.

Managed records persist `attemptGeneration`, `leaseGeneration`, `dimensions`, and
`reservedSlots`. Generations start at one; settlement checks the caller and
stop-evidence generations through the existing Mission lease-mapping verdict.
An `uncertain` record retains all reserved capacity and has no completion timestamp. Managed preemption cannot free capacity, and the legacy
`release` API rejects managed records. MC launch failures and terminal/paused Ralph
status observations retain uncertainty. Only `settle` with current-generation,
trusted supervisor termination evidence releases execution capacity. The caller must obtain this evidence from the
supervision owner; worker claims and status strings are not evidence.

Offline coverage: `test/unit/serve/shared-host-scheduler-managed.test.ts` and
`test/unit/cli/handlers/mc-managed-admission.test.ts` (T-OG-05/06/08).

## Managed cumulative allowances and quota recovery

Managed admission binds `parallelism.budgets` and `parallelism.retry` into the
activated policy. `AdmissionRequest.allowance` supplies stable `runId` (equal to
`orchestratorId`) and `taskId`, optional Mission `spec.budgets` ceilings for each
scope, and an optional `{ tokens, costUsd }` reservation. Each supplied dimension
must be positive and finite, or explicitly null. With no explicit reservation,
the scheduler reserves the effective token envelope and `reservationUsd` or the
effective cost envelope. An unbounded, unobserved dimension remains null.
A bounded dimension without a finite reservation cannot launch.

`managedAllowanceFromOwner` translates existing Mission budgets, Ralph
`maxIterations`/`maxTotalTokens`/`maxTotalCost`/`maxWallClockMinutes`, or Flow
`ceilings` into this binding. Mission and Flow ceilings bind the run so child
tasks and reviews share them; an opaque Ralph loop binds its task envelope. MC uses it before launching native Ralph loops.
A caller without an explicit binding uses its orchestrator and mission/request
identity; callers replacing an attempt must preserve the original run/task IDs.
These identities belong to trusted workflow owners, not worker output. Flow's
worker-value feature handshake continues to reject unsupported runtime bindings;
the budget conversion does not enable managed Flow execution by itself.

The existing admission file persists `allowances`, `cooldowns`, and per-record
`accounting`. Run, task, and project ceilings intersect by minimum and never
increase when another attempt supplies larger limits. Deadlines begin with the
first binding and include queue/backoff time. Admitting an invocation atomically
reserves all applicable dimensions and debits the common attempt counter.
Queued, cancelled-before-launch, and denied requests do not debit attempts.
Retry defaults are three task attempts and exponential delays from one to sixty
seconds. Configured ceilings override those defaults.

Quality changes, effort changes, fallback, retry, and review use fresh request
IDs and the same allowance. `previousRequestId` must identify the latest admitted
task attempt, which must already be `settled`. Detached native loops reserve their
bounded iteration count up front (`attemptCount`), intersected with the effective
attempt ceiling; MC passes that bound and the reserved token/cost and remaining
wall envelope to the existing launcher. Early completion does not refund this
conservative attempt debit. The loop still consumes its worker reservation once.

Reservations remain distinct from schema-validated `WorkerUsage`. Null usage
means not yet observed. Reported, estimated, and unknown observations remain
queryable on their attempt records. Unknown measurements stay null; settlement
retains their reservation as a charge. Estimates cannot refund reservations.
Only confirmed final reported usage can replace a reservation with a measured
charge, including an explicitly reported zero. Before settlement, uncertainty
retains the larger measured/reserved charge. Unknown observations may refine to
estimates/reports; reported observations cannot decrease before settlement.
Hard spend policies remain rejected with `OG_BUDGET_UNMEASURABLE`: this scheduler
has no bound enforcing adapter and does not promise to stop upstream overspend.

`recordFailure(requestId, generation, failure)` records a trusted observation;
`recordRateLimit` is its 429 shorthand. `settle(requestId, generation, health,
usage, failure?)` can record failure, charge usage, and reconcile termination in
one transaction. The existing `decideLeaseMapping` derives stop proof from
validated health and checks the proof's own observer generation independently
of the supplied generation. Unconfirmed/stale proof retains uncertain capacity.
Settlement replay is idempotent; changed final usage conflicts. All attempts and
confirmed stop evidence remain in the same store after capacity is released.

Automatic retry/fallback requires a retryable rate-limit, unavailable, or timeout
failure permitted by `retry.on`. Authentication, invalid-request, and policy
failures cannot trigger automatic fallback. Every replacement honors the prior
task backoff and original deadline/attempt/spend ceilings, including a fallback
to another account. Routing owners still enforce eligible members and exact pins.

A 429 additionally cools the installation's authority-bound quota scope. Its next
admission time is the maximum of existing cooldown, valid `resetAt`, and bounded
exponential backoff. Missing/malformed resets use backoff. Another installation,
group, task, or caller sharing that quota cannot evade or shorten the cooldown.
Repeating the same failure observation does not extend/reset it. Native workers
without quota identity conservatively honor every recorded cooldown. No sleeping
or hidden retry loop is added to the scheduler; owners reconcile the bounded queue.

Pre-allowance managed snapshots fail closed with a migration/reconciliation
diagnostic and preserve capacity. They must be reconciled through the authority
owner before dispatch resumes; this slice supplies no automatic migration or refund.

Offline cases for T-OG-05/06/08/09 are in
`test/unit/serve/shared-host-scheduler-budgets.test.ts`; MC and existing direct
contract regressions remain under their existing suites.
