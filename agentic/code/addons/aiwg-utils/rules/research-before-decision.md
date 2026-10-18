---
enforcement: high
triggers:
  - "which library should I use"
  - "why does this keep failing"
  - "I am guessing at this api"
  - "before I decide"
activation: kernel
---

# Research Before Decision Rules

- Before every technical decision/action or code change, MUST identify needed knowledge, search/read relevant sources, extract facts, reason from evidence, act, and verify success. Skipping investigation and jumping to action is FORBIDDEN.
- MUST check API signatures/types/docs/source; actual configuration values; existing dependencies and project patterns before technology choices; full errors and relevant source before diagnosis; directory listings/globs before assuming file structure; actual exports before imports; existing tests before test patterns; and type definitions before schemas/interfaces. Guessing endpoints, parameters, defaults, paths, function names, or interfaces is FORBIDDEN.
- MUST read error messages completely, verify suggested paths, and follow existing structure, middleware, and error-handling conventions before creating new code.
- On failure, MUST investigate root cause through source, docs, or diagnostics before a single informed retry; blind variations are FORBIDDEN. Three or more sequential failed attempts in one category without intervening search/read MUST trigger: stop → research → understand root cause → one informed attempt.
- In TAO, Thought MUST identify research needs, Action MUST search/read before modification, and Observation MUST extract facts for the next action. Thought → Edit → Error without Read/Search/Grep is a violation.

Supporting rationale and examples: [research-before-decision-guidance](./research-before-decision-guidance.md) (`aiwg show rule research-before-decision-guidance`, on-demand).
