# Design: Native Grok Build and Hermes session discovery

**Status:** Proposed; design only  
**Date:** 2026-10-18  
**Issue:** [jmagly/aiwg#312](https://github.com/jmagly/aiwg/issues/312)  
**Baseline:** `0a2d20867`

## Context and goals

The issue reports Grok Build histories at
`~/.grok/sessions/<url-encoded cwd>/<id>/chat_history.jsonl`, a shared
`session_search.sqlite`, and `~/.grok/active_sessions.json`; Hermes has
`~/.hermes/state.db`. These are operator observations from titan/noodle on
2026-10-17, not schema qualification. This design does not inspect those stores.

Goals:

- Discover and import matching Grok Build sessions after explicit `--grok-root`
  authorization, without a manual export for each session.
- Discover Hermes through an explicitly authorized `sqlite3.backup()` snapshot.
- Keep workspace selection, provider-store authorization, import confirmation,
  and live-status evidence distinct and inspectable.
- Report native discovery support truthfully, independently of export support.
- Preserve exact-manifest import, bounded reads, deterministic replay, and privacy.

Non-goals: provider deployment changes, Grok Bot support, provider-side indexing,
cloud/API acquisition, reading credentials or configuration, process control,
background home scans, automatic first-use consent, and a general SQLite browser.
Search sees new transcript events only after authorized import/refresh; discovery
alone does not index text. No source or test changes accompany this proposal.

## Current state

References below are repository-relative, with baseline line numbers.

| Surface | Current behavior and reference |
|---|---|
| Workspace discovery | `DiscoverWorkspaceOptions` has Codex/Muse roots but no Grok/Hermes roots; both providers are in `MANUAL_EXPORT_PROVIDERS` ([workspace-discovery.ts:76](../../src/sessions/workspace-discovery.ts#L76), [line 98](../../src/sessions/workspace-discovery.ts#L98)). |
| Wiring gate | Only enumerated strategies whose adapters advertise `discover` are scanned; other providers receive export-required reports ([workspace-discovery.ts:183](../../src/sessions/workspace-discovery.ts#L183), [line 300](../../src/sessions/workspace-discovery.ts#L300)). |
| Grok adapter | `implemented`, inspect/stream only, manual-export; `discover()` throws and native locators are rejected ([grok-build.ts:30](../../src/sessions/adapters/grok-build.ts#L30), [line 94](../../src/sessions/adapters/grok-build.ts#L94)). |
| Grok CLI helper | List/search return IDs; export validates Markdown and writes exclusively. Subprocesses use no shell, 15 seconds, and 2 MB output limits ([grok-build-cli.ts:24](../../src/sessions/grok-build-cli.ts#L24), [line 43](../../src/sessions/grok-build-cli.ts#L43), [line 129](../../src/sessions/grok-build-cli.ts#L129)). |
| Hermes adapter | `implemented`, inspect/stream only; `discover()` yields nothing. Accepts snapshot JSONL marked `sqlite-backup`, rejects raw `hermes-state-db`; no backup creator exists here ([hermes.ts:86](../../src/sessions/adapters/hermes.ts#L86), [line 137](../../src/sessions/adapters/hermes.ts#L137), [line 164](../../src/sessions/adapters/hermes.ts#L164)). |
| Schema knowledge | Hermes export parser targets schema 23; an export schema does not establish the physical DB tables or migration version ([hermes.ts:18](../../src/sessions/adapters/hermes.ts#L18), [line 49](../../src/sessions/adapters/hermes.ts#L49)). |
| Sources command | Uses a separate hard-coded `providerDisposition()` table; both rows say `implemented` with no discovery operation ([sessions.ts:294](../../src/cli/handlers/sessions.ts#L294), [line 1664](../../src/cli/handlers/sessions.ts#L1664), [line 1775](../../src/cli/handlers/sessions.ts#L1775)). |
| CLI | Discovery parses existing provider roots; help/parser have no flags for these stores ([sessions.ts:190](../../src/cli/handlers/sessions.ts#L190), [line 1469](../../src/cli/handlers/sessions.ts#L1469), [line 1927](../../src/cli/handlers/sessions.ts#L1927)). |
| Integrity and refresh | Manifests hash source bytes and persist exact roots; batch import rechecks size/mtime/digest; refresh reuses prior grants ([workspace-discovery.ts:179](../../src/sessions/workspace-discovery.ts#L179), [line 368](../../src/sessions/workspace-discovery.ts#L368), [batch-import.ts:292](../../src/sessions/batch-import.ts#L292), [refresh.ts:37](../../src/sessions/refresh.ts#L37)). |
| Public output | Public manifest removes locator/root but retains workspace fields; locator redaction retains the basename ([workspace-discovery.ts:398](../../src/sessions/workspace-discovery.ts#L398), [discovery.ts:93](../../src/sessions/discovery.ts#L93)). |
| Live state | Catalog lifecycle includes `active`, but the session adapter/probe contract has no live-evidence interface ([contracts.ts:152](../../src/sessions/contracts.ts#L152), [line 404](../../src/sessions/contracts.ts#L404)). There is no Grok active-registry consumer in the inspected session code. |

Root cause: export ingestion is implemented, while native enumeration, workspace
matching, acquisition, and live evidence are absent. `implemented` is an adapter
classification, not proof of discoverability. Updating that label alone cannot
make sessions searchable. Existing [Grok](../providers/grok-build-sessions.md)
and [Hermes](../providers/hermes-sessions.md) docs describe the export boundary.

## Provider decisions

### Grok Build

Prefer a version-qualified native JSONL reader. It avoids subprocess side effects
and the existing Markdown export's missing timestamps/workspace/tool results.
The present prohibition on native reads remains until qualification lands.
The CLI export helper remains the operator-selected fallback; it is not silently
invoked, since a provider CLI may open/update its own search database or settings.
An automated export alternative needs a separate proof of read-only behavior.

1. Authorize the sessions directory itself, not Grok home. Enumerate only the
   documented two directory levels and exact `chat_history.jsonl` filename.
   Ignore `session_search.sqlite` and unrelated files; never rebuild its index.
2. Decode workspace-directory names exactly once using the qualified encoding.
   Reject malformed escapes, NUL, ambiguous encodings and traversal. Treat the
   decoded value as workspace metadata, never as a path to traverse. Compare
   canonical absolute cwd to the authorized canonical workspace, not a prefix.
   If native metadata also declares cwd, require agreement. Unresolvable or
   conflicting workspaces are inconclusive, never attached to the caller's cwd.
3. Qualify released versions using minimal synthetic records that establish
   layout, schema identification, session/event identity, timestamp units,
   append versus rewrite behavior, compaction, and incomplete-tail behavior.
   Do not infer record keys from the reported filename. An unrecognized shape
   produces `SCHEMA_DRIFT`; retain explicit export support.
4. Read a bounded, validated prefix from an open regular-file handle into a
   private immutable acquisition file. Recheck identity and prefix consistency;
   concurrent appends are deferred, a trailing partial record stays provisional,
   and interior corruption or rewrites invalidate acquisition. Native schema
   qualification must establish how this prefix maps to event identities.
5. Use provider session IDs and qualified event IDs/monotonic sequence for replay.
   Keep unknown timestamps and lineage unknown. Record loss/projection boundaries
   rather than inventing equivalence with the Markdown export.

`active_sessions.json` is a sibling of the sessions root. Authorizing the latter
must not grant parent-directory access. Add explicit file authorization through
`--grok-active-sessions`; require `--grok-root` too. Read only this regular file,
validate its qualified schema and match entries to workspace-scoped session IDs.
Expose evidence as `active` or `unknown`, with observation time, reason and basis.
An entry indicates provider-reported activity, not a verified running process.
Missing entries, stale data, invalid JSON, absent authorization, future timestamps,
or unsupported schemas mean `unknown`, never completed/inactive. Freshness uses
a proposed 120-second ceiling only if a qualified heartbeat field exists; file
mtime alone cannot make an old entry fresh. Do not probe PIDs or command lines.
Consumers must expire evidence and overlay it on catalog reads, without inserting
synthetic transcript events or permanently setting lifecycle to active.

### Hermes

`--hermes-root` explicitly authorizes `<root>/state.db` and its SQLite WAL/SHM
sidecars solely for backup. It does not authorize other Hermes-home files.
Help must disclose that backup transiently copies the whole session DB, including
other workspaces, before filtering. If that scope is unacceptable, the operator
can continue supplying a workspace-specific export.

Use a packaged helper invoking Python's standard-library `sqlite3` in isolated
mode, without importing Hermes. Connect to an escaped `file:` URI with `mode=ro`,
set query-only on the source connection, and call `source.backup(destination)`
with bounded page batches and a deadline/progress callback. Python supports
[backup while other clients access the database](https://docs.python.org/3/library/sqlite3.html#sqlite3.Connection.backup).
Keep SQLite locking enabled. Never use `immutable=1` on the live DB:
[it disables locking and change detection](https://www.sqlite.org/uri.html).
Never copy DB/WAL files independently, checkpoint, migrate, vacuum, or repair the
provider database. The [backup API](https://www.sqlite.org/backup.html) provides
a consistent completed snapshot; it does not prove a session has ended.

The helper must have no write access to the provider tree, including sidecars;
qualify the runtime/filesystem combination with a read-only source-directory test.
If WAL access requires creating or modifying SHM, fail closed rather than reopening
writable. SQLite `mode=ro` alone is not the entire sidecar write-protection policy.
Unsupported platforms keep native discovery disabled until that boundary works.

Inspect schema/version and required columns only on the private backup. Support
an explicitly qualified physical schema, not the export parser's implicit default
of 23. Query allowlisted tables/columns with parameter binding; disable extension
loading and do not execute schema-provided SQL or follow attachments. Select
workspace metadata first, then fetch messages only for canonical cwd matches.
Missing/relative/unresolvable cwd, remote routing, or conflicting workspace data
is excluded and reported in aggregate as inconclusive. No content-based matching.

Project matching sessions into the existing `hermes-consistent-snapshot-jsonl`
shape, with `snapshotConsistency: "sqlite-backup"` set only by successful helper
completion. Include native message IDs and deterministic ordering; keep active
sessions provisional even though the backup is transactionally consistent.
Delete the whole-DB backup after projection, including on error/cancellation.
Do not expose Hermes live status from absence of `ended_at`; report unknown until
a separate qualified liveness signal exists.

## Proposed CLI, API and JSON contract

Examples are proposed commands, not currently available flags:

```sh
aiwg sessions discover --workspace /work/project \
  --expected-providers grok-build,hermes \
  --grok-root /home/operator/.grok/sessions \
  --grok-active-sessions /home/operator/.grok/active_sessions.json \
  --hermes-root /home/operator/.hermes --json
aiwg sessions import-discovered --workspace /work/project --confirm --json
aiwg sessions sources --json
```

Add `grokRoot`, `hermesRoot`, and `grokActiveSessions` to
`DiscoverWorkspaceOptions`, CLI help and the value-flag parser. Resolve relative
CLI values from cwd like existing roots, then canonicalize and validate them.
No fallback through `$HOME`, `GROK_HOME`, `HERMES_HOME`, `--provider-home`, or
runtime detection grants access. `--expected-providers` selects scope, not consent.
Reject provider-specific flags when that provider is outside the selected scope.

Add an internal provider discovery strategy registry shared by workspace discovery
and `sources`. A strategy owns authorization, acquisition, and workspace matching;
adapters own inspect/stream normalization. Only advertise `discover` after the
strategy and ingest path are registered and qualified. Reuse `jsonl` and
`sqlite-snapshot` acquisition modes; preserve manual import modes.

Retain the CLI `1.0.0` envelope and legacy `disposition: "implemented"`. Add a
`discovery` object to each `sources` provider row, sourced from the shared registry:

```json
{
  "provider": "hermes",
  "disposition": "implemented",
  "supportedOperations": ["discover", "inspect", "stream"],
  "discovery": {
    "disposition": "discoverable",
    "authorization": "explicit-root",
    "requiredFlags": ["--hermes-root"],
    "liveDetection": "unsupported"
  }
}
```

`sources` is a capability inventory and never probes disk. `discoverable` requires
an installed qualified strategy, not merely an adapter. Otherwise report
`manual-export` (or `unsupported` if no ingest path). A particular discovery run
can still be unauthorized, unavailable, or incomplete. Keep the existing provider
report dispositions/statuses; missing consent uses `export-required` plus
`SHARED_ROOT_AUTHORIZATION_REQUIRED`, with preflight `authorization-required`.
Only a fully scanned, matched-empty scope gets `checked`/`NO_WORKSPACE_SOURCES`.
Incomplete scans use `not-checked`; extend preflight handling to preserve partial
coverage instead of treating accepted sources as complete coverage.

Write native manifests as `schemaVersion: "1.1.0"`; retain reading/import of
legacy `1.0.0` manifests unchanged. Update the version validator and manifest
identity calculation together. Older binaries must reject new manifests.
Add private `providerAuthorizations` with canonical roots, exact auxiliary file
grants, workspace and operation (`native-read` or `sqlite-backup`), plus
`acquisition` per source: method, origin identity, qualified schema, consistency,
and snapshot digest. Include all grants/acquisition fields in manifest identity.
Keep `authorizedRoots` for origin roots; source `authorizedRoot` identifies only
the owned staging directory. Refresh must not confuse staging access with a
provider read grant; native refresh requires the new explicit operation grant.

Strategies return file-backed source descriptors for staged `grok-build-native-jsonl`
or existing Hermes snapshot JSONL locators. Persist and verify snapshot
size/mtime/digest through the existing batch importer. Use stable source identity
derived from provider, canonical workspace, origin root identity, native session
ID and locator class; digest identifies a generation, not a new logical source.
Snapshot continuity requires native identity-based cursors and idempotent inserts
before enabling `sourceContinuity: "snapshot"` ([contracts.ts:423](../../src/sessions/contracts.ts#L423)).
Keep native and manual-export identities distinct; do not promise cross-format
deduplication without qualified event identity.
Keep source-mtime ranges explicitly labeled as file inventory times; snapshot
creation times must never be presented as session activity timestamps.

Add optional public source `liveEvidence` with `state: active|unknown`,
`basis: grok-active-sessions|none`, `observedAt`, `expiresAt`, and `reasonCode`.
For `unknown`, expiry may be null. Treat this as advisory data outside the content
generation hash so polling cannot trigger redundant transcript imports. Refresh
live observations even when batch import reports unchanged. Surface them through
the catalog list/read path as expiring evidence; historical lifecycle stays separate.

Public output includes only approved provider/status/count/digest/time fields,
opaque source IDs and fixed locator labels. Strip private grants, auxiliary file
paths, backup paths, decoded directory names, titles, snippets, SQL values and
provider diagnostics. Existing caller-selected workspace fields remain explicit.
Use fixed labels rather than basename redaction for these native sources.

## Security, authorization and storage lifecycle

- Bind each grant to the canonical workspace and exact provider root/file identity;
  no sibling or prefix workspace matches. Revalidate containment and file identity
  when opening, and reject symlinks in root and descendant components, special
  files, path traversal, changed roots and link races. Use opened-handle checks;
  pathname validation followed by an unchecked reopen is insufficient.
- Persist reusable grants only in owner-controlled local manifests. A digest
  proves integrity, not consent: imported/untrusted manifests require fresh root
  authorization. Refresh reuses only trusted saved operations and exact roots,
  never infers a native backup grant from a legacy export or staging root.
- Provider stores remain read-only. Credentials/settings files and network access
  are outside the allowlist. Subprocesses use argument arrays, closed stdin,
  minimal environment, bounded stderr capture and sanitized error codes. Do not
  run provider commands as a side effect of scanning.
- Resolve owned staging beneath the configured session artifact store, not a
  hard-coded project directory. Keep directories `0700`, files `0600`, exclusive
  creation and atomic publication. Raw DB backups are ephemeral. Retain only
  matching-session projections referenced by a saved manifest for retry/import.
- `--dry-run` performs authorized reads and ephemeral backup/projection, cleans
  temporary files, and persists neither manifest, grants, snapshots nor catalog.
  Failed operations clean partial staging. Successful imports release projections
  after receipts commit; unfinished manifests expire after a proposed 24 hours.
  Cleanup must respect concurrent imports/leases; missing/expired snapshots
  require rediscovery, never silent reacquisition during exact-manifest import.
- Treat transcript text as untrusted data throughout normalization. Discovery,
  logs, receipts and errors never echo it; imported searchable text continues
  through existing redaction policy. Never log environment values or raw rows.

## Resource limits and failures

Initial limits are implementation budgets to validate, not measured guarantees:

| Resource | Proposed bound |
|---|---|
| Enumeration | 10,000 directory entries/provider; Grok depth fixed at two |
| JSONL/projection | 8 MiB/record, 1,000,000 records, 1 GiB/provider, nesting 64; enforce while streaming |
| Active registry | 1 MiB, 10,000 entries, nesting 16 |
| Hermes backup | 1 GiB destination; 256 pages/step; 5-second busy budget; 30-second total deadline |
| Invocation | 60-second total deadline; one backup/provider at a time; cancellation closes handles/kills helper |
| Scratch | 2 GiB total including backup and projection; check capacity and enforce growth limits |

No unbounded `readFile`, `fetchall`, or retry loop. A hard deadline also bounds
backup restarts under frequent writes. Limits never silently truncate coverage.

| Failure | Result and recovery |
|---|---|
| No root authorization | Zero provider reads; authorization-required; explicit flag remediation |
| Missing root/DB, permission or read-only WAL failure, helper absent | `unavailable`; safe reason code; no writable/export fallback |
| Unsupported schema/encoding, ambiguous workspace | `not-checked` with aggregate excluded/inconclusive counts; qualify schema or select export |
| Corruption, limit, lock timeout, cancellation | Mark affected provider incomplete; discard its unpublished projections; preserve other providers' valid results |
| Grok append/rewrite during read | Defer appended tail; bounded reacquisition on rewrite, then incomplete; never fabricate complete coverage |
| Live registry missing/malformed/stale | Histories remain usable; `liveEvidence.state = unknown` |
| Snapshot tamper/expiry/missing file | Reject exact-manifest import with existing integrity errors; require rediscovery |

Fatal argument/authorization errors fail the command. Provider-local failures
return an inventory with explicit boundaries, not an overall coverage claim.
Preserve `--min-coverage` enforcement on list/report commands. Reuse existing
`SOURCE_*`, `SCHEMA_DRIFT`, `RESOURCE_LIMIT_EXCEEDED`, and `UNSUPPORTED_OPERATION`
error codes; reason codes distinguish timeout, missing helper and schema mismatch.

## Test plan and phased rollout

This document adds no tests. Each implementation work item must land its tests
before advertising its corresponding capability. Fixtures use temporary stores
and minimal synthetic text; never copy operator transcripts or credential files.

| Phase / issue-sized work item | Tests and release gate |
|---|---|
| 1. Capability truth and contract | Extend `test/unit/cli/handlers/sessions.test.ts`, `sessions-coverage.test.ts`, and session `coverage-preflight.test.ts`: unwired providers remain manual; registered strategies alone advertise discover; inventory does no disk reads; legacy JSON remains readable. |
| 2. Qualify Grok/Hermes layouts | Record supported release/schema ranges, synthetic layout/row mappings and active-registry heartbeat semantics. Extend `grok-build-adapter.test.ts`, `hermes-adapter.test.ts`, `provider-conformance.test.ts`; unknown schemas fail closed. This gates native readers, not this design document. |
| 3. Acquisition and manifest grants | Extend `workspace-discovery.test.ts`, `discovery-readers.test.ts`, `repository-importer.test.ts`; add focused native-discovery/helper suites beside them. Cover no-consent zero reads, other-workspace isolation, URI/encoding edge cases, symlinks/races, tampered grants, 1.0/1.1 round trips and limits/cancellation/cleanup. |
| 4. Grok discovery and replay | Wire root/native reader; test workspace equality, append/partial tail/rewrite/compaction, native IDs, deterministic refresh and no duplicate catalog events. Assert provider files unchanged and search becomes populated only after confirmed import. Keep export-only until native identity tests pass. |
| 5. Hermes backup discovery | Exercise a real temporary WAL DB with concurrent commits, including committed data remaining in WAL; assert backup consistency and matching-only projections. Test read-only directory/sidecars, Python missing, busy deadline, schema drift and message ordering; verify provider DB/WAL/SHM bytes and directory entries unchanged. Wire only after these pass. |
| 6. Live evidence, refresh and docs | Test explicit auxiliary-file grant, active/unknown outcomes, stale/future/no heartbeat, expiry on unchanged imports, restart and no permanent active lifecycle. Update CLI help, provider session docs and getting-started guide; add targeted CLI regression coverage. |

Enable each qualified provider independently through explicit flags. Preserve
existing exports and revoke native grants by rediscovering without those providers;
revocation stops future scans and does not delete catalog history. If a released
schema fails qualification, disable its native strategy and report export fallback
without touching provider data. Broad validation runs on the Dev Lab host; local
implementation checks use typecheck and only affected Vitest suites.

## Open questions for the product owner

1. Approve the native Grok reader preference, with export fallback, and provide a
   supported release range for qualifying JSONL identities and registry heartbeat?
2. Accept separate `--grok-active-sessions` authorization, or prefer an explicit
   parent-home grant with a narrowly documented allowlist?
3. Accept transient whole-DB Hermes backup, Python as an optional native-discovery
   dependency, and fail-closed behavior where sidecar writes cannot be prevented?
4. Should cwd-less/remote Hermes sessions remain excluded, or gain a future explicit
   per-session workspace binding? Proposed first release excludes them.
5. Approve the additive `sources.discovery` contract, native manifest version 1.1,
   24-hour unfinished-projection retention and initial resource budgets?
