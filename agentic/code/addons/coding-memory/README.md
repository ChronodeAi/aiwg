# Coding Memory Addon

The `coding-memory` addon establishes one provider-neutral lifecycle for durable coding
intelligence:

**Recall -> Verify -> Explore -> Act -> Test -> Record -> Promote -> Commit -> Close**

It assigns a distinct job to each authority:

- **Agentmemory** stores project-scoped episodic and procedural memory.
- **Codebase Memory** supplies the current structural graph of source, tests, and accepted decisions.
- **Live files, tests, commits, and accepted ADRs** remain the proof authorities.

Memory is advisory. A recalled result can locate evidence or suggest a hypothesis, but it cannot
prove correctness, authorize a decision, or become new evidence without fresh verification.

## Artifacts

| Artifact | Purpose |
|---|---|
| `coding-memory-lifecycle` | Runs the complete coding-memory lifecycle at task, edit, verification, commit, and stop boundaries. |
| `coding-memory-evidence` | Enforces project scope, privacy, provenance, and memory-is-not-proof governance. |
| `coding-memory-audit` | Audits configuration, retrieval, capture, promotion, commit linkage, and graph health. |

## Project Contract

Agentmemory and Codebase Memory must use the same credential-free canonical project ID, normally:

```text
github.com/owner/repository
```

Agentmemory configuration lives in `.agentmemory/project.yaml` or its user-local project override.
Codebase Memory configuration lives in `.codebase-memory/config.toml` or an explicitly selected
user-local project override. Strict projects use `capture_profile: balanced`,
`external_processing: false`, and local processing for raw content.

The lifecycle rejects implicit unscoped recall. Cross-project retrieval requires an explicit global
query and must never be injected automatically.

## Operations

Use the native Agentmemory skills supplied by its Codex or Claude plugin. MCP-only providers receive
the lifecycle through this addon rule and behavior rather than duplicate skill copies.

Run the audit with:

```text
aiwg show skill coding-memory-audit
```

Baseline diagnostics:

```text
agentmemory doctor --dry-run
agentmemory status
codebase-memory-mcp --version
codebase-memory-mcp cli --json index_status project=<storage-project-name>
aiwg doctor
```

Automatic synchronization into Codex native memory or a Claude memory bridge is intentionally
disabled. Curated native-memory promotion remains an explicit user-approved action.
