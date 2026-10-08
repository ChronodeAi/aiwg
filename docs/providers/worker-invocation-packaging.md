# Worker invocation package boundary (S1, #2884)

T-OG-14 baseline, 2026-10-07: Linux, Node 24.12.0, package version
2026.10.1. Both `aiwg` and `@aiwg/cli` were packed, installed with npm in
separate temporary projects outside the checkout, and exercised **before source
changes**. No checkout `node_modules` symlink or source fallback was used.

| Scenario | Expected | Observed |
| --- | --- | --- |
| T-OG-14-root-installed | Load supported tool path and built-in adapters | Passed; npm installed 181 dependencies |
| T-OG-14-cli-installed | Load dedicated CLI copy of the same adapters | Passed; npm installed 181 dependencies |
| T-OG-14-before-renderer | Identify the missing invocation dependency | No installed module/dependency was missing. `prepareWorkerInvocation` was absent on every built-in adapter. Legacy `buildSessionArgs` was callable in both targets. |
| T-OG-14-after-shell | Prepare typed shell descriptor from installed code | Passed for both targets; all nine registry keys present |
| T-OG-14-after-mcp | Prepare pinned MCP descriptor from installed code | Passed for both targets; no managed state |

The nine keys were `claude`, `codex`, `opencode`, `factory`, `pi`, `omp`,
`deepseek-harness`, `dsh` and `muse`. Registry presence is not live provider
qualification. Baseline calls only constructed synthetic arguments; no vendor
worker, model service, login or credential store was used.

The boundary already worked, so no helper was extracted and no driver or Ralph
supervisor was relocated. The root package retains
`tools/ralph-external/index.mjs`, the path used by `getOrchestratorPath`.
The dedicated CLI continues to ship its selected adapter/transport subset.

Reproduction sequence (run packing/installing from temporary directories):

```sh
# Build in the checkout first.
npx tsc
npm run build:copy-mjs

# Root target, from an external temporary project:
npm pack /absolute/checkout --ignore-scripts --json --pack-destination .
npm install ./aiwg-2026.10.1.tgz --ignore-scripts --no-audit --no-fund

# Dedicated target: stage in a second external temporary project.
node /absolute/checkout/tools/release/build-cli-package.mjs --output /temporary/stage
npm pack /temporary/stage --ignore-scripts --json --pack-destination .
npm install ./aiwg-cli-2026.10.1.tgz --ignore-scripts --no-audit --no-fund
```

Import the installed `tools/ralph-external/lib/provider-adapter.mjs`, await
`ensureProvidersRegistered`, then exercise `createProvider` and its argument /
invocation methods. `test/integration/worker-adapter-package.test.ts` additionally
loads the frozen third adapter/catalog solely through approved installation
metadata, and checks shell/MCP preparation. It uses real npm installation,
empty npm configuration, bounded registry requests and no checkout dependency
links. A pre-populated public dependency cache can be supplied with
`AIWG_PACKAGE_TEST_NPM_CACHE` to make its install step offline.

## Reusable preparation contract

`ProviderAdapter.prepareWorkerInvocation(invocation, qualification)` validates
and returns a detached existing `workerResolvedInvocation` payload. The trusted
caller supplies adapter metadata, CLI version, required controls, validation
clock and (for MCP) current binding plus input/output schemas. MCP schema digests
cover the exact `JSON.stringify` UTF-8 representation supplied by the qualified
profile. Keep that serialization stable when recording qualification.

Selection checks require trusted `modelObservation` or `defaultObservation`
evidence, even when no policy override is supplied. Null effort additionally
requires observation `effortSupport: 'not-applicable'`, the selected `role`, and
merged policy role guidance with `allowNotApplicableEffort: true`. Preparation
does not support skipping observation checks.

The method checks Linux/version/transport/control qualification and expiration.
It quotes each shell token, structurally renders CWD/input/output redirections,
forwards only profile-allowlisted environment names, and derives shell syntax
rather than trusting a supplied `shellCommand`. MCP arguments are size-bounded
by the bundled worker codec and validated against the pinned input schema.
It never falls back to legacy bypass arguments.

This is preparation, including preparatory plans; it does not prove launch
readiness. The resolver/qualified driver still owns exact provider argument
mapping, policy selection and digest production. Immediately before launch the
conductor/bridge must recheck actual paths/symlinks, brief/policy/catalog/profile
digests, binary identity and readiness. Launch, result parsing, health,
cancellation and verification remain with their existing owners. Managed
admission, retries, checkpointing, budget settlement and completion are deferred
to S2+; none is instantiated by preparation.

## Dispatch gate and worker isolation (Tier 0, #2954)

After preparation and before launch, the conductor runs the live
resource gate, then launches the prepared command in its own resource scope:

