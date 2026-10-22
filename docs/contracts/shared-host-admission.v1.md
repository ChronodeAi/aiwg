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

## Managed fencing and checkpoint reconciliation

Managed `renew(requestId, generation)` and `cancel(requestId, generation)` require
an explicit current `leaseGeneration`. `stop(requestId, generation, reason)` accepts
`cancel`, `disconnect`, `preempt`, or `observer-loss`; `disconnect(requestId,
generation)` is its disconnect shorthand. Each rejects stale generations before
mutation. Stopping an admitted worker immediately records `uncertain`, retaining
all dimensions; stopping queued work cancels it without an execution reservation.
Expiry also retains uncertainty. Renew never modifies observed health or the
semantic progress watermark, and cannot revive an expired or uncertain lease.

Before spawning, the execution owner calls `claimLaunch(requestId, generation)`
and checkpoints that generation in its existing Mission/MC state. The claim
rechecks the original run/task deadlines as well as the lease. A second claim
is rejected, including after restart. A crash between claim and launch therefore
requires reconciliation; the owner never automatically replays uncertain or
already claimed work. `bindExecution(requestId, generation, { pid, startedAt })`
binds the actual process immutably. Here `startedAt` is the OS birth identity
(including boot/start identity), not a wall-clock timestamp or a PID-only check.
A changed identity, including reuse of the same PID, conflicts.
A claimed launch with no reconciled execution identity retains capacity even
when supplied confirmed health; identity reconciliation must precede settlement.

`observeHealth(requestId, generation, health)` consumes the shared Mission health
mapping and advances a nondecreasing semantic progress watermark only for fresh
progress. Its health observer generation must match the lease. Observer loss and
uncertain observations retain capacity; even confirmed health observations alone
do not settle. `acceptFinal(requestId, generation, health, usage?)` stores final
evidence separately from termination proof. Stale finals are rejected before any
state change. A late final remains evidence while cancellation or disconnect is
uncertain and never releases capacity or accepts task completion.

Only explicit `settle` releases capacity. When an execution identity is bound,
`settle(requestId, generation, health, usage, failure?, execution?)` additionally
requires that same identity. The trusted supervision owner must verify process
group or authoritative remote termination; a status string, worker final or
notification delivery cannot supply that proof. Both caller and proof generations
must be current. Settlement replay leaves the attempt unchanged and conflicting
final usage is rejected.

Managed MC checkpoints persist the launch claim, admission generation and process
identity before status reconciliation. Local cancellation records uncertainty
before attempting a bounded owned-process signal; unproved descendants retain
capacity. Resume revalidates the current activated policy and lease state,
preserves existing artifacts, and never launches an uncertain attempt. Ordinary
unfenced Ralph abort/resume/cleanup routes reject managed registry entries.

Offline recovery and fencing vectors (T-OG-06/24) are in
`test/unit/serve/shared-host-scheduler-fencing.test.ts`; the S2 trace harness has
separate managed cases in `test/evidence/s2-scheduler-traces.test.ts`.

## Managed Flow adapter

Managed composition uses `createManagedCompositionAdapter` from the bundled
composition runtime. Its trusted host supplies the existing project scheduler,
`prepareNode`, the execution owner's `invokeNode`, and
`managedAllowanceFromOwner`. `prepareNode` qualifies selection and returns the
existing admission request; Flow retains graph permissions, approval gates,
routes, completion and original run ceilings. Every attempt submits to that same
scheduler, links the latest same-task attempt, claims launch, and binds the
execution owner's OS birth identity before accepting termination evidence.
Prepared briefs must name the same project reservation and fenced generation.

The execution callback receives the admitted record and fenced `bindExecution`,
`renew`, `observeHealth` and `cancel` operations. Its result or thrown error may
carry `managedEvidence: { health, usage, failure? }`, using the existing Mission
health and usage definitions. Only current proof checked by `acceptFinal` and
`settle`, against the bound identity, permits output delivery. Missing, stale or
uncertain proof disconnects the attempt and retains shared capacity. Raw output
presence and status strings cannot supply proof. Fenced admission identities and
selected worker dimensions survive in Flow results and checkpoints.

