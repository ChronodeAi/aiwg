# Pi session acquisition

AIWG discovers Pi v3 JSONL session trees only inside explicitly authorized roots. The default Pi root is `${PI_CODING_AGENT_SESSION_DIR}` when set, otherwise `~/.pi/agent/sessions`; discovery recurses into Pi's per-working-directory subdirectories, and callers may select an explicit file or `--session-dir` export instead. Ingestion covers persisted session files only; live `--mode json` and `--mode rpc` event streams are consumed by the external agent-loop adapter, not by this importer.

The adapter preserves native entry IDs and parent IDs as provenance, maps messages, model/thinking changes, compaction, summaries, labels, and custom entries, and retains unknown entry types as opaque records. Tool results and custom extension data are redacted at ingestion. Unknown session majors, malformed or truncated JSONL, oversized records, duplicate IDs, symlinks, and paths outside the authorized root fail closed.

Verification lives in `test/unit/sessions/pi-adapter.test.ts` and the shared provider conformance and repository importer suites.

Pi documents the version-3 tree format, its entry types, and the default `~/.pi/agent/sessions/` layout in [Session Format](https://pi.dev/docs/latest/session-format) (last verified 2026-09-13); the adapter's known entry set matches that page. Session-directory overrides are documented in the [CLI reference](https://github.com/earendil-works/pi/tree/main/packages/coding-agent#cli-reference) (last verified 2026-09-04).
