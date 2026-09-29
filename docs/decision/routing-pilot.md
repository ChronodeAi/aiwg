# Routing pilot

The D28 routing pilot is experimental and default-off/shadow-only. It chooses
among route candidates that have already passed deterministic hard-constraint
checks. The public APIs are `runRoutingPilot`, `validateRoutingPolicy`,
`buildRoutingShadowReport` and `runRoutingControlDrill`.

The runtime evaluates privacy, authorization, region, tools, context, allowlist,
budget, deadline, health and executable status before any Jev evidence callback.
Only still-eligible sanitized route summaries and D10-projected task state are
sent to the injected evidence provider.

Jev evidence is bounded task-fit evidence, not a calibrated probability of task
success. It cannot add route IDs, grant permissions, change prices, override
health, authorize execution or optimize cost directly. Unknown route IDs,
incompatible profiles, uncalibrated evidence when calibration is required,
projection denial, empty eligible sets and missing evidence all route to review
or no-route without dispatch.

The receipt records route pins, eligibility and sanitized exclusion reasons,
Jev provenance and distributions, selected route, policy version, actual
worker/model, attempts/fallbacks, usage/cost and verified outcome. Fallbacks
after outage, rate-limit, timeout or circuit-open responses walk only
already-eligible routes and honor max attempts, max fallbacks and deadlines.
Unknown cost is never treated as zero.

`buildRoutingShadowReport` scaffolds held-out comparison across fixed,
heuristic and Jev-assisted arms. It applies preregistered total/per-slice sample
requirements, CI method/level metadata, quality non-inferiority, failure,
rework, fallback, budget and positive net-economics gates. Net economics are
savings against the baseline after failed and rerouted attempts.

The report embeds #2037/#2048 eval-integrity fields and preserves
`PROMOTE`/`HOLD`/`ROLLBACK`; routing cannot upgrade integrity `HOLD` or
`ROLLBACK`.

`runRoutingControlDrill` reuses D17 champion/challenger and drift-response APIs:
active runs are pinned with `pinChampionForRun`, drift is resolved through
`executeDriftResponse`, and rollback for future runs delegates to
`rollbackChampionForNewRuns`. Active run pins stay unchanged.

Offline tests and the addon example cover deterministic routing properties,
receipts, fallback bounds, promotion gates and D17 drill plumbing. Live Jev
calls, representative held-out data, human reviewer approval, production
telemetry and security/privacy rollout approval remain pending external inputs.