The factory reports revision 1, the current Mission worker definition digest,
lossless handling, the five baseline features, `worker-health.v1`, and
`worker-flow-values.v1`. `composition run` forwards this adapter registration;
managed metadata alone cannot qualify an arbitrary execution callback. Existing
adapters without managed mode retain their previous behavior.

Before dispatch, managed Flow resolves schemas offline from their bundled owners
and checks actual inputs, outputs, state and restored results. Draft-07 and
2020-12 validators keep their dialects, including cross-dialect references and
format checks. Present but invalid output fails before state or output delivery.
Every serial or parallel attempt is accounted before output validation; sibling
spend survives parallel failure. Missing usage remains null with conservative
reservations, and checkpoints retain both known spend and unknown reservations.
An interrupted invocation boundary requires owner reconciliation before replay.

## Managed MC worker handoff

`aiwg mc dispatch <session> <objective> --completion <criteria>
--worker-dispatch <absolute-path>` accepts prepared `workerDispatch` JSON in
managed mode. MCP `mission-dispatch.worker_dispatch` forwards the same path to
MC; both front ends use the same resolver and policy checks. Dispatch queues
without reserving capacity or launching. `mc run` rechecks current qualification,
selection pins, activation and artifact digests before submitting the existing
shared admission request. Native and external workers share project capacity.
Direct MCP worker tools retain their independent handoff path.

The dispatch's intent and prepared brief must be bounded local artifacts inside
the project. The intent identifies the original Mission parent and task; the
brief binds the selected tuple, policy/catalog digests, project reservation and
generation, isolated workspace, output path and zero delegation allowance.
The brief's lease must match admission before the durable launch claim. Managed
configuration without explicit parent task authority can expose eligibility but
cannot render a launchable direct invocation.

MC checkpoints the generation, claim, qualified invocation and capture directory
before launching Ralph's existing one-shot shell capture. The child rechecks the
shared lease and selected dimensions at dispatch, uses the original cumulative
deadline, and does not charge a second direct allowance. Managed capture currently
requires a qualified Linux shell profile; unsupported transports fail before
admission. `createMcFlowAdapter` supplies the same qualification and project
authority to the composition adapter through its trusted execution callback.
Flow may hand a qualified MCP descriptor to that callback; the managed MC
one-shot capture remains limited to shell transport.

Running observations renew ownership without manufacturing progress. Missing or
stale capture evidence retains uncertain capacity. Status strings, final claims,
and cancellation never settle. MC stores a `workerResult` with independent
verification pending and unavailable usage explicitly unknown; successful worker
claims leave the mission paused for the parent's original completion checks.
Only matching fenced capture evidence confirming descendant termination, plus
kernel confirmation that the bound supervisor no longer exists, reaches shared
settlement. An unavailable process observation cannot supply that confirmation.
Late evidence remains reconcilable after pause/cancel without changing the
parent's control decision.

## Managed host authority (S4)

`parallelism.admission.authorityRef=host:<id>` uses the existing executor
registry and `FileAdmissionStore`. It never falls back to the project MC file.
Direct dispatch and disabled/legacy routes retain their existing behavior.

The trusted service owner calls `bindTrustedHostAdmissionPolicy` with a local
host identity, positive policy revision, host ceilings, canonical upstream
account/quota/model bindings and an explicit set of approved project policies.
Project identities are hashes of canonical roots. Build each approved project
policy with `managedProjectAdmissionPolicy` using `authorityRef=project` while
retaining the activation digest of the actual host configuration. The MC factory
performs the same normalization; it compares the complete approved policy.
When changing the authority reference creates a new activation digest, the host
owner also approves `migrationFrom`, the exact prior project policy. Only the
activation digest may differ; unrelated project policy changes require separate
reconciliation. Migration compares the source against that approved prior policy.
Host ceilings intersect project ceilings. Project model/quota limits remain
project-scoped; host model/quota limits aggregate all approved installations.
Host installation model allowlists and canonical upstream quota aliases cannot
be supplied or changed by a project request. Unknown native dimensions reserve
conservatively. Local member, request, run and task IDs are project-namespaced;
public scheduler snapshots contain only that project's records and allowances.

