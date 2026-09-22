<!-- markdownlint-disable MD013 MD060 -->

# Implementation, qualification, and migration plan

This file preserves the reviewed P1–P7 dependency plan for #2573. P1–P6 and
the code/documentation portion of P7 are implemented in the normalized
decision runtime and `decision-engine` addon. Live calls remain opt-in, and
task-specific model-quality qualification remains an operator rollout gate
rather than a claim made by fixture-based CI.

## Ordered work packages

| ID | Depends on | Work and proposed targets | Exit evidence |
|---|---|---|---|
| P1 | This baseline | Add versioned schemas to `schemas/decision/`; generated TypeScript models and semantic validation in `src/decision/{types,validate,resolve}.ts`. Implement artifact pin/canonicalization, local-only embedded schemas, references, input projection and domain invariants. | All positive/negative schema cases plus semantic reference/pointer/domain fixtures pass; canonicalization vectors cover fractional numbers, Unicode and key ordering. |
| P2 | P1 | First-class artifact classifications and reference edges in `src/artifacts/`; package a `decision-engine` addon with `decision-evaluate` skill and authoring templates. Add discovery/list/show, schema-aware linting, trusted source resolution, stable catalog IDs. | Discover and show all three authored kinds, resolve a pinned artifact, detect shadowed/missing/conflicting identities. Existing skills/index queries unchanged. |
| P3 | P1 | Shared evaluator in `src/decision/{evaluate,predicates,compose,receipts}.ts`: three-valued predicates, composition/conflicts, input snapshots, acceptance profiles, retry/fallback ownership, deadlines, accounting and atomic receipts. | C08–C13, C16–C24, C27–C29, C32–C36 tested with fake clock/adapters and deterministic fixtures. No credential or external service needed. |
| P4 | P3 | `src/decision/adapters/jev.ts`: transport, capability limits, credentials resolver, response normalization, status mapping and usage. Start with one evaluation per call; batching separately qualified. | Recorded/synthetic Choice, fractional Score and Noul fixtures pass; 401/422 non-retry and 429/529 bounded retries tested. Explicit opt-in live smoke passes from scoped vault reader. |
| P5 | P3 | `src/decision/adapters/llm-subagent.ts`: actual dispatch/RunWorker seam, fixed structured-output prompt, tool-disabled bounded worker, cancellation/terminal observation and strict parser. | Worker start/terminal receipts plus valid result; plan-only worker rejection; malformed/prose responses rejected; uncertainty stays uncalibrated/absent. |
| P6 | P2,P4,P5 | Bridge through existing FlowGraph skill node and invocation/receipt identities. Project ceilings and external binding selection; graph retry=0 for this dispatcher. | Same graph/ruleset/definitions/consumer run against both bindings. One digest per shared definition; only binding differs. Provenance distinguishes all attempts. Downstream action still independently authorized. |
| P7 | P6 | Qualification and opt-in rollout; `docs/decision/`, addon docs, examples, changelog, operational reader wiring through itops. | Contract suite green; held-out quality evaluation accepted for intended use; disabled-feature regression passes; scoped credentials confirmed; documentation accurately distinguishes implemented capability and limitations. |

Expected complexity: P1/P3/P5 highest risk; P2/P4/P6 medium. No calendar estimate substitutes for the gates. P4 and P5 may proceed independently after P3; neither is a prerequisite for portable schema design. P7 must not proceed on schema-only validation.

## Qualification strategy

| Layer | Inputs | Required check |
|---|---|---|
| Schema | Every example and deliberate malformed variant | Compile draft 2020-12, closed-world authoring, conditional fields, unknown keys, finite values. |
| Semantics | `fixtures/conformance.json`, fake clock, fake transport/worker | Result domains, reference integrity, three-valued logic, ordering, conflict, failure/abstention, budgets, cancellation, receipts. |
| Adapter contract | Same portable definitions, backend-native fixture responses | Typed result equivalence; explicit unsupported capabilities; never identical-output assumptions. |
| Graph integration | Existing FlowGraph runtime test seam and valid catalog | External binding swap, correct outputs/usage, replay before inference, no multiplied retry budgets. |
| Security/operations | Synthetic state with hostile instructions and failing secret resolver | No state-driven permissions, no tools, no secret/locator in captures, deny before egress, sanitized errors. |
| Live transport | Opt-in synthetic Jev request and one actual subagent task | Actual model/output, usage/terminal record, error handling, credential custody; bounded calls. |
| Task quality | Curated held-out routing/scoring set with ambiguous and adversarial examples | Report accuracy, abstention/coverage, calibration separately by profile, latency and cost. Select task-specific gates before measurement. |

