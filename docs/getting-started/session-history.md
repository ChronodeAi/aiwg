# Import AI session history

> **First time using AIWG?** Begin with [Install, Connect, and Verify](install-connect-verify.md). This guide assumes AIWG is already installed and connected to this project.

Use the session catalog when you want one privacy-aware timeline across
multiple AI providers.

Install the catalog's SQLite runtime once and verify that its native module
loads:

```sh
aiwg features install sqlite
aiwg features info sqlite --json
```

The installer uses a platform prebuild when one is available. On platforms
without a compatible prebuild, `better-sqlite3` falls back to `node-gyp`; that
requires Python 3, `make`, and a C/C++ compiler supported by your Node
platform. Install those prerequisites and repeat the command if the runtime
load check fails. AIWG keeps this native dependency in its user-owned optional
feature root rather than adding it to every base installation.

From the project root, preview discovery first:

```sh
aiwg sessions discover --workspace "$PWD" --dry-run
```

Claude, Cursor, and Factory histories are discovered only below workspace-keyed
provider roots. Codex keeps sessions in a shared root, so authorize it
explicitly:

```sh
aiwg sessions discover \
  --workspace "$PWD" \
  --codex-root ~/.codex/sessions \
  --json
```

The command reports every provider, including unavailable and manual-export
providers, and saves an immutable manifest unless `--dry-run` is present.
Review it, preview the exact batch, then confirm:

```sh
aiwg sessions import-discovered --workspace "$PWD" --dry-run
aiwg sessions import-discovered --workspace "$PWD" --confirm
```

For non-interactive automation, `--yes` is equivalent to `--confirm`. Imports
are resumable and idempotent:

```sh
aiwg sessions import-discovered --workspace "$PWD" --resume --yes
```

Read commands infer an unambiguous current project, so the normal follow-up is:

```sh
aiwg sessions list
aiwg sessions timeline --gap 30m
aiwg sessions search "decision" --control-events exclude
```

Both list and timeline report whether coverage is complete, partial, stale, or
unknown. Use `--min-coverage 0.95` when an audit should fail below a threshold.
If inference reports multiple workspace candidates, rerun with the exact
`--workspace` shown in the diagnostic.

The catalog contains normalized AIWG copies. Discovery and import never modify
provider histories, and source paths are redacted from public command output.
Rejected entries in `import-discovered --json` include an optional `detail`:
resource limits report `limit`, `configured`, and `observed`; byte limits also
report `setting` and `origin` (`flag`, `env`, `config`, or `default`); schema failures
report `issues` containing only `path` and validator `code`. Paths use dotted
field names and array indexes, with `<root>` for document-level failures.
Hand-written checks use `custom`; invalid JSON uses `invalid_json`. At most
20 validator issues are included. The same detail appears in the diagnostic
string and is preserved in stored batch runs and import failure receipts.
For example, `{"limit":"maxBytes","configured":1024,"observed":2048}`
identifies an authorized byte-limit rejection without exposing source content.
Muse workspace inspection failures also retain this detail when available.
Imports default to 64 MiB per record and 1 GiB (1,073,741,824 bytes) per source. Configure
`sessions.import.max_record_bytes` and `sessions.import.max_source_bytes`, or
pass `--max-record-bytes` and `--max-source-bytes` to `sessions import`,
`sessions import-discovered`, or `index refresh`. You can also set
`AIWG_SESSIONS_IMPORT_MAX_RECORD_BYTES` and `AIWG_SESSIONS_IMPORT_MAX_SOURCE_BYTES`
to decimal byte counts, using the same integer ranges as config. Precedence is
CLI flag > env var > workspace config > default. A source cap of `0` from any
origin means unlimited and still streams JSONL imports. See the [config reference](../configuration/aiwg-config.md#sessions).
To skip a Codex rollout before reading it, add its native session ID or an
absolute path glob to `sessions.import.exclude`. For example, either entry skips
the same rollout:

```json
{
  "sessions": {
    "import": {
      "exclude": [
        "12345678-1234-1234-1234-123456789abc",
        "~/.codex/sessions/**/rollout-*-12345678-1234-1234-1234-123456789abc.jsonl"
      ]
    }
  }
}
```

IDs match exactly using discovery metadata or the filename; sources are never
parsed to decide exclusions. Path globs support `*`, `**` and `?`, and `~`
expands to home. `AIWG_SESSIONS_IMPORT_EXCLUDE` adds comma-separated entries.
Repeatable `--exclude <id-or-glob>` adds entries for `sessions import-discovered`
and `index refresh`:

```bash
aiwg sessions import-discovered --workspace "$PWD" --confirm \
  --exclude 12345678-1234-1234-1234-123456789abc \
  --exclude '~/.codex/sessions/**/rollout-2026-10-18*.jsonl'
aiwg index refresh --only sessions --exclude '~/.codex/sessions/**/rollout-2026-10-18*.jsonl'
```

Discovery, import and refresh report these sources as `excluded`, with the
matching entry and kind (`session-id` or `path-glob`). They have their own
`excluded` count and do not count as rejected or errors, cause partial-import
warnings, or leave a sticky checkpoint. A previously rejected source now
matching the list becomes excluded. Rediscover after removing a discovery
exclusion to include that source again.

Use `aiwg sessions --help` for the complete command and JSON contracts.

## Ask questions about collected history

Use `aiwg discover "spelunk session data"` and `aiwg show skill session-explore`
for questions such as “where did we decide this?”, “which tool kept failing?”,
or “what changed between provider sessions?”. The skill covers scoped FTS5
queries, pagination, timelines, tool/HITL analytics, citations and coverage gaps.

`session-analyst` and the `session-investigation` flow collect and synthesize
bounded evidence. `session-harvest` previews extraction and carries reviewed
candidate versions through memory promotion. See the
[exploration recipes](https://git.integrolabs.net/roctinam/aiwg/src/branch/main/agentic/code/addons/aiwg-utils/skills/session-explore/references/recipes.md)
for acquisition, comparison, investigation, maintenance and handoff examples.

When rebuilding a catalog, retain its saved discovery manifest and use
`aiwg sessions import-discovered --workspace "$PWD" --manifest <saved-manifest> --carry-forward <old-catalog> --db <new-catalog> --confirm`.
This rereads available sources and re-redacts history stored only in the old
catalog. Keep the old copy until receipt counts, rejected sources, and redaction
checks are reviewed. See [the rebuild procedure](../sessions/cli.md).
