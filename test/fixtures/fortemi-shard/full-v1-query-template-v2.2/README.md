# Knowledge Shard 2.2.0 full-v1 consumer corpus

Source: Fortemi/fortemi commit `b88084407751153e67a9279fff9303cc3db70474`,
`tests/fixtures/shards/full-v1-query-template-v2.2/`.
The two JSON files are copied verbatim; `PROVENANCE.txt` records the source pin.
Their SHA-256 pins are checked by `test/unit/artifacts/fortemi-shard-export.test.ts`:

- `embedding_sets.json`: `f279cad22517395194c6a5dc327b4531bd089e151b9141324c94f01e81bacf32`
- `embedding_configs.json`: `bc76206df48215d0da7a3c944874d7af5b6e01bb07df8b5849869025b7d25f89`

The test composes these components with the existing `aiwg-full-v1.shard`, updates
manifest counts/checksums and the exact 2.2.0/full-v1 tuple, then imports into clean
PGlite snapshots through AIWG's public consumer. Export and a second clean import
preserve both component files byte-for-byte. Additional cases cover null/absent
fields, internal/external ownership, invalid input before database access,
non-full profiles, stored-field edits, and older supported versions.

Use `importAiwgFortemiKnowledgeShard`, `exportAiwgFortemiKnowledgeShardWithReport`
and `validateAiwgFortemiKnowledgeShard` from AIWG's package API. The consumer uses
Core's existing snapshot tables and transactional importer; it never downgrades
the stored authority tuple. The validation view adapts newer embedding fields to
the pinned Core 2026.7.15 validator. Snapshot records retain those fields intact.
An absent or null `vector_source` has internal ownership; its wire representation
is retained rather than rewritten. Explicit downgrade exports fail closed.

Run the existing WASM test lane:

```sh
npx vitest run --config config/vitest.wasm.config.js test/unit/artifacts/fortemi-shard-export.test.ts
```

This qualifies AIWG's local full-v1 reader only. Schema 2.2.0 remains an
unreleased candidate under Fortemi/fortemi#1217. Existing release receipts and
the index producer's default 2.0.0/full-v1 tuple are unchanged.

Local validation for #3157:

- `npm run typecheck`: passed.
- `npm run build:cli`: passed.
- WASM command above: 24 passed, 0 failed.
- Neighbour command below: 201 passed, 1 existing skip, 0 failed.
- `npm run lint:test-registration`: passed, 1507 files assigned.
- `npm run lint:test-process-timeouts`: passed, 0 unbounded calls.

```sh
npx vitest run --config config/vitest.config.js \
  test/unit/artifacts/fortemi-shard-export.test.ts \
  test/unit/artifacts/browser-export.test.ts \
  test/unit/artifacts/fortemi-core-parity.test.ts \
  test/unit/artifacts/fortemi-core-security.test.ts \
  test/unit/artifacts/fortemi-core-sync.test.ts \
  test/unit/artifacts/fortemi-core-discover-show.test.ts \
  test/unit/sessions/fortemi-shard-recovery.test.ts \
  test/unit/sessions/knowledge-shard.test.ts test/unit/ci
```

The default config excludes WASM tests; the explicit WASM run is required in
addition to the neighbour run.

Result line for Fortemi/fortemi#1217 (not posted):

> AIWG #3157 full-v1/2.2.0: PASS (24/24 shard tests), canonical corpus pinned to Fortemi/fortemi@b88084407751153e67a9279fff9303cc3db70474; query_template/vector_source/provider_dimension retained byte-equivalently; invalid vector_source rejected before database calls; un-upgraded profiles fail closed. Local candidate qualification only; implementation is uncommitted.
