# Gate metric providers (isolated loading + records binding)

Status: experimental, disabled by default. Bundle providers require an
explicit `allowBundleProviders: true` option **and** a matching
project-config allowlist entry. No environment variable activates loading.
With no opt-in, resolution and evaluation stay byte-identical to the
core-only path.

Operator decision §12.4 permits addons/extensions to ship metric-provider
code. This document describes how that code is made safe. The `vm` context
alone is NOT the security boundary; the permission-restricted child process
(plus the parent's SIGKILL timeout and output caps) is.

## Isolation (P1)

Providers run ONLY in a separate child Node process:

- `node --experimental-vm-modules --permission
  --allow-fs-read=<snapshotDir>`, so the child gets fs-read of the provider
  snapshot directory only: no fs-write, no worker threads, no addons/wasi,
  and child-process spawn is denied by the permission model.
- Inside the child, provider modules are linked through a tiny loader
  (`src/gates/providers/isolated-child-source.ts`) serving only relative
  `.mjs` snapshot files via static string specifiers, and evaluated in a
  `vm` context whose globals expose ONLY: the input records (frozen), a
  frozen clock value (`clock` plus a `Date` shim whose `now()` returns it),
  a seeded deterministic RNG (`random()`; `Math.random` is removed), and a
  minimal pure standard library (`Math` without `random`, `JSON`, `Object`,
  `Array`, `Map`/`Set`/`WeakMap`/`WeakSet`, typed arrays, `Promise`,
  `Error` kinds, `RegExp`, string/number helpers, … — no `URL`, `fetch`,
  timers, `performance`, `crypto` or structured-clone).
- Removed from the context: `eval`, `Function`, `WebAssembly`, `Proxy`,
  `Reflect`, `console`, `Intl`, `Atomics`, `SharedArrayBuffer`,
  `FinalizationRegistry`, `WeakRef`, disposable-stack helpers and `Iterator`.
  There is no `require`, no `import()`, no `process`, no `fetch`, no timers.
  Dynamic `import()` and `require()` refuse at load via a lexical scan of
  every snapshot module (comments/strings/templates skipped, `${}` regions
  scanned as code; anything the scanner cannot lex refuses) backed by the
  linker's unconditional dynamic-import trap at run time. A provider source
  containing `import(` or `require(` inside a REGEX literal is refused as
  well (fail closed; rewrite the expression).
- The parent enforces a wall-clock timeout by killing the child (SIGKILL),
  covering module import and execution together, plus an output size cap on
  the single JSON message the child writes to stdout. Timeouts, output-cap
  trips, crashes and rejections surface as `GateProviderError`
  (`timeout` / `rejected`); they never propagate exceptions into the existing
  workflow and never run provider code in-process.

The RNG seed derives deterministically from the provider code digest and the
input-records digest (`deriveIsolatedSeed`), so identical inputs give
identical bytes. The frozen clock defaults to the real clock for standalone
`invokeBundleProvider` calls; evaluation passes its fake clock, so re-runs
are byte-identical.

## Code pinning (P2)

Provider code is the entire declared provider directory (the directory
containing the entry module), copied — never symlinked — into a fresh
private snapshot dir:

- Every entry is lstat-checked: symlinks (files or dirs) and non-regular
  files refuse. Only regular `.mjs` files are copied; other regular files
  are inert (the linker never serves them, so they are neither copied nor
  digested). Files using the reserved `__aiwg_` prefix refuse.
- The code digest covers the snapshot bytes (sorted relative paths plus
  content hashes). Any byte change anywhere in the directory moves the
  digest, so a binding pinned to the old digest refuses until re-pinned.
- The child loads ONLY from that snapshot. Modules must be self-contained
  relative `.mjs` with static string specifiers only: dynamic `import()`,
  `require`, bare/external imports (`leftpad`, `node:fs`, …), absolute
  specifiers, snapshot escapes (`../`), non-`.mjs` relatives (`.cjs`, …) and
  reserved paths refuse at load.
- Bare package imports are FORBIDDEN in phase 1, even with a lockfile.
  Vendored dependencies remain future work.

## Trust root (P3)

A provider registers only if the project config (`aiwg.config`
`gates.providers`) allowlists it with a matching
`{bundleId, providerId, codeDigest, reviewer, reviewedAt}` entry.
`validateGatesConfig` validates the allowlist (required fields, digest and
date-time shapes, no duplicates, no unknown fields). Unknown or mismatched
entries refuse registration (`unregistered` / `attestation-mismatch`).
In-bundle review files are integrity-checked for consistency but are
informational only: they never authorize registration.

## Records binding (P4)

Bindings pin the input-records digest for each provider section
(`metricProviders[].recordsDigest`, required on bundle pins, forbidden on
core pins). At evaluation the host re-runs the pinned provider over records
digesting to the pin via the isolated runner and USES THE RE-RUN OUTPUT;
caller-asserted metrics for provider-backed gates are never accepted (a
forged alarming section cannot roll back a clean re-run, and a forged clean
section cannot hide a regression). Reports record the provider code digest
and records digest in their pins. When the runtime records do not match the
pin, or no runtime covers a bundle pin, evaluation refuses — including the
file path (`aiwg gates evaluate` refuses provider-backed sections it cannot
reproduce; pass records through the library `providerRuntime` input).
Re-running a bundle provider through the CLI from a records file is pending.

## Opt-in (P5)

`loadGateBundleProviders` requires `allowBundleProviders: true` AND a
matching allowlist entry. There is no environment-variable activation.
Loaded providers expose a `compute` that throws: in-process execution is
disabled; use `invokeBundleProvider` (async, abortable, budgeted) or the
evaluator's synchronous re-run.

## Records-BP.1 worked example (offline)

```ts
import { loadGateBundleProviders, invokeBundleProvider, providerBindingPin } from './src/gates/index.js';

const manifest = JSON.parse(readFileSync('test/fixtures/gates-example-extension/manifest.json', 'utf8'));
const [provider] = await loadGateBundleProviders('test/fixtures/gates-example-extension', manifest, {
  allowBundleProviders: true,
  now: '2026-09-03T00:00:00.000Z',
  allowlist: [{
    bundleId: 'gates-example', providerId: 'example.count/v1',
    codeDigest: 'sha256:76cd4dcb9af82fc27461a845254401bd66e96f8f5198cbb57c28c1f99511a590',
    reviewer: 'Example Reviewer', reviewedAt: '2026-08-15T00:00:00.000Z',
  }],
});
const records = [{ slice: 'a', failed: false }];
const raw = await invokeBundleProvider(provider, records, { timeoutMs: 5000 });
const pin = providerBindingPin(provider, records); // binding.spec.metricProviders entry
```

## Deferred to separate issues

- Vendored (audited) third-party dependencies for providers (bare imports).
- CLI records-file input for bundle-provider evaluation re-runs.
- `import.meta` support inside providers (currently unusable).
