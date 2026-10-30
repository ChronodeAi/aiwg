# Signed D29 access fixtures (#3747)

These files are additive schema fixtures alongside the frozen D29 studies.
`valid.json` describes the signed access/v2 shape; its signature is deliberately
non-verifying. `test/unit/decision/d29-access.test.ts` loads that body and signs it
with a fresh test-generated key and `createGenesisKeyring`. No host key or
committed private key is used.

`unsigned.json`, `missing-bundle.json`, `bad-time.json` and `unknown-field.json`
are negative schema fixtures read by the same test. The decision schema catalog
registers all five. Historical access/v1 records were not rewritten or re-signed.

The [scorer-pin disposition](../../../../docs/decision/d29-signed-access-disposition.md)
records the nine dependent fixture changes and their before/after byte digests.
