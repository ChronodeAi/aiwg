# Account-scoped Grok Bot sessions (#316)

Status: proposed; product decision required. This document changes no runtime
behavior. Discovery and refresh still copy authorized Grok Bot conversations
into each workspace catalog.

## Confirmed cause

Grok Bot replicas contain no workspace identity. The adapter deliberately leaves
`declaredWorkspaceId` unset. Authorizing a persistence root authorizes all its
allowlisted replicas; it does not establish project ownership.

The current implementation compounds that distinction:

- `src/sessions/workspace-discovery.ts`, `discoverWorkspaceHistories`: Grok Bot
  has no workspace filter. Native source identity hashes
  `grokbot-native-source-v1`, **workspace ID**, and conversation ID. Two workspaces
  discovering the same replica therefore produce different source IDs.
- `src/sessions/importer.ts`, `normalizeBatch`: session identity depends on source ID,
  and imported sessions receive the caller's workspace ID. The duplication is
  reflected in session identities, not just file storage.
- `src/sessions/contracts.ts`, `SessionSchema` and `AuthorizedScope`: sessions
  require a nonempty workspace ID; authorization has no host scope discriminator.
- `src/sessions/batch-import.ts`, `importDiscoveryManifest`: every source in a
  batch imports into the manifest's single workspace.
- `src/sessions/refresh.ts`, `refreshSessionCatalog`: incremental refresh restores
  previously authorized roots and rediscovers all eligible replicas. Filtering
  only the interactive discovery invocation would not survive maintenance.
- `src/cli/handlers/sessions.ts`: import verifies the manifest's workspace;
  default storage is a project catalog, and reads select workspace scope.

Removing workspace ID from source identity alone cannot deduplicate independent
SQLite databases. Sharing a database with `--db` alone also leaves the distinct
workspace-derived identities. Using a synthetic workspace directory as a host
catalog would misrepresent ownership and supply no workspace reference contract.

## Recommended direction: explicit host ownership

Prefer an opt-in user-scope catalog for native Grok Bot replicas. Account
conversations can span projects or have no project, so host ownership reflects
the available evidence and does not require assigning every conversation.

This is larger than an adapter fix: it introduces a second authorization scope,
shared reads, and migration of existing identities. Implement it after agreeing
the following contract, with host scheduling coordinated with #310.

### Proposed contract

1. An operator explicitly enables host discovery and authorizes each Grok Bot
   persistence root. No default root scan, implicit account access, or network
   acquisition is added. Manual exports and explicit single-file workspace
   imports retain their existing authorization path.
2. Introduce an explicit account/host scope in persisted session, discovery, and
   import contracts. Do not encode it as a fake filesystem workspace. Select a
   user-private catalog location through the project's user-data path convention;
   keep a location override for scheduled maintenance. Exact flags and path are
   implementation decisions after scope approval, not supported CLI today.
3. Native identity includes provider, account identity, and conversation identity,
   independent of workspace, content digest, and cache location. The locator
   classifier currently exposes only conversation ID; extend filename-only
   classification to retain account identity. Do not assume conversation UUIDs
   are globally unique across accounts. Relocating an authorized root must not
   reset conversation identity or authorize the replacement automatically.
4. Preserve snapshot continuity, provider-native sequence cursors, adapter/version
   guards, and the strict filename allowlist. Host scope must not cause roster,
   unrelated blob, or credential reads.
5. A workspace may explicitly reference an authorized host catalog. A reference
   points to existing host session identities; it creates no local session,
   event, checkpoint, or transcript copy. A reference must not authorize another
   root/account or silently expose every account on the host.
6. Workspace discovery reports referenced account history separately from native
   workspace history. Provider coverage must distinguish unavailable references
   from checked workspace sources. A missing host catalog must not trigger a
   fallback copy or implicit catalog creation.
7. Host queries return account history. Workspace-local queries retain project
   scope; an explicit inclusive read can resolve authorized references. Search
   and analytics that combine catalogs deduplicate by host session/event identity,
   including when multiple workspaces reference the same conversation. Results
   preserve scope so account history is not presented as project evidence.
8. The host refresh imports each replica once using the existing catalog writer
   lease mechanism. Workspace refresh resolves references and never imports those
   replicas. Persist the scope and account authorization in manifest identity so
   refresh and resume cannot broaden access. An unchanged replica adds no events;
   a sliding window adds only new sequences, as today.
