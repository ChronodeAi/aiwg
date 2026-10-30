# Evaluator evidence and calibration

Agreement is not proof. Same-vendor and cross-vendor models can share errors;
observed family diversity is a selection constraint, not statistical independence.
Consequential claims require an executable check against the acceptance criteria
or explicit acceptance by an accountable human. Record the check or acceptance
reference and retain unresolved disagreements.

When using multiple reviewers, prefer independent voting (commit initial answers
before exposing others' judgments), or structured review with diverse initial
answers and confidence calibrated against ground truth, over plain debate.
Preserve initial answers, revisions, dissent and the final acceptance basis.
Do not claim reduced human-review time from the papers below.

## Existing review owners

The #3316 inventory searched `src/`, `schemas/`, `agentic/code/` and `docs/`, then
checked the repository for delegation-brief/final-review gate terminology:

| Surface | Existing owner and extension |
| --- | --- |
| Durable review | `schemas/decision/DecisionReview.schema.json`; `src/decision/review/{types,validate,service,store}.ts`. Each decision can carry `evaluation`; it is bound to the matching append-only event. |
| Test review and findings | `agentic/code/addons/testing-quality/schemas/test-review.v1.schema.json`, `lib/{contracts,assessment,workspace}.mjs`, and `templates/test-review.md`. `spec.evaluation` survives the existing artifact builder, document loader and create-only writer. Findings retain their existing status/severity fields. |
| Qualification approval | `QualificationReviewRecord` in `src/decision/qualification/gate-evidence.ts`. Optional `evaluation` is validated and retained by the existing qualification runner's digest-bound artifact copy. |
| Study review | `schemas/decision/D17StudyReview.v1.schema.json` and comparative-replay review packets hold human study judgments; preserve their study-specific ground-truth protocols. |
| Model selection | `src/models/resolver.ts`: `reviewOf` and `requireDifferentFamily` require unambiguous observed lineage. `src/smiths/context-pipeline/parallelism-section.ts` emits the guidance. |
| Orchestration guidance | SDLC `rules/sdlc-orchestration.md`, `skills/artifact-orchestration/SKILL.md`, `agents/code-reviewer.md`, orchestrator architecture docs, and aiwg-utils `prompts/core/multi-agent-pattern.md`. |

No separately named findings-ledger schema or #3167 delegation-brief/final-review
gate was present in this checkout. Do not infer that those gates ran from a model
resolution or a review verdict. This change extends existing review records.

## Recording a review

All added fields are optional so historical records remain valid. For new model
reviews, populate `evaluation.evaluatorModel`, `evaluatorVendor` and
`evaluatorFamily` from observed runtime identity; never infer them from CLI names
or requested aliases. Omit unavailable facts or record `unknown` explicitly.
Human-only acceptance can omit model identity.

Record `acceptanceCriteriaRef` as the exact criteria document/version or digest
reference. `disagreements` lists `claimRef`, `generatorPosition`,
`evaluatorPosition`, and optional `resolutionRef` pointing to the executable check
or human acceptance. An empty list means no recorded disagreements, not proof of
correctness. After material fixes, create a new review with fresh source/outcome
bindings and set `reReviewOf` to the earlier review/decision reference; retain the
old evidence. A pending durable review can instead append a new proposal and a
fresh decision referencing its earlier decision. Existing approvals do not cover
an edited proposal.

Use `DecisionReviewService.decide(scope, id, decision, rationale, evaluation)`;
metadata is stored with that evaluator's decision and event. Test review builders
pass it in `spec.evaluation`; qualification approvals use top-level `evaluation`.
This metadata does not authenticate model identity, satisfy human quorum, or
execute checks by itself. Store only approved projections/references, never raw
private reasoning or credentials.

## Calibration procedure

Keep one report per exact evaluator configuration using the template below in
the configured artifact store, alongside existing evaluation reports. Resolve the
artifact root through `aiwg artifacts path --json --check-write` before writing.
This is a procedure and blank template; no evaluator is calibrated by this change.
Use authorized cached outputs or synthetic fixtures for an offline rehearsal;
paid calls are not part of this procedure's implementation.

1. Freeze the evaluator model snapshot, observed vendor/family, prompt and rubric
   hashes, tools/retrieval context, decoding settings and acceptance threshold.
   Pin the generator configuration separately. Any material change requires a new
   report; do not pool configurations.
2. Pin a held-out set and ground-truth version/digest with an executable oracle or
   independent human adjudication. Separate development/tuning data from this
   set. Define task slices, correctness rules, abstention handling, minimum sample
   sizes and release thresholds before inspecting outcomes. Hide labels from both
   models and reviewers until their judgments are committed.
3. Preserve generator answers and blind evaluator initial answers against the
   same items, before showing generator answers or other reviewers' votes. Then
   record evaluator accept/reject/abstain judgments of generator output separately.
   Keep per-item correctness labels, wrong-answer identities and disagreements.
   Do not substitute agreement for ground truth.
4. Report the paired correctness table overall and per slice. With G = generator
   wrong and E = evaluator initial answer wrong, report `P(E | G) = n(G and E) /
   n(G)`, plus `P(same wrong answer | G and E)` for discrete answers under a
   preregistered equivalence rule. Also report `P(evaluator accepts | G)` as the
   false-acceptance rate; it is a different measurement. Include counts,
   denominators, uncertainty method/intervals, missing data and abstentions.
   A zero denominator is undefined; small samples cannot establish independence.
5. Compare against the frozen thresholds, record failed slices and limitations,
   link executable checks and human disposition, and set the report's status.
   Hold consequential use when evidence is insufficient. Recalibrate after model,
   prompt, rubric, tool, threshold or task-distribution changes. Link each material
   fix's re-review to the previous review and its applicable calibration report.

## Blank report template

Copy this block once per configuration. Leave measurements blank until observed;
never fill them with example numbers or paper results.

```yaml
status: not_run
report_ref:
evaluator_configuration:
  observed_model_snapshot:
  observed_vendor:
  observed_family:
  prompt_hash:
  rubric_hash:
  tools_and_context_hash:
  decoding_settings:
  acceptance_threshold:
generator_configuration_ref:
held_out_set:
  reference_and_digest:
  ground_truth_reference_and_digest:
  oracle_or_human_adjudication:
  development_split_exclusion:
  blinding_and_initial_answer_commitment:
preregistered_rules:
  task_slices:
  correctness_and_wrong_answer_equivalence:
  abstentions_missing_and_exclusions:
  minimum_sample_sizes:
  acceptance_thresholds:
  uncertainty_method:
paired_counts: # Repeat overall and per slice; no measured numbers supplied.
  slice:
  both_correct:
  generator_wrong_evaluator_correct:
  generator_correct_evaluator_wrong:
  both_wrong:
  same_wrong_answer:
  generator_wrong_evaluator_accepts:
  abstentions_and_missing:
metrics: # Record numerator, denominator, estimate and interval for each.
  evaluator_accuracy:
  evaluator_error_given_generator_error:
  same_wrong_answer_given_both_wrong:
  false_acceptance_given_generator_error:
  confidence_calibration_if_used:
per_item_evidence_ref:
disagreements_and_resolution_refs:
executable_check_refs:
human_acceptance_or_hold_ref:
limitations_and_failed_slices:
recalibration_triggers:
previous_report_and_re_review_refs:
```

## Research grounding and limits

[REF-2922, Correlated Errors in Large Language Models](https://doi.org/10.48550/arXiv.2506.07962)
finds correlated mistakes across vendors and judges accepting shared errors.
It motivates measuring conditional overlap rather than assuming independent errors
from vendor labels.

[REF-2923, Demystifying Multi-Agent Debate](https://doi.org/10.18653/v1/2026.findings-acl.1694)
compares majority voting and debate, and studies diversity of initial answers and
calibrated confidence. Its strongest interventions include trained confidence;
comparisons are not token-matched. The preference above is a review design policy,
not a measured AIWG performance improvement.

[REF-2919, Debating with More Persuasive LLMs](https://doi.org/10.48550/arXiv.2402.06782)
and [REF-2921, AI Debate Aids Assessment of Controversial Claims](https://doi.org/10.52202/085713-5666)
show human judgment benefits under their tested protocols, including same-vendor
advocates. They do not establish independent model errors or reduced human-review
time. REF-2921 uses a selected cohort and sequential phases; its reported review
times do not demonstrate a saving. These results do not certify a new evaluator
configuration or replace accountable acceptance.
