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

## Read-only cleanup and tier recommendations

`aiwg memory recommend` ranks advisory candidates from the audit inventory and
`cost.ts` utility/footprint attribution. It writes nothing, including telemetry,
indexes, owner receipts, or approval records. JSON uses
`aiwg.memory-recommendations.v1`; its schema lives beside the audit/cost schemas
in `schemas/memory/`. It accepts the same `--scope global|project|provider`,
`--provider`, and `--json` selections as audit/cost. Global selection is explicit.

```bash
aiwg memory recommend --provider claude
aiwg memory recommend --scope project --provider codex --json
aiwg memory recommend --evidence evidence.json --usage usage.json --json
```

Use audit item IDs as keys in the optional evidence input. Each entry needs a
`source` locator identifying the operator review or supporting evidence:

```json
{
  "thresholds": {
    "minimumAgeDays": 30,
    "reviewAgeDays": 90,
    "demoteMinimumTokens": 512,
    "taskPackCharacters": 8000
  },
  "items": {
    "<audit-item-id>": {
      "source": "owner-review:decision-42",
      "criticality": "ordinary",
      "ownerPinned": false,
      "rareObligation": false,
      "provenance": "verified",
      "createdAt": "2025-01-01T00:00:00.000Z",
      "reviewedAt": "2026-01-01T00:00:00.000Z",
      "history": "known",
      "obsolete": true,
      "categoryCorrection": "decision"
    }
  }
}
```

These threshold values are configurable **local starting points to evaluate**,
not research-established TTLs or optimum token budgets. An old review opens an
investigation; age, retrieval frequency, or rejection alone never justifies
retirement. Unknown creation/history or utility evidence blocks retirement.
Owner pins, source-frontmatter pins, critical rules and rare obligations remain
visible as blocked candidates with protected-item exceptions. Caller evidence
cannot clear a source pin. Dates are UTC ISO timestamps; filesystem modification
time is never treated as creation time. Evidence IDs outside the inventory and
invalid inputs are rejected. These are caller assertions with provenance, not
independently observed runtime telemetry.

`--usage` reuses the cost input: `{ "<audit-item-id>": { "retrieved": true,
"used": false, "rejected": false, "evidence": "task-review:42" } }`.
Exposure, retrieval, successful use, rejection and unknown remain distinct.
Without telemetry, absence of successful use stays unknown. Cost estimates reuse
the existing UTF-8 bytes estimators and confidence; unknown savings stay unknown.
Demotion estimates subtract the retrieval-anchor overhead from `cost.ts` and are
conditional on retrieval verification and provider regeneration. Savings across
overlapping candidates must not be added together. Retirement retains source
and history, so it claims no disk deletion savings.

Additional item evidence accepts `conflictsWith` (audit IDs), `supersededBy`
(audit ID), `summaryStale`, and `categoryCorrection`. Audit conflict/collision
findings and contradictory provenance produce conflict candidates and block
merges. Identical digests support consolidation review; originals and source
links remain immutable. Stale summaries require source/lineage review and an
explicit replacement rather than generated facts. No semantic contradiction
detector is claimed: provide source conflicts that the static audit cannot see.

New knowledge defaults to indexed storage. Successful-use evidence first proposes
bounded task context through the existing `buildWorkspaceContextPack` builder,
with the configured total character budget. The recommendation policy adds no
body loading beyond audit and does not build a pack itself. An explicit `residentProposal` requires `owner` (the existing
owner), `rationale`, `budgetTokens`, a future `reviewDate`, and
`boundedPackEvaluated: true`, plus verified provenance and observed successful
use. A missing field, unknown footprint, or exceeded budget rejects the proposal.
Placement never grants new authority.

Every candidate includes evidence, uncertainty, conditional savings with estimator
confidence, retrieval impact, blocking reasons, and protected-item exceptions.
Ranks prioritize conflicts, taxonomy, lineage, duplicates, demotion, promotion,
then retirement; savings break ties. Ranking carries no mutation authority.

Export one advisory candidate to stdout and save it using shell redirection:

```bash
aiwg memory recommend --evidence evidence.json --usage usage.json \
  --candidate <candidate-id> --emit-review-input > review-input.json
aiwg memory plan --recommendation review-input.json --reviewer operator \
  --out reviewed-plan.json --json
```

Stdout export keeps recommend's zero-write contract. The exported JSON is still
an advisory report containing one candidate, never an approved plan. Blocked,
conflicting and rejected candidates cannot be exported for execution. Planning
requires an explicit reviewer, checks the unchanged whole-source fingerprint,
then binds the current owner's native record revision and snapshot. Audit keeps
source fingerprints separate from Markdown body digests and reads existing
owner placement/protection metadata. Re-audit after a source change.

