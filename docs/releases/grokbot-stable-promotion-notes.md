# Release notes — Grok Bot stable promotion (#210)

**Date:** 2026-09-16 (America/New_York)  
**Provider:** `grokbot` (display name **Grok Bot**)  
**Change:** `experimental` → `stable`

## Highlights

- Promote provider id `grokbot` from `experimental` to `stable`.
- Grok Bot fleets should use `--provider grokbot`; Cursor IDE fleets stay on `--provider cursor` (see [migration guide](../migration/grokbot-from-cursor-workaround.md)).
- User-scope / global skill deploys remain fail-closed without absolute `AIWG_GROKBOT_SKILLS_DIR`.
- Reload guidance: start a new Grok Bot agent chat or re-read skills — never Cursor reload wording.
- Optional native adapters (routines / CreateAgent / connectors) remain deferred under [#209](https://github.com/jmagly/aiwg/issues/209) and do **not** block this promotion.

## Evidence checklist

- [x] Linux PUW (required) — [`docs/integrations/grokbot-linux-puw.md`](../integrations/grokbot-linux-puw.md)
- [x] macOS PUW — **waived** by maintainer (jmagly/Manitcor), 2026-09-16: Linux verification sufficient for release
- [x] Windows/WSL PUW — **waived** (same guidance)
- [x] Security review — [`docs/security/grokbot-path-security-review.md`](../security/grokbot-path-security-review.md)
- [x] Migration + release notes
- [x] Capability-matrix + provider-definition status flip (`status: stable`)
