# Routing pilot

The D28 routing pilot is experimental and default-off. Its only enabled mode
is `shadow`, and no mode executes a route chosen by Jev evidence. The public
APIs are `runRoutingPilot`, `evaluateRoutingEligibility`,
`validateRoutingPolicy`, `validateRoutingTask`, `freezeRoutingPreregistration`,
`buildRoutingShadowReport`, `validateRoutingShadowReport` and
`runRoutingControlDrill`.

## Modes

- `disabled`, or any call without `enabled: true`: the runtime calls no hook
  (no reservation, evidence, dispatch, delay or timer). It returns a
  `disabled` receipt with `selectedRouteId: null`.
- `shadow`: the runtime executes only the existing deterministic route. That is
  `defaultRouteId`, then `deterministicFallbackRouteId`, whichever are still
  eligible. It then records the Jev-assisted policy's choice in
  `counterfactual`. The counterfactual is never dispatched. If neither
  deterministic route is eligible, the result is `no-route`, even when other
  routes are eligible.

Advisory or canary execution of the Jev-assisted choice is not implemented. It
would need a PROMOTE report, security/privacy review and explicit operator
approval, as listed under pending work below.

## Hard constraints

The task is validated against the closed `DecisionRoutingTask.v1` schema. A
missing, unknown or non-finite requirement returns a `review` receipt with
reason `invalid-task` before any hook runs.

Eligibility is a pure check that runs before any Jev call. It covers privacy,
authorization scopes, region, required tools, context, the allowlist,
per-attempt cost against `min(task, policy)` budget, deadline, health,
executable status, capabilities and the provider allowlist. It also enforces
the ordinary authorization ceiling in `requirements.authorized`: a binding
that holds any tool, network, filesystem, secret or action permission beyond
that ceiling is excluded as `permission-denied`. A route decision therefore
cannot widen the permissions a task already has. Ineligible routes are recorded
only as sanitized reason codes. The policy is deep-frozen after validation, so
the binding passed to `dispatch` cannot be changed in place.

## Execution (shadow)

`dispatch` requires the `reserve` and `release` hooks; without them the
receipt is `review` with reason `reservation-unavailable`. Before each attempt
the runtime checks, in order:

1. the caller's cancellation signal;
2. `ceilings.maxAttempts`, per-route `operations.maxAttempts` and
   `ceilings.maxFallbacks`;
3. the provider circuit, which is opened by any outage, rate-limit or
   circuit-open failure and skips later routes on the same provider;
4. the cumulative budget: `spent + price <= min(task, policy)`, where `price`
   is the larger of the pinned `costMicrosPerAttempt` and the highest actual
   cost already charged on that route or provider in this run;
5. the cumulative deadline: `min(task, policy)` from the start on the injected
   clock, after exponential backoff from `retryDelayMs` (capped at 30 s). The
   backoff uses a real timer when `delay` is omitted.
6. `reserve` for that one route only.

Each dispatch races an attempt deadline through `timer`, which defaults to a
real timer. When the deadline wins, the dispatch signal is aborted and the
attempt is recorded as `timeout`. Every granted reservation is followed by one
`release` call with the charged cost.

Each dispatch result is validated for its exact shape, types and
status/reason consistency. The reported `actualProvider` and `actualModel`
must equal the binding's pin. When they do not, the receipt is `review` with
`model-substitution` or `actual-model-unknown`. The actual reported cost is
charged cumulatively. An unknown cost stops further attempts (`cost-unknown`),
and spending over the budget ends in `budget-exceeded`. A timeout retries the
same route, up to its `maxAttempts`, only when the dispatch itself reported a
`timeout` failure with a known cost. A hung dispatch that the runtime aborts
at its attempt deadline has no known cost, so the run stops with
`cost-unknown`. Circuit failures move to the next route.
Other failures stop the run, and cancellation stops before the next attempt
and aborts an attempt in flight.

Every path after policy validation returns a receipt. Hook failures are
contained:

- a throwing `reserve` counts as a denial;
- a throwing `dispatch` is recorded as `rejected`;
- a failing `timer` counts as a timeout;
- a throwing `release` keeps the charge in the receipt;
- a throwing `evidence` callback makes the counterfactual `review`.

Any other runtime failure, such as an invalid clock, gives a `runtime-error`
receipt that keeps every attempt already recorded. The clock is read before
reserving, so a granted reservation is always released. An invalid policy
throws `RoutingContractError` before any hook runs.

## Jev evidence (counterfactual only)

Jev evidence is bounded task-fit evidence. It is not a calibrated probability
that a routed model will succeed. Jev receives only:

