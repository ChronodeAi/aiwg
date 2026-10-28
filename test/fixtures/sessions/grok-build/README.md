# Sanitized Grok Build CLI export fixtures

These synthetic fixtures reproduce the documented output of `grok export <id>
[file]` at public harness revision
`4247f661689354b831191f11eeeac8424993fe3d`. The upstream renderer emits only
exact `## User`, `## Assistant`, and `## Tools` sections. The fixture text
contains no account, credential, machine, or repository data.

The `coverage.json` manifest maps synthetic CLI projection cases for TUI,
headless, ACP, compaction, resume/fork, subagent, attachments/snapshots, partial,
corrupt, and changed-heading inputs. It explicitly marks which cases are only
loss assertions and still lack native evidence. The Markdown contract intentionally
omits TUI/headless/ACP mode, timestamps, model/version, cwd, compaction markers,
lineage, subagents, attachments, snapshots, and tool results. Tests assert that
AIWG reports those fields as unavailable rather than reconstructing them. These
synthetic exports do not claim to qualify those omitted native scenarios.

Direct `$GROK_HOME/sessions` fixtures are absent by design. Native parsing stays
disabled until sanitized files from a released binary establish the complete
schema and a qualified version range.

## Synthetic native store fixtures (unqualified)

`native-layout/` reproduces only the *documented directory layout*
`<sessions>/<url-encoded cwd>/<uuid>/chat_history.jsonl` (operator observation,
2026-10-17), never observed record bytes. The `chat_history.jsonl` record shape
(`schemaVersion: 1` with `sessionId`/`seq`/`role`/`content`, optional
`timestamp`/`toolName`/`toolCallId`/`id`) and `native-active-sessions.json`
(`schemaVersion: 1` with `sessionId`/`cwd`/`lastHeartbeatAt`) are AIWG-defined
synthetic v1 contracts: real stores were never inspected, so anything outside
these shapes fails closed and no compatibility with released binaries is claimed.
`session_search.sqlite` is present only as an enumeration decoy (empty, never
opened). Tests copy or rebuild this layout under `os.tmpdir()/mkdtemp`
with the encoded cwd derived from the test workspace.
