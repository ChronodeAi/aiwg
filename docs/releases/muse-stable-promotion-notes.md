# Release notes — Muse Code stable promotion (#231)

**Date:** 2026-10-02 (America/New_York)  
**Provider:** `muse` (display name **Muse Code**)  
**Change:** `experimental` → `stable`

## Highlights

- Promote provider id `muse` from `experimental` to `stable`. No aliases; `muse-code`, `muse-spark`, `spark`,
  and `meta` stay rejected.
- `aiwg use all --provider muse` now installs the managed `SessionStart` hook and an opted-in `--mcp` profile
  (previously skipped by the kernel-only `use all` path).
- Skills deploy to project `.agents/skills`; `--scope user` uses `$XDG_CONFIG_HOME/muse/skills` and fails
  closed on bad XDG metadata.
- Sessions import from `muse export` documents, or from native logs with an explicit `--muse-root`.
- The `muse exec` Ralph adapter remains optional (`AIWG_MUSE_RALPH_ENABLED=0` disables it).

## Evidence checklist

- [x] Linux PUW (required) — [`docs/integrations/muse-linux-puw.md`](../integrations/muse-linux-puw.md)
- [x] macOS PUW — **waived** by the maintainer, 2026-10-02: Linux verification sufficient for release
- [x] Windows/WSL PUW — **waived** (same guidance)
- [x] Skills deploy + `AGENTS.md` bridge + session export import (PUW)
- [x] Security review — [`docs/security/muse-path-security-review.md`](../security/muse-path-security-review.md):
      no `settings.json` clobber (opt-in, backup, operator `aiwg` key never replaced); hooks-outside-sandbox
      warning documented in the provider reference
- [x] Capability-matrix + provider-definition status flip (`status: stable`)
