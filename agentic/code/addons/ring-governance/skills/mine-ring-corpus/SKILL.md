---
namespace: ring-governance
name: mine-ring-corpus
platforms: [all]
description: Mine the archived Ring workspace as evidence for future AIWG governance addon work without directly porting Ring code.
triggers:
  - mine ring corpus
  - inventory ring before archive
  - ring migration inventory
  - ring archive baseline
---

# Mine Ring Corpus

Use this skill to continue the Ring archive and migration inventory.

## Required Baseline

Start from:

`.aiwg/reports/ring-mining-baseline-2026-06-22.md`

If working outside the original Ring checkout, ask for the Ring source path before continuing.

## Mining Categories

- trusted-core guards
- candidate verification and grader boundary
- evolution/genome/evo-hq adapter
- self-harness controller
- AIWG bridge and policy
- Fortemi memory boundary
- execution/supervisor/routing/hooks/research/observability archive surfaces

## Dispositions

Use exactly these labels:

- `migrate-candidate`
- `reference-only`
- `defer`
- `archive-only`
- `discard-candidate`

## Constraints

- Do not copy Ring code into AIWG.
- Do not mutate the Ring checkout.
- Do not treat runtime state as in-scope unless the user explicitly asks for it.
- Prefer evidence-backed inventory over broad summary.

## Output

Produce a concise table of newly mined artifacts, disposition, evidence path, and rationale.
