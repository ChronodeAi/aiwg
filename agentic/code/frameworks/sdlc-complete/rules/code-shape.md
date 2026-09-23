---
enforcement: high
triggers:
  - "code shape"
  - "file too large"
  - "function too complex"
  - "split this file"
  - "complexity threshold"
---

# Code Shape

## Checkers (binding)

Keep the toolchain floor per `strict-toolchain`. Before hand-off run `aiwg run skill codebase-health -- --base <base-ref> --architecture --meta --ci`. It fails when a changed function is new past both p90 bands or worsens past either; when above-band functions in the changed set increase; when a contract fails or frozen edges grow; when bands, suppressions or evaluator surfaces change outside an ADR-cited evaluator-change commit. Legacy is baselined by base-ref delta; the config that judges a PR is the one on the base branch. On FAIL fix the code, never the gate. No `.aiwg/quality/gate.json` → run `-- --calibrate --write` and land it alone citing an ADR. CI: `templates/deployment/code-shape-gate.github.yml` (or `.gitea.yml`).

## Volume

The diff is the budget: no unrequested functionality, no speculative abstraction, no duplicate helper (search first, cite the existing one). Adjacent structural work → separate tidy commit or filed issue.

## File growth

A file above the file-LOC p90 band may grow only with a `File-Growth: <path> — <reason>` trailer naming its responsibility; splitting to dodge the band does not satisfy this.

## Conventions (not gates)

Greppable specific names (no `utils`/`helpers`/`common`/`misc`); one-line purpose statement per file; direct imports (barrel `index` only as a package facade); composition over deep inheritance.

## Judgment

Extract-or-not, duplicate-or-abstract and split tests live in the Code Reviewer agent and the `decompose-file` skill.

## References

- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/skills/codebase-health/SKILL.md
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/executable-feedback.md
- @$AIWG_ROOT/agentic/code/frameworks/security-engineering/rules/strict-toolchain.md

---

**Rule Status**: ACTIVE
