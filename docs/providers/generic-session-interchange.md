# Generic Session Interchange

Status: manual import only

Evidence date: 2026-07-26

Tested contract: `aiwg.session-interchange` schema `1.0.0`

## Purpose

The generic adapter imports an explicitly selected AIWG interchange file when
no provider-specific adapter applies. It does not discover sources and does not
guess provider semantics from arbitrary JSON keys.

## Format

The interchange is UTF-8 JSONL. The first record is a mandatory header:

```json
{"type":"aiwg.session-interchange","schemaVersion":"1.0.0","product":"exporter-name","productVersion":"1.0.0","sourceId":"selected-source-id","exportedAt":"2026-07-26T12:00:00Z","consistency":"complete","lifecycle":"complete","workspace":{"id":"workspace-id"},"provenance":{"exporter":"exporter-name","exporterVersion":"1.0.0","sourceClass":"manual-export"}}
```

Header fields:

| Field | Required | Values |
|---|---|---|
| `type` | yes | `aiwg.session-interchange` |
| `schemaVersion` | yes | semantic version; only major `1` is supported |
| `product`, `productVersion` | yes | non-empty strings |
| `sourceId` | yes | must equal the `--source-id` passed to `aiwg sessions import` |
| `exportedAt` | yes | RFC 3339 timestamp with an explicit offset |
| `consistency` | yes | `provisional` (partial or still-changing history), `consistent-snapshot`, or `complete` |
| `lifecycle` | yes | `active`, `complete`, or `archived` |
| `workspace.id` | yes | declared workspace; recorded as provenance only (see below) |
| `provenance.exporter`, `provenance.exporterVersion`, `provenance.sourceClass` | yes | non-empty strings |
| `extensions` | no | object |

The import workspace comes from `aiwg sessions import --workspace`, not from
the header's `workspace.id`, so a file cannot choose its own authorization
scope. When `--workspace` is omitted the import uses `default`. The import
receipt reports the resolved `workspaceId` and warns when it differs from the
header's declared workspace.

An invalid header names the failing field and its allowed values. A header
with a valid `type` is never reported as undeclared input.

Following records have `type: "event"` and require `sessionId`, `eventId`,
nonnegative `sequence`, `kind`, `text`, and `lifecycle`. Timestamps must be RFC
3339 with `Z` or an explicit numeric offset. Unknown fields are retained under
the `native.generic` normalized extension.

## Safety and limitations

- Selection and allowed-root authorization are explicit; home-directory
  scanning and network acquisition are not supported.
- Unknown schema majors, arbitrary JSON, missing or duplicate identities,
  ambiguous local timestamps, malformed records, and truncated tails fail
  closed.
- Transcript text is untrusted data. It is redacted before normalized
  persistence and cannot invoke commands, tools, URLs, plugins, or workflows.
- The adapter preserves declared product, workspace, lifecycle, provenance,
  extensions, and unknown fields. It does not infer absent provider semantics.
- Raw provider data is never modified. Deleting an AIWG import removes only
  AIWG-owned normalized and derived copies according to the session lifecycle
  policy; it does not delete the manually selected export.

## Verification

Synthetic fixtures live under `test/fixtures/sessions/generic/`. They cover a
valid v1 interchange, opaque future event kinds, redaction canaries, duplicate
IDs, ambiguous timestamps, unknown schema majors, arbitrary opaque input, and
a truncated provisional file. No real-user transcript data is included.
