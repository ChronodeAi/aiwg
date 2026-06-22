---
namespace: ring-governance
name: evolution-surface-review
platforms: [all]
description: Review an evolution/search adapter such as evo-hq, AlphaEvolve-style search, or a native optimizer for governance boundaries before integration.
triggers:
  - evolution surface review
  - evo-hq governance review
  - optimizer adapter review
  - genome engine review
  - self improvement adapter review
---

# Evolution Surface Review

Use this skill when an optimizer, proposer, or search harness generates candidate changes.

## Process

1. Fill out `templates/evolution-adapter-card.md`.
2. Identify what the proposer can read and write.
3. Identify evaluator, criteria, policy, population/frontier state, and promotion owner.
4. Apply `evaluator-immutability` and `no-self-grading`.
5. Decide whether the adapter is:
   - `reference-only`;
   - `prototype`;
   - `candidate-for-executable-extraction`.

## Required Questions

- Can the proposer edit the evaluator, criteria, policy, or promotion path?
- Is population/frontier state bounded and governance-owned?
- Is verifier output bound to the candidate artifact?
- Are criteria plural or rotatable enough to resist overfitting?
- Is memory used only as context/provenance?

## Output

Return a verdict with required closures before integration.
