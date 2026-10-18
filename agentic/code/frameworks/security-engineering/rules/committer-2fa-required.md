---
enforcement: high
id: committer-2fa-required
severity: HIGH
applies_to:
  - all-agents
  - security-auditor
  - release-manager
tags:
  - source-control
  - 2fa
  - mfa
  - committer-governance
activation: bound
summary: Require platform-enforced strong 2FA for every committer with write access; prefer hardware keys and store recovery credentials outside the repository.
bound_to:
  agents:
    - security-auditor
    - deployment-manager
    - secure-bootstrap-reviewer
  skills:
    - committer-2fa-audit
    - supply-chain-trust
    - supply-chain-hardening-quickstart
triggers:
  - require two factor authentication for repository committers
---

# Committer 2FA Required

**Enforcement Level**: HIGH
**Scope**: Source-control organizations, maintainers, deploy keys, release owners
**Framework**: security-engineering

## Rule

Every committer with write access MUST have strong two-factor authentication enforced at the hosting platform. Hardware security keys are preferred; TOTP is the minimum acceptable fallback. Recovery codes and break-glass credentials MUST be stored outside the repository in an approved secret store.

AIWG documents and audits the requirement; enforcement remains platform-layer policy.

## Detection

Use `committer-2fa-audit`. GitHub org audits require an org-admin token and use the platform's `2fa_disabled` member filter. Gitea support is best-effort and depends on instance API capability.

## References

- `.aiwg/security/curl-checklist-gap-analysis.md` row 4, Practice 25
- `agentic/code/addons/aiwg-utils/rules/token-security.md`

**Rule Status**: ACTIVE
**Last Updated**: 2026-05-23
