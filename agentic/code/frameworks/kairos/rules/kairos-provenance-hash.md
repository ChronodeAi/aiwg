---
id: kairos-provenance-hash
name: Kairos Provenance Hashes
description: Every proposal, packet and finding carries the sha256 of its sources and a UTC recorded_at.
enforcement: high
triggers:
  - "hash the sources"
  - "provenance for this proposal"
  - "recorded_at timestamp"
  - "verify packet integrity"
---

# Kairos: Provenance Hashes

## Scope

Applies to every JSON record under `.aiwg/kairos/`: proposals, evidence bundles, gate evaluations, review packets, decisions, observation receipts, conformance receipts and findings.

## Requirements

- `recorded_at` is UTC in ISO 8601 with `Z` or `+00:00`, written when the record is created. Do not backfill it from memory.
- `sources[]` lists `{ref, sha256}` for every input read. Hash exact bytes: `shasum -a 256 <file>` or `node <framework>/scripts/kairos-records.mjs sha256 <file>`. For an HTTP response, hash the raw body you saved, not a re-serialized copy.
- A review packet also carries `contract` and `contract_sha256` (the gate policy it was judged against), the same fields and meaning as the AIWG gate record (`schema`, `recorded_at`, `gate`, `status`, `recommendation`, `human_go_signoff`, `contract`, `contract_sha256`).
- A finding carries `output.sha256` of the saved raw output and a `fingerprint` computed as documented in `schemas/finding.schema.json`.
- Records are append-only. A correction is a new record that references the superseded record's sha256; never edit a signed packet or a filed finding in place.
- Validate before relying on a record: `node <framework>/scripts/kairos-records.mjs validate <file>`. The validator checks shape, hashes' format, fingerprints and credential leaks; it cannot prove a command was run.

## Required response

A record without hashes or `recorded_at` is incomplete: finish it or mark it `draft` in its file name. Never cite an unhashed record as evidence in a packet or issue.
