---
namespace: aiwg
name: codebase-health
platforms: [all]
description: Run the change-scoped code-shape ratchet, import-contract check, evaluator meta-check, hotspot routing and band calibration against a base ref; use before handing off any code change
triggers:
  - "codebase health"
  - "code shape ratchet"
  - "check import contracts"
  - "calibrate code-shape gates"
  - "hotspot report"
  - "evaluator meta-check"
  - "is this function too complex"
script:
  entrypoint: scripts/health.mjs
  runtime: node
  cwd: project-root
  argsHint: "[--base <ref>] [--architecture] [--meta] [--history] [--calibrate [--write]] [--functions <file>] [--format text|json] [--ci]"
commandHint:
  argumentHint: "[--base <ref>] [--architecture] [--meta] [--history] [--calibrate [--write]] [--functions <file>] [--format text|json] [--ci]"
  allowedTools: 'Bash, Read'
  model: haiku
  category: code-analysis-testing
  modelRole: efficiency
  modelTier: economy
---

# Codebase Health

Mechanical code-shape gates. The script does the measuring (via `lizard`); do not re-grade code by absolute size in prose. Binding policy lives in the `code-shape` rule.

## Commands

```bash
aiwg run skill codebase-health -- --base origin/main --architecture --meta --ci   # before hand-off / in CI
aiwg run skill codebase-health -- --calibrate --write                             # create or refresh bands
aiwg run skill codebase-health -- --history                                       # hotspots and co-change pairs
aiwg run skill codebase-health -- --functions src/module.py --format json         # one file's function table
aiwg run skill codebase-health --                                                 # distribution report
```

Requires `lizard` (`pipx install lizard`) and git.

## Modes

| Flag | What runs |
|------|-----------|
| `--base <ref>` | Ratchet: changed files between the merge base and `HEAD`, base vs head per function |
| `--architecture` | `contracts.command` and the frozen-edge count (base vs head) |
| `--meta` | Evaluator immutability (requires `--base`) |
| `--history` | First-parent churn hotspots and co-change pairs — prioritisation only, not defect prediction |
| `--calibrate [--write]` | LOC-weighted p70/p80/p90 bands from this repo; `--write` persists them |
| none | Share of NLOC per band and the largest above-p90 functions |

Order: ratchet → architecture → meta → history. `--format json` emits `{mode, verdicts, shape, exceptions, summary}`.

## Bands

Bands are this repository's LOC-weighted percentiles (p70/p80/p90), printed beside the SIG CCN benchmark (6/8/14). Fewer than 200 functions → `UNDERPOWERED`, bands provisional. Blocking applies only to non-additive function metrics (NLOC, CCN); file LOC is advisory.

**The config that judges a PR is the one on the base branch.** With `--base`, every section reads `.aiwg/quality/gate.json` at that ref; editing it in the change cannot pass the check.

## Verdicts

| Code | Level | Meaning |
|------|-------|---------|
| `function-worsened` | FAIL | New function past both p90 bands, or a changed function worsened past either |
| `function-worsened` | WARN / NOTE | Worsened past p80 / p70 |
| `above-band-count-increased` | FAIL | More above-p90 functions across the changed set than at base |
| `split-mirage-candidate` | WARN | Function count rose ≥ 3 while `sum_ccn` did not fall |
| `file-growth` | ADVISORY | File above file-LOC p90 grew; `JUSTIFIED` by a `File-Growth: <path> — <reason>` trailer |
| `contracts` | FAIL | Contract command exited non-zero |
| `frozen-edges-increased` | FAIL | More frozen-edge lines than at base |
| `gate-config-removed` | FAIL | `gate.json` present at base, absent at head |
| `evaluator-surface-changed` | FAIL | Evaluator surface edited outside an evaluator-only commit citing an ADR on base |
| `band-loosened` | FAIL | Bands raised, lists shrunk, or other config changed without an accepted evaluator commit |
| `quality-step-suppressed` / `-removed` | FAIL | Workflow quality step made non-blocking or dropped |
| `suppression-unjustified` / `-unused` | FAIL | New `noqa`/`eslint-disable`/… in measured files (include/exclude apply) without a valid annotation; unused suppressions |
| `codeowners` | FAIL / WARN | Multi-owner CODEOWNERS missing evaluator surfaces / single owner |

Every changed file also prints `SHAPE <file> loc b→h functions b→h sum_ccn b→h max_ccn b→h`. Accepted evaluator commits print `EXCEPTION evaluator-change <sha> ADR-<id>`.

Suppression annotation (same line or line above):
`AIWG-allow:suppression owner="…" expires="YYYY-MM-DD" reason="…"`

## Exit codes

- `0` — pass (or report-only without `--ci`)
- `1` — `--ci` and at least one FAIL
- `2` — tool/config error: lizard missing, no merge base, no `gate.json` at base, HEAD or working tree for any mode but `--history`/`--calibrate`/`--functions`

## Bootstrap

No `.aiwg/quality/gate.json`: (1) ADR adopting code-shape gates → merge; (2) `aiwg run skill codebase-health -- --calibrate --write`; (3) commit `gate.json` alone with trailer `Evaluator-Change: ADR-NNN`; (4) CI step from `templates/deployment/code-shape-gate.github.yml` or `code-shape-gate.gitea.yml`.

## On FAIL

Fix the code, never the gate. Split along one named responsibility (`decompose-file`), reduce the function, or justify file growth with a trailer. Evaluator changes are human governance work: their own commit, an ADR already on base, a reviewer other than the author.

## Limitations

- Workflow scanning is line-wise over `.github/workflows` and `.gitea/workflows`; remote `uses:` reusable workflows are not inspected.
- CCN stands in for cognitive complexity.

## References

- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/code-shape.md — binding policy
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/skills/decompose-file/SKILL.md — responsibility-led splits
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/deployment/code-shape-gate.github.yml — CI template
