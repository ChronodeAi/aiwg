# Grok Bot Linux PUW — issue #210

**Date:** 2026-09-16 (America/New_York)  
**Host:** Linux box (`uname -a` below)  
**AIWG version:** 2026.9.15  
**Git SHA (main base):** `f676fe27d28686e6e6c286b03ff420154f08db38` (merge of #211)  
**Branch evidence:** `chore/210-promote-grokbot-stable`  
**Operator skill root:** absolute temp dir via `AIWG_GROKBOT_SKILLS_DIR` (never invented `~/.grokbot` / `~/grokbot-skills` / `.cursor/`)

## Environment

```text
Linux cursor 6.12.94+ #1 SMP PREEMPT_DYNAMIC Tue Sep  8 16:09:32 UTC 2026 x86_64 GNU/Linux
```

Artifact root on the box: `/workspace/aiwg-210-puw/` (logs/, artifacts/).

## Commands and exit codes

| Step | Command | Exit |
|---|---|---|
| Build CLI | `npm run build:cli` | 0 |
| Fail-closed unset | `aiwg use all --provider grokbot --scope user --dry-run` (no `AIWG_GROKBOT_SKILLS_DIR`) | 1 (blocked) |
| Fail-closed relative | `AIWG_GROKBOT_SKILLS_DIR=relative/skills … --scope user --dry-run` | 1 |
| Fail-closed bare `~` | `AIWG_GROKBOT_SKILLS_DIR='~' … --scope user --dry-run` | 1 |
| Tilde-prefix expand | `AIWG_GROKBOT_SKILLS_DIR='~/grokbot-skills' … --scope user --dry-run` | 0 (ADR: `~/` expands; dry-run only) |
| Project dry-run + env | `AIWG_GROKBOT_SKILLS_DIR=<abs> aiwg use all --provider grokbot --dry-run` | 0 |
| User dry-run + env | `… --scope user --dry-run` | 0 |
| Project deploy + env | `… aiwg use all --provider grokbot` | 0 (after #210 verify fix) |
| User deploy + env | `… --scope user` | 0 (registry recorded 26 skills) |
| Bridge-only project | unset env; `aiwg use all --provider grokbot` | 0 (AGENTS.md / WORKSPACE.md / AIWG.md only) |
| Doctor | `aiwg doctor --provider grokbot` | 0 (WARN only; 28 passed) |
| Live smoke | `AIWG_GROKBOT_LIVE_SMOKE=1 npm run smoke:grokbot:live` | 0 (`LIVE_CHECKS_PASSED`; `wroteCursor=false`; `wroteInventedHome=false`) |
| Vitest | `vitest run test/unit/providers/grokbot-provider.test.ts test/unit/sessions/grokbot-adapter.test.ts test/unit/cli/deployment-verification.test.ts` | 0 (22+ tests in verification file; grokbot provider/session suites green) |

## Containment checks

- No `.cursor/` writes under the PUW project (`cursor-after-deploy.txt` empty).
- Skills files only under the configured absolute root (`skills-containment.txt`: `outside=0`, 54 files with markers).
- No `~/.grokbot` or `~/grokbot-skills` invented by AIWG.
- User registry (`AIWG_USER_REGISTRY_PATH` isolated for PUW) recorded `grokbot` with 26 skill entries after `--scope user`.

## Platform coverage note

**Linux required evidence: attached.**  
macOS and Windows/WSL PUW were **not** run this cycle (Cloud Agents unavailable; this box is Linux only). Provider status remains **experimental** until those platforms are evidenced as applicable per ADR / #210.

## Log index

- `logs/build-cli.log`, `logs/build-cli-after-fix.log`
- `logs/fail-closed-*.log`
- `logs/project-dry-run.log`, `logs/user-dry-run.log`
- `logs/project-deploy-fixed.log`, `logs/user-deploy-fixed.log`
- `logs/bridge-only-project.log`
- `logs/doctor-grokbot-fixed.log`
- `logs/smoke-grokbot-live.log`
- `logs/vitest-grokbot.log`, `logs/vitest-verification.log`
- `artifacts/*`
