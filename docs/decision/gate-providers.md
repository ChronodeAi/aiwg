# Gate metric providers (isolated loading + records binding)

Status: experimental, disabled by default. Bundle providers require an
explicit `allowBundleProviders: true` option **and** a matching
project-config allowlist entry, and run only inside a working bubblewrap
sandbox (they refuse, fail closed, without one). No environment variable
activates loading.
With no opt-in, resolution and evaluation stay byte-identical to the
core-only path.

Operator decision §12.4 permits addons/extensions to ship metric-provider
code. This document describes how that code is made safe.

## Threat model

Provider code is untrusted even after review: a reviewed digest proves which
bytes ran, not that they are benign. The adversary controls every byte of the
provider directory and wants to (a) reach the host process (environment
secrets, network, filesystem, real clock, other runs), (b) forge or
influence results outside its own computation, or (c) run code that differs
from the pinned digest.

**The `vm` context is NOT the security boundary.** Node documents `vm` as
unsuitable for untrusted code, and round-3 review proved it: the
`Function` constructor reached through any intrinsic generated code that
called `import()`, the dynamic-import trap threw a host-realm `Error`, and
`error.constructor.constructor('return process')()` returned the host
`process`. The boundary is the operating system sandbox described below;
every in-process layer is defence in depth.

## Isolation (P1, round 3)

Every provider run (load-time inspection, `invokeBundleProvider`, evaluator
re-runs) is a fresh child process launched through **bubblewrap**
(`isolationLaunchPlan`):

- `bwrap --unshare-all --unshare-user --disable-userns --die-with-parent
  --new-session --clearenv --cap-drop ALL`: private user, pid, ipc, uts,
  mount and **network** namespaces (no host network, loopback included), no
  nested user namespaces, no controlling terminal, killed with its parent.
- The spawn environment is empty (`env: {}`) and bwrap clears it again; the
  only variable inside is `PWD=/tmp`, which bwrap sets for the sandbox cwd.
- The only host paths visible are **read-only** binds of the node binary (at
  `/aiwg/bin/node`) and exactly the shared libraries the parent node process
  has mapped (plus their soname aliases and the ELF interpreter). There is a
  private tmpfs `/tmp`, a new `/proc` for the private pid namespace and a
  minimal `/dev`. No home directory, working tree, `/etc`, sockets or
  provider files are mounted.
- Inside, node runs with `--permission` (no filesystem read or write, no
  child processes, no workers, no addons/WASI) and
  `--disallow-code-generation-from-strings` (host-realm `eval`/`Function`
  disabled too).
- **Fail closed.** Before the first run (and per bwrap path) the runner
  executes a capability self-test inside the same sandbox: the environment
  must be empty, all six namespaces must differ from the parent's, and the
  parent's home directory, working tree, `/etc/passwd`, `/home`, `/root`,
  `/var`, `/run` and `/srv` must be invisible (`probeIsolationSandbox` adds a
  loopback connect to a parent listener). If bwrap is missing or the
  self-test fails, every bundle provider load and run refuses with
  `GateProviderError` code `sandbox-unavailable`. There is no unsandboxed
  fallback. `isolationSandboxStatus()` reports the verdict without throwing.

Inside the sandbox, the trusted driver
(`src/gates/providers/isolated-child-source.ts`, passed via `node -e`; it
reads no files):

- reads its whole request from stdin (provider module sources, frozen clock,
  seed, records, expected identity) and a per-run 256-bit nonce BEFORE any
  provider code is compiled;
- creates the `vm` context with `codeGeneration: { strings: false, wasm:
  false }`, so `Function`, `eval`, and the generator/async function
  constructors throw `EvalError` from every intrinsic;
- deletes `eval`, `Function`, `WebAssembly`, `Proxy`, `Reflect`, `console`,
  `Intl`, `Atomics`, `SharedArrayBuffer`, `FinalizationRegistry`,
  `WeakRef`, disposable-stack helpers, `Iterator` and `Math.random`, and
  installs the frozen clock (`clock`, a `Date` shim whose real constructor is
  unreachable) and the seeded RNG (`random()`);
- **freezes every intrinsic reachable from the context global** (prototype
  chains, accessors and hidden intrinsics such as generator and iterator
  prototypes) before provider code runs, so provider code cannot hijack
  `Promise.prototype.then` (which host-side awaits would otherwise call with
  host functions) or install `Error.prepareStackTrace`;
