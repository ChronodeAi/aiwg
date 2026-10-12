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
