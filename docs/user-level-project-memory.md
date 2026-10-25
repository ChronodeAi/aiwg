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

`aiwg memory plan`, `apply`, `verify` and `restore` coordinate the existing line-memory,
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
aiwg memory verify --plan retire-plan.json --json
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

Before mutation, human output and the JSON review event show the resolved project
root and scope, operation diff, owner review requirements, and native/next-session
limitations. JSON review events go to stderr; stdout retains the result JSON.
Review this targeting even when supplying `--yes`: global audit does not authorize
a global write.

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


## Discover and verify maintenance

The `harness-memory-maintenance` skill is the natural-language entry point on
supported providers. Discover the operation, then fetch only its section:

```bash
aiwg discover "harness memory audit"
aiwg show skill harness-memory-maintenance --section audit
aiwg discover "harness memory cleanup"
aiwg show skill harness-memory-maintenance --section cleanup
aiwg show skill harness-memory-maintenance --section demote
aiwg show skill harness-memory-maintenance --section recategorize
aiwg show skill harness-memory-maintenance --section retire
```

The same route handles "harness memory promote" and "harness memory demote".
The discovery anchor stays small; deployment adds no always-loaded maintenance
rule or full operation instructions. The generic `aiwg memory` commands below
remain usable without a skill or provider integration.

After apply or restore, run `aiwg memory verify --plan <file> [--json]`.
Verification writes nothing: it checks the exact operation's existing owner
receipt, recorded end state, retained tombstone/history, and required published
indexed retrieval. It does not create a verification store, reapply a plan,
repair drift, regenerate provider files, or prove that a running native session
has reloaded. Missing receipts, changed records, or unavailable retrieval are
findings to investigate; an unreadable/failed owner check is an execution failure.
After a later reviewed operation changes the target, verify that newer plan;
an older plan's expected end state may legitimately differ.

The maintenance subcommands share these exit codes, in human and JSON modes:

| Code | Meaning | Operator action |
|---|---|---|
| `0` | Success, no findings, or help | Continue; preview success authorizes no write. |
| `1` | Findings: audit/cost inventory findings, recommendation candidates, or verification drift | Inspect the report; recommendations remain advisory. |
| `2` | Usage error, including malformed input or invalid option combinations | Correct the invocation/input and retry. |
| `3` | Stale plan/source, failed execution, or partial apply | Re-review stale input; resume the exact plan for interrupted owner work. |

`--help` gives concise operation flags. JSON reports remain available when
findings produce exit `1`; automation must preserve stdout before evaluating
status. Opaque runtime surfaces remain reported limitations; exit `0` establishes
only the static checks. A successful apply receipt alone does not establish native reload.

## Worked maintenance examples

Run these commands from the intended project root. Each saved plan filename
must be new, with an existing parent directory. The source examples assume
`.aiwg/knowledge/release-checklist.md` is an existing semantic-memory Markdown
source published in the project index. For an external artifact root, substitute
the actual canonical source path returned by audit; `.aiwg/` paths below are
illustrative. Do not copy provider-native startup files into an executable plan.

### Global and project audit

Inspect explicit user-wide exposure first, then isolate the project. Both scans
are read-only, and an exit `1` still leaves a findings report on stdout:

```bash
aiwg memory audit --scope global --provider claude --json > global-audit.json
global_status=$?
aiwg memory audit --scope project --provider claude --json > project-audit.json
project_status=$?
printf 'global=%s project=%s\n' "$global_status" "$project_status"
aiwg memory cost --scope project --provider claude --json > project-cost.json
```

Review the global report's registered roots and the project's resolved source
locators, exposure chains and finding IDs. Global selection can inspect user
stores and registered projects; it does not enable global plan/apply. To change
an eligible registered project's source, enter that project and create a fresh
project-owned plan. Opaque/inaccessible/truncated coverage remains uncertain.

### Demote a low-use resident item

Suppose operator task reviews establish that the release checklist is rarely
needed, while an owner review confirms it is neither pinned nor a rare
obligation. Low use opens placement review; it does not justify retirement.
For an already-resident semantic-memory record, refresh its published index and
review the conditional footprint change before making a plan:

