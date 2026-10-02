# Muse Code session ingestion

AIWG registers `muse` with explicit export import and evidence-gated native
discovery. The adapter ingests explicit `muse export` trajectory JSON documents
supplied by the operator, gated on the document's `export_schema_version` major
(currently `1`); unknown majors fail closed with `UNKNOWN_SCHEMA_MAJOR`, as
with peer native-export adapters. Native discovery is available only when the
operator explicitly authorizes the verified sessions root with `--muse-root`.
AIWG does not scrape home directories for this provider, does not assume a
default root, and never probes `~/.muse`.

## How to import

1. Export the session from Muse Code. On an interactive terminal, `muse
   export` opens the same session picker as `muse resume`; `--last`,
   `--session`, and `--out` skip the picker:
   - `muse export --last`
   - `muse export --session <session-uuid> --out trajectory.json`
   - `muse export --redacted --out share.json` for the share-safe variant
     (payload strings run through redaction rules before they leave the
     trust boundary).
2. Pass the exported file explicitly to `aiwg sessions import` with provider
   `muse` and locator class `manual-export`.
3. Keep the export under an authorized workspace root.

Inspect and stream succeed only for that authorized file. Calling the Muse
adapter's `discover()` without an explicitly authorized root throws
`UNSUPPORTED_OPERATION` with remediation to select a file explicitly or pass
`--muse-root`.

## Native discovery

`aiwg sessions discover --workspace <path> --muse-root <path>` explicitly
authorizes a Muse sessions root such as `~/.local/share/muse/sessions`. When
authorized, discovery enumerates only this bounded shape:

```text
<muse-root>/YYYY/MM/DD/<session-id>/session.jsonl
```

Discovery does not follow symlinks and skips junk files, nested subagent logs,
wrong-depth files, and directories that do not match the date/session layout.
Discovered native sources use locator class `muse-native-session-log`.

Workspace matching is evidence-only. AIWG matches a native Muse log to the
requested workspace only from workspace facts inside the log, currently
`payload.record.workspace_root` from `runtime.session.metadata` or
`session.workspace_branch.observed`, and `payload.record.cwd` from
`runtime.session.route_facts`. `session.opened` records are useful identity
evidence but do not carry a path, so they are not sufficient. If a log has no
workspace/cwd/root evidence, discovery does not guess from the file path and the
source is not selected for that workspace.

## Trajectory shape