- passes **only primitives** across the host/context boundary: the provider
  is driven by context-realm functions created by the bootstrap, results
  leave as a JSON string the host polls for, thenable results are resolved
  with context-realm resolvers, and the dynamic-import trap throws a
  context-realm `Error`. No host object or function ever reaches provider
  code;
- links provider modules only from the request's module map (relative `.mjs`
  static specifiers); dynamic `import()` and `require()` also refuse at load
  via a lexical scan (comments/strings/templates skipped, `${}` regions
  scanned as code; anything the scanner cannot lex refuses). The scan is a
  convenience layer only: a regex literal can desynchronise it, and the
  runtime trap above is authoritative.

**Result channel (IPC).** The parent accepts exactly one stdout line,
`AIWG-RESULT <nonce> <json>\n`, written by the driver
(`parseIsolatedFrame`). An unframed message, a wrong nonce, a second line or
trailing bytes reject as a forgery. Provider code cannot read the nonce (it
was consumed from stdin and lives only in the driver's module scope).

The parent enforces a wall-clock timeout by killing the sandbox (SIGKILL;
`--die-with-parent` and the private pid namespace take the provider with
it), covering module import and execution together, plus an output size cap.
Timeouts, output-cap trips, crashes, refusals and rejections surface as
`GateProviderError` (`timeout` / `rejected` / `sandbox-unavailable`); they
never propagate exceptions into the existing workflow and never run provider
code in-process.

The RNG seed derives deterministically from the provider code digest and the
input-records digest (`deriveIsolatedSeed`), so identical inputs give
identical bytes. `invokeBundleProvider` requires an explicit `clockMs` (no
real-clock default); evaluation passes its own timestamp, so re-runs are
byte-identical.

## Code pinning (P2, round 3)

Provider code is the entire declared provider directory (the directory
containing the entry module), read into an **in-memory** snapshot:

- Every entry is lstat-checked: symlinks (files or dirs) and non-regular
  files refuse. Only regular `.mjs` files are captured; other regular files
  are inert (the linker never serves them, so they are neither captured nor
  digested). Module bytes must be valid UTF-8 so they round-trip exactly to
  the compiled source text. Files using the reserved `__aiwg_` prefix refuse.
- The code digest covers the snapshot bytes (sorted relative paths plus
  content hashes). Any byte change anywhere in the directory moves the
  digest, so a binding pinned to the old digest refuses until re-pinned.
- The loader keeps the bytes in a private record keyed by the frozen provider
  object it issues. Nothing is written to disk and no path is shared between
  runs: each run (evaluator re-runs included) makes its OWN copy of those
  bytes, re-digests exactly that copy, requires it to equal the issued digest
  (and, for evaluator re-runs, the binding's pinned digest), and sends that
  copy to the sandbox over stdin with a per-run request. Caller-supplied
  provider objects, snapshot paths and digests are never trusted: a copy of
  an issued provider refuses to run (`unregistered`). Later source edits do
  not move execution (the load-time bytes run) and concurrent runs cannot
  observe each other's records.
- Modules must be self-contained relative `.mjs` with static string
  specifiers only: dynamic `import()`, `require`, bare/external imports
  (`leftpad`, `node:fs`, …), absolute specifiers, snapshot escapes (`../`),
  non-`.mjs` relatives (`.cjs`, …) and reserved paths refuse at load.
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

The allowlist cannot be bypassed by registering a provider object directly:
`MetricProviderRegistry.register` refuses any provider carrying a
`codeDigest` unless it is the exact frozen object `loadGateBundleProviders`
issued after the allowlist check (`isLoaderIssuedProvider`), and the
evaluator re-checks issuance before every re-run.

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
const raw = await invokeBundleProvider(provider, records, { timeoutMs: 5000, clockMs: Date.parse('2026-09-03T00:00:00.000Z') });
const pin = providerBindingPin(provider, records); // binding.spec.metricProviders entry
```

## Deferred to separate issues

- Vendored (audited) third-party dependencies for providers (bare imports).
- CLI records-file input for bundle-provider evaluation re-runs.
- `import.meta` support inside providers (currently unusable).
- Non-Linux hosts and containers without bubblewrap or unprivileged user
  namespaces cannot run bundle providers (fail closed); a CI lane with a
  sandbox-capable runner is needed to exercise the isolation suites there.
