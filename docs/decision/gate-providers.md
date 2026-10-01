# Bundle metric providers (addon/extension)

Experimental, default-off offline harness (#2831). Addons and extensions MAY
ship metric-provider code; packs stay declarative. Core providers remain the
default: bundle loading runs only when the caller passes
`allowBundleProviders: true` (or sets `AIWG_GATES_BUNDLE_PROVIDERS=1`). With
no opt-in, resolution and evaluation are byte-identical to the core-only path.

## What is implemented

- Manifest declarations (`gateProviders` in `src/extensions/manifest.ts`,
  Zod plus TS): `{id, version, module, description, review | reviewFile}`.
  `module` is a bundle-relative `.mjs` path; `reviewFile` is a
  bundle-relative `.json` sidecar. Duplicates, absolute paths, traversal and
  unknown fields fail at parse.
- Loader (`src/gates/providers/loader.ts`): resolves each `module` inside the
  bundle root only (no traversal, no escaping symlinks, no absolute paths,
  per-file/total/file-count limits), never by arbitrary import. It computes
  the CODE digest over the module bytes plus resolved local imports; bare
  externals contribute only their bundle `package-lock.json` integrity pin
  (`{specifier, version, integrity}`) and refuse without one.
- Mandatory review: every entry needs a `review` (or `reviewFile`) with
  `{reviewer, reviewedAt, codeDigest}`. Registration refuses absent
  attestations, future review dates, and any `codeDigest` mismatch. A byte
  change moves the digest, so the binding refuses until re-pinned.
- Binding pins (`GateBinding.spec.metricProviders`, optional `codeDigest`):
  core pins omit it; bundle pins must carry the loader-computed digest. The
  registry verifies the pin against the loaded provider; the evaluator
  additionally verifies the sealed metric section against the pin. Forged,
  null or unknown digests fail closed and never verify as compatible.
- Sealed sections (`sealProviderSection`): the host binds each provider result
  to `{codeDigest, recordsDigest}` and overwrites self-declared
  `version`/`sourceDigest` with the registry values. The evaluator never
  trusts provider-declared fields alone.
- Invocation (`invokeBundleProvider`): budget (`maxRecords`) and cancellation
  are reserved before dispatch; compute races a timeout and an abort signal.
  Timeout, budget, rejection and cancellation fail closed per provider without
  discarding other providers' completed sections.

## Review process

1. The author declares the provider in the bundle manifest with its module
   path and a review slot.
2. An independent reviewer reads the module and every resolved local import,
   checks determinism (below), computes the code digest with
   `computeProviderCodeDigest(bundleRoot, module)`, and records
   `{reviewer, reviewedAt, codeDigest}` in the manifest or sidecar.
3. The loader re-computes the digest at load and refuses on mismatch. Any
   later byte change (including helper files) requires a new review and a new
   binding pin. The fixture example
   (`test/fixtures/gates-example-extension/`, reviewer `Example Reviewer`)
   follows this flow; its test pins the digest constant.

## Determinism constraints

Providers MUST be pure offline functions of their records: no network, no
filesystem/process access, no clock unless injected through records, no
randomness unless seeded through records. The loader statically refuses
`fs`, `child_process`, `net`, `http(s)`, `dgram`, `dns`, `tls` and
`worker_threads` imports; anything else impure is a review failure, not a
runtime guarantee. Invocation is bounded by a timeout, but a pure provider
returns identical bytes for identical records.

## Offline example

```ts
import { loadGateBundleProviders, invokeBundleProvider, sealProviderSection } from '../../src/gates/providers/loader.js';

const manifest = JSON.parse(readFileSync('test/fixtures/gates-example-extension/manifest.json', 'utf8'));
const [provider] = await loadGateBundleProviders('test/fixtures/gates-example-extension', manifest, {
  allowBundleProviders: true, now: '2026-09-03T00:00:00.000Z',
});
const records = [{ slice: 'a', failed: false }];
const raw = await invokeBundleProvider(provider, records, { timeoutMs: 5000 });
const section = sealProviderSection(provider, records, raw as { metrics: unknown });
```

Conformance vectors live in
`test/conformance/gates-v1/gates-bundle-providers.test.ts` (fake clock,
offline transport, negative controls for byte tweaks, missing attestations,
path escapes, undeclared providers and stale pins).

## Pending (not implemented)

Live provider qualification on real held-out data, human reviewer sign-off
beyond the fixture attestation, production rollout, the `aiwg gates` CLI
(#2830) and study migrations (#2833+). No live criterion is met.
