# Governance Boundary

**Enforcement Level**: HIGH
**Scope**: Project governance corpus, protected surfaces, agentic workflow gates, promotion paths,
and provider bridge files that route governance behavior.
**Addon**: ring-governance
**Status**: DRAFT

## Rule

Governance-defining surfaces must be inventoried, protected, and reviewed before any autonomous or
semi-autonomous agent can propose changes near them.

## Governance Corpus

In an AIWG workspace, governance-defining surfaces usually live under `.aiwg/` and include context,
architecture, ADRs, audits, reports, evals, tests, rules, project-local bundles, issue gates,
acceptance criteria, rubrics, release records, and provenance artifacts. Provider bridge files such as
`AGENTS.md` and `AIWG.md` are routing surfaces and must be reviewed when they alter governance
behavior.

## Protected Surface Classes

- evaluator and verifier code
- criteria, rubrics, benchmark corpora, and answer keys
- policy files and capability-token rules
- arming floors, thresholds, and promotion gates
- protected-set definitions and allowlists
- CI/workflow gates that decide pass/fail
- audit-chain and verdict-signing paths

## Review Guidance

- Start from the live `${cwd}/.aiwg` tree unless the user explicitly supplies another corpus.
- Trace producer-to-verdict flow before recommending automation or promotion.
- Duplicate protected inventories are allowed only when tests prove they agree.
- If two lists define what is safe to edit and they can drift independently, the governance boundary is
  not trustworthy.
- Treat changes to provider bridges, discovery/routing rules, or project-local bundles as governance
  changes when they can alter who decides or what counts as evidence.

## Violations

- A candidate can edit the protected-surface inventory that governs its own review.
- A policy, allowlist, or threshold can be widened without governance review.
- A provider bridge can route around the intended reviewer, verifier, or gate.
- A generated report can substitute for primary evidence or executable verification.