- the task ID;
- the D10 projection of `task.state`, with credential-shaped values redacted by
  the governance redactor;
- the projection evidence;
- sanitized summaries of the eligible routes.

`task.description` is never sent to Jev. The authoritative outcome is
recorded before the evidence call, and the call cannot delay the receipt past
the task deadline:

- it is not started once the task deadline has passed (`not-evaluated`,
  `deadline-exhausted`);
- it is cut off at the remaining task time, capped by the policy deadline
  (`review`, `jev-evidence-timeout`);
- the caller's abort ends it at once (`not-evaluated`, `cancelled`);
- the request carries a `signal` that is aborted in both cases;
- a failure while evaluating the counterfactual marks only the counterfactual.

The evidence must match the closed evidence schema. Every number must be
finite and within [0, 1], and `model` must equal the projection's model. The
calibration must be `calibrated` (`calibrationRequired` is fixed to `true`),
and the profile must be compatible. There must be exactly one distribution for
each eligible route, with no unknown or duplicate IDs. Anything else makes the
counterfactual `review`. If the quantized ambiguity is above
`uncertaintyThresholdBps`, the counterfactual is `deterministic-fallback`
instead.

Otherwise, deterministic utility ranks the routes, with ties broken by route
ID. The result does not depend on the order in which the evidence or
candidates arrive, and the policy digest is independent of candidate order.
The receipt stores the evidence with its distributions sorted by route ID.

## Shadow report

`freezeRoutingPreregistration` pins the policy, the baseline arm, the paired
held-out task set with each task's slice, and every threshold before any
holdout access. The thresholds are:

- minimum total and per-slice paired N, with floors of 30 and 10;
- the paired CI method (`newcombe-10` or `tango`) and level in basis points;
- the quality non-inferiority margin;
- maximum failure, rework, fallback and human-override rates;
- maximum p95 latency increase and provider calls per task;
- failure and human-override penalties;
- whether budget compliance and positive net economics are required.

`buildRoutingShadowReport` needs a separately trusted preregistration digest,
checked the same way as for `evaluatePreregisteredBinaryBenchmark`. It returns
PROMOTE only when all of these hold:

- `registeredAt < holdoutAccessedAt <= evaluatedAt`;
- every registered task is observed exactly once in each arm, with its
  registered slice;
- the sample floors are met in total and in every slice;
- the lower bound of the shared `pairedBinaryDifferenceInterval` is at or above
  the margin under `pairedNonInferiority`. A point estimate never passes.
- every rate, latency and provider-call gate passes;
- budget compliance holds. It is computed from each task's actual attempt spend
  against its budget, plus policy violations.
- risk-adjusted net savings against the baseline are positive. Risk-adjusted
  cost is attempt spend including failed and rerouted attempts, plus rework
  cost, plus the failure and override penalties.
- the shared `integrityMetadataFindings` (#2611) are empty, and the integrity
  `sample_n` equals the paired N.

The decision comes from `ensembleIntegrityDecision`, so an upstream `HOLD` or
`ROLLBACK` is never upgraded. The report carries its observations, and
`validateRoutingShadowReport(report, trustedDigest)` rebuilds it and requires
canonical equality. A forged decision with a recomputed digest is therefore
rejected.

## Control drill

`runRoutingControlDrill` resolves drift through D17 `executeDriftResponse`:

- Every response except `alert` opens the Jev route circuit through the
  host's `RoutingPolicyControl`.
- `restore-champion` first does the reversible step: it restores the prior
  pinned routing policy for new runs and verifies that it was installed. It
  then runs D17 `rollbackChampionForNewRuns`, which refuses unless the alias
  currently holds this record's promotion. If D17 refuses, the policy restore
  is reversed.
- Any failure throws `RoutingControlDrillError`. Its `state` reports whether the
  Jev circuit is open, whether the policy was restored, whether the alias was
  rolled back, whether compensation ran, the current policy, and `consistent:
  false` when the policy and the alias disagree (for example when compensation
  itself fails).
- Active-run pins are read again after the response and must equal the pins
  read before it; a mismatch throws `RoutingControlDrillError` whose `state`
  carries the before (`activeRunPinsBefore`) and after (`activeRunPinsAfter`)
  pins beside the circuit, policy and rollback state.

## Pending external inputs

Offline tests and the addon example cover the properties above. The following
remain open:

- live Jev calls;
- a representative held-out corpus and its trusted preregistration anchor;
- human reviewer and operator approval;
- production telemetry;
- security/privacy review;
- any advisory or canary mode that would execute a Jev-assisted choice.

Routing privileged, irreversible or high-risk work from model evidence is out
of scope without those additional gates.