```bash
aiwg index build --graph project --force
aiwg memory cost --scope project --provider claude \
  --demote .aiwg/knowledge/release-checklist.md --json
aiwg memory plan --owner semantic-memory \
  --target .aiwg/knowledge/release-checklist.md --op demote --placement indexed \
  --reviewer operator --rationale 'Task reviews show occasional use; retain indexed retrieval' \
  --out checklist-demote.json --json
aiwg memory apply --plan checklist-demote.json --preview --json
aiwg memory apply --plan checklist-demote.json --yes --json
aiwg memory verify --plan checklist-demote.json --json
```

The expected diff is `resident/active -> indexed/active`; scope, authority and
body stay intact. The semantic owner checks its own published active record and
content digest before resident removal. A stale/absent index blocks this path.
Default line-memory and compound-memory owners lack that native proof and refuse
resident removal, even with `--link`. Demotion does not remove text already
copied into a provider's startup files; review the existing regeneration owner's
source and inspect a fresh native session before claiming runtime savings.

### Correct taxonomy without changing placement

After the prior apply completes, create a new owner snapshot for the category
correction. This changes the category to `procedure` and leaves the current
placement, lifecycle, scope and authority unchanged:

```bash
aiwg memory plan --owner semantic-memory \
  --target .aiwg/knowledge/release-checklist.md --op recategorize --category procedure \
  --reviewer operator --rationale 'Checklist is an operating procedure, not a decision' \
  --out checklist-category.json --json
aiwg memory apply --plan checklist-category.json --preview --json
aiwg memory apply --plan checklist-category.json --yes --json
aiwg memory verify --plan checklist-category.json --json
```

For promotion, explicitly select `--op promote --placement task-context` or
`resident` only after owner review establishes the needed placement and budget.
Review the same exact-plan preview and verify steps; promotion never raises
knowledge into instruction authority.

### Retire and restore retained knowledge

Suppose a source review now establishes that the indexed checklist is obsolete.
Retire it with an explicit review basis; age alone is insufficient for protected
obligations. This example follows demotion, so the source is already indexed:

```bash
aiwg memory plan --owner semantic-memory \
  --target .aiwg/knowledge/release-checklist.md --op retire \
  --reviewer operator --rationale 'Release process review confirms this checklist is obsolete' \
  --retirement-basis review --out checklist-retire.json --json
aiwg memory apply --plan checklist-retire.json --preview --json
aiwg memory apply --plan checklist-retire.json --yes --json
aiwg memory verify --plan checklist-retire.json --json
```

Expected result: lifecycle `retired`, unchanged source body, a retained tombstone
and owner history, and exclusion from ordinary retrieval. Retiring a resident
semantic item instead requires `--link <indexed-path>` identifying an active
published same-digest retained copy. Retirement never purges either source.

If a later review reinstates the checklist, target the retained source with a
new plan and apply it through the restore command:

```bash
aiwg memory plan --owner semantic-memory \
  --target .aiwg/knowledge/release-checklist.md --op restore \
  --reviewer operator --rationale 'Reviewed reinstatement for the supported release process' \
  --out checklist-restore.json --json
aiwg memory restore --plan checklist-restore.json --preview --json
aiwg memory restore --plan checklist-restore.json --yes --json
aiwg memory verify --plan checklist-restore.json --json
```

Expected result: lifecycle `active`, indexed retrieval restored, prior retirement
retained in history, and unchanged authority/scope. Verify the restore plan; the
retirement plan now describes an earlier end state.

### Recover an interrupted apply or investigate verification drift

If apply exits `3` with `partial.completed`/`partial.pending`, preserve the exact
plan and owner/coordinator journals. Once the reported owner/index problem is
resolved, rerun the same command; existing owner receipts prevent duplicate work:

```bash
aiwg memory apply --plan checklist-category.json --yes --json
aiwg memory verify --plan checklist-category.json --json
```

Use the interrupted plan here, before any later plan in the examples. If a source
or owner snapshot changed before execution, do not edit the saved plan or remove
locks/journals to force it through. Re-audit, resolve the change with the owner,
and create a new reviewed plan. If verify exits `1`, inspect its receipt/state,
history and retrieval findings; verify itself cannot repair them. Missing owner
receipts after an incomplete transaction call for resuming the original apply,
while an intentional later transition calls for verifying its newer plan.