The adapter follows the documented export format from the Meta [audit agent
sessions recipe](https://dev.meta.ai/docs/cookbook/audit-agent-sessions) and
does not invent fields the docs don't show:

- Top level: `export_schema_version` (integer), `redaction`, `exporter_version`
  / `session_build` (`display` strings), `session_terminated_abnormally`
  (boolean), per-stream `sessions` summaries (`session_id`, `turn_count`,
  `step_count`, `session_end`), ordered `events`, and `diagnostics` counters.
- Each record event carries an envelope `{sequence, id, causation_id, stream,
  recorded_at, record_type, durability, payload_type, payload}`; the effective
  event kind is `payload.event.kind`, falling back to `payload_type` (a stream
  fact such as `approval_wait.effect.started`). Events are attributed to
  their own `envelope.stream.id`, falling back to `sessions[0].session_id`
  only when the stream block is absent. Gap markers carry `"envelope": null`
  and are skipped.
- Muse Code 1.4.0 writes `recorded_at` as epoch microseconds (converted to
  RFC 3339 on import) and `causation_id` as a string or `null`. Export
  `retained_frame` events carry a transaction frame (`children`,
  `transaction_id`, `content_sha256`) instead of a record envelope; like gap
  markers, they are skipped. Native `session.jsonl` retained frames decode
  `children[].record_json` and emit those record envelopes.

## Preserved provenance

Approvals, tool runs, and model-lifecycle facts are preserved under
`extensions["native.muse"]` with provenance fields, including:

- `side_effect_intent`: `operation` (`tool:<name>`), `policy_decision`
  (e.g. `allow:policy`, `allow:llm_judge`).
- `decision_applied`: `decision`, `policy_result`, `decision_source`
  (`kind`, e.g. `llm_judge`, with `prompt_version`, `params_version`,
  `context_digest`).
- `approval_wait.effect.terminal`: `outcome`.
- Document-level provenance: `exportSchemaVersion`, `redaction`,
  `exporterVersion`, `sessionBuild`, `terminatedAbnormally`, `diagnostics`.

A trajectory whose log recorded no orderly `session.end`
(`session_terminated_abnormally: true`) inspects as `provisional`; an
orderly export inspects as `complete`.

## Multi-stream behavior (live evidence)

Verified 2026-09-24 against a real `muse export` from Muse Code 1.3.0
(`exporter_version`/`session_build` display `Muse Code 1.3.0 (3c572bc734)`),
a parent session that spawned three parallel subagents (567 events: 552
record + 14 gap + 1 retained_frame):

- The document carries exactly one `sessions[]` summary per exported parent
  session. Subagents appear only inside `sessions[0].accepted_spawns[]` as
  spawn handles (`subagent_id`, `agent_path`, `role`, `parent_session_id`),
  never as extra `sessions[]` entries.
- Every merged record event carries its own `envelope.stream.id` (always the
  parent session id in the probe), so the importer attributes per event from
  the envelope and only falls back to `sessions[0].session_id` when the
  stream block is absent.
- Subagent tool runs are NOT merged into the parent export. Only
  `subagent.control.*` records (spawn/attest/bound/result) are merged; the
  child work lives in `subagent/<child_session_id>/session.jsonl` under its
  own stream id.
- `subagent_id` is the spawn handle; `child_session_id` (from
  `subagent.control.child_session_bound`) and `subagent_session_id` (from
  `start_attested`) are the child session identity, naming the nested log
  directories. They are distinct values and must never be conflated. The
  adapter preserves both, plus `source_session_id`, under
  `extensions["native.muse"]`.
- Gap markers carry `"envelope": null`; the adapter skips them and never
  fabricates records for them.

To import a subagent's work, export its nested log separately
(`muse export --session <parent-log-dir>/subagent/<child_session_id>/session.jsonl`)
and import it as its own manual-export stream. Automatic nested-log
ingestion is future work; nested sessions are joined via
`child_session_bound`.

## Native log root (verified 2026-09-25)

Verified on disk against an installed Muse Code 1.4.0. Each session is a
directory:

```text
$XDG_DATA_HOME/muse/sessions/YYYY/MM/DD/<session-id>/   (default ~/.local/share/muse/sessions)
  session.jsonl                  durable event log
  cli-<uuid>.log                 CLI diagnostics (hooks, MCP, rules, skills loading)
  tool-outputs/                  spilled tool output
  session.peer-history.sqlite3   cross-session message history
  cron.db                        scheduled tasks
  approval-review/
  subagent/<child_session_id>/session.jsonl   (when subagents ran)
```

`muse exec --session-id <uuid>` pins the directory name. A session index
lives at `$XDG_DATA_HOME/muse/session-index.db`. `session.jsonl` mixes three
line shapes: record envelopes (the same envelope `muse export` and
`muse exec --json` emit), omission markers (`omitted_record`,
`retained_marker: "omitted_live_only"`) for ephemeral records that were not
persisted, and retained transaction frames whose children are
JSON-encoded record strings. Because that format is internal, native import is
evidence-gated: it is available only for an explicitly authorized
`--muse-root`, and it parses fail-closed. Record-envelope lines are mapped like
export records; retained frames decode `children[].record_json`; omission
markers are skipped and counted in provenance diagnostics. The documented
export remains supported:

```bash
muse export --session ~/.local/share/muse/sessions/2026/09/25/<session-id>/session.jsonl --out trajectory.json
```

No `~/.muse` (or similar) root exists or is assumed. An evidence-gated
`--muse-root` discover path, analogous to `--codex-root`, is the only native
discovery entry point.

## Tested contract

AIWG adapter contract: `1.0.0`. Synthetic fixtures cover:

- authorized export trajectory import (`valid-v1.json`) — approvals, tool
  runs, and lifecycle events preserved with provenance
- malformed opaque input (`malformed.json` → `MALFORMED_SOURCE`)
- unknown schema major (`unknown-major.json` → `UNKNOWN_SCHEMA_MAJOR`)
- rejection of unsupported locator classes
- discover unsupported without an explicit `--muse-root`
- explicit `--muse-root` native discovery using locator class
  `muse-native-session-log`, with workspace matching only from log evidence
- cursor-based resume across streamed events
- live multi-stream shape (`multistream-v1.json`, replicating the real
  1.3.0 export) — per-event `envelope.stream.id` attribution, null-envelope
  gap markers skipped, spawn handle vs. child session id kept distinct
- real Muse Code 1.4.0 export (`live-1.4.0-v1.json`, scrubbed from a
  `muse export --redacted` of a live run) — epoch-microsecond timestamps,
  null causation ids, and a retained transaction frame that is skipped

Synthetic fixtures are records of the documented trajectory shape; the
multi-stream rules above were verified against a real Muse Code 1.3.0
export. No credentials were used.