Planning validation command: `python3 validate.py`. It validates this package only. Implementation adds meaningful Vitest tests under `test/unit/decision/`, then runs existing composition/index regressions, typecheck/build and repository-required delivery checks. A live API call is opt-in; default CI has no TypeSafe account or paid calls. Never report mocked subagent results as a live execution.

## Rollout and rollback

1. Land schemas/resolver and addon behind explicit opt-in configuration. No existing workflow changes. Publishing schemas does not enable inference.
2. Install a dispatcher skill and discover a real stable index ID. Add an opt-in example graph using current schema fields; put binding selection in caller configuration. Do not check in made-up stable catalog IDs as executable examples.
3. Run shadow evaluation on synthetic/approved inputs, returning outcomes as data only. Compare Jev and LLM results under their own uncertainty profiles. Collect task-quality evidence without taking automated actions.
4. Qualify a bounded routing use case. Enable only that workflow/binding after ordinary policy checks; preserve former behavior as the explicit rollback target.
5. Expand only after per-task evaluation. Existing lint rulesets and other workflows are never mass-converted.

Rollback: disable the decision skill invocation or restore the prior pinned binding at a run boundary; cancel in-flight attempts and preserve receipts. Do not change a binding underneath an active run, delete historical definitions, or replay side effects. A backend swap uses a newly pinned binding/run; definition pins stay fixed. Unsupported capability is reported before any call. Old API validators remain available for historical receipts.

## Risks and dispositions

| Risk | Disposition |
|---|---|
| Vendor confidence mistaken for correctness | Source/profile/calibration in result; acceptance is profile-specific; benchmark calibration separately. |
| Normal LLM number treated as calibrated Jev probability | Label as model self-report; never inherit Jev acceptance implicitly. |
| Partial/plan-only subagent implementation | Require actual terminal/output evidence; `executor-unavailable` otherwise. |
| Retry multiplication or hidden cost | One owner, global attempts/deadline, unknown cost explicit, conservative price bound for monetary ceilings. |
| External input becomes instruction/authority | Data separation, no tools for worker, trusted definitions, independent action policy. |
| Corpus control artifacts confused with runtime storage | Honor artifact-root routing; no new storage subsystem; use existing activity/provenance facilities. |
| Schema/index drift | New kinds/filters/validators/help/fixtures delivered together; old consumers reject unsupported versions. |
| Vendor API changes | Pinned adapter/version and actual model receipts; current limits verified at implementation and periodic qualification. |

## Operational handoff

The Jev key was vaulted and round-trip verified before the synthetic call. The one-time import used the itops explicit administrative induction path because no applicable internal maintainer bootstrap was present; production runtime must use a least-privilege reader, not root. Store its logical credential reference in binding, inject actual locator/field at deployment, and test exact-read plus adjacent-secret denial. Reader provisioning and routine runtime wiring are P7 work, not prerequisites for completion of this specification. The operator source file is retained with mode 0600; no destructive custody cleanup was performed.

Per itops secret SOP, metadata catalog is the authoritative per-secret record; no leaf secret or path goes into DATAGERRY. This operation added a vault entry, not a host/service deployment, so existing CMDB deployment/mount records need no per-secret object.

## Completion boundaries

This planning task completes when the six planning requirements map to reviewed artifacts, schemas/examples validate, reference/domain checks pass, a concrete implementation breakdown exists, and Jev key custody has been verified before any use. #2573 remains open until P1–P7 implementation gates pass. The source-code adapters, actual LLM qualification, rollout and changelog release entry are explicitly outstanding product work.
