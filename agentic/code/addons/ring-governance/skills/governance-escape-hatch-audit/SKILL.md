---
namespace: ring-governance
name: governance-escape-hatch-audit
platforms: [all]
description: Audit an agent, harness, optimizer, or governance workflow for loopholes that let the producer alter its own judge, policy, criteria, or promotion path.
triggers:
  - governance escape hatch audit
  - find governance loopholes
  - audit self grading
  - reward hacking audit
  - evaluator immutability review
---

# Governance Escape-Hatch Audit

Use this skill when reviewing a system where an agent or optimizer can propose changes and a governance
surface decides whether those changes are accepted.

## Process

1. Identify the producer, grader, policy engine, criteria, promotion path, and memory/context surfaces.
2. Fill out `templates/protected-surface-inventory.md`.
3. Apply the rules:
   - `no-self-grading`
   - `governance-boundary`
   - `evaluator-immutability`
   - `judge-validation-protocol`
   - `memory-is-not-proof`
4. Search for loopholes:
   - candidate edits evaluator or benchmark corpus;
   - candidate widens patchable surface;
   - policy YAML or capability tokens are mutable;
   - LLM judge uses raw agreement as proof without chance-corrected agreement, retest, task-family
     transfer, and bias-audit evidence;
   - candidate can edit judge prompt, calibration corpus, answer order, result parser, or validation
     thresholds;
   - advisory events are treated as proof;
   - memory recall is treated as acceptance;
   - generated docs claim a gate is active before code proves it.
5. Produce findings ordered by severity.

## Output

Include:

- summary verdict: `blocked`, `revise`, or `acceptable-with-residual-risk`;
- protected surfaces;
- exploit path for each finding;
- concrete closure test or rule.

Do not propose executable autonomy until high-risk loopholes are closed.
