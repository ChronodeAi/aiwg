# Coding Memory Evidence

**Enforcement Level**: HIGH
**Scope**: Coding sessions using Agentmemory, Codebase Memory, semantic recall, summaries,
reflections, lessons, profiles, slots, context injection, or promotion.
**Addon**: coding-memory
**Status**: ACTIVE

## Authority Boundary

Agentmemory is episodic and procedural memory. Codebase Memory is structural discovery. Neither is
proof. Correctness, acceptance, and architecture claims require current live files, executable
tests, commits, signed verdicts, or accepted ADRs.

## Project Boundary

- Derive one credential-free canonical project ID from the normalized Git remote.
- Require that project ID for recall, smart search, file history, sessions, slots, lessons,
  insights, profiles, context packets, expanded results, commit linkage, and project health.
- Reject omitted scope unless the caller explicitly requests global scope.
- Never inject global or other-project records into a project session.
- Namespace project slots by project ID.
- Link child-agent sessions to their parent and retain the same project boundary.

## Retrieval And Capture

- At task start, request one project context packet of at most 2,000 tokens and five results.
- Before editing a file, retrieve its project-scoped history and inspect the live code graph.
- Verify recalled claims against current evidence before acting on them.
- Use balanced capture: full content for prompts, edits, writes, failures, migrations, accepted
  decisions, commits, and completion; metadata only for reads, searches, listings, and status.
- Redact secrets before storage. Exclude environment files, caches, build output, provider
  deployments, generated evidence, and `.aiwg/working/**`.
- Do not save recalled content as fresh evidence without a new verification event.

## Promotion

- Generate at most three candidates from a substantive completed session.
- Auto-promote a bug or workflow lesson only after a reproduced failure, passing verification, and
  source or commit provenance.
- Require explicit user acceptance for architecture, preferences, security policy, and business
  decisions.
- Store accepted architecture as a concise pointer to its canonical ADR and commit.
- Keep automatic Codex native-memory and Claude memory-bridge synchronization disabled.

## Privacy And Failure

- Strict projects deny external processing of raw content and use local embeddings or
  summarization.
- Memory or graph outages degrade recall and discovery; they do not invalidate unrelated live
  evidence. Record the outage and use direct-file discovery when graph tools are unavailable.
- A memory record must never contain a credential, secret-file payload, or raw sensitive fixture.

## Completion

After verification, record only qualified lessons. After an agent-created commit, link its SHA to
the project and session. At stop, summarize unresolved work, close the session idempotently, and
leave authoritative state in Git, tests, issues, or accepted ADRs.
