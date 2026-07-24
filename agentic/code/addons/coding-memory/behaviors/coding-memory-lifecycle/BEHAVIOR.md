---
name: coding-memory-lifecycle
type: behavior
version: 0.1.0
description: Project-scoped coding lifecycle that recalls context, verifies evidence, records qualified lessons, and links commits.
metadata:
  scope: project
  triggers:
    - session-start
    - task-start
    - pre-edit
    - post-test
    - post-commit
    - session-stop
mode: prompt
memory:
  project_scoped: true
  context_token_budget: 2000
  maximum_results: 5
  native_memory_sync: false
providers:
  native: [claude-code, codex]
  emulated: [cursor, factory, opencode, hermes, warp, copilot, windsurf, openhuman, openclaw]
---

# Coding Memory Lifecycle

Apply this sequence to every substantive coding task:

**Recall -> Verify -> Explore -> Act -> Test -> Record -> Promote -> Commit -> Close**

## Recall

1. Resolve the canonical project ID and active session.
2. Load one project-scoped context packet, applicable lessons, profile slots, and unresolved work.
3. Accept no more than five relevant results and 2,000 tokens. Do not inject a source ID twice in
   one session.

## Verify

1. Treat recalled content as a lead, not a fact.
2. Verify important claims against live files, current tests, commits, issues, or accepted ADRs.
3. Mark recalled material so it cannot be re-saved as new evidence without fresh verification.

## Explore

1. Before editing, retrieve project-scoped history for the target files.
2. Use Codebase Memory for structural discovery, call paths, and architecture.
3. Check index coverage for operated-on files before exhaustive or negative claims.
4. If graph transport or coverage is unavailable, record the limitation and inspect live files
   directly.

## Act

1. Make changes against current source, not remembered source.
2. Preserve project privacy, exclusion, redaction, and authority boundaries.
3. Keep child agents linked to the parent project and session.

## Test

1. Reproduce failures where applicable.
2. Run focused verification and broaden it in proportion to the change.
3. Record exact commands, outcomes, identifiers, and affected files in the facts ledger.

## Record

1. Capture high-value prompts, edits, failures, migrations, accepted decisions, and completion.
2. Capture reads, searches, listings, and status commands as metadata only.
3. Deduplicate repeated tool events and semantically equivalent observations.
4. Save only lessons supported by fresh evidence and provenance.

## Promote

1. Generate at most three candidates for a substantive completed session.
2. Auto-promote verified bug and workflow lessons only when failure, passing verification, and
   source or commit provenance are all present.
3. Ask the user to accept architecture, preference, security-policy, and business-decision
   candidates.
4. Point architecture memories to the accepted ADR and commit; never create a competing decision
   record.

## Commit

1. After a successful agent-created commit, link the full SHA to the canonical project and session.
2. Do not claim commit coverage from configuration alone; verify the linkage.

## Close

1. Summarize verified outcomes and unresolved work.
2. Close or resume sessions idempotently; close stale abandoned sessions without deleting history.
3. Leave automatic Codex native-memory and Claude memory-bridge synchronization disabled unless the
   user explicitly approves a curated promotion.
