# User-Level Project Memory

AIWG can keep private project memory outside a repository under the operator's
AIWG home. This avoids git noise from personal agent memory while preserving the
same effective `.aiwg` layout used by project-local AIWG artifacts.

## Layout

User-level project memory is rooted at:

```text
~/.aiwg/projects/
  manifest.json
  index/
    manifest-index.json
  <project-id>/
    .aiwg/
      aiwg.config
      memory/
      index/
      artifacts/
```

`manifest.json` records each registered project's stable id, display name,
workspace roots, git remotes, metadata, and private `.aiwg` memory root. The
`index/manifest-index.json` sidecar maps project ids, workspace roots, and git
remotes to manifest entries so AIWG can resolve the active project without
scanning every memory directory.

## Commands

Register the current workspace:

```bash
aiwg memory project register
```

Inspect and resolve:

```bash
aiwg memory project list
aiwg memory project inspect
aiwg memory project inspect --remote git@git.integrolabs.net:roctinam/aiwg.git
aiwg memory project resolve
```

Maintain mappings:

```bash
aiwg memory project reindex
aiwg memory project relocate <project-id> ~/.aiwg/projects/<new-id>/.aiwg
aiwg memory project remove <project-id>
aiwg memory project remove <project-id> --delete-files
```

All commands accept `--json` for automation.

## Resolution Order

Memory storage resolves in this order:

1. Explicit `.aiwg/storage.config` memory root or backend.
2. Project-local `.aiwg/memory` when the active workspace has a `.aiwg`
   directory.
3. Registered user-level project memory under `~/.aiwg/projects/<id>/.aiwg`
   when the active workspace path or git remote matches the manifest.
4. Default project-local `.aiwg/memory`.

This keeps reviewed project-local AIWG artifacts authoritative. User-level
memory is best for private, per-operator context that should not be committed.
Use project-local `.aiwg` when the memory or artifact must be shared,
reviewed, or reproduced by collaborators.

## Repository Pollution

Private memory roots live outside the checkout, so registering a project does
not modify the target repository or require repository-specific `.gitignore`
rules. The memory contents still use the normal `.aiwg` subdirectories, which
lets existing storage commands and memory tools work with the relocated root.

## Read-only memory audit

`aiwg memory audit` inventories this workspace's memory, startup instructions,
subtree instructions, eligible roles/rules/prompts/skills, static tool declarations,
and linked context. It uses configured storage and external artifact roots without
creating directories, indexes, baselines, or receipts.

```bash
aiwg memory audit
aiwg memory audit --scope project --json
aiwg memory audit --scope provider --provider codex
aiwg memory audit --scope global --provider claude --json
```

Workspace/project/provider scans exclude provider user roots. Global selection
explicitly inventories user stores and registered project roots; `--provider`
filters native surfaces. The project registry's metadata and a private memory root
resolved for the current project remain eligible in a workspace scan.

JSON uses `aiwg.memory-audit.v1` (schema: `schemas/memory/memory-audit.v1.schema.json`).
Records retain owner identity and protection metadata; each exposure retains its
provider and traversal chain. Findings include shadow candidates, differing
instruction copies, duplicate resident bytes, alias collisions, include cycles,
stale references, unmanaged files, and firewall baseline/deployment drift.
Copilot instructions combine without an asserted general precedence.

This is static inventory: `on-disk` and inferred eligibility never prove live
loading. Hidden system content and external tool descriptions remain `opaque`;
unreadable paths are `inaccessible`, never evidence of clean coverage. No network
or tool execution is performed. Toolsmith catalogs and JSON tool declarations are
inventoried when available. Content bodies and configuration secrets are omitted.
The shared firewall trust/drift classifier is reused; run `aiwg context-firewall
scan` for its poisoning assessment and baseline review workflow.

Scanning stops at 12 levels, 5,000 files, 20,000 directory/discovery entries,
20,000 exposures, five seconds, or 2 MiB per file. `coverage.limitsHit` and
`scan-truncated` findings identify incomplete scans. Credential files, dependency
and build directories are excluded. Durable size never establishes injected size;
provider ceiling findings are risks, not measured runtime truncation.