After migration, the owner calls
`ExecutorRegistry.installHostAdmissionAuthority(executorId, version, store,
workerWritableRoots)` on an existing registration advertising
`x-admission-policy-revision:1`. This capability alone grants no authority; the
public executor registration payload cannot install a host binding. File-backed
bindings persist in the existing executor identity store at
`~/.config/aiwg/executor-identities.json`. Host lookup ignores project storage
redirects and `AIWG_EXECUTOR_IDENTITY_STORE`. A trusted embedding can provide an
explicit host identity-store location to `ExecutorRegistry` and pass that
registry to `createMcAdmissionScheduler`; project configuration cannot choose it.
Fresh MC/Ralph processes restore the protected binding from that location.
Changed registrations and deregistration fence existing clients and revoke the
binding; trusted installation is required to reopen it. Every scheduler
transaction compares the complete effective policy, host revision and project
authority generation against the current admission snapshot.

Re-registering a host-bound executor ID requires its current bearer token,
including compatible registrations. Missing or incorrect tokens return HTTP 401
without updating the registration or revoking authority. General executor
re-register token reclaim is tracked separately as #3439. The token is checked
only against the live executor or the protected host record, never a selectable
identity store. Host metadata is read
and persisted only at the protected host identity-store location; selectable
identity stores cannot supply it. A `host:` authorityRef emits a warning when
`AIWG_EXECUTOR_IDENTITY_STORE` is set and continues to ignore it for lookup.

Host registration and admission files require canonical absolute paths, private
owner directories/files and no worker-writable mount containing either file.
Host admission reads reject symlinks, writable aliases through hardlinks and
files larger than 16 MiB; registration files are bounded to 1 MiB. Migration enables durable writes on both file stores. Protected
and migration writes use exclusive temporary files, atomic rename and file/directory fsync.
An existing file lock or temporary-file conflict blocks writes. These checks
require actual sandbox/ACL enforcement outside the worker's writable mounts;
private modes alone cannot isolate an unsandboxed process with the same uid.
Read or write failure blocks managed admission. Retention, stale-lock disposition
and disk-pressure remediation remain trusted operator actions.

Host authority is supported only on Linux/POSIX platforms with uid and mode
checks. Missing uid or mode support fails closed.

### Pilot limitation

The same-uid limitation is accepted for the #2924 pilot only if its executor
runs workers in a sandbox whose writable mounts exclude `~/.config/aiwg` and
the host admission directory. The code checks declared writable roots but cannot
verify the actual sandbox mounts. Before managed mode becomes generally
available or a default, authority files require a separate service uid or an
equivalent enforced isolation boundary.

### Host migration

`migrateProjectAdmissionToHost(source, target, projectId, options)` extends the
same store owner. `options` supplies a stable migration ID and expected source
and target revisions. Approved projects have no host generation until migration
completes, including projects with an empty local store. Migration closes the
old route first, freezes the host, and drains both authorities. Renew, stop and
proof settlement remain available while frozen; submissions, queued admissions
and launch claims are blocked. Admitted or uncertain leases prevent transfer.
Expiry, cancellation, final results and status strings never satisfy draining.

The drained history digests bind all reservations, measured/unknown spend,
original deadlines, attempt counters and idempotency records. Transfer preserves
local identities under the project namespace, intersects tighter host budgets
without resetting clocks, remaps quota cooldowns to trusted upstream identities
and keeps the later cooldown. Independent failure counts accumulate once per
canonical alias. Charged history requires current-generation,
confirmed stop evidence. A source/target revision conflict, history change,
invalid evidence or failure at freeze/drain/transfer/commit leaves dispatch
closed. The host generation commit is atomic within its existing store; the
host stays frozen until the source redirect is recorded. Recovery repeats the
same migration ID against matching bindings/digests and is idempotent. No blind
rollback, stale-lock removal or automatic replay of uncertain work is provided.
The first freeze write can precede the second after a crash; the old route is
closed and the project still lacks a usable host generation, so two authorities
cannot dispatch that project's work. The trusted owner resumes the same
migration to complete freezing/reconciliation. This is a single-host protocol;
no distributed lock or cross-host authority is supported.