```js
import { checkWorkerDispatch } from '../../tools/scripts/resource-preflight.mjs';
import { launchIsolatedWorker } from '../../tools/ralph-external/lib/worker-isolation.mjs';

// From the project config: build.resource_preflight.dispatch thresholds,
// tightened field-by-field by parallelism.admission.hostResources
// (conservative defaults when unset). worker_dispatch off means legacy:
// { enabled: false, ok: true } with no signal sampling.
const gate = checkWorkerDispatch({ config });
if (!gate.ok) {
  // Queue, pick another qualified host, or reject with gate.failures
  // (each names its signal: avail-mem, load, mem-psi-avg10, mem-psi-avg60,
  // workers, platform, thresholds). Never launch.
}
const outcome = launchIsolatedWorker({
  name, memoryMaxGb, command: prepared.argv[0], args: prepared.argv.slice(1),
  cwd: prepared.cwd, logFile, gate,
});
// outcome.mode is 'systemd-unit' (own unit, MemoryMax + MemorySwapMax=0,
// PATH/HOME passthrough, stdin /dev/null) or, where no systemd user manager
// exists, an explicit degraded diagnostic — never a silent unconfined launch
// unless the caller passes allowDegraded: true and records the degraded mode
// in the qualification record.
```

The `dispatch` preflight profile exposes the same gate on the command line
(`node tools/scripts/resource-preflight.mjs --profile dispatch`), and
`aiwg doctor` reports the live host state plus the isolation mode read-only.
No mandatory enforcement is wired into `prepareWorkerInvocation` or the
managed dispatch internals here; this section is the consumable API the
Tier 0 conductor procedure and #2888 dispatch templates must call before launch:
`prepareWorkerInvocation` → `checkWorkerDispatch` with the actual project config
and current host signals → `launchIsolatedWorker` with that gate result.
Omitting the gate refuses launch. Explicit `gate: 'disabled'` is allowed only
when the supplied config has worker_dispatch off.

Threshold precedence is monotonic: build dispatch, admission hostResources,
and caller/task overlay are combined per field. Minimum thresholds take MAX;
maximum thresholds (including max_workers) take MIN. No layer can relax another
configured limit or the conservative defaults, which form the base layer. All
layers are validated, including values superseded by stricter limits. At N
running workers, max_workers=N blocks the next launch. Counts use current-user
`aiwg-worker-*` service units when available; otherwise exact `codex`/`muse-bin`
process names owned by the current UID. Legacy build bypass environment flags
never disable the dispatch profile.

Serialize heavy verification runs per host, and checkpoint progress before
heavy steps in long runs (NFR-OG-023). Run the live gate before each heavy
verification step as well as before each worker launch.

Systemd launches disable environment expansion so prepared argv stays literal.
Units are retained for `getWorkerIsolationStatus(outcome.unit)`, which returns
`{ active, result, execMainStatus, memoryMax }` (memoryMax in bytes). Record OOM
results before explicit cleanup with `systemctl --user reset-failed <unit>`;
automatic collection would discard that evidence. Degraded opt-in launches
return `outcome.child` and `outcome.pid` immediately, without a worker deadline;
the caller owns output draining, completion, cancellation and qualification
recording.

## Validation limits and cleanup

The focused and related Vitest command ran ten files: 402 passed, zero failed
(including 31 invocation-preparation cases). `npm run typecheck` passed;
`npm run lint:orchestration-packs` passed with all statuses still partial;
`npm run lint:schemas` compiled all 236 cataloged schemas strictly, with zero
errors and two existing fixture warnings. `git diff --check` passed.

```sh
npx vitest run \
  test/unit/ralph-external/{worker-invocation,provider-adapter,session-launcher,output-analyzer,installed-worker-adapter}.test.ts \
  test/unit/cli/handlers/{ralph-launcher-buildargs,models-worker-contracts}.test.ts \
  test/unit/models/worker-capabilities.test.ts test/unit/mcp/worker-contracts.test.ts \
  test/conformance/mission-v1/worker-contracts.test.ts
```
 The packaging lane's existing
full-prepack global setup failed with `listen EPERM` on the tsx IPC pipe before
the two package tests could run. Direct shell `npm pack --ignore-scripts`,
install and installed imports worked for both targets before and after changes;
this does not substitute for the blocked full-prepack gate. The conductor must
rerun the unchanged packaging harness outside the sandbox:

```sh
npx vitest run --config config/vitest.packaging.config.js test/integration/worker-adapter-package.test.ts
```

The existing orchestration conformance lane had 10 passes and 16 failures:
three synchronous child probes reported spawn errors; thirteen fake CLI/MCP
cases received empty stdout or premature disconnect. A separate baseline probe
of the unchanged fake CLI and MCP fixtures also returned empty piped stdout.
These do not establish successful MCP runtime/chaos qualification. Rerun this
lane on the conductor's host; no fixture or harness was changed to suppress it:

```sh
npx vitest run --config config/vitest.conformance.config.js test/conformance/orchestration-v1
```

Unit tests assert removal of their temporary roots. All manual pack/install
projects, synthetic briefs, requests and probes were removed after collecting
these sanitized results. No Mission-v1 files or schemas changed.
