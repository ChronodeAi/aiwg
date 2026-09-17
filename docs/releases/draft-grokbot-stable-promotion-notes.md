# Draft release notes — Grok Bot stable promotion (#210)

> **Draft only.** Do not publish until `grokbot` status is actually flipped to `stable` after Linux + applicable macOS/Windows PUW, security review, and docs are merged. This cycle (#210 evidence PR) keeps the provider **experimental**.

## Highlights (when promotion lands)

- Promote provider id `grokbot` (display name **Grok Bot**) from `experimental` to `stable`.
- Grok Bot fleets should use `--provider grokbot`; Cursor IDE fleets stay on `--provider cursor` (see [migration guide](../migration/grokbot-from-cursor-workaround.md)).
- User-scope / global skill deploys remain fail-closed without absolute `AIWG_GROKBOT_SKILLS_DIR`.
- Reload guidance: start a new Grok Bot agent chat or re-read skills — never Cursor reload wording.

## Evidence checklist

- [x] Linux PUW (required) — see PR artifacts / `/workspace/aiwg-210-puw/PUW-linux.md` on the verification host
- [ ] macOS PUW (as applicable)
- [ ] Windows/WSL PUW (as applicable)
- [x] Security review — [`docs/security/grokbot-path-security-review.md`](../security/grokbot-path-security-review.md)
- [x] Migration + draft release notes
- [ ] Capability-matrix + provider-definition status flip
