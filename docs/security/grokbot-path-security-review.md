# Grok Bot path security review (#210)

**Date:** 2026-09-16 (America/New_York)  
**Scope:** Path resolution and deploy writers for provider `grokbot`  
**Sources reviewed:** `src/providers/grokbot-paths.ts`, `src/cli/scope-resolver.ts` (`USER_SCOPE_PATHS.grokbot`), `tools/agents/providers/grokbot.mjs`, `src/skills/deployer.ts` (grokbot branch), `src/cli/services/deployment-verification.ts`, `tools/security/context-memory-firewall.mjs` (grokbot inventory), Linux PUW under `/workspace/aiwg-210-puw/`

## Threats considered

| Threat | Result |
|---|---|
| Path traversal via `AIWG_GROKBOT_SKILLS_DIR` | Mitigated: absolute-path requirement after optional `~/` expansion; NUL rejected; empty/root-only rejected |
| Invented home layout (`~/.grokbot`, `~/grokbot-skills`) as default | Mitigated: unset env fails closed for user-scope / global skill writes; no default home skill root |
| Deploy into `.cursor/**` | Mitigated: project bridge never targets `.cursor/`; deployer throws if configured root is a `.cursor` path |
| Relative skill root | Mitigated: relative values rejected with remediation |
| Bare `~` | Mitigated: rejected (would invent a home skill root) |
| Secret scrape (API keys, session tokens) | No code path reads Grok/xAI credentials for this provider; detection explicitly ignores generic `GROK_*` / xAI API env as Grok Bot evidence |
| Ownership overwrite of operator skills | Mitigated: managed markers / sidecars (`.aiwg-managed`); peer kernel routing preserves operator-owned trees; remove only recorded AIWG entries |
| Secret leakage in doctor/status output | Doctor/status print paths and counts; PUW live smoke asserted `wroteCursor=false` / `wroteInventedHome=false`; reports do not dump skill bodies |

## Absolute-root policy (observed)

1. **Unset** → user-scope / `--global` skill deploy blocks with remediation (`GROKBOT_SKILLS_DIR_UNSET` / CLI ERROR).
2. **Relative** → rejected (`not-absolute`).
3. **Bare `~`** → rejected.
4. **Leading `~/…`** → expanded against `homedir()` then treated as absolute (ADR-allowed). This is **not** the same as inventing `~/grokbot-skills` when unset.
5. **Absolute** → `path.resolve` + deploy only under that root (PUW containment: `outside=0`).

## Bugs found and fixed this cycle

1. **Project-scope verification false failure** — definition keeps `artifacts.skills: null` (fail-closed sentinel), so verification reported `provider-artifacts-missing` even when `AGENTS.md` bridge landed. Fixed: count `AIWG_GROKBOT_SKILLS_DIR` when set; accept bridge-only (`provider-bridge-only` info) when native dirs are intentionally empty and the bridge file exists.
2. **User-scope registry miss** — `getProviderArtifactPathStrings('grokbot')` returned empty skills, so same-path inventory / `recordUserDeploy` never ran. Fixed: resolve skills via `resolveGrokbotSkillsDir()` in `getProviderArtifactPathStrings`.

## Residual / out of scope

- Native Grok Bot filesystem layout remains **unverified** product fact — AIWG must not invent it.
- macOS / Windows path semantics not exercised this cycle; **waived** by maintainer for #210 stable promotion (Linux-only validation sufficient).
- Optional natives (routines / CreateAgent / connectors) remain #209.

## Conclusion

Path policy matches the ADR fail-closed contract on Linux evidence. No path-traversal or secret-scrape defects found in the reviewed surfaces beyond the verification/registry accounting bugs fixed above. **Stable promotion approved under maintainer Linux-only waiver (2026-09-16); macOS/Windows PUW not required for #210.**
