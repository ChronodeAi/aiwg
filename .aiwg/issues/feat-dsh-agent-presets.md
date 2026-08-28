---
status: open
type: feature
area: dsh-provider
tracker: local-file
tracker-blocked: "gitea MCP 404 (localhost:4000 swagger) and HTTP API unreachable 2026-08-27; sync to roctinam/aiwg when tracker returns"
scope-note: "Receipt counting (deployedTo.dsh.agents) and doctor preset-collision warning are documented follow-ups; E2E-verified via DSH discoverPresets()"
---

## Motivation

The `dsh` provider (capability-matrix.yaml:473, branch `feat/dsh-provider-integration`) declares `agents: null` — DSH has no agent-file surface, so AIWG agent definitions (`.claude/agents/*.md`, 199 files) never reach DeepSeek Harness sessions. Meanwhile DSH ships a first-class named-agent system: **agent presets** (`packages/preset/agent-presets/`) — a directory with `agent.cordis.yml` (realm-isolated plugin composition) + `preset.yml` (display metadata), discovered live from the user root `~/.dsh/.agent-presets/` (`USER_PRESET_DIR`, `discovery.ts`).

A session-mining audit (117 DSH sessions, 2026-08-27; report: `.aiwg/reports/dsh-aiwg-session-mining-20260827.md` in the fork workspace) found DSH sessions cannot reach AIWG personas at all: delegation happened via hand-written role prompts only. We hand-authored three bridge presets (`aiwg-efficiency-worker`, `aiwg-coding-worker`, `aiwg-reasoning-worker`) mirroring the `aiwg-model-*-worker` canon — validated via DSH's own `discoverPresets()` — but they are machine-local shadow artifacts: no provenance in the corpus, no fleet distribution, no refresh path, and vulnerable to silent shadowing if upstream ever ships ids that collide (shipped root wins over user root in discovery precedence).

Affected: every operator using AIWG with DeepSeek Harness. Now is the time because the dsh provider integration is already on a feature branch and the preset contract is stable enough to translate.

## Proposal

Extend the dsh provider deployer so agent definitions participate in the same `aiwg` CLI pipeline as skills:

1. **Corpus authoring (AIWG-native):** author DSH preset translations under `agentic/code/providers/` (e.g. `agentic/code/providers/dsh/agent-presets/<id>/{agent.cordis.yml,preset.yml}`) or translate from canonical agent definitions (frontmatter model-role/tools → persona text + composition rows). Start with the three model-worker presets whose personas already exist as `aiwg-model-*-worker` agents.
2. **Deploy surface:** `aiwg use <framework> --provider dsh` gains an `agent-presets` artifact class writing to the user root `~/.dsh/.agent-presets/<id>/` (`paths.artifacts.agents` becomes that path instead of `null`). Recorded in `deployedTo.dsh.agents` like skills are today.
3. **Refresh/drift:** `aiwg refresh --provider dsh` re-syncs presets (hash-verified copy, same preservation logic as skills); `aiwg doctor` gains a preset staleness check.
4. **Precedence safety:** document and detect the shipped-root-wins rule — doctor should warn when a user-root preset id collides with a shipped/system preset id.
5. **Steward capability matrix:** flip `artifact_paths.agents` for dsh from "(not supported)" to the preset path with a note that presets are session-scoped compositions (per-child persona shadowing remains the per-delegation mechanism — no per-delegation preset param exists in DSH's `tool-subagent`).

## Alternatives considered

- Keep hand-authored user-root presets (status quo): no corpus provenance, no distribution, drifts silently. Rejected.
- Per-child persona injection only (`tool-subagent` config persona / `ChildComposition.persona`): works for one-off dispatch but is fixed per tool instance config, not name-selectable, and not corpus-managed. Rejected as the primary mechanism; remains useful.
- Filesystem-copy conventions (documenting "copy these files yourself"): fails the same provenance/drift test.

## Out of scope

- Per-delegation preset selection inside DSH sessions (DSH upstream design change — presets are session-scoped by design; children inherit the parent's preset via `child-agent.ts`).
- Model pinning inside preset compositions (DSH owns the model route on the host plane; model-role is recorded as display metadata only).
- Other providers' agent formats.

## Acceptance criteria

- [ ] `aiwg use <framework> --provider dsh` deploys at least the three `aiwg-*-worker` presets to `~/.dsh/.agent-presets/` and records them in `deployedTo.dsh.agents`
- [ ] `aiwg refresh --provider dsh` updates changed presets and leaves operator edits preserved per the standard preservation logic
- [ ] `aiwg doctor` warns on user-root preset ids colliding with shipped ids
- [ ] `discoverPresets()` (DSH `@deepseek-ai/dsh-agent-presets`) returns the deployed presets with correct id/name/description (validated the same way the hand-authored bridge presets were)
- [ ] capability-matrix.yaml `dsh.artifact_paths.agents` updated from `null`
- [ ] Docs updated: `docs/agents/providers/deepseek-harness.md` + CHANGELOG

## Related

- Issues: follows the dsh provider integration branch `feat/dsh-provider-integration` (git 8658ca89)
- Existing skills/agents/rules this builds on: `aiwg-model-efficiency/coding/reasoning-worker` agents (canonical personas), `cli-secondary` rule, `steward-quickref` Domain 1 (expansion authoring)
- Environment: AIWG 2026.8.17 [dev] @ 8658ca89 · macOS 25.5.0 arm64 · Node v24.16.0 · provider: dsh (DeepSeek Harness)
- Note: `dsh` is not yet in the aiwg-issue provider enumeration (claude-code, hermes, codex, copilot, cursor, warp, factory, opencode, windsurf, openclaw) — worth a follow-up docs fix.
