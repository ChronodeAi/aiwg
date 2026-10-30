# Claude Code session import

AIWG can import documented Claude Code transcript JSONL and lifecycle-hook
evidence into the normalized session catalog. The adapter was characterized
against synthetic records matching Claude Code 2.1.18 on 2026-07-27.

## Evidence and supported sources

Claude Code documents continuous local session storage under
`~/.claude/projects/<project>/<session-id>.jsonl`. `CLAUDE_CONFIG_DIR` can move
that configuration root. Each JSONL line represents a message, tool result, or
other metadata. See the official [session management
documentation](https://code.claude.com/docs/en/sessions).

Claude Code hooks expose `session_id`, `transcript_path`, `cwd`,
`permission_mode`, and `hook_event_name`. `SessionStart` also describes whether
the session started normally or through resume, clear, or compaction;
`SessionEnd` records its reason. See the official [hooks
reference](https://code.claude.com/docs/en/hooks).

The adapter supports:

- explicitly authorized project or hook roots;
- deterministic JSONL discovery without following symbolic links;
- explicit transcript and hook-file inspection and streaming;
- active append-only transcripts, with an incomplete final line ignored until
  a later import completes it;
- stable native session identity across resume;
- a new native identity for a fork, consistent with Claude Code's documented
  `--fork-session` behavior;
- lifecycle evidence from hook records, including start source, completion
  reason, model, and permission mode;
- forward-compatible preservation of unknown fields as opaque extensions.

Declared unknown major schema versions, malformed records, identity drift, and
paths outside the authorized roots fail before any catalog write. Source paths,
working directories, and transcript paths are reduced to redacted locator or
workspace classes before persistence.

## Claude web/account export (manual-export)

Claude.ai account/web data exports are a distinct source format from local
JSONL transcripts -- renaming `conversations.json` to `.jsonl` is not a
conversion, and this adapter does not accept it as one. Support was added
as a `manual-export` acquisition mode (#2565), following the same pattern
already used by the Copilot and Cursor adapters for their own account/web
exports: `manual-export` sources are never auto-discovered by
`aiwg sessions discover` -- they require an explicit, user-selected file
path, because a web export must be requested and downloaded from the
provider first.

```bash
aiwg sessions import ./conversations.json \
  --provider claude --source-id my-web-export --workspace default
```

A `.json` file passed to `import` for the `claude` provider is treated as a
web/account export (`claude-web-export-json`); `.hooks.jsonl`/`.hook.jsonl`
and other `.jsonl` files are treated as local hook/transcript sources as
before, unchanged.

Supported layout: a JSON array of conversations, each with a `uuid`,
optional `name`/`created_at`/`updated_at`, and a `chat_messages` array.
Each message carries a `uuid`, `sender` (`human` or `assistant`), and
either a `text` string or a `content` array of text blocks. This matches
one export file containing many conversations/sessions, not a
one-file-per-session assumption.

What is preserved:

- every conversation's native identity (`uuid`) as its own session, so one
  export file can and normally does become many catalog sessions;
- message identity, ordering, timestamps, and role;
- attachment/file references (`file_name`, `file_type`, `file_size`, and
  extracted text when present) as metadata.

What is explicitly not claimed: the web/account export format does not
carry original attachment bytes, only metadata about them. Records with an
attachment note this in their `metadataLoss` rather than silently omitting
it. This is a genuine format limitation, not something this adapter chose
to drop.

Fails closed with `MALFORMED_SOURCE` on: a non-array root (including a
JSONL transcript renamed to `.json`), an export with zero conversations,
or any message whose fields don't match the documented shape. Fails closed
with `DUPLICATE_NATIVE_ID` on a repeated conversation uuid within one
export file, or a repeated message uuid within one conversation -- a `uuid`
field is only useful as an identifier if it is actually unique, so a
collision is treated as a data-integrity signal worth surfacing rather
than silently accepting the later record.

## Claude admin intake walkthrough

This is the operator path from a Claude.ai account/web export download to a
verified Fortemi shard. It needs no Anthropic Admin API client and no daemon:
exports are downloaded by hand, then imported with the session catalog CLI.

### 1. Download the export

Request and download the account/web export from Claude.ai. It arrives as a
`conversations.json` file (one JSON array holding many conversations, as
described above). Save each export under its own filename in one intake
directory, for example:

```bash
mkdir -p ./claude-intake
# conversations-2026-10-01.json, conversations-2026-10-15.json, ...
```

Only `.json` (web/account export) and `.jsonl` (transcript/hook) files are
recognised for the `claude` provider. Anything else in the directory -- an
operator `notes.txt`, for example -- is skipped with a reason and never
imported.

### 2. Import one export

```bash
aiwg sessions import ./claude-intake/conversations-2026-10-01.json \
  --provider claude --source-id claude-admin-2026-10-01 --workspace default --json
```

Expected receipt: `"status": "ok"` with `data.totals` reporting the inserted
sessions and events. Repeating the same command is idempotent: the second run
inserts nothing because every record carries a stable identity.

### 3. Batch-import the whole intake directory

```bash
aiwg sessions import --from-dir ./claude-intake \
  --provider claude --source-id claude-admin --workspace default --json
```

`--from-dir` extends `sessions import`: it adds no new top-level command.
`--source-id` becomes an optional per-file prefix, so each file gets a stable
source ID such as `claude-admin/conversations-2026-10-01.json`. Every
recognised file is imported through the same single-file path (same adapter,
same redaction, same idempotency). Files already imported are skipped by
content digest before any adapter work.

Expected receipt: `"status": "ok"` with one entry per file plus a summary:

```json
{
  "contractVersion": "1.0.0",
  "command": "sessions.import",
  "status": "ok",
  "data": {
    "fromDir": "./claude-intake",
    "provider": "claude",
    "workspaceId": "default",
    "sourceIdPrefix": "claude-admin",
    "schemaVersion": "1.0.0",
    "files": [
      {
        "file": "conversations-2026-10-01.json",
        "sourceId": "claude-admin/conversations-2026-10-01.json",
        "digest": "sha256:<hex>",
        "status": "imported",
        "reason": null,
        "sessionsInserted": 3,
        "eventsInserted": 12
      },
      {
        "file": "notes.txt",
        "sourceId": null,
        "digest": null,
        "status": "skipped",
        "reason": "unrecognised extension for provider claude: expected .json (web/account export) or .jsonl (transcript/hook), got \"notes.txt\"",
        "sessionsInserted": 0,
        "eventsInserted": 0
      }
    ],
    "summary": {
      "total": 2,
      "imported": 1,
      "alreadyImported": 0,
      "skipped": 1,
      "rejected": 0,
      "sessionsInserted": 3,
      "eventsInserted": 12
    },
    "interruptedRuns": []
  },
  "error": null
}
```

Add `--dry-run` to preview the file plan (`recognised`, planned `sourceId`)
without writing anything. Repeating the batch after a successful run imports
nothing: recognised files come back as `"status": "already-imported"` with
`"reason": "content digest already imported"`, and the summary reports
`imported: 0` with zero inserts. A file that fails to import is reported as
`"status": "rejected"` with its error code; the remaining files still import.

### 4. Read back the catalog

```bash
aiwg sessions list --provider claude --workspace default --json
```

Each conversation in the export appears as its own session. The importing
project can also read another workspace's catalog with `--db`, as documented
in `docs/sessions/cli.md`.

### 5. Export a Fortemi shard

```bash
aiwg sessions export plan --workspace default \
  --out /tmp/claude-selection.json \
  <session-id-1> <session-id-2>
aiwg sessions export build --plan /tmp/claude-selection.json --out ./claude-export
aiwg sessions export verify --input ./claude-export/evidence.shard
```

The plan binds the exact selection to source/event digests; the build writes
the `.shard` archive plus a receipt; `verify` cross-checks the shard against
its receipt. The full four-step workflow, including `unpack`, is documented
under "Native session-to-Fortemi shard export" in `docs/sessions/cli.md`.

The export carries attachment metadata and extracted text, never original
attachment bytes: the web/account export format does not include them (see
"Supported layout" under "Claude web/account export (manual-export)" above).
Edited or branched conversations remain unhandled
rather than silently flattened (see "Known limitations" below).

## Consistency and replay

Transcript files are treated as provisional because Claude Code may still be
appending to them. Only complete JSON records are emitted. Import cursors and
native event identifiers make a replay with no new complete records a no-op.
Lifecycle-hook evidence is complete only after a `SessionEnd` record.

Same-session use from multiple terminals may interleave records in one
transcript. The adapter preserves source sequence and provenance rather than
claiming a stronger causal order.

## Retention and deletion boundaries

AIWG deletion tombstones catalog data only. It never edits Claude Code provider
logs.

Claude Code documents a default 30-day cleanup for local session data,
configurable with `cleanupPeriodDays`. It also documents
`CLAUDE_CODE_SKIP_PROMPT_HISTORY` and `--no-session-persistence` controls.
Removing a project transcript or changing those controls does not establish
that copies in backups, exports, editor or desktop history, synchronized
storage, or remote retention systems were removed. Purge procedures must name
and verify each system in scope; this adapter makes no broader erasure claim.

## Telemetry separation

Counts-only session telemetry from issue #1649 remains separate from transcript
acquisition. The Claude adapter does not reinterpret aggregate telemetry as
session content and does not use it to create catalog sessions or events.

## Known limitations

- Only the documented local JSONL/hook shapes and the documented
  web/account export `conversations.json` array shape are supported.
- The web/account export adapter has not been characterized against edited
  or branched conversations, since the current test fixtures don't cover
  that structure; if the real export format represents edits/branches
  differently than a flat `chat_messages` array, that case is unhandled
  rather than silently misrepresented as a normal linear conversation.
- Provider-internal fields can change without notice; unknown minor fields are
  preserved, but an unknown declared major version fails closed.
- Content redaction follows the catalog import policy. Opaque provider fields
  are preserved for provenance and therefore must be handled under the same
  data-access controls as transcript content.
- Discovery requires an explicit allowed root; it does not scan a home
  directory implicitly.
