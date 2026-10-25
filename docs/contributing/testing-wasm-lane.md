# WebAssembly test lane (#3073)

The default Vitest pool uses worker threads. CI runs 81094 and 90363 aborted
Node with V8's fatal `jit_page_->allocations_.erase(addr) == 1` check in
`ThreadIsolation::JitPageReference::UnregisterAllocation`, called from
`UnregisterWasmAllocation` (exit 132/133). No individual test was attributed.
Run 90363 included `fortemi-shard-export.test.ts` in flight. A V8 allocation
bookkeeping race during worker-thread teardown is the leading hypothesis,
not a confirmed upstream diagnosis.

`config/test-lanes.mjs` assigns runtime WebAssembly users to
`config/vitest.wasm.config.js`, excluded from the base threads config.
`npm run test:wasm` runs them in an isolated fork through the same private
TMPDIR/leak gate, setup and CI reporters. The required `wasm` CI job runs
once, outside the four default shards, and gates `build`.

## Runtime inventory

The inventory searched `test/`, imported `src/`, the lockfile and installed
dependency source for PGlite, `WebAssembly`, `.wasm`, SQLite, ONNX and tokenizers.

| Tests / dependency | Runtime finding | Lane |
| --- | --- | --- |
| `test/unit/artifacts/fortemi-shard-export.test.ts` | `ArchiveManager.create()` → Core's default storage factory → `createPGliteInstance()` → lazy `@electric-sql/pglite` + vector → `PGlite.create()`. Confirmed WebAssembly instantiation. | WASM forks |
| Session shard export/recovery, marketplace exchange, browser export and Core query tests | Core converters, validators, tar helpers and `openShard()` use JavaScript records/archives. Core imports PGlite lazily; these APIs do not create a database. | Existing lanes |
| Artifact/session/storage SQLite tests | `better-sqlite3` is the native backend, not WebAssembly SQLite. | Existing lanes |
| `embedding-index`, `embedding-dedup`, `profile-embed` tests | Optional `@xenova/transformers`/HNSW peers are absent from the locked default install. No ONNX/model/tokenizer instantiation in that install. The optional peer can bring `onnxruntime-web` and native `onnxruntime-node`; optional-feature execution requires a separate inventory if enabled. | Existing lanes |
| Provider isolation / cockpit fixtures / writing patterns | WebAssembly denial policy, runtime labels or prose only. | Existing lanes |

Installed Core is 2026.7.15 and PGlite is 0.4.6 (`package-lock.json`).
The only installed `.wasm` files are PGlite's `pglite.wasm` and `initdb.wasm`.
An offline Node probe wrapping WebAssembly compilation/instantiation methods
recorded zero calls after importing Core and four `instantiate` calls after
creating a memory archive and querying `SELECT 1`.

The guard in `test/unit/testing/wasm-lane.test.ts` follows static local value
imports, re-exports and literal dynamic imports/requires. It detects PGlite,
Core database entry points, direct WebAssembly calls and literal WASM loads.
It checks the default/forks union and disjointness, registration ownership,
and required CI wiring. When introducing a new WASM-backed dependency, extend
the detector and inventory; computed module names and new third-party wrappers
still require review.

## Node/V8 patch status

`ci/digests.txt` and the canonical workflow pin Node 24.15.0. Local validation
uses Node 24.22.1; that version alone is not evidence of an upstream fix.
No offline Node 24.x changelog or V8 issue/fix reference for this exact check
was available in the worktree or installed dependency documentation. Per the
task's offline-only documentation restriction, no network lookup was made.
Whether a later Node 24.x patch contains a fix **needs checking** against the
[Node changelog](https://github.com/nodejs/node/blob/main/doc/changelogs/CHANGELOG_V24.md)
and [V8 issue tracker](https://issues.chromium.org/issues?q=UnregisterWasmAllocation).
Those are follow-up references, not verified fix citations. Keep the process
isolation mitigation and current container pin until that is verified.

Local commands:

```sh
node tools/testing/run-default-lane.mjs --maxWorkers=4
npm run test:wasm
npm run lint:test-registration
```
