---
name: quality-gate-watcher
version: 1.1.0
description: Enforce SDLC quality gate criteria on commits and pull requests.
platforms:
- claude-code
- opencode
- warp
- openclaw
- codex
metadata:
  triggers:
  - watch quality gates
  - check gate criteria
  - enforce quality
  scope: daemon
inputs:
- name: phase
  type: enum
  values:
  - inception
  - elaboration
  - construction
  - transition
  required: false
  description: SDLC phase to validate gates for (auto-detected if omitted)
- name: strict
  type: boolean
  required: false
  default: false
  description: Fail on any unmet gate criterion (vs warn)
hooks:
  on_commit:
  - action: run_script
    script: scripts/check-commit-gates.sh
  on_pr_open:
  - action: run_script
    script: scripts/check-pr-gates.sh
scripts:
  main: scripts/main.sh
  check-commit-gates: scripts/check-commit-gates.sh
  check-pr-gates: scripts/check-pr-gates.sh
manifest:
  category: quality
  requires:
    bins:
    - node
  outputs:
  - type: report
    path: .aiwg/reports/quality/
  composable_with:
  - security-sentinel
  - test-watcher
---

# Quality Gate Watcher

Enforce SDLC quality gate criteria automatically on commits and pull requests.

## When Triggered via NLP

Run a full gate evaluation for the current or specified SDLC phase. Report which criteria are met, which are unmet, and what actions are needed to pass the gate.

## When Triggered via Hooks

### on_commit

Lightweight gate check on each commit:
- Verify conventional commit format
- Check that modified files have associated tests
- Validate no `.aiwg/` artifacts are stale relative to code changes

### on_pr_open

Comprehensive gate evaluation when a PR is opened:
- Run full phase gate criteria check
- Verify all required artifacts exist and are current
- Check test coverage thresholds
- Validate security review status
- Post gate status as PR comment
- Run the code-shape ratchet, contracts and evaluator meta-check (`aiwg run skill codebase-health -- --base "$BASE_REF" --architecture --meta --ci`) — blocking where the runner honours exit 1 (OpenClaw); CI enforcement uses the shipped workflow template (`templates/deployment/code-shape-gate.github.yml` / `code-shape-gate.gitea.yml`)

The code-shape step runs when `.aiwg/quality/gate.json` exists at the base ref or in the working tree (so deleting it in the PR cannot skip the check). It requires `aiwg` on `PATH` and `lizard` (`pipx install lizard`); a missing tool fails the check rather than skipping it.

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `PROJECT_ROOT` | `AIWG_PROJECT_DIR`, then `.` | Project root to check |
| `AIWG_PROJECT_DIR` | — | Project root set by the OpenClaw runner |
| `BASE_REF` | `origin/main` | Base ref whose `gate.json` judges the PR |
