# Muse Code Linux PUW — issue #231

**Date:** 2026-10-02 (America/New_York)  
**Host:** Linux workstation (`uname` below)  
**Muse Code:** 1.4.2 (`1.4.2-R4684.1`), authenticated for the Meta provider  
**AIWG version:** 2026.9.24 (`main` at `6ded8c849`); hook/MCP steps re-run on `chore/231-promote-muse-stable`
**Sandboxing:** user-scope and MCP steps used a temporary `XDG_CONFIG_HOME`; the operator's real
`~/.config/muse` was never written.

## Environment

```text
Linux 7.0.0-34-generic #34-Ubuntu SMP PREEMPT_DYNAMIC Wed Sep  2 14:29:37 UTC 2026 x86_64 GNU/Linux
node v24.12.0
Muse Code 1.4.2 (1.4.2-R4684.1)
```

## Commands and exit codes

| Step | Command | Exit |
| --- | --- | --- |
| Fail-closed relative XDG | `XDG_CONFIG_HOME=relative/cfg aiwg use all --provider muse --scope user --dry-run` | 1 (blocked) |
| Fail-closed bare `~` | `XDG_CONFIG_HOME='~' aiwg use all --provider muse --scope user --dry-run` | 1 (blocked) |
| Project dry-run | `aiwg use all --provider muse --dry-run` | 0 (zero writes) |
| Project deploy | `aiwg use all --provider muse` | 0 (26 skills in `.agents/skills`) |
| User dry-run | `XDG_CONFIG_HOME=<tmp> aiwg use all --provider muse --scope user --dry-run` | 0 |
| User deploy | `XDG_CONFIG_HOME=<tmp> aiwg use all --provider muse --scope user` | 0 (26 skills in `<tmp>/muse/skills`) |
| Doctor | `aiwg doctor --provider muse` | 0 (29 passed, 4 warnings, Muse native section) |
| Status | `aiwg status --probe --provider muse` | 0 |
| Steward | `aiwg steward capabilities --provider muse` | 0 |
| Live smoke | `AIWG_MUSE_LIVE_SMOKE=1 npm run smoke:muse:live` | 0 (`LIVE_CHECKS_PASSED`, 26/26 skills loaded) |
| Muse loads skills | `muse skills list --source all --workspace <project> --trust-workspace --json` | 0 (26 project skills, 0 duplicate ids) |
| Trust gate, untrusted | `muse exec --provider echo "…"` | 0 (`rules.context_load … skipped_untrusted=1`) |
| Trust gate, trusted | `muse exec --provider echo --trust-workspace "…"` | 0 (`project_sources=1`: `AGENTS.md` loaded) |
| Hooks + MCP via `use all` | `XDG_CONFIG_HOME=<tmp> aiwg use all --provider muse --mcp` | 0 (`.muse/hooks.json` + sidecar; settings backup) |
| Doctor after hooks/MCP | `aiwg doctor --provider muse` | 0 (`Hooks: managed`, `MCP: configured`) |
| Hook runs in Muse | trusted `muse exec --provider echo` | 0 (`hook_run_terminal status=completed`) |
| MCP loads in Muse | same run | `mcp.config.resolve … server_count=1`; 16 `mcp__aiwg__*` tools |
| Export | `muse export --session <session.jsonl> --redacted --out trajectory.json` | 0 |
| Import | `aiwg sessions import trajectory.json --provider muse --source-id … --json` | 0 (1 session, 57 events committed) |
| Discovery, no root | `aiwg sessions discover --workspace <project> --json` | 0 (muse `export-required`, 0 sources) |
| Discovery, `--muse-root` | `… --muse-root ~/.local/share/muse/sessions --json` | 0 (2 sources: exactly this project's sessions) |

The echo provider exercises Muse's startup path (skills, rules, hooks, MCP) without a model call.

## Model calls

The Muse API quota was exhausted on 2026-10-02 (resets 2026-10-05), so real-model `muse exec` runs come
from the 2026-09-25 qualification on Muse Code 1.4.0 (#2726): the `--json` envelope
(`run.output.delta`, `run.terminal.<state>`), exit codes 0/1/2, `--session-id` create-or-continue, `--`
before a leading-dash prompt, and observed models `muse-spark-1.3` and `muse-spark-1.3-contributor`.
The Ralph adapter drove real `muse exec` end to end in that run. Nothing in 1.4.2's `exec` help or
export format changed relative to those findings.

## Findings fixed in the promotion

- `aiwg use all --provider muse` never installed the managed hook or an opted-in `--mcp` profile:
  `use all` deploys in kernel-only mode, which the Muse writer treated as skills-only. Fixed in
  `tools/agents/providers/muse.mjs`; the hook and MCP rows above were re-run with the fix.

## Containment checks

- No `.cursor/` trees in the project or the temporary XDG root.
- No `~/.muse` exists.
- User skills only under `<tmp>/muse/skills` (0 `SKILL.md` outside it); `<tmp>/muse` holds only `skills/`.
- `~/.agents/skills` pre-dates the PUW (2026-09-01, README only) and no entry in it changed during the run.

## Platforms

- Linux: verified above.
- macOS and Windows/WSL: waived by the maintainer on 2026-10-02; Linux verification is sufficient for release.
