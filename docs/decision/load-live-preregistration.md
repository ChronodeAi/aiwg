# D05 staged-provider load preregistration

**DRAFT, awaiting operator approval.** This document proposes the live run for
issue [#2682](https://git.integrolabs.net/roctinam/aiwg/issues/2682) following
the operator's 2026-10-25 decisions. The harness was built
and tested offline. No live run, budget approval, provider qualification, G5
pass, or production enablement is recorded here.

## Approval record

Joe is the named operator, approver, and second owner for the canary rollback,
as explicitly designated on 2026-10-25. Before each live run, he must complete
and approve this record, including the rollback and stop conditions.

| Field | Value to approve and retain |
|---|---|
| Approval identity, timestamp, reference | Pending: Joe |
| Exact full source commit and exact-head validation reference | Pending |
| Manifest byte digest and profile digests | Pending; pin [`load-manifest.v3.json`](./load-manifest.v3.json) before execution |
| Run identifier and D11 artifact directory | Pending |
| UTC start window | Pending |
| Previous qualification spend and remaining combined allocation | Pending; total across live Jev qualification runs must stay within USD 5 |
| Budget and every manifest stop condition approved | Pending |
| Shadow, canary, and rollback approved | Pending |
| Exclusive credential use and no active workers on noodle verified | Pending |
| Provider-side credential rate limit, model, and approved egress path | Pending |
| Sourced pricing snapshot and its checked-at timestamp reviewed | Pending |
| Result reviewer | Joe |

The USD 5 combined ceiling replaces the September allocation for this task.
The checked-in manifest allocates USD 1 of that ceiling to this proposed first
run (estimate USD 0.06–0.21), with a USD 0.80 dispatch stop, leaving USD 4 for
the other live qualifications. Before any repeat, Joe must account for the prior run's
conservative reservations, record the remaining allocation, and preregister a
new manifest version with a ceiling no greater than that remainder. Do not
reset the combined allocation by starting another process.

## Host and source record

Run only on **noodle, 16 cores, 30 GB**, while no workers are active and no
other consumer uses the Jev credential. Record actual hostname, CPU model and
core count, total memory, OS/platform and architecture, Node version, network
path (including any proxy or egress boundary), start/end timestamps, exact
commit, and the operator's idle/exclusivity checks. The harness records host,
CPU, memory, platform, Node, and the caller's `--network-path` description;
retain the other approval checks alongside its result.

Use the exact approved full commit in a clean source tree. The runner checks
the source before and after the run. Any source change or dirty tree prevents
qualification. Build and verify that same source before approval; keep output
outside the checkout so evidence creation cannot dirty it.

## Proposed command

After approval, first resolve and verify the canonical external evidence root:

```bash
aiwg artifacts path --json --check-write
```

Set `<D11-artifact-root>` to a D11 directory beneath the returned
`artifact_root`. If it is unavailable, stop; do not use a repository-local
fallback. Retain the approval, manifest bytes/digest, source validation, host
checks, and result together in that directory.

The exact proposed live command is:

```bash
node tools/decision/load-qualification.mjs --live --manifest docs/decision/load-manifest.v3.json --commit <approved-full-commit> --credential-env AIWG_JEV_LOAD_API_KEY --network-path <approved-egress-description> --output <D11-artifact-root>/d05-load-v3/load-result.json
```

Replace each angle-bracket placeholder with its approved value, quoting values
containing spaces. The caller supplies `AIWG_JEV_LOAD_API_KEY` in the process
environment at execution time through the scoped secret-service reader for
`kv_internal/typesafe/jev/api-key`. Use only that approved logical credential.
The runner never reads credential files. Never put its value in a command,
file, log, digest, or evidence record. The command reads existing sourced
`decision.ask.cost` pricing from project configuration; it does not refresh
pricing or obtain credentials. Retain its model, split input/output rates,
source, and checked-at timestamp in the result.

Omitting `--live` uses the deterministic fake backend. Such a result identifies
itself as `offline-fake-provider` and cannot qualify G5. The live flag alone
cannot start a run without the caller's environment credential, explicit
`maxUsd`, and complete validated manifest.

## Schedule, measurements, and bounds

Pin seed `2601`, synthetic requests only, and model `jev-1.14.0`. The new
`d05-staged-v3-canary` profile runs a 10-second shadow window followed by the
60-second burst/load, 30-second spike, and 900-second soak schedule, with noisy
and reserved quiet principals. Restore `d05-staged-v3-previous` at a run
boundary and observe its 10-second rollback window. The intended total window
is 1,010 seconds, within the 1,200-second wall-clock ceiling. The initial
profile registration, change, and rollback retain their content digests.

All stages use the existing admission controller. Canary provider concurrency
is 3 and workspace concurrency is 4; the previous provider/workspace profile
uses 2. These remain below the documented eight-call point. Every scope pins
rpm, tokens/second, invocation cost, retained-work, queue length, and queue
dwell limits. The manifest also pins principal reservations and share caps.
Do not adjust a bound after observing the result; changed bounds require a
new manifest version and renewed approval.

The record retains admission receipts, actual provider usage when available,
profile and breaker history, calls, retries, retry amplification, queue-wait
distribution, quiet-principal wait/admission ratio, maximum active/queued
work, and cancellation latency. Fixed 1,000 ms samples measure process RSS,
heap, and CPU from `process.memoryUsage()` and `process.resourceUsage()`.
Actual sample times are retained, with a maximum sampling-gap bound of
2,000 ms to detect lost coverage while allowing ordinary timer jitter.
Compare every bound against retained measurements, including the RSS
1,024 MiB, heap 512 MiB, one-core CPU 80%, eligible-lane wait 2,000 ms,
cancellation 100 ms, and quiet-principal admission ratio 0.95 thresholds.

## Budget and stop response

| Guard | Preregistered value |
|---|---|
| Combined qualification ceiling | USD 5 total across live runs |
| This proposed run's `maxUsd` / `stopAtFraction` | USD 1 / 0.8; stop at USD 0.80 |
| `maxCalls` | 1,500 provider attempts, including retries |
| `maxTokens` | 8,000,000 reserved tokens |
| `maxWallClockSeconds` | 1,200 |
| Breaker continuously open | Stop beyond 5,000 ms |
| Retry amplification | Stop above 1.25 |
| 429 storm | Stop beyond 5,000 ms |
| Cross-principal quota violations | Stop on any violation |

The guard reserves calls, tokens, and USD before dispatch using the sourced
cost configuration. Reservations conservatively price tokens at the larger
input/output rate and remain charged when usage is unknown; the result keeps
provider-reported actual usage separately. A reservation that would cross the
USD 4 stop or other cap prevents further dispatch. Usage beyond a reservation,
invalid reservations, source drift, or driver errors also fail closed.

Any stop aborts new work and records an explicit reason. Preserve the partial
record and all attempt, admission, breaker, and profile history; a stop cannot
be a silent pass. Restore the previous `profileVersion` at the boundary even
after a stop, without starting additional provider work. For outage or retry
storms follow [`RUN-JEV-OUTAGE-v1`](./operations/README.md); for profile
changes and rollback follow
[`RUN-JEV-ADMISSION-v1`](./operations/admission.md). Joe approves the recovery
and canary rollback under the designated second-owner arrangement.

## Evidence review and completion

The output is a digest-bound `decision-load-result/v1` artifact of kind
`load-manifest-qualified`, containing exact manifest bytes and digest, source
commit, execution mode, measurements, per-bound comparisons, and stop state.
The name alone does not establish qualification. G5 verifies the live artifact
and its exact commit, digests, complete rollout, clean source, and measured
bounds; offline or stopped evidence cannot satisfy it.

The existing D11 qualification runner accepts this file through its
`gateArtifacts['load-manifest-qualified']` input. Its default artifact limit
is 1 MiB; use `maxArtifactBytes: 4 * 1024 * 1024` when attaching a larger
retained receipt history. Keep the exact manifest bytes inside the record.

Joe reviews the full result and retained evidence before accepting any live
qualification claim. Afterwards an authorized operator links the approved D11
evidence from [#2682](https://git.integrolabs.net/roctinam/aiwg/issues/2682),
parent [#2601](https://git.integrolabs.net/roctinam/aiwg/issues/2601), and G5
consumer [#2604](https://git.integrolabs.net/roctinam/aiwg/issues/2604). Those tracker updates,
the actual live run, and operator approval are future operator actions. D05's
offline closure remains separate from this live evidence requirement.
