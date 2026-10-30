# Grok Build session ingestion

> "Find my Grok Build sessions for this workspace, export the session I choose,
> and import its transcript into AIWG. Explain what the export leaves out."

The assistant can use the documented CLI path below. Native storage ingestion
is experimental, unqualified, and disabled by default. No released Grok Build
version is qualified for native ingestion. AIWG registers `grok-build`
separately from `grokbot`.

## Command reference: documented CLI export

The `sessions` command can call the public Grok Build CLI and return only session
IDs, keeping private titles, prompt snippets, and CLI diagnostics out of its JSON response:

```bash
aiwg sessions grok-list --workspace "$PWD" --json
aiwg sessions grok-search "query" --workspace "$PWD" --json
aiwg sessions grok-export <session-id> --workspace "$PWD" --out /authorized/exports
aiwg sessions import /authorized/exports/<session-id>.md \
  --provider grok-build --source-id grok-build-<session-id> --workspace "$PWD"
```

The commands invoke `grok --no-auto-update` without a shell, cap output at 2 MB
and execution at 15 seconds, reject unsafe or symlinked `$GROK_HOME` and output
roots, and never overwrite an existing export. `--grok-bin` accepts an absolute
operator-selected executable path. The export is written with owner-only file
permissions. CLI listing/search remains Grok's workspace-scoped behavior;
AIWG does not inspect its native session store on this path.

For a session ID from a separately captured headless run, use `aiwg sessions
grok-id <file> --format json|streaming-json`. It reads a bounded regular file,
requires one consistent UUID `sessionId`, and returns only the ID. It does not
run a prompt or include headless response content in its output.

Equivalent direct Grok CLI commands are:

```bash
grok sessions list
grok sessions search "query"
grok export <session-id> <session-id>.md
```

Keep the UUID session ID as the export filename. AIWG uses it as native
identity, parses only the documented CLI Markdown headings (`User`,
`Assistant`, and `Tools`), and fails with `MALFORMED_SOURCE` or `SCHEMA_DRIFT`
when the filename or export shape changes. Reimporting the same file is
deterministic and idempotent. Unknown top-level `##` headings and malformed or
oversized tool blocks fail closed before a CLI export is written or imported.
Because raw message text can itself contain Markdown headings, this
conservative check can reject a legitimate transcript; retain the original
export for review rather than silently treating an unfamiliar section as data.

Grok Build resolves its own storage under `$GROK_HOME/sessions` (default
`~/.grok/sessions`). AIWG does not read that tree by default. Use `grok sessions
list` or `search` for discovery and `grok export` for acquisition. Experimental
native access requires the separate opt-in and explicit roots below; it does
not follow session-store symlink escapes or inspect Grok Bot and Cursor stores.

## Export limits and privacy

The CLI Markdown export contains prompts, assistant output, and compact tool
call summaries. It does not expose timestamps, model or Grok version, working
directory, tool results, compaction records, parent/child lineage, subagent
records, attachments, or file snapshots. AIWG leaves those fields unknown and
records the loss in `native.grok-build` provenance; it does not infer them.

Prompts, assistant output, tool summaries, attachment names, and file paths can
still contain private source code, personal data, secrets, or workspace
structure. Review the Markdown before importing it and authorize only its
containing directory. Native snapshots and tool output would increase that
privacy exposure substantially. The experimental reader imports native message
content, including tool output, so review the source before opting in. It does
not acquire attachment bytes or file snapshots and does not claim to qualify
their ownership or compaction, lineage, or subagent semantics.

## Verification evidence

The conformance fixtures under `test/fixtures/sessions/grok-build/` are
sanitized synthetic CLI Markdown projections aligned to public harness revision
`4247f661689354b831191f11eeeac8424993fe3d`. Their `coverage.json` maps
TUI, headless, ACP, compaction, resume/fork, subagent, attachments/snapshots,
partial, and corrupt cases, and marks native-only evidence as missing. These
are not claimed as captures from a released binary. The adapter tests cover exact
heading parsing, prompts, assistant output, tool calls, native identity,
provenance, unavailable fields, changed output, unsupported native/Cursor
locators, symlink escape rejection, deterministic replay, and idempotency.

## Experimental native discovery: synthetic v1 only

> "I understand this native schema is synthetic and unqualified. Opt in for
> this command, discover sessions only under the root I authorize, and preview
> the import before I confirm it."

Set `AIWG_GROK_BUILD_NATIVE_EXPERIMENTAL=1` for **each** native operation,
including discovery, inspection, import, refresh, and tail. Only the exact value
`1` enables it; an unset variable, `0`, or `true` leaves it disabled. Root
authorization alone does not opt in. Without the opt-in, `sessions sources`
advertises CLI export only, workspace discovery reports
`GROK_BUILD_NATIVE_EXPERIMENTAL_DISABLED`, and native reads fail with
`UNSUPPORTED_OPERATION` plus the opt-in and CLI-export alternative.

```sh
AIWG_GROK_BUILD_NATIVE_EXPERIMENTAL=1 \
aiwg sessions discover --workspace /work/project \
  --expected-providers grok-build --grok-root /home/operator/.grok/sessions --json
AIWG_GROK_BUILD_NATIVE_EXPERIMENTAL=1 \
aiwg sessions import-discovered --workspace /work/project --dry-run --json
AIWG_GROK_BUILD_NATIVE_EXPERIMENTAL=1 \
aiwg sessions import-discovered --workspace /work/project --confirm --json
```

With the opt-in, `sessions sources` reports
`GROK_BUILD_NATIVE_EXPERIMENTAL_ENABLED`, native discovery and JSONL acquisition;
the warning still states that no released-binary schema or version range is
qualified. This opt-in enables fixture development, not a claim of released
Grok Build compatibility. Sanitized captures from a released binary are still
required before native ingestion can be promoted to qualified support.

`--grok-root` authorizes the sessions directory itself (never Grok home, `$HOME`,
`GROK_HOME`, or `--provider-home`). Discovery enumerates only the documented two
levels and the exact `chat_history.jsonl` filename, ignores `session_search.sqlite`
and unrelated files, and never runs `grok export`. The url-encoded cwd directory
is decoded exactly once and matched against the authorized workspace; other
workspaces never attach. Only `chat_history.jsonl` records in the synthetic v1
shape (`schemaVersion: 1` with `sessionId`/`seq`/`role`/`content`) import — real
store bytes were never inspected, so anything else fails closed.

With the same experimental opt-in, `--grok-active-sessions` optionally
authorizes the synthetic `active_sessions.json` schema (read-only,
bounded) for live detection. Presence plus a fresh `lastHeartbeatAt` (120-second
ceiling) reports `active`; anything else reports `unknown`. This is
provider-reported activity, not a verified running process, and it is advisory
manifest data outside the manifest identity hash. Authorizing the sessions root
never grants its parent: a sibling registry file is unread without the explicit
file flag. Fixtures live under `test/fixtures/sessions/grok-build/native-layout/`
and `native-active-sessions.json` (see that directory's README).
