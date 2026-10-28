# Following native session events

```sh
aiwg sessions tail <session-id> --follow
aiwg sessions tail --provider claude --latest --workspace /work/project --follow --json
aiwg sessions tail <session-id> --follow --import
```

Tail resolves an existing catalog session (internal ID, exact native ID, or
unique prefix), then reads its provider source from the last committed cursor
for that source and adapter version. `--latest` selects the most recently updated
session for the provider in the selected/inferred workspace, with the catalog's
stable ID tie-break. Account-scoped sessions resolve through saved host-catalog
references.

Native paths come from the existing discovery manifest. `--manifest <file>`
selects a saved manifest; configured `sessions.discovery_manifests` are also
searched. For older direct imports, explicitly authorize the native source with
`--input <file>`. The catalog stores a redacted locator, so tail cannot recover
an unsaved pathname from the catalog alone.

Without `--follow`, tail reads the currently available suffix and exits.
`--follow` polls every 500 ms and exits on SIGINT or the caller's abort signal.
There is no daemon or watcher. JSON mode emits one versioned `sessions.tail`
envelope per normalized event, as JSONL. An empty suffix produces no event rows.
Human output includes timestamp, provider, kind, and sanitized text.

Read-only mode opens SQLite read-only and keeps progress in memory. Restarting
tail replays from the catalog cursor. `--import` explicitly acquires the existing
import lease and sends normalized batches through the transactional importer;
its continuity and resource checks continue to apply. The source cursor advances
across every record, including records for other sessions in a shared source;
only the selected session is printed. Importing also commits those other records
through the existing source-wide checkpoint path.

Every registered adapter currently advertises `stream`, including exporters
that can follow changes to an explicitly selected export file. This does not
grant access to unsupported internal stores or create a provider export.
An adapter without `stream` returns `UNSUPPORTED_PROVIDER`, naming the provider.
Warp exports lack a native session ID; tail supplies the catalog identity to
keep it stable when the exported document grows.

## Source and cursor investigation (#3228)

The table cites each adapter's `stream()` and resume implementation. Numeric
cursors count emitted records unless specified otherwise; they are not timestamps.

| Provider | Stream entry point | Cursor implementation |
| --- | --- | --- |
| Claude | `src/sessions/adapters/claude.ts:169` | `claude.ts:183`, emitted-record index at `:213` |
| Codex | `src/sessions/adapters/codex.ts:111` | `codex.ts:119`, emitted-record index at `:169` |
| Muse | `src/sessions/adapters/muse.ts:275` | Native emitted-record index `muse.ts:298`; export raw-event position `:397` |
| Grok Bot | `src/sessions/adapters/grokbot.ts:266` | Monotonic native sequence parsed at `grokbot.ts:280`, emitted as `native:<seq>` at `:308`; snapshot continuity `:198` |
| Pi | `src/sessions/adapters/pi.ts:52` | Byte boundary `pi.ts:85`; legacy raw-line index also accepted at `:59` |
| Copilot | `src/sessions/adapters/copilot.ts:85` | Normalized-record slice `copilot.ts:88` |
| Cursor | `src/sessions/adapters/cursor.ts:145` | Emitted-record index `cursor.ts:213`; export slice `:226` |
| Factory | `src/sessions/adapters/factory.ts:108` | Emitted-record index `factory.ts:142`; API slice `:156` |
| Hermes | `src/sessions/adapters/hermes.ts:158` | Emitted-record index `hermes.ts:195`; API slice `:210` |
| OpenCode | `src/sessions/adapters/opencode.ts:134` | SSE emitted-record index `opencode.ts:229`; export slice `:243` |
| OpenClaw | `src/sessions/adapters/openclaw.ts:128` | Normalized-record slice `openclaw.ts:135`; JSONL emitted-record index `:210` |
| OpenHuman | `src/sessions/adapters/openhuman.ts:113` | Emitted-record index `openhuman.ts:156` |
| Grok Build | `src/sessions/adapters/grok-build.ts:85` | Native emitted-record position `grok-build.ts:102`; Markdown counts tool records individually at `:113` and messages at `:129` |
| OMP | `src/sessions/adapters/omp.ts:60` | Byte boundary emitted at `omp.ts:93` |
| DeepSeek Harness | `src/sessions/adapters/deepseek-harness.ts:66` | Byte boundary emitted at `deepseek-harness.ts:104` |
| Warp | `src/sessions/adapters/warp.ts:56` | Normalized-record slice `warp.ts:59` |
| Devin Desktop | `src/sessions/adapters/windsurf.ts:66` | Normalized-step index `windsurf.ts:95` |
| Generic | `src/sessions/adapters/generic.ts:129` | Byte cursor at `generic.ts:187`, legacy event index at `:141` |

`sessions show` resolves the catalog identity at
`src/cli/handlers/sessions.ts:477`, then reads stored events at `:508`.
`SessionRepository.listEvents()` (`src/sessions/repository.ts:1515`) joins
committed import runs and orders by sequence and event ID.

`sessions timeline` reads catalog inputs at `src/cli/handlers/sessions.ts:443`.
`SessionRepository.listTimelineInputs()` (`src/sessions/repository.ts:1594`)
joins visible sessions and committed events, ordering by event time and sequence.
`deriveSessionTimeline()` (`src/sessions/timeline.ts:34`) derives activity
segments from those stored events. Neither command follows the provider source.

The catalog checkpoint lookup is `src/sessions/repository.ts:2219`: the latest
committed `import_runs` checkpoint for `(source_id, parser_version)`.
`getBatchCheckpoint()` at `:2229` additionally scopes staged/committed progress
to a batch run. `ImportCheckpointSchema` (`src/sessions/contracts.ts:216`)
describes the cursor, record/byte counts, position kind, versions, and continuity
metadata. The importer resumes at `src/sessions/importer.ts:234` and preserves
byte/native/explicit adapter cursors at `:253` through `:269`.

Redaction and image extraction now share
`src/sessions/normalization.ts:12` between tail and import; events pass through
`sanitizeSessionEvent()` at `:44`. This extraction keeps the importer under
500 lines. The existing large handler receives only an import, help, and dispatch.

## Verification scope

`test/unit/sessions/tail.test.ts` appends synthetic fixtures under `mkdtemp`
for every registered streaming adapter, plus Grok Build Markdown. Snapshot
formats append logical entries by rewriting their JSON documents. Tests check
delivery within two seconds, no duplicate replay during polling, unchanged
catalog bytes/checkpoints, unsupported adapters, and explicit import commits.
`test/unit/cli/handlers/sessions-tail.test.ts` covers selection, redaction,
authorization, JSON/human output, and cancellation through the real handler.
