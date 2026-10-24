# Local discovery library

Import `discoverInventory` and its types from `src/discovery/index.ts` (ESM
consumers use `./discovery/index.js`). There is no CLI or mutation surface.

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
