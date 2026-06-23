# Evaluator Immutability

**Enforcement Level**: HIGH
**Scope**: Evaluators, verifiers, LLM judges, judge prompts, calibration data, criteria, rubric data,
policies, result parsers, credentials, signing keys, and promotion wrappers.
**Addon**: ring-governance
**Status**: DRAFT

## Rule

The evaluator must be outside the producer's edit surface. This includes code, data, criteria, policy,
credentials, signing keys, and any wrapper that transforms evaluator output into a verdict.

## Definitions

- **Producer**: The agent, optimizer, harness, generated worker, or candidate branch proposing work.
- **Evaluator**: Any code, service, data, rubric, policy, or human workflow that turns evidence into a
  pass/fail, approve/reject, promote/hold, or arm/disarm decision.
- **Verdict binding**: A recorded link between the evaluator result and the exact candidate artifact,
  commit, tree, build, or release being judged.

## Minimum Review

- Identify every file or service that can affect the verdict.
- Prove the candidate cannot edit those surfaces.
- Prove policy and protected-set definitions cannot be widened by the candidate.
- Prove the evaluator runs from a trusted baseline or independent deployment.
- Prove promotion requires a verdict bound to the candidate tree or artifact being promoted.
- For LLM-as-judge evaluators, prove the validation package is protected and current for the task
  family being judged.

## Required Controls

- Evaluator inputs, criteria, corpora, and result parsers must be versioned or otherwise attributable.
- Candidate code must not control evaluator import paths, environment variables, plugin loading, or
  result parsing.
- Candidate code must not control judge prompts, calibration cases, answer ordering, threshold floors,
  or bias-audit logic.
- Promotion must fail closed when verdict binding is missing or ambiguous.
- Any evaluator change must be reviewed as governance-surface work, not ordinary feature work.

## Failure Smell

A held-out evaluator is not held out if the candidate can rewrite its corpus, oracle, import path, policy,
or result parser.
