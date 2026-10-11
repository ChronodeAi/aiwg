# Grok Bot session ingestion

AIWG registers `grokbot` with two acquisition paths:

- **Manual export** (`manual-export`): an authorized AIWG generic session
  interchange file, imported the same way for every provider that has one.
- **Native replica** (`grokbot-native-transcript-replica`, #2970): an
  evidence-gated locator for the Grok Bot desktop app's local transcript
  cache, selected through Linux discovery or an explicit single-file import.

## Native store layout (verified: Grok Bot desktop 0.68.1, Linux, Electron app "sand")

- Store root: `$XDG_CONFIG_HOME/Grok Bot/sand-client-persistence/` (default
  `~/.config/Grok Bot/...`). **Linux only.** macOS and Windows equivalents are
  unverified; AIWG never guesses them, and native discovery reports
  unavailable there.
- One JSON document per logical key, filename `<key>.blob`, where `<key>` is
  the RFC 4648 section 6 base32 encoding of the key string — lowercase, no
  padding.
- Two key shapes are ever decoded and opened by this adapter:
  - `sand.client.slice.account.grok%7Cuser_<ACCOUNT>.transcript.replicas.<conversation-uuid>` —
    one conversation. The only key class selected as an importable source.
  - `sand.client.slice.account.grok%7Cuser_<ACCOUNT>.roster.last-roster` —
    the account's conversation index (`{schemaVersion, value: {rows: [{id,
    name, description, title, createdAt, updatedAt, lastMessageId, ...}]}}`).
    Never opened or imported by this adapter (no session content); kept out
    of `discover()` results entirely.
- During native discovery, every other key — composer-drafts, send-journal,
  experiments, ui-layout, `sand-secrets.json`, `box-secrets-*`, `Cookies`, Local/Session Storage, and
  anything else — is **never decoded for content and never opened**.
  `~/.grokbot` (daemon credentials) is a separate directory and is never
  referenced.

### Replica document shape

```json
{
  "schemaVersion": 1,
  "value": {
    "entries": [{ "kind": "...", "id": "...", "timestampMs": 0, "requestId": "...", "seq": 1 }],
    "epochHint": "...",
    "acceptedSequenceHint": 0,
    "persistedAt": 0,
    "precedingTimestampMs": 0
  }
}
```

Entry kinds mapped to normalized records:

| Native `kind` | Role | Text |
|---|---|---|
| `send-message` | `assistant` | By `message.type`: `text` → `message.content`; `widget` → `[widget] <prompt> -> <respondedValue>`; `email-draft`/`slack-draft` → `[<type>] <subject/target>\n<body>`; `attachment` → `[attachment] <file_name> (<url>)`; `user-form` → `[user-form] <title>`; `secret-request` → `[secret-request] <label> (value not exported)` — the secret value itself is never read or exported, only `entry.secretProvided` (boolean) |
| `message` | `entry.role` (`user`\|`assistant`) | `entry.content`; `entry.fromAgent` (bot-to-bot) is carried as `participant` and in `extensions` |
| `user-attachment` | `user` | `[user-attachment] <file_name> (<width>x<height>, <byteSize> bytes)` |
| `event` | `system` | `[event] <event.kind or .type>`; full (sanitized) event body in `extensions` |
| `notice` | `system` | `entry.text` |

Any other `kind` is skipped — never fabricated into a record — matching the
project's convention for unknown marker types.

### Bounded cache and consistency

The replica is a bounded client-side cache (observed max ~200 entries). When
`entries[0].seq > 1` and `precedingTimestampMs > 0`, the cache has evicted
older entries: the adapter reports `consistency: provisional` and never
claims complete history. Otherwise it reports `complete`.

### Workspace association

Grok Bot conversations carry **no workspace/cwd field** anywhere in the
native format — unlike Claude Code, Cursor, Codex, or Factory, there is no
evidence linking a conversation to a project directory. This adapter follows
the existing precedent for other account-scoped, non-workspace-filtered
native locators (`pi`, `deepseek-harness`: `workspace-discovery.ts` applies no
per-source workspace match for either): every conversation found under the
authorized root surfaces to whichever workspace runs `aiwg sessions discover`.
`inspect()` never sets `declaredWorkspaceId` for native sources — there is no
evidence to report.

### Idempotent re-import across the sliding window

Because the cache can evict old entries between two `discover` runs, the
file's bytes are not append-only — it may shrink, and Grok Bot may rewrite a
replica via a rename-swap that changes its inode. Three mechanisms keep
re-import non-duplicating:

1. The adapter declares `sourceContinuity: 'snapshot'` (contracts.ts), which
   tells the shared importer to skip its generic size-shrink,
   file-identity (inode), and prefix-rewrite checks for this source — those
   checks assume append-only growth, which does not hold here. The importer
   still fingerprints the current file and reports `unchanged-replay` or
   `validated-append` based on whether its content digest matches the prior
   checkpoint, and it still enforces the source-generation and
   adapter-version guards.
2. `workspace-discovery.ts` assigns native Grok Bot sources a
   conversation-id–derived `sourceId` (not a content-digest one), the same
   convention already used for OMP's native sessions, so the catalog's
   per-source checkpoint survives the window sliding and any inode change.
3. `stream()` resumes from each entry's native, monotonic `seq` — not a byte
   position — and tags every record's cursor as an opaque provider-native
   resume token (`native:<seq>`), which the importer stores verbatim
   (`positionKind: 'provider-native'`) instead of reinterpreting as a byte
   offset. Combined with the catalog's identity-keyed insert, re-importing
   after the window has slid (or after a rename-swap) can only add genuinely
   new entries.

## How to import

### Manual export (unchanged)

1. Export or copy an authorized session transcript into the AIWG generic
   session interchange format (`type: aiwg.session-interchange`, schema
   major `1`).
2. Pass that file explicitly to `aiwg sessions import` with provider
   `grokbot` and locator class `manual-export`.
3. Keep the export under an authorized workspace root.

### Native discovery

1. `aiwg sessions discover --workspace <path> --grokbot-root <authorized
   sand-client-persistence root>` — no default root is assumed; this flag is
   required.
2. Review the discovery manifest (`.aiwg/sessions/discovery-manifest.json`
   by default).
3. `aiwg sessions import-discovered --workspace <path> --confirm` to import
   the exact authorized manifest.

### Single native replica

Pass an authorized transcript replica directly, keeping its original
base32-encoded `.blob` filename:

```bash
aiwg sessions import /authorized/path/<key>.blob --provider grokbot --source-id <id> --workspace <path>
```

Use the same `--source-id` for later imports of that conversation. Add
`--dry-run --json` to preview the source. The filename must decode to a
transcript-replica key; other filenames retain the manual-export path and
must contain valid AIWG generic interchange data.

Fail-closed behavior, preserved from the manual-export-only era:

- Any `locatorClass` other than `manual-export` or
  `grokbot-native-transcript-replica` is rejected.
- Unknown `schemaVersion` majors fail with `UNKNOWN_SCHEMA_MAJOR`.
- Malformed documents fail with `MALFORMED_SOURCE`.
- Native discovery never opens or reads non-allowlisted files in the store
  root. Explicit single-file imports treat non-allowlisted filenames as
  manual exports, never as native replicas.

## Tested contract

AIWG adapter contract: `1.0.0`. Synthetic fixtures cover:

- authorized generic interchange import (`valid-v1.jsonl`)
- malformed opaque input (`opaque-input.jsonl` → `MALFORMED_SOURCE`)
- unknown schema major, manual export (`unknown-major-v2.jsonl` → `UNKNOWN_SCHEMA_MAJOR`)
- rejection of non-`manual-export`/non-native locator classes
- native: a complete replica, a truncated (`seq > 1`) replica, a bot-to-bot
  `fromAgent` message, draft/widget/secret-request `send-message` subtypes,
  an unknown `schemaVersion` major, and decoy non-allowlisted files
  (composer-drafts-shaped key, and a non-base32 `sand-secrets.json`-style
  name) with content that would raise an error if ever opened — proving
  discovery never touches them. CLI tests cover native single-file preview,
  catalog import, and decoy rejection through the manual-export path.
- idempotent re-import: streaming with a prior `seq` cursor emits only the
  entries after it, and the evicted-prefix (truncated) case is distinguished
  from the complete case.

## See also

- `docs/providers/generic-session-interchange.md` — the manual-export wire
  format shared across providers.
- `docs/providers/omp-sessions.md` — the identity-keyed `sourceId` precedent
  this adapter reuses.
