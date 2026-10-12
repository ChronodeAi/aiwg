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
When an installation has recorded raw version evidence, subsequent qualification
checks both the normalized version pin and the exact captured version text from
that banner. Decimal core normalization can accommodate Cursor's date spelling
on initial qualification, but a later change from `2026.10.1` to `2026.010.1`
cannot reuse the recorded pin. Prefix/suffix text outside the capture is not
part of this version comparison.
The frozen `stdin: 'closed'` field renders empty stdin (`< /dev/null`, immediate
EOF); it does not promise an absent operating-system file descriptor.
It quotes each shell token, structurally renders CWD/input/output redirections,
forwards only profile-allowlisted environment names, and derives shell syntax
rather than trusting a supplied `shellCommand`. MCP arguments are size-bounded
by the bundled worker codec and validated against the pinned input schema.
It never falls back to legacy bypass arguments.
An `adapter-frame` shell stage runs under `env -i` with the recorded environment
names only. Its conductor-bound installation-store path and SHA-256 bytes digest,
policy (checked against the installation's effective config digest), adapter,
scope and brief digest are explicit inputs. It never reads project or model
configuration from the worker-writable cwd; an absent or changed binding fails
closed. Adapter frames must contain at least one byte.

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

## Attached one-shot capture (S1, #2895)

The existing Ralph command can supervise one resolved shell invocation:

```sh
install -d -m 700 /private/attempt
aiwg models resolve --role coding --task implementation --group qualified-group \
  --brief /private/brief.json --workdir /absolute/worktree \
  --final-output /private/attempt/final.json --format=json > /private/plan.json
aiwg ralph-external --launch-worker --invocation /private/plan.json \
  --run-dir /private/attempt
```

`FILE` is the complete JSON plan from `models resolve`, including its invocation
and input digests. The launcher rechecks it against current trusted configuration,
catalog, installation and brief inputs before spawning; a bare argv array or an
edited shell command cannot grant launch authority. Prepare fresh invocation and
final paths for each attempt. The run directory must be outside the worker's
writable worktree and within the authorized output scope. The launcher opens
captures before spawning, rejects symlink/traversal paths and pre-existing attempt
outputs, and writes directories with mode 0700 and files with mode 0600.
An existing run directory must be empty, private and conductor-owned. A used
directory or final path is refused. Assigned final files may be inside that
directory only when the qualified boundary grants that leaf. **This grants no
filesystem isolation from the rest of the run directory's trusted metadata**:
the worker runs as the same UID as the conductor (no sandboxing user, no
mount namespace separating them), so it can read and write every file the
conductor placed there, including `worker-exit.json`, `worker-identity.json`
and `process.json`. Mode 0700/0600 keeps other users out; it does not keep
the worker out. The launcher therefore never derives `exitCode`, `signal`,
`termination` or `confirmed` from a file in the run directory — only from the
kernel-observed wait() status of its own direct child (the trusted transport,
never the worker) or, for `systemd-unit` mode, from `getWorkerIsolationStatus`
queried against the unit by name. A worker that plants its own
`worker-exit.json` claiming a clean exit is recorded only as an
unauthenticated, informational `workerReportedExit`/`workerTermination`
hint; it cannot make a real failure read back as success.

The live dispatch gate runs first. Available isolation uses the existing
`launchIsolatedWorker` owner; a host without isolation requires the explicit
`--allow-degraded-worker` option. A degraded launch records unavailable resource
confinement and cannot claim that boundary. This mode stays attached to exactly
one attempt: no retry, queue, daemon, Mission or MC state is created. The legacy
Ralph launch API and installed package paths remain the same.
An unconfined process group can escape via `setsid`; degraded descendant stop
therefore remains uncertain even after the direct child's owning wait completes,
and degraded mode can never report a confirmed stop — there is no cgroup to
prove no descendant escaped. The CLI's `--launch-worker` exit code reflects
this directly: 0 is a confirmed success, 1 is a confirmed failure (error,
timeout, or a confirmed stop with a nonzero/signaled exit), and 2 is an
uncertain termination — a degraded run can look entirely clean and still
exit 2, because "clean" is not the same claim as "confirmed." Callers must
treat 2 as neither success nor failure, not coerce it to one.
For `systemd-unit` mode, a hard timeout stops the unit itself
(`systemctl --user stop <unit>`, which `KillMode=control-group` turns into a
cgroup-wide kill) rather than attempting a PID/PGID signal that may still be
unresolved; the unit's own retained state is then what confirms or fails to
confirm the stop, never the act of having requested it.
The attached transport refuses `NODE_OPTIONS`, `NODE_PATH` and native loader
override variables in the worker allowlist, and removes them at the service
boundary before its supervisor starts. Requalify a profile that needs those
variables through another supported direct handoff.
File operations pin Linux directory handles and reject symlink ancestors;
permission cleanup acts on opened inodes rather than worker-replaced paths.

`invocation.json` records a digest-bound, sanitized command, environment variable
**names**, the prompt reference/digest, workspace and output bindings, and
thresholds. It contains no environment values or prompt text.
The sanitized `argv` and `commandDisplay` describe the substituted launch argv;
`executedArgvDigest` binds it, while `placeholderArgvDigest` binds the plan argv
before substitution (`argvDigest` remains its compatibility alias). Each generated
artifact records its name, UTF-8 `byteLength` and SHA-256 content digest, never
its contents. Output paths cannot use the run directory's `artifact-` namespace.
`process.json`
distinguishes the supervisor from the actual worker and records available PID,
PGID, UID, host/boot, executable, parent and process-start identity. Unknown facts
are null. Restricted stdout and stderr remain separate captures; JSONL naming
applies only to a qualified event format. Adapter final extraction writes a
separate candidate final and preserves the event stream. Final presence and exit
zero are evidence for conductor verification, not proof of task correctness.
`final-evidence.json` binds that candidate's path and digest to this invocation.
The run directory retains private canonical captures as well as the exact
stdout/stderr output paths declared by the resolved plan.

`exit.json` comes from the owning wait or native terminal evidence, retaining an
unknown exit code as null. Stop certainty includes owned descendants. Sending a
signal or seeing the supervisor exit alone cannot prove termination. Before each
signal, ownership is rechecked against boot/start identity and the isolated group;
the conductor's group, reused identities and uncertain ownership are refused.
Completed timers are cleared so they cannot later signal a reused PID.

### Manual launch and adoption

An owning shell can apply the same convention without calling the Ralph helper.
Recheck the full plan and dispatch gate first, authorize any degraded boundary,
and use only its literal typed argv and allowlisted environment. Never evaluate
`shellCommand` or execute a command supplied by worker output. The following Bash
procedure uses the shell's own `wait` and Node's standard library; replace the example argv with the exact
qualified argv, including the fresh output references:

```bash
umask 077
run=$(mktemp -d /tmp/aiwg-worker.XXXXXXXX) || exit 1
chmod 700 "$run" || exit 1
brief=/absolute/private/brief.json
plan=/absolute/private/rechecked-plan.json
workdir=/absolute/authorized/worktree
final=/absolute/authorized/outputs/fresh-final.json
stdout="$final.stdout"              # Exact #2887 output bindings.
stderr="$final.stderr"
argv=('/absolute/qualified-binary' 'literal argument from the rechecked plan')
record_manual() {
  node --input-type=module - "$run" "$plan" "$1" "$$" "${worker-}" "${wait_status-}" \
    "$workdir" "$brief" "$stdout" "$stderr" "$final" "${argv[@]}" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
const [run, filename, stage, shell, child, waited, cwd, brief, stdout, stderr, final, ...argv] = process.argv.slice(2);
const normalize = v => Array.isArray(v) ? v.map(normalize) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, normalize(v[k])])) : v;
const digest = v => 'sha256:' + createHash('sha256').update(JSON.stringify(normalize(v))).digest('hex');
const bytesDigest = v => 'sha256:' + createHash('sha256').update(v).digest('hex');
function safe(p) {
  if (!path.isAbsolute(p) || p.split('/').includes('..')) throw Error('unsafe path');
  let current = '/';
  for (const part of p.split('/').filter(Boolean)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw Error('symlink'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
for (const p of [run, filename, cwd, brief, stdout, stderr, final]) safe(p);
const runStat = fs.statSync(run);
if (runStat.uid !== process.getuid() || (runStat.mode & 0o077)) throw Error('unowned/private directory');
function read(p, limit) {
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try { const s = fs.fstatSync(fd); if (!s.isFile() || s.nlink !== 1 || s.size > limit) throw Error('unbounded input');
    return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
}
function write(name, value) {
  const target = path.join(run, name); safe(target);
  const temp = path.join(run, '.' + randomUUID());
  const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, target);
}
function identity(pid) {
  if (!Number(pid)) return null;
  try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const f = s.slice(s.lastIndexOf(')') + 2).split(/\s+/);
    return {pid:Number(pid), pgid:Number(f[2]), parentPid:Number(f[1]), sessionId:Number(f[3]), startTicks:f[19],
      uid:Number(/^Uid:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1]),
      host:os.hostname(), bootId:fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), executable:fs.readlinkSync(`/proc/${pid}/exe`)};
  } catch { return null; }
}
if (stage === 'before') {
  const p = JSON.parse(read(filename, 1048576)); const i = p.invocation;
  if (p.mode !== 'direct' || p.status !== 'eligible' || i.readiness !== 'launchable' || Date.parse(i.expiresAt) <= Date.now()
    || JSON.stringify(i.argv) !== JSON.stringify(argv) || [i.cwd,i.briefPath,i.stdoutPath,i.stderrPath,i.finalPath].join('\0') !== [cwd,brief,stdout,stderr,final].join('\0')
    || bytesDigest(read(brief, 262144)) !== i.briefDigest || fs.readdirSync(run).length) throw Error('plan binding changed');
  const invocationId = randomUUID();
  write('invocation.json', {invocationId, origin:'manual', planDigest:digest(p), invocationDigest:digest(i),
    argv:i.argv.map((v,n) => n === 0 ? v : '<argument:' + bytesDigest(v) + '>'), argvDigest:digest(i.argv),
    envNames:i.envNames, prompt:{path:brief,digest:i.briefDigest}, selected:i.selected,
    cwd, worktree:{path:cwd,baseRevision:null}, paths:{stdout,stderr,final}, health:i.health,
    attemptId:invocationId, previousAttemptId:null});
  write('process.json', {invocationId, origin:'manual', supervisor:identity(shell), worker:null});
} else if (stage === 'started') {
  const old = JSON.parse(read(path.join(run,'process.json'),65536));
  write('process.json', {...old,worker:identity(child),launchTime:new Date().toISOString(),monotonicStart:process.hrtime.bigint().toString(),ownership:'unknown'});
} else {
  const old = JSON.parse(read(path.join(run,'process.json'),65536)); const status = Number(waited);
  write('exit.json', {invocationId:old.invocationId, waitStatus:status, exitCode:status < 128 ? status : null,
    signal:null, endedAt:new Date().toISOString(), termination:'uncertain', descendants:'unknown'});
}
JS
}
record_manual before || exit 1
# Open every capture before spawn; failure ends the attempt without a worker.
set -C                            # Refuse existing capture/final files.
exec {out}>"$stdout" || exit 1
exec {err}>"$stderr" || exit 1
: >"$final" || exit 1
# PATH/HOME here are examples: use exactly the qualified envNames.
# Run with job control off; verify $! against actual PID/PGID/start identity.
set +m
(cd "$workdir" &&
  while IFS= read -r name; do
    case "$name" in PATH|HOME) ;; *) unset "$name" || exit 1 ;; esac
  done < <(compgen -e)
  exec setsid "${argv[@]}") \
  < /dev/null >&"$out" 2>&"$err" &
worker=$!
# For brief-text/brief-json, replace /dev/null with "$brief"; EOF follows the file.
if ! record_manual started; then
  printf '%s\n' 'Metadata unavailable; retain the shell/child references and unknown ownership in conductor context.' >&2
fi
if wait "$worker"; then wait_status=0; else wait_status=$?; fi
exec {out}>&-
exec {err}>&-
record_manual ended || exit 1
# Bash statuses >128 can also be ordinary exits: without native evidence, record
# exact code/signal as null and retain wait_status. Never invent exit code zero.
# Owned descendants not independently proven stopped => termination uncertain.
# Extract a separate final through the qualified parser; retain both captures.
```

The metadata steps use exclusive temporary regular files
and atomic rename under the private directory, reject symlink/hardlink aliases,
and preserve mode 0600. Native isolation remains required whenever the profile
needs it; `setsid` establishes a process group, not a filesystem or resource
sandbox. A hand-launched process that shares its parent's group remains
inspectable but grants no group-kill rights.

`SessionLauncher.adoptWorker({ runDir?, invocationId?, worker?, paths? })` accepts
known manual references with `origin: 'manual'`, returns explicit nulls for
unknown identities/terminal facts and does not signal processes. It never scans
by process name or trusts an adopted PID as cancellation authority. Omit
`runDir` when writable scratch is unavailable: the returned observation stays in
conductor context, with unavailable deadline/stop guarantees explicit. No status
query can discover absent records, and no automatic MC fallback occurs.

Retention and disposition belong to the conductor. Restricted raw prompts/logs
default to 24 hours after confirmed termination and disposition; live or uncertain
attempts are preserved. Dirty/partial worktrees require explicit disposition.
This helper supplies evidence; it does not run a retention service.

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

## Recorded installations for direct resolution (#2887)

The production `models resolve` loader reads the existing installation owner's
host records from `$AIWG_CONFIG/worker-installations.json` (default
`~/.config/aiwg/worker-installations.json`). Project model configuration may
reference an installation ID; it cannot supply executable module paths.
The shared owner now lives in `src/models/worker-installation.mjs`; Ralph's
`ProviderAdapter` and factory exports remain compatibility facades for it.
No supervisor or launch lifecycle was moved.

A trusted host first calls `inspectWorkerInstallation` with the installed
binary, approved modules and dependency closure, workspace/input/output roots,
permissions, boundary, effective merged policy digest, account and environment.
It obtains host-owned observations for the shipped negative fixture suite,
bound to the inspected scope. `qualifyWorkerInstallation` performs the bounded
version probe and verifies those observations. Then
`recordWorkerInstallation({ cli, binding, installation })` repeats qualification
and atomically records successful evidence; it never records a disabled result.
Here `installation` is the same qualification request, including adapter metadata
and its negative evidence. For the production loader, `effectiveConfigDigest`
is `qualificationDigest(mergedModels.defaults.workerSelection)`.
Environment values are reduced to names before persistence.

The host must protect this configuration directory and installed dependency
closure from workers. The loader refuses symlinked, hardlinked or untrusted
writable record files, records inside worker-writable roots, duplicate IDs,
expired or incomplete observations, and changed installation inputs. It checks
negative evidence before importing an approved factory and rechecks the exact
scope before returning a driver. Resolution reads existing evidence and checks
binary bytes; it performs no version probe, model call, login, server start or
qualification write. The shared preparation method checks paths, policy controls,
argv and environment again before a plan can be returned. Missing qualification
produces `OG_ADAPTER_UNQUALIFIED` with the owner methods needed to qualify it.

The production-handler test installs the fake worker fixture and its trusted
module into an isolated host directory, provides scoped synthetic host evidence,
and resolves through the real loader without `createModelsHandler` injection.
It proves plan rendering and mutation refusal; it does not qualify a vendor CLI.

## Direct worker status (#2913, S1)

Use the existing status command with exactly one explicit private selection:

```sh
aiwg ralph-status --workers --run-dir /private/runs/attempt --json
aiwg ralph-external --status --workers --runs-root /private/runs
aiwg ralph-external --status --workers --runs-root /private/runs --watch --deadline-seconds 1800 --json
```

Default queries read metadata and owned local process facts. They create no
files, invoke no models, launch no subprocesses and change no worker processes.
Legacy status retains its existing behavior. A fresh project needs no Mission,
admission or activation files. Hand-created private directories may contain just
`process.json` with an invocation ID and known identity; missing clocks, progress,
exit status and enforced deadlines remain unknown. Workers with no directory
cannot be discovered by this command: use the owning conductor's in-memory
samples or `SessionLauncher.adoptWorker` and disclose the unavailable guarantees.

JSON snapshots and human summaries use the same projection. Watch emits JSONL,
keeps prior observations in memory, and stops on a finite watch deadline or when
all selected workers terminate. A watch timeout never cancels workers. Optional
`--observe` requires `--watch`, reserves exclusive observation ownership and atomically replaces
`last-observed.json`; it writes only private owner scratch. A busy owner blocks
another writer. A lost owner's reservation requires explicit reconciliation;
the query never removes another owner's file or assumes termination.
Scratch history is used only with a matching lock owner whose process identity
is still live, including its start ticks and boot ID. It cannot improve a worse
live classification or upgrade coverage. Untrusted scratch is ignored with a
finding and degraded coverage. Observation write failures retain readable health
rows and add findings. Watch intervals are at least one second and the resolved
check cadence; total samples are capped at `ceil(deadlineSeconds) + 1`, including
the initial snapshot and deadline snapshot.

Snapshot exit codes are 0 for readable workers with no required action (including
an explicit empty root), 2 for action-required or degraded required coverage, and
1 for invalid requests/read failures. Failed rows retain readable siblings.
Selection is capped at 256 entries, 32 files per run, 64 KiB per metadata record,
10 MiB per capture and a five-second sampling budget. Excess selection reports
`complete:false` and asks for a narrower root. Ancestors, records and captures
reject symlinks; private ownership and single-link files are required.

Effective thresholds include source pointers, max(role, effort, model) scaling,
remaining parent/profile ceilings, step enforcement and truncated windows.
CPU milliseconds remain null without a supplied qualified conversion, with
`cpu` in `health.unavailableSignals` and `counters.available.cpu:false`. The status
path does not spawn `getconf` to obtain a conversion. Byte
growth and CPU activity never establish semantic progress. Recorded health or
exit data never grants verification acceptance or signal authority. Tier 0 has
no shared breaker authority (`breakers:[]`). Managed leases, shared breakers,
remediation and durable transition settlement are deferred to S2+.
