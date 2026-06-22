# Evaluator Immutability

## Rule

The evaluator must be outside the producer's edit surface. This includes code, data, criteria, policy,
credentials, signing keys, and any wrapper that transforms evaluator output into a verdict.

## Minimum Review

- Identify every file or service that can affect the verdict.
- Prove the candidate cannot edit those surfaces.
- Prove policy and protected-set definitions cannot be widened by the candidate.
- Prove the evaluator runs from a trusted baseline or independent deployment.
- Prove promotion requires a verdict bound to the candidate tree or artifact being promoted.

## Failure Smell

A held-out evaluator is not held out if the candidate can rewrite its corpus, oracle, import path, policy,
or result parser.
