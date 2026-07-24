---
namespace: coding-memory
name: coding-memory-audit
platforms: [all]
description: Audit project-scoped coding memory, privacy, evidence, retrieval, promotion, commit linkage, and code-graph health.
triggers:
  - coding memory audit
  - agentmemory project health
  - audit codebase memory integration
  - verify coding memory lifecycle
commandHint:
  argumentHint: "[--project <canonical-id>] [--session <id>] [--json]"
  allowedTools: Read, Bash
  category: memory
  orchestration: false
  modelRole: reasoning
  modelTier: premium
---

# Coding Memory Audit

Audit the live project against the `coding-memory` lifecycle. Remain read-only unless the user
explicitly approves repair or migration.

## Procedure

1. Establish the Git root, normalized credential-free remote, canonical project ID, active
   provider, and deployed addon version.
2. Locate Agentmemory's effective project configuration using process environment, user-local
   override, repository manifest, and inferred defaults in precedence order. Confirm privacy
   resolves to the most restrictive layer.
3. Confirm balanced capture, secret-file authentication, redaction exclusions, local processing
   for strict projects, and disabled automatic native-memory synchronization.
4. Run `agentmemory doctor --dry-run` and `agentmemory status`. Inspect project health through
   `memory_project_health(project)`.
5. Confirm new records are project scoped; sample recall, smart search, file history, sessions,
   slots, lessons, insights, profiles, expanded results, and context packets for cross-project
   leakage.
6. Check one context packet for a 2,000-token ceiling, at most five results, source-ID
   deduplication, relevance filtering, and provenance.
7. Inspect capture metrics, semantic duplicates, rolling compaction, exact-facts retention,
   abandoned sessions, parent-child links, promotion counts, injection latency, and commit
   coverage.
8. Verify that auto-promoted bug or workflow lessons have reproduced failure, passing verification,
   and source or commit provenance. Verify architecture, preference, security, and business
   candidates required explicit acceptance.
9. Run Codebase Memory version and index health checks. Confirm its canonical project ID matches
   Agentmemory, source/test roots are indexed, accepted ADR roots are recognized as decision
   authority, and configured exclusions do not dominate the graph.
10. Sample graph discovery and file-history retrieval before inspecting live source and tests.
    Verify graph misses use direct-file fallback rather than unsupported certainty.
11. Sample agent-created commits and verify `memory_commit_link` provenance.
12. Report each finding as `pass`, `warn`, `fail`, or `not_applicable`, with current evidence and a
    bounded remediation.

## Acceptance Gates

- Zero cross-project leakage and 100% project scope for new records.
- At least 80% precision in a bounded top-five recall benchmark.
- Fewer than 2% duplicate observations and at least 95% commit linkage.
- Context packets at or below 2,000 tokens and p95 injection latency below two seconds.
- Secret fixtures absent from observations, embeddings, summaries, and provider requests.
- Codebase graph indexes all intended source/test roots and recognizes all canonical accepted ADRs.
- Provider fresh-session checks, Agentmemory doctor, project health, AIWG doctor, and Codebase index
  health pass before broad rollout.

## Evidence Boundary

Memory and graph results may direct the audit to evidence but cannot satisfy a gate by themselves.
Use live configuration, source, tests, commits, accepted ADRs, and direct diagnostic output for
verdicts.
