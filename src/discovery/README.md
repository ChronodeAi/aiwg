# Local discovery library

Import `discoverInventory` and its types from `src/discovery/index.ts` (ESM
consumers use `./discovery/index.js`). Discovery has no CLI or mutation surface.
The separate setup plan store below persists plans without performing installer
actions.

```ts
const inventory = await discoverInventory({
  workspaceRoot: process.cwd(),
  // Omit roots for shallow workspace + registry inspection.
  roots: ['/explicitly/selected/projects'],
  maxDepth: 4,
  maxEntries: 20_000,
  timeBudgetMs: 2_000,
});
```

Default scope is the current workspace and exact workspace roots in the existing
project-memory registry manifest (`projectMemoryManifestPath()`, including its
`AIWG_PROJECT_MEMORY_HOME` override). Seeds are inspected without recursion;
their memory stores are never scanned. `registrySeeds: false` disables registry
access; an array supplies previously read seeds. Only `roots` opts into recursive
scanning. No ancestors are searched. Home and filesystem roots cannot be scanned
recursively. Explicit root symlink aliases canonicalize to a single project;
nested symlinks are skipped, including provider-directory and metadata symlinks.

Mandatory exclusions cover dependencies, VCS internals, builds, caches, and
provider/AIWG payload trees. Provider paths are inspected individually using
the shared provider definitions. Contents of credentials/provider files are
never read. Only project manifests, Git indirection markers, AIWG config, and
the registry manifest are read, with a per-file byte bound.

The global entry limit conservatively counts filesystem operations (including
failed lookups, directory reads, registry and PATH checks), rather than only
projects. Zero is valid for each bound. Directory enumeration is incremental.
Deadline checks surround each operation; a timer also bounds waiting for stalled
I/O. Cleanup continues asynchronously if a timed-out operation completes later;
kernel operations cannot be cancelled. This is a discovery boundary for a stable
filesystem, not a sandbox against concurrent hostile ancestor replacement.

`vcs` describes a marker at the observed root: Git directories and Git worktree
indirection files are distinguished; external Git metadata is never read. A
seed is retained even without project markers. Scans detect Node manifests,
pnpm/Lerna workspace markers and common Rust/Python/Go/CMake project markers.
Workspace declarations report their patterns; `packageRoots` contains only
observed descendants, not expanded workspace globs. Nested undeclared packages
produce an ambiguous layout. Declared monorepos retain their layout and also
report an ambiguity diagnostic so a future interview can confirm root versus
package. Bounds can leave this list partial; inspect diagnostics and `truncated`.

The tool list comes from `knownWorkerCliExecutables`, with direct PATH checks
that require an executable regular file (package-manager executable shims are
allowed). It never executes a CLI, probes accounts, or uses the network. Missing
tools are `installed: 'no'` only after PATH inspection completes; interrupted or
inaccessible detection stays `unknown`. Local AIWG provider selections establish
`configured: 'yes'`, separately from installation. Authentication and
qualification remain unknown unless prior local `toolEvidence` is supplied.
Versions likewise remain `null` without supplied evidence. A context file alone
does not establish configuration, authentication, or qualification. All readiness
dimensions use independent `yes | no | unknown` observations.

## Setup plans

`SetupPlan` and the plan helpers are exported from the same index. A v1 plan
contains an ID, inventory ID, ISO timestamps, source-tagged answers keyed by
stable question ID, recommendations with reasons, unresolved choices, planned
actions, workspace receipts, and the original `DiscoveryInventory`. Reuse
workspace/provider-scoped question IDs across interviews and resumes; every
present answer counts, including `false`, `null`, and defaults. The interview
slice must preserve explicit answers when merging new information.

```ts
const path = await writeSetupPlan(projectDir, plan);
const saved = await readSetupPlan(projectDir, plan.id);
const actions = remainingPlanActions(saved);
const questions = unansweredPlanChoices(saved);
const changes = revalidateSetupPlan(saved, freshInventory);
```

The store uses the shared artifact-root resolver and writes
`setup/plans/<id>.json` beneath that root. It refuses an unavailable external
root without creating it or falling back. An optional environment map supports
isolated callers/tests. Writes validate a JSON snapshot, use an exclusive
temporary file with mode `0600`, sync it, then rename it over the destination.
Callers own IDs and timestamps and must serialize updates to a plan; there is
no concurrent-writer merge or apply behavior.

Readers refuse future versions with an upgrade diagnostic. `migrateSetupPlan`
is the explicit migration entry point: the pre-release v0 compatibility fixture
lacks `updatedAt` and `receipts`; migration supplies `createdAt` and an empty
receipt list respectively. Reads never rewrite migrated files. Writes accept
only v1.

Credential values are refused before any filesystem write. Use only
`{ kind: 'credential-ref', source: 'env' | 'file' | 'stdin-at-apply', name }`;
the store never opens the referenced file or resolves an environment value.
The guard reuses governance text redaction patterns, adds JWT and generated
token detection, and checks sensitive field/question names recursively,
including evidence, receipt messages, keys, and credential reference names.
Invalid references and extra reference fields are refused. Rejections never
echo rejected material. Pattern detection is conservative; callers must still
collect credential locators rather than raw values.

Action dependencies select project fields, tool fields, or paths represented
in the saved inventory. Revalidation compares only those facts against fresh
observations and returns changes grouped by action; it performs no filesystem
or tool probes. Missing paths, removed tools, changed versions/fields, and
unknown or incomplete observations require review. A path dependency must
refer to a root, manifest, observed package root, AIWG directory/config/context,
or provider file recorded by discovery. Paths absent from a complete inventory
can represent an expected absence. This does not detect content changes at an
unchanged path. Select every fact an action relies on, including its target
workspace when its continued existence matters.

`remainingPlanActions` excludes only actions with an `applied` receipt in their
own workspace. Failed, skipped, and unreceipted actions remain eligible for the
apply slice to decide retry policy. `unansweredPlanChoices` removes any choice
with an own answer entry. Both helpers preserve the original plan. Revalidation
reports all affected actions, including applied ones, for callers to reconcile;
it never clears receipts or automatically authorizes remaining actions.
