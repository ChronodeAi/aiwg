# Grok Build health fixtures

`stream.ndjson` and `manifest.json` are the existing synthetic 1.0.50
documentation vectors. The following are scrubbed live captures supplied for
#2994 from an authenticated **grok 1.0.38** run on **2026-10-25**:

- `live-1.0.38-stream.ndjson`: `--output-format streaming-json`, prompt:
  `Run the shell command 'echo hi' then reply with exactly: ok`
- `live-1.0.38-result.json`: `--output-format json`, a separate single-result
  capture returning `ok`; its prompt was not supplied with the evidence.

Scrubbing replaces `signature`, `sessionId`, `requestId`, and `toolCallId`
with stable `fixture-<field>-<number>` placeholders, preserving equality and
distinctness across both files. No additional account/agent identifiers were
present. Shell `current_dir` and nonempty `output_file` paths become stable
paths under `/synthetic/grok-capture/`, removing machine, user and embedded
session identifiers; empty paths remain empty. Each `available_commands`
list retains its first two tools and first two commands. No event, field or
null was removed; event order, text chunks, nested shapes, usage and cost
numbers are otherwise preserved. JSON whitespace was normalized.

The stream has 26 events: `available_commands` ×4, `text` ×14, `tool_call`
×1, `tool_call_update` ×4, `usage` ×2, `end` ×1. The tool begins `pending`;
updates use `null`, `in_progress`, `in_progress`, `completed`. The first
`usage` precedes the tool call; both usage events omit `messageId` and
`stopReason`. `end.stopReason` is `end_turn`, with aggregate usage, two
turns, cost fields (including `total_cost_usd_ticks`) and `modelUsage`.

Replay is offline through the headless transport, shared health observer,
and direct adapter parity tests. This establishes compatibility with this
captured 1.0.38 stream, not live timing, permission-mode behavior, or live
qualification of the documented 1.0.50 direct-shell invocation profile.
