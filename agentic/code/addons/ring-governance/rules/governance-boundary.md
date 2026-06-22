# Governance Boundary

## Rule

Governance-defining surfaces must be inventoried, protected, and reviewed before any autonomous or
semi-autonomous agent can propose changes near them.

## Protected Surface Classes

- evaluator and verifier code
- criteria, rubrics, benchmark corpora, and answer keys
- policy files and capability-token rules
- arming floors, thresholds, and promotion gates
- protected-set definitions and allowlists
- CI/workflow gates that decide pass/fail
- audit-chain and verdict-signing paths

## Review Guidance

Duplicate protected inventories are allowed only when tests prove they agree. If two lists define what is
safe to edit and they can drift independently, the governance boundary is not trustworthy.