9. Referencing a conversation grants no host mutation authority. Removing a
   workspace reference removes that association only. Host deletion, tombstone,
   restoration, purge, and export require explicit host authorization. Workspace
   tags and derived outputs need a defined relationship to shared host records.

### Existing catalogs and manifests

Opt-in must define a transition, rather than silently reinterpret old workspace
authorization as host authorization. Proposed transition:

1. Inventory existing native Grok Bot sources and preview account/conversation
   groups using allowlisted locator metadata; do not print transcript content.
2. Explicitly authorize host discovery, then import and validate its catalog.
   Legacy workspace copies may contain evicted events absent from the current
   bounded replica. A migration must reconcile retained history, sequence and
   event conflicts, tags, receipts, tombstones, and derived references before
   claiming those copies are replaceable. Re-reading the current replica alone
   is insufficient.
3. Explicitly replace affected workspace root grants with host references and
   create new manifests. Old saved manifests and resumable batches must not
   silently reintroduce copies after this transition. Record a supersession
   boundary checked by import and refresh, including caller-supplied manifests.
4. Preview any later cleanup separately. Do not automatically delete or purge
   existing copies. During migration, report legacy copies distinctly; do not
   claim aggregate counts are deduplicated until they are reconciled or excluded.

Existing behavior outside the opt-in remains a compatibility question. Leaving
legacy root grants active indefinitely means #316 remains reproducible there;
the release must state the boundary clearly.

## Smaller alternative: one workspace owner per conversation

If the host scope is too large for 2026.11, approve explicit workspace mapping
instead. A single operator-owned mapping must assign each account/conversation
to at most one canonical workspace. Separate per-workspace allowlists permit the
same assignment in every workspace and cannot guarantee host-wide uniqueness.

The mapping must filter by filename before fingerprinting or opening replicas.
Unassigned conversations remain unimported; no workspace is inferred from
transcript text, titles, or process cwd. Persist a reviewed mapping snapshot and
its digest in the manifest identity, and use it during refresh and resume.
Changed ownership needs explicit rediscovery and reconciliation of prior copies;
it must not silently create a second owner or delete the first owner's history.

This avoids shared-catalog queries but introduces exclusive ownership policy,
operator configuration, and incomplete collection of unassigned conversations.
For the #310 host scheduler to import every replica once with this option, every
replica must have an owner and the scheduler must route each source to that
workspace exactly once. Unknown conversations need a reported unassigned state.

## Decisions needed before implementation

- Choose host ownership with explicit references (recommended), or exclusive
  workspace ownership. The former supports conversations without a project; the
  latter can fit a narrower release but requires maintained assignments.
- Decide whether references select whole authorized accounts or individual
  conversations, and whether inclusive reads are explicit on each query.
- Approve the compatibility policy for legacy root-only manifests: continued
  copying until opt-in migration, or an announced transition that blocks native
  workspace refresh until an ownership choice is recorded.
- Define treatment of retained legacy history and workspace-specific tags and
  derived references before removing any existing copy from aggregate results.

No runtime changes are proposed for merge until these choices are resolved.

## Required implementation tests

Use minimal synthetic accounts, conversation IDs, and records alongside existing
session suites. Do not use live transcripts or account stores.

- Two workspace references to one host conversation produce one host session and
  event set, zero workspace copies, and one result/count in combined analytics.
- Two accounts with the same conversation ID remain distinct; cache relocation
  and workspace path changes preserve host identity.
- Refresh of an unchanged source is idempotent; window eviction and rename-swap
  add only new sequences. Concurrent host refresh respects the writer lease.
- Root authorization alone grants no new host access. Missing, unauthorized, or
  redirected references fail without importing or broadening authorization.
- Legacy manifests and resumed batches cannot recreate copies after migration;
  history evicted from the live replica survives approved reconciliation.
- Removing a reference leaves host history intact; workspace mutation commands
  cannot mutate host sessions. Workspace-only queries preserve their scope.
- Manual exports, explicit single-file imports, and other providers retain their
  existing behavior; native discovery still ignores non-allowlisted files.
- For the mapping alternative, test two workspaces sharing one root, unassigned
  conversations, conflicting/changed owners, refresh and resume with a saved
  mapping, and the host scheduler's single-import routing.