Recommendation handoff supports individual project-owned sources recognized by
an existing maintenance owner. Aggregate line-memory/canonical-store files need
explicit owner-handle review through ordinary plan flags; provider/global sources
remain with their existing owners. Merge review additionally requires
`--replacements <json-file>` and binds every related source. Supersession repair
remains blocked until source facts and replacement lineage are resolved; ordinary
plan flags accept the reviewed replacement. The existing indexed-retrieval checks
and resident-owner limitations below still apply. Review and apply remain
separate commands.

## Reviewed placement and retirement

`aiwg memory plan`, `apply` and `restore` coordinate the existing line-memory,
compound-memory canonical context, and semantic-memory artifact-index owners.
They preserve source bodies, original handles, aliases, lineage and owner
history. Retirement records a tombstone; it never deletes a source file.

Plan a single owner revision, inspect it, then apply that exact plan:

```bash
aiwg memory plan --owner semantic-memory --target .aiwg/knowledge/decision.md \
  --op retire --reviewer operator --rationale 'Reviewed obsolete decision' \
  --retirement-basis review --out retire-plan.json --json
aiwg memory apply --plan retire-plan.json --preview --json
aiwg memory apply --plan retire-plan.json --yes --json
```

Use a line-memory handle (`lm_…`), canonical-context entry handle, or indexed
Markdown source path as the target. Plans include digests, revision, owner
snapshot, placement/lifecycle, project scope, rationale, uncertainty, impacted
links, reviewer and next-session effect. `--out` must be a new file inside the
workspace whose parent already exists. Planning writes only that file;
`--preview` writes nothing. `--input <plan-file>` validates an existing exact
plan; `--out <new-file>` saves the validated preview.

Promotion/demotion uses `--placement resident|indexed|task-context|archived`;
recategorization uses `--category <name>`. Lifecycle and placement are separate
operations, so retirement leaves the placement axis intact. `--replacements`
reads a JSON array of `{ "key", "value", "sourcePath"?, "category"? }` objects;
semantic-memory requires a new canonical `sourcePath` for each replacement.
Supersede takes one replacement, split at least two, and merge one replacement
plus `--related <file>` containing a JSON array of additional source handles.
All merge inputs bind their own digest/version and must retain scope and
authority. No promotion grants instruction authority.

Semantic-memory verifies active published index records with the same content
digest before resident removal. Demotion to indexed placement can verify its
own published record; retirement requires a retained active copy supplied with
`--link <indexed-path>`. A Markdown file alone is insufficient. If the index
is absent, stale or unavailable, removal fails closed.

The default line-memory and canonical-context maintenance owners explicitly
refuse demotion, retirement or replacement that removes resident content:
neither publishes an owner-native indexed retrieval projection today.
Supplying `--link` cannot enable these unsupported operations. Other reviewed
operations remain available. Pinned mandatory constraints cannot be retired by age;
`--retirement-basis` defaults to `age`. Native line-memory capacity handling
also refuses to prune a pinned constraint.

Apply checks the reviewed source digests, revisions and owner snapshot under
owner locks. At a TTY, type the exact displayed plan digest; headless callers
must supply `--yes` or `--confirm <plan-digest>`. JSON mode requires explicit
confirmation. Changed plans need a new review. `--yes` confirms the specified
file; it does not bypass stale-source or owner checks.

Each owner persists its own receipt with its transaction. Coordinator journals
under `.aiwg/memory/maintenance/` contain receipt metadata and progress, not
memory bodies. An interruption or failed index refresh reports
`partial: { completed, pending }` with stable operation keys. Rerun the same
apply command to resume. Completed owner work is recovered even if the process
stopped before coordinator journaling. A different plan cannot take over an
unfinished owner transaction. Keep the plan and journals until recovery is
complete; do not clear a live owner's lock.

To restore, first review a new plan targeting the retained record:

```bash
aiwg memory plan --owner semantic-memory --target .aiwg/knowledge/decision.md \
  --op restore --reviewer operator --rationale 'Reviewed reinstatement' \
  --out restore-plan.json
aiwg memory restore --plan restore-plan.json --yes --json
```

Restoration retains prior dispositions in owner history and preserves scope
and authority. Superseded content may require resolving an active replacement
conflict before restore.

Executable plans currently support project-owned sources and one operation per
owner snapshot; a plan may coordinate different owners. Review another plan
for another revision of the same owner. Global, transient/session, opaque and
provider-native files are refused by these writers. Provider files remain
owned by existing regeneration workflows. Canonical resident projections and
line-memory loading exclude demoted/retired content; artifact rebuilds retain
lifecycle exclusions. There is no canonical-context-to-provider regeneration
consumer in the current codebase: use its filtered `residentEntries()` API
when adding one. Portable exports deliberately retain history. These commands
do not rewrite a running session or automatically regenerate provider files;
all effects are reported as next-session changes.
