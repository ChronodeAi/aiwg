/**
 * Session Launcher for External Ralph Loop
 *
 * Handles spawning Claude Code CLI sessions with proper argument
 * construction and output capture.
 *
 * @implements @.aiwg/requirements/design-ralph-external.md
 * @security docs/ralph-external-security.md
 *
 * SECURITY WARNING
 * ================
 * This module spawns Claude Code with --dangerously-skip-permissions which
 * BYPASSES ALL PERMISSION PROMPTS. The spawned session can:
 *
 * - Read ANY file the process user can read
 * - Write/modify ANY file the process user can write
 * - Execute ANY shell command
 * - Make network requests
 * - Install packages
 * - Modify system configuration
 *
 * This is required for headless/daemon operation but carries significant
 * security implications. Sessions run autonomously for extended periods
 * without human oversight.
 *
 * BEFORE USING:
 * - Read docs/ralph-external-security.md in full
 * - Understand all risks
 * - Set appropriate budget and iteration limits
 * - Ensure clean git state for rollback
 * - Have monitoring and abort procedures ready
 */

import { StringDecoder } from 'node:string_decoder';
import { spawn } from 'child_process';
import { createWriteStream, mkdirSync, existsSync, readFileSync, copyFileSync, constants } from 'fs';
import { open, mkdir, rename, unlink, lstat, readdir, realpath } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, relative, isAbsolute } from 'path';
import { EventEmitter } from 'events';
import { homedir, constants as osConstants } from 'os';
import { parseDocument } from 'yaml';
import { importImpl } from '../_resolve-impl.mjs';
import { sampleWorkerIdentity, sameWorkerIdentity, createWorkerIdentityCapture, sampleWorkerGroup, sampleWorkerChildren, sampleProcessCgroup, sampleProcessAncestry,
  qualifyWorkerCpuTickRate, sampleWorkerCpuTime } from './process-monitor.mjs';
import { createWorkerHealthObserver, sampleOwnedWorktreeContent, classifyWorkerHealthFailure } from './lib/worker-health.mjs';
import { ScopedFailureBreaker, attributeFailureScope } from './lib/consecutive-failure-circuit-breaker.mjs';
import { checkWorkerDispatch, detectWorkerIsolation, launchIsolatedWorker, getWorkerIsolationStatus, stopWorkerUnit, readUnitControlGroup } from './lib/worker-isolation.mjs';

/**
 * Kernel-verified containment gate for any candidate worker identity,
 * whether it came from a worker-writable disk record (`worker-identity.json`)
 * or a `/proc` children scan. A record that merely matches a REAL process
 * (resampled fresh by pid) is not sufficient on its own: that real process
 * can be any same-UID process on the host, including one entirely unrelated
 * to this invocation -- a same-UID worker can read another process's own
 * `/proc` entry and forge a record that matches it exactly (#2895 round 2,
 * MAJOR a). Trust requires containment derived from kernel facts the worker
 * cannot forge:
 *   - `systemd-unit` mode: the candidate pid's own cgroup
 *     (`/proc/<pid>/cgroup`) must equal the unit's own `ControlGroup`
 *     (`KillMode=control-group` places the transport, the worker and any
 *     descendants in that single cgroup).
 *   - degraded/attached mode: the candidate pid's real `/proc` ancestry
 *     chain (walked via ppid, never a worker-reported parentPid) must
 *     actually lead back to the launcher's own trusted transport child
 *     (`nativeSupervisor`), matching both pid, bootId and startTicks so a
 *     reused pid cannot stand in for it.
 */
function verifyWorkerContainment(pid, { mode, unit, nativeSupervisor,
  readControlGroup = readUnitControlGroup, readCgroup = sampleProcessCgroup, readAncestry = sampleProcessAncestry } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (mode === 'systemd-unit') {
    const unitGroup = unit ? readControlGroup(unit) : null;
    const pidGroup = readCgroup(pid);
    return !!unitGroup && !!pidGroup && pidGroup === unitGroup;
  }
  if (!nativeSupervisor || !Number.isSafeInteger(nativeSupervisor.pid)) return false;
  const chain = readAncestry(pid);
  if (!chain) return false;
  return chain.some(ancestor => ancestor.pid === nativeSupervisor.pid
    && ancestor.bootId === nativeSupervisor.bootId && ancestor.startTicks === nativeSupervisor.startTicks);
}

const bytesDigest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export const beneath = (root, filename) => { const r = relative(root, filename); return r === '' || !r.startsWith('..') && !isAbsolute(r); };
const signalNumberToName = Object.fromEntries(Object.entries(osConstants.signals ?? {}).map(([name, number]) => [number, name]));

/** Resolve the deepest existing ancestor's realpath, then reattach any
 * not-yet-created remainder. A lexical prefix match is not sufficient: a
 * symlinked ancestor of either path can make `beneath()` wrong in either
 * direction, so both sides are resolved before the lexical comparison. */
async function resolveRealish(target) {
  const parts = target.split('/').filter(Boolean);
  for (let i = parts.length; i >= 0; i--) {
    const candidate = i === 0 ? '/' : `/${parts.slice(0, i).join('/')}`;
    try {
      const real = await realpath(candidate);
      const remainder = parts.slice(i).join('/');
      return remainder ? join(real, remainder) : real;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}
export async function realBeneath(root, filename) {
  const [realRoot, realFilename] = await Promise.all([resolveRealish(root), resolveRealish(filename)]);
  return beneath(realRoot, realFilename);
}

// Linux directory handles pin each ancestor. O_NOFOLLOW on a pathname alone
// cannot protect an ancestor that the worker replaces after inspection.
async function withWorkerPath(filename, operation) {
  if (!isAbsolute(filename) || filename.includes('\0') || filename.split('/').includes('..')) throw new Error('Invalid worker path');
  const components = filename.split('/').filter(Boolean);
  const leaf = components.pop();
  let directory = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const component of components) {
      const next = await open(`/proc/self/fd/${directory.fd}/${component}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await directory.close(); directory = next;
    }
    return await operation(`/proc/self/fd/${directory.fd}/${leaf ?? '.'}`);
  } finally { await directory.close(); }
}

// #2915 review 4 (finding 4): `privateOutput: true` REPAIRS a loose mode
// (chmod 0600) rather than rejecting it — correct for the worker's own
// final-output file, which the launcher itself created and is free to
// re-tighten. `rejectInsecureMode: true` additionally REFUSES a mode other
// than exactly 0600 instead of repairing it, for evidence this launcher
// did NOT create moments ago (retry predecessor metadata) — a 0666 file
// there is itself a signal worth refusing on, not silently normalizing
// away.
async function boundedPrivateRead(filename, limit, inspect, privateOutput = false, rejectInsecureMode = false) {
  if (!await inspect(filename, 'file')) throw new Error('Required worker input is missing');
  const handle = await withWorkerPath(filename, target => open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error('Worker input must be a bounded unaliased regular file');
    if (privateOutput) {
      if (stat.uid !== process.getuid()) throw new Error('Worker final must be conductor-owned');
      if (rejectInsecureMode) {
        if ((stat.mode & 0o777) !== 0o600) throw new Error('Worker input mode must already be exactly 0600; insecure modes are refused, not repaired');
      } else {
        await handle.chmod(0o600);
      }
    }
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error('Worker input exceeds bound');
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}

export async function publishWorkerRecord(runDir, name, value, inspect) {
  await inspect(runDir, 'directory');
  const target = join(runDir, name);
  await inspect(target, 'output');
  await withWorkerPath(target, async anchoredTarget => {
    const temporary = join(dirname(anchoredTarget), `.${name}.${randomUUID()}`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await handle.chmod(0o600);
      await handle.sync();
    } finally { await handle.close(); }
    try { await inspect(target, 'output'); await rename(temporary, anchoredTarget); }
    finally { await unlink(temporary).catch(() => {}); }
  });
}

/** Never trust a PID/PGID from disk. The attached owner supplies this identity. */
export function signalOwnedWorker(identity, signal, { sample = sampleWorkerIdentity, group = sampleWorkerGroup,
  kill = process.kill, supervisor = sampleWorkerIdentity(process.pid) } = {}) {
  if (!identity || identity.pgid !== identity.pid || identity.uid !== process.getuid?.()
    || identity.pgid === supervisor?.pgid || !sameWorkerIdentity(identity, sample(identity.pid))) return false;
  const members = group(identity.pgid);
  if (!members || !members.length || members.some(member => member.uid !== identity.uid
    || member.bootId !== identity.bootId || member.sessionId !== identity.sessionId)) return false;
  try { kill(-identity.pgid, signal); return true; } catch { return false; }
}

/**
 * Bounded SIGTERM-then-SIGKILL escalation against a single already-spawned
 * child process (#2915 review 5, "a second worker over unresolved
 * execution"): the degraded-isolation MCP wait path in
 * `src/mcp/tools/worker-invoke.mjs` sent a single unobserved SIGTERM on
 * timeout and never escalated, unlike this launcher's own identity-verified
 * degraded `stop()` escalation inside `captureOneWorker`, which always
 * follows an unacknowledged SIGTERM with SIGKILL after a bounded grace
 * window. Exported so every caller that owns a plain (non-owned-group)
 * child process shares this ONE escalation instead of re-implementing
 * SIGTERM/grace/SIGKILL timing a second time.
 *
 * Resolves `{ terminated: boolean }` once the child's own `'exit'` event
 * fires or the bounded window elapses, whichever is first — never waits
 * unboundedly beyond `graceMs` plus one fixed 100ms settle tick.
 */
export function terminateChildWithGrace(child, { graceMs = 5000 } = {}) {
  return new Promise(resolve => {
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    if (exited()) { resolve({ terminated: true }); return; }
    let settled = false;
    const done = terminated => { if (settled) return; settled = true; resolve({ terminated }); };
    child.once('exit', () => done(true));
    try { child.kill('SIGTERM'); } catch { done(exited()); return; }
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      setTimeout(() => done(exited()), 100);
    }, graceMs);
    if (killTimer.unref) killTimer.unref();
  });
}

/**
 * ONE function that resolves stop evidence from the isolation layer (#2915
 * round 8, D4), used by every settlement path below instead of deriving
 * `confirmedStop` ad hoc from a child-exit observation or a post-spawn
 * `blocked` outcome (#2915 round 8 critique, finding 5: "stop confirmation
 * is manufactured from insufficient evidence").
 *
 * Returns `{ stop, confirmedStop }` where `stop` is `'none-needed'`,
 * `'unresolved'`, or `'confirmed'` (the vocabulary a reservation's own
 * `stop` field uses — see `ScopedFailureBreaker`), and `confirmedStop` is
 * the boolean every existing `settleDirectWorker`/`reconcileStopEvidence`
 * caller already expects.
 *
 * - `dispatchState: 'never-began'` (the D2 hook was never reached — a
 *   proven pre-spawn refusal): `none-needed`, never `unresolved` — there is
 *   nothing to confirm the stop of.
 * - `dispatchState: 'submission-uncertain'` (a `systemd-run` submission
 *   itself failed or timed out): dispatch-uncertain, so `unresolved` — the
 *   absence of a returned child/unit does not prove nothing dispatched.
 * - `isolationMode: 'systemd-unit'`: the OWNED UNIT (`unitName`) is the
 *   actual stop/query authority — NEVER the attached `systemd-run`
 *   transport child. `confirmed` only when the unit itself is inactive
 *   after the stop request; an unavailable/ambiguous unit query is
 *   `unresolved`, never a fabricated confirmation.
 * - `isolationMode: 'degraded'` (including a degraded ATTACHED transport
 *   wrapper): no native unit query exists, so a confirmed exit of OUR OWN
 *   direct child — the wrapper, or the worker itself for a non-attached
 *   launch — is NEVER sufficient evidence that its descendants stopped;
 *   this always reports `unresolved`/`confirmedStop: false`, even when the
 *   bounded stop escalation below genuinely confirms the direct child
 *   exited (see `ScopedFailureBreaker`'s own doc comment on degraded
 *   blocking markers — this is a documented, accepted limitation, not an
 *   oversight). The escalation still runs, best-effort, so a live child is
 *   actually signalled.
 */
export async function resolveStopEvidence({ isolationMode, unitName = null, child = null,
  dispatchState = 'dispatched', graceMs = 5000,
  terminateChild = terminateChildWithGrace, stopUnit = stopWorkerUnit, getStatus = getWorkerIsolationStatus } = {}) {
  if (dispatchState === 'never-began') return { stop: 'none-needed', confirmedStop: false };
  if (dispatchState === 'submission-uncertain') return { stop: 'unresolved', confirmedStop: false };
  if (isolationMode === 'systemd-unit' && unitName) {
    try { stopUnit(unitName); } catch { /* best-effort: still re-check status below */ }
    try {
      const status = getStatus(unitName);
      if (status && status.active === false) return { stop: 'confirmed', confirmedStop: true };
    } catch { /* unit status unavailable -- fall through to unresolved */ }
    return { stop: 'unresolved', confirmedStop: false };
  }
  if (typeof terminateChild === 'function' && child) {
    try { await terminateChild(child, { graceMs }); } catch { /* best-effort */ }
  }
  return { stop: 'unresolved', confirmedStop: false };
}

/** Execution-time files in the launcher's private directory. Content producers
 * are pure; preview paths remain ${artifact:name}. Workspace locations are a
 * future declaration kind and are refused here. */
export async function materializeWorkerArtifacts(invocation, runDir) {
  const artifacts = invocation.artifacts ?? [];
  if (!Array.isArray(artifacts) || artifacts.length > 16) throw new Error('Worker artifact count exceeds bound');
  const names = new Set();
  let total = 0;
  for (const artifact of artifacts) {
    if (!artifact || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(artifact.name)
      || /[^A-Za-z0-9_-]/.test(artifact.name) || names.has(artifact.name) || typeof artifact.content !== 'string'
      || artifact.location !== undefined && artifact.location !== 'run-directory') throw new Error('Invalid worker artifact declaration');
    names.add(artifact.name);
    const size = Buffer.byteLength(artifact.content);
    total += size;
    if (size > 1048576 || total > 4194304) throw new Error('Worker artifact bytes exceed bound');
  }
  const paths = new Map(artifacts.map(artifact => [artifact.name, join(runDir, `artifact-${artifact.name}`)]));
  const argv = invocation.argv.map(token => {
    if (!token.includes('${artifact:')) return token;
    const match = /^\$\{artifact:([A-Za-z0-9][A-Za-z0-9_-]{0,63})\}$/.exec(token);
    if (!match || !paths.has(match[1])) throw new Error('Undeclared worker artifact placeholder');
    return paths.get(match[1]);
  });
  const { inspectWorkerPath } = await importImpl(import.meta.url, 'serve/worker-invocation.js');
  await inspectWorkerPath(runDir, 'directory');
  const stat = await lstat(runDir);
  if (stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Worker artifact directory must be private and owned');
  const created = [];
  const cleanup = async () => {
    const results = await Promise.allSettled(created.map(filename =>
      withWorkerPath(filename, target => unlink(target)).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      })));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  };
  try {
    for (const artifact of artifacts) {
      const filename = paths.get(artifact.name);
      const handle = await withWorkerPath(filename, target => open(target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
      created.push(filename);
      try { await handle.writeFile(artifact.content); await handle.sync(); }
      finally { await handle.close(); }
    }
    return { argv, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

async function launchOneWorker(owner, options) {
  const { inspectWorkerPath: inspect, revalidateWorkerInvocationPlan: validate } = await importImpl(import.meta.url, 'serve/worker-invocation.js');
  const { qualificationDigest } = await importImpl(import.meta.url, 'models/qualification-digest.mjs');
  const planBytes = await boundedPrivateRead(options.invocationPath, 1048576, inspect);
  const saved = JSON.parse(planBytes.toString('utf8'));
  const loadInputs = options.loadInputs ?? (options.inputs ? async () => options.inputs : async () =>
    (await importImpl(import.meta.url, 'cli/handlers/models.js')).loadWorkerInputs({
      cwd: process.cwd(), args: [], rawArgs: [], frameworkRoot: fileURLToPath(new URL('../../', import.meta.url)) }));
  let inputs = await loadInputs();
  const clock = () => typeof options.now === 'function' ? options.now() : options.now ?? new Date().toISOString();
  const now = clock();
  const invocation = await validate(saved, inputs.snapshot, inputs.drivers, now);
  if (invocation.transport !== 'shell') throw new Error('One-shot capture requires shell transport; use the qualified MCP descriptor directly');
  if (process.platform !== 'linux') throw new Error('One-shot worker capture requires qualified Linux process identity');
  const runDir = options.runDir;
  const runExists = await inspect(runDir, 'directory');
  if (runExists) {
    const stat = await lstat(runDir);
    if (stat.uid !== process.getuid() || (stat.mode & 0o077) || (await readdir(runDir)).length) {
      throw new Error('Worker run directory must be fresh, empty, private and owned');
    }
  }
  const writableRoots = inputs.drivers[invocation.selected.cli].qualification.installation?.workerWritableRoots ?? [invocation.cwd];
  let writableRootsContainRunDir = await realBeneath(invocation.cwd, runDir);
  for (const root of writableRoots) writableRootsContainRunDir ||= await realBeneath(root, runDir);
  if (writableRootsContainRunDir) {
    throw new Error('Run metadata must be outside worker-writable roots');
  }
  // #2915 review 5 (finding 4, "unauthenticated or reused authority"):
  // `verifyRetryPredecessor`'s own `workerWritableRoots` exclusion was
  // never wired into production -- `SessionLauncher.launchWorker` called
  // it BEFORE any plan was even loaded, with no resolved driver and so no
  // `workerWritableRoots` to pass, leaving a forged predecessor record
  // planted inside a worker-writable directory able to pass through the
  // real `launchWorker` unchecked. Resolving the plan first (here, after
  // `writableRoots` is already computed above for the run-directory check)
  // is what it takes to pass the SAME production-resolved roots into this
  // check too.
  let verifiedPreviousAttemptId = null;
  if (options?.retryOf !== undefined) {
    const exitRecord = await verifyRetryPredecessor(options.retryOf,
      { newInvocationPath: options?.invocationPath, inspect, workerWritableRoots: writableRoots });
    verifiedPreviousAttemptId = exitRecord.invocationId;
  }
  const paths = { stdout: invocation.stdoutPath, stderr: invocation.stderrPath, final: invocation.finalPath };
  if (new Set(Object.values(paths)).size !== 3 || Object.values(paths).some(filename =>
    filename === options.invocationPath || filename === invocation.briefPath
    || dirname(filename) === runDir && basename(filename).startsWith('artifact-')
    || ['invocation.json', 'process.json', 'exit.json', 'health.json', 'final-evidence.json', 'worker-start.json', 'worker-identity.json', 'worker-exit.json',
      'stdout.log', 'stdout.events.jsonl', 'stderr.log', '.launch-owner'].some(name => filename === join(runDir, name)))) {
    throw new Error('Worker output paths must be distinct from trusted metadata, capture files and artifact- paths');
  }
  for (const filename of Object.values(paths)) {
    if (await inspect(filename, 'output')) throw new Error('Fresh worker output paths are required');
    if (!await inspect(dirname(filename), 'directory')) throw new Error('Worker output parent is missing');
  }
  const brief = await boundedPrivateRead(invocation.briefPath, 262144, inspect);
  if (bytesDigest(brief) !== invocation.briefDigest) throw new Error('Worker prompt digest changed');
  // Frame stdin before any spawn: brief-json delivers a conductor-built params
  // document on the stdin pipe, never brief text in argv (#2911).
  const { workerStdinBytes } = await importImpl(import.meta.url, 'serve/worker-stdin-frame.mjs');
  const stdinBytes = workerStdinBytes(invocation, brief, inputs.drivers[invocation.selected.cli]);
  let gate = (options.checkDispatch ?? checkWorkerDispatch)({ config: inputs.snapshot.config });
  if (!gate.ok) throw new Error('Worker dispatch resource gate refused launch');
  const isolation = options.isolation ?? detectWorkerIsolation();
  if (isolation.mode === 'degraded' && !options.allowDegraded) {
    throw new Error('Worker isolation unavailable; explicitly select --allow-degraded-worker or use manual observation');
  }
  // #2915 final (one admission, step 3): invocation ids are minted BEFORE
  // admission, so the exact covering-key set that gated this attempt is the
  // same set `settleDirectWorker` later resolves against — no separate
  // pre-mint probe and post-mint noted-keys pair to drift apart. `options.
  // scopedBreaker === null` disables the gate for callers that own recovery
  // themselves; pre-spawn refusals above never reach this point. Global
  // dispatch AND per-CLI enablement are checked inside `admitDirectWorker`
  // before any breaker construction (#2915 final review, finding 1).
  const invocationId = randomUUID();
  // #2915 review 4 (finding 8): computed ONCE, before admission, so the
  // SAME digest both gates the allowance reservation here and is published
  // into invocation.json below — never recomputed from a possibly-stale
  // `invocation` snapshot after the mid-attempt revalidation further down.
  //
  // #2915 review 6 (finding 6, "changed disabled behavior"): when dispatch
  // is globally disabled, `admitDirectWorker` never consults `taskDigest`
  // at all (it returns `{ gated: false }` before even looking at it), so
  // there is no functional reason to compute the NEW role/task/group/
  // brief-content identity here -- and every reason not to, because this
  // same value is published into `invocation.json` below regardless of
  // gating. Preserve the EXACT origin/main algorithm
  // (`qualificationDigest(saved.request)`) for that published value when
  // disabled, so a disabled-dispatch launch writes byte-for-byte the same
  // `taskDigest` origin/main always did.
  const taskDigest = gate.enabled
    ? await stableTaskChainDigest(saved.request, invocation.briefDigest)
    : qualificationDigest(saved.request);
  let admission;
  try {
    admission = await admitDirectWorker({ gateEnabled: gate.enabled, config: inputs.snapshot.config,
      invocation, invocationId, drivers: inputs.drivers, scopedBreaker: options?.scopedBreaker,
      taskChainDigest: taskDigest, maxAttempts: invocation.limits?.maxAttempts, captureRoot: options?.captureRoot,
      ledgerLock: options?.ledgerLock });
  } catch (error) {
    // Fail closed, never fail open or leak a slot: an admission-time
    // exception (bad breaker state, a thrown import) is a refusal, not a
    // silent skip of the gate.
    const wrapped = new Error(`Worker launch refused: recovery admission failed closed: ${error?.message ?? String(error)}`);
    wrapped.code = RECOVERY_SCOPE_OPEN_CODE;
    throw wrapped;
  }
  if (admission.refused) {
    // #2915 review 4 (finding 8): a ledger-exhaustion refusal has no
    // covering scope (`blockedBy` is empty) -- say so plainly instead of
    // reporting an empty "recovery scope open ()", which reads as a
    // breaker refusal that never happened.
    const message = admission.refused.blockedBy.length
      ? `Worker launch refused: recovery scope open (${admission.refused.blockedBy.join(', ')})`
      : `Worker launch refused: ${admission.refused.reason ?? admission.refused.code}`;
    const error = new Error(message);
    error.code = admission.refused.code;
    error.blockedBy = admission.refused.blockedBy;
    if (admission.refused.ledgerDiagnostic) error.ledgerDiagnostics = [admission.refused.ledgerDiagnostic];
    throw error;
  }
  // #2915 review 6 (finding 9): collects every ledger-accounting diagnostic
  // (a refund that failed to persist) across this attempt's lifecycle so it
  // can be surfaced on the thrown error or the returned result, instead of
  // being silently swallowed. `admission.ledgerDiagnostic` (finding 4: a
  // worker-writable captureRoot fell back to the in-process ledger) is
  // folded in up front so every exit path reports it.
  const ledgerDiagnostics = admission.ledgerDiagnostic ? [admission.ledgerDiagnostic] : [];
  const settleLedger = async (outcome) => {
    const diagnostic = await settleDirectWorker(admission, outcome);
    if (diagnostic) ledgerDiagnostics.push(diagnostic);
  };
  // #2915 review 4 (finding 8): once a real ledger exists, it — not the
  // caller-supplied `options.correctStartup.correctionsUsed` — is
  // authoritative for the one-correction budget. `SessionLauncher.
  // launchWorker`'s own early gate (using the caller's count) still runs
  // first as a fast pre-check with no plan/ledger loaded yet; this is the
  // actual enforcement whenever a task chain is resolvable.
  //
  // #2915 review 6 (finding 6): the read, `startupCorrectionGate`
  // validation and the increment+write now happen inside ONE atomic
  // `reserveLedgerCorrection` call, replacing the former peek-then-gate-
  // then-record sequence (three independent, unlocked steps two concurrent
  // launches could each pass).
  //
  // #2915 review 6 (finding 9): wrapped in try/catch so ANY exception from
  // this block (lock contention, a corrupted record) settles the admission
  // before re-throwing -- the former code let such an exception escape
  // uncaught, stranding the breaker reservation AND the ledger's pending
  // slot forever (neither settle call below this point would ever run).
  if (options?.correctStartup !== undefined && admission.ledger) {
    let gate;
    try {
      // `admission.ledger.captureRoot` (never a fresh re-read of
      // `options?.captureRoot`) so this reuses WHATEVER root admission
      // itself actually settled on -- including the in-process fallback
      // when `admitDirectWorker` found the caller-supplied root
      // worker-writable (finding 4). Re-deriving independently here could
      // otherwise disagree with admission's own decision and address a
      // worker-writable root directly.
      gate = await reserveLedgerCorrection({ captureRoot: admission.ledger.captureRoot, taskChainDigest: taskDigest,
        maxAttempts: invocation.limits?.maxAttempts, reasonCode: options.correctStartup.reasonCode, lock: options?.ledgerLock });
    } catch (error) {
      await settleLedger({ kind: 'uncertain', confirmedStop: true });
      if (ledgerDiagnostics.length) error.ledgerDiagnostics = ledgerDiagnostics;
      throw error;
    }
    if (!gate.ok) {
      // #2915 review 6 (finding 3b, "blocking markers... zero spawns"): a
      // reservation that provably never dispatched must release without
      // leaving a marker, even if this settlement happens to land past its
      // own canary deadline -- PROVEN here: no worker process has been
      // started at any point before this refusal.
      await settleLedger({ kind: 'uncertain', confirmedStop: true });
      const error = new Error(`Startup correction refused: ${gate.reason}`);
      error.code = 'STARTUP_CORRECTION_REFUSED';
      if (ledgerDiagnostics.length) error.ledgerDiagnostics = ledgerDiagnostics;
      throw error;
    }
  }
  // #2915 review 4 (finding 2): this run-directory preparation is
  // pre-spawn work happening AFTER a successful admission above — any
  // failure here (mkdir, ownership, the `.launch-owner` write) must settle
  // the reservation exactly like every other pre-spawn exit, never leak it
  // by throwing before the big try/catch below is reached.
  try {
    if (!runExists) await mkdir(runDir, { mode: 0o700 }); // exclusive attempt: no recursive creation or reuse
    const runStat = await lstat(runDir);
    if (runStat.uid !== process.getuid()) throw new Error('Worker run directory must be conductor-owned');
    await withWorkerPath(runDir, async target => { const handle = await open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await handle.chmod(0o700); } finally { await handle.close(); } });
    const reservation = await withWorkerPath(join(runDir, '.launch-owner'), target => open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
    try { await reservation.writeFile(invocationId); await reservation.sync(); } finally { await reservation.close(); }
  } catch (error) {
    // #2915 review 6 (finding 3b): PROVEN zero-spawn pre-spawn failure --
    // release without leaving a marker even past the canary deadline.
    await settleLedger({ kind: 'uncertain', confirmedStop: true });
    if (ledgerDiagnostics.length) error.ledgerDiagnostics = ledgerDiagnostics;
    throw error;
  }
  const supervisor = sampleWorkerIdentity(process.pid);
  const launchTime = new Date().toISOString();
  const monotonicStart = process.hrtime.bigint().toString();
  const profile = inputs.drivers[invocation.selected.cli].qualification.adapter.invocationProfiles[invocation.selected.profileRef];
  const captures = { stdout: join(runDir, profile.health?.outputFraming === 'jsonl' ? 'stdout.events.jsonl' : 'stdout.log'),
    stderr: join(runDir, 'stderr.log') };
  const writeRecord = options.publishRecord ?? publishWorkerRecord;
  const publishFailures = [];
  let publishing = Promise.resolve();
  // Each write must stay independent: one rejected publish must never block
  // every later one (including the final exit.json). The chain only orders
  // writes; `.catch(() => {})` keeps a prior failure from poisoning it, and
  // the per-call promise returned to the caller still reflects this write's
  // own outcome.
  const publish = (name, value) => {
    const write = publishing.catch(() => {}).then(() => writeRecord(runDir, name, value, inspect));
    publishing = write.catch(error => { publishFailures.push({ name, error: error?.message ?? String(error) }); });
    return write;
  };
  const handles = [];
  let outcome;
  let artifacts;
  try {
    artifacts = await materializeWorkerArtifacts(invocation, runDir);
    const displayArgv = artifacts.argv.map((token, i) => i === 0 ? token : `<argument:${bytesDigest(token)}>`);
    // #2915 review 4 (finding 4): a STABLE task-chain identity, never the
    // raw request object — `qualificationDigest(saved.request)` included
    // `final_output` (a fresh path on every legitimate attempt by design)
    // and the `brief`/`workdir` PATHS, so a genuinely confirmed predecessor
    // with a fresh output path was incorrectly refused as a "different
    // task". Identity is role/task/group plus the BRIEF CONTENT digest
    // (never its path) — the same instructions, not the same
    // attempt-specific paths. (Computed once, above, before admission.)
    await publish('invocation.json', { version: 1, origin: 'launcher', invocationId, attemptId: invocationId,
      // #2915 step 4: set only after `verifyRetryPredecessor` (above, now
      // resolved HERE with the production `workerWritableRoots` wired in —
      // #2915 review 5 finding 4) independently confirmed the predecessor's
      // owned, launcher-written, confirmed-terminal evidence for this exact
      // task — never from an unverified caller claim.
      previousAttemptId: verifiedPreviousAttemptId,
      requestId: invocationId, taskDigest, role: saved.request.role,
      selected: invocation.selected, planDigest: qualificationDigest(saved), invocationDigest: qualificationDigest(invocation),
      policyDigest: invocation.policyDigest, catalogDigest: invocation.catalogDigest, profileDigest: invocation.profileDigest,
      expiresAt: invocation.expiresAt, argv: displayArgv, commandDisplay: displayArgv.map(token => JSON.stringify(token)).join(' '),
      // Retain the legacy digest binding while naming both argv stages explicitly.
      argvDigest: qualificationDigest(invocation.argv), placeholderArgvDigest: qualificationDigest(invocation.argv),
      executedArgvDigest: qualificationDigest(artifacts.argv),
      artifacts: (invocation.artifacts ?? []).map(artifact => ({ name: artifact.name,
        byteLength: Buffer.byteLength(artifact.content), sha256: bytesDigest(artifact.content) })),
      envNames: invocation.envNames, stdin: invocation.stdin,
      prompt: { path: invocation.briefPath, digest: invocation.briefDigest }, cwd: invocation.cwd,
      worktree: { path: invocation.cwd, baseRevision: null }, paths, captures, outputFraming: profile.health?.outputFraming ?? 'opaque',
      health: invocation.health ?? null, transport: invocation.transport,
      isolation: { mode: isolation.mode, memoryMaxGb: options.memoryMaxGb ?? 4 },
      limits: invocation.limits, maxOutputBytes: Math.min(invocation.maxOutputBytes ?? 10485760, 10485760) });
    await publish('process.json', { invocationId, origin: 'launcher', supervisor, worker: null,
      launchTime, monotonicStart, ownership: 'unknown', isolation: isolation.mode });
    // All captures (including the reserved final) open successfully BEFORE spawn.
    for (const filename of [...Object.values(paths), ...Object.values(captures)]) {
      const handle = await withWorkerPath(filename, target => (options.openCapture ?? open)(target, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
      handles.push(handle);
    }
    // Recheck policy, prompt, installation and exact bindings after file preparation.
    inputs = await loadInputs();
    await validate(saved, inputs.snapshot, inputs.drivers, clock());
    gate = (options.checkDispatch ?? checkWorkerDispatch)({ config: inputs.snapshot.config });
    if (!gate.ok) throw new Error('Worker dispatch resource gate refused launch');
    if (bytesDigest(await boundedPrivateRead(invocation.briefPath, 262144, inspect)) !== invocation.briefDigest) throw new Error('Worker prompt changed before spawn');
    const environment = Object.fromEntries(invocation.envNames.filter(name => process.env[name] !== undefined)
      .map(name => [name, process.env[name]]));
    const baselineContent = await sampleOwnedWorktreeContent(invocation.cwd, { files: options.healthArtifacts });
    // #2915 round 8 (D2, replaces the former "debit immediately before this
    // call" comment): the ledger debit now happens INSIDE the dispatch-
    // commit hook, which `launchIsolatedWorker` invokes itself after ALL of
    // its own preparation checks (isolation detection, argument/path
    // validation, manager-environment resolution) and immediately before
    // the actual process-start call — never before them, and never here.
    // This closes the "debiting before the wrapper is premature" gap: a
    // preparation failure INSIDE `launchIsolatedWorker` (e.g. an
    // unreachable systemd user manager) now never reaches the debit at
    // all, exactly like any other pre-spawn refusal above this line.
    //
    // The hook also re-admits this exact dispatch through the breaker's own
    // `beginDispatch -> commitDispatch` bracket (#2915 round 8, D3) — the
    // single leaf-level consumption of this reservation's launch authority,
    // replacing the former separate `claimLaunch` call the borrowed-
    // admission path used to make. `abortDispatch` on any failure (a
    // rejected `beginDispatch`/`commitDispatch`, or a ledger debit that
    // throws) leaves nothing started and the reservation in a releasable,
    // never-dispatched state.
    const onDispatchCommit = admission.gated ? async () => {
      const began = admission.breaker.beginDispatch(admission.token,
        { invocationId: admission.invocationId, selectionDigest: admission.selectionDigest });
      if (!began.ok) throw new Error(`Worker dispatch refused: ${began.reason}`);
      try {
        if (admission.ledger) await debitDirectWorkerAllowance(admission.ledger);
      } catch (error) {
        try { admission.breaker.abortDispatch(admission.token); } catch { /* best-effort */ }
        throw error;
      }
      const committed = admission.breaker.commitDispatch(admission.token);
      if (!committed.ok) {
        try { admission.breaker.abortDispatch(admission.token); } catch { /* best-effort */ }
        throw new Error(`Worker dispatch refused: ${committed.reason}`);
      }
    } : undefined;
    // #2915 round 8: `launchIsolatedWorker`'s dual-mode contract (see its
    // own doc comment on `_runDispatchCommit`) returns a plain object
    // synchronously whenever NO hook is given (the not-gated case) — only
    // `await` it when it genuinely returned a Promise, so a not-gated
    // attached launch keeps its real child's listeners attached in the
    // SAME synchronous tick the child is spawned in, exactly as before
    // this change. Introducing an unconditional microtask tick here let a
    // real child's own queued events (exit/close) race ahead of
    // `captureOneWorker`'s own listener attachment in several tests (and
    // would in production).
    const launchResult = (options.launchIsolated ?? launchIsolatedWorker)({ name: invocationId,
      command: artifacts.argv[0], args: artifacts.argv.slice(1), cwd: invocation.cwd,
      memoryMaxGb: options.memoryMaxGb ?? 4, gate, config: inputs.snapshot.config, isolation,
      allowDegraded: !!options.allowDegraded, attached: true, ownedGroup: true,
      env: environment, envNames: invocation.envNames, stdin: invocation.stdin, runDir,
      ...(onDispatchCommit ? { onDispatchCommit } : {}) });
    outcome = typeof launchResult?.then === 'function' ? await launchResult : launchResult;
    if (!outcome.child) throw new Error('Worker launch did not return an attached child');
    // #2915 review 4 (finding 3): when THIS attempt is the admitted canary
    // for one or more covering scopes, execution itself must be clipped to
    // the canary's own deadline (min(task deadline, admission+300s)) — not
    // merely the breaker's bookkeeping, which only knows how to settle a
    // reservation after the fact. `canaryDeadlineMs`/`canaryNowMs` let
    // `captureOneWorker` enforce a real stop at that wall-clock deadline,
    // on the SAME clock the breaker used to compute it (so synthetic-clock
    // tests and production `Date.now()` both stay self-consistent).
    const canaryDeadlineMs = admission.token?.canaryKeys?.length > 0 ? admission.token.deadlineMs : null;
    const canaryNowMs = admission.breaker?.nowMs ?? (() => Date.now());
    const result = await captureOneWorker(owner, { child: outcome.child, outcome, invocation, invocationId, supervisor,
      launchTime, monotonicStart, publish, publishFailures, paths, handles, inspect, inputs, profile, baselineContent, options, brief, stdinBytes, runDir,
      canaryDeadlineMs, canaryNowMs,
      // #2915 review 4 (finding 7): recovery-specific attempt parsing
      // (`driver.parseWorkerAttemptFinal`) and `result.attemptOutcome`
      // publication only run when recovery is actually gated — disabled
      // dispatch must do no new work at all, matching origin/main exactly
      // (a disabled-dispatch probe still observed the new parser called
      // once).
      recoveryGated: admission.gated });
    // #2915 final (production closure): settle using the evidence-contract
    // `result.attemptOutcome` — never `result.termination` — so a genuinely
    // successful degraded attempt closes its scope instead of silently
    // reopening it forever (#2915 final review, finding 4).
    await settleLedger(classifyAttemptForSettlement(invocation, result,
      { quotaAccount: admission.quotaAccount, installationQualifier: admission.installationQualifier }));
    // #2915 review 6 (finding 6, "changed disabled behavior"): origin/main's
    // `SessionLauncher` never had `lastAttemptResult`/`lastAttemptInvocationId`
    // at all -- gated on `admission.gated` (set HERE, inside `launchOneWorker`,
    // rather than unconditionally in `launchWorker` below) so a disabled-
    // dispatch launch leaves the launcher instance exactly as untouched as it
    // always was, matching origin/main byte-for-byte.
    if (admission.gated) {
      owner.lastAttemptResult = result ?? null;
      owner.lastAttemptInvocationId = result?.invocationId ?? owner.lastAttemptInvocationId;
    }
    // #2915 review 6 (finding 9): surface any ledger-accounting diagnostic
    // accumulated across this attempt's lifecycle on the returned result,
    // mirroring `publishFailures` — never silently discarded.
    if (ledgerDiagnostics.length && result) result.ledgerDiagnostics = ledgerDiagnostics.slice();
    return result;
  } catch (error) {
    if (!outcome?.child) {
      // Pre-spawn failure (or a recovery-scope refusal): PROVEN -- this
      // attempt never ran, so it settles outstanding membership with NO
      // failure evidence (#2915 final review: "every pre-spawn exit
      // releases capacity"). `confirmedStop: true` (#2915 review 6, finding
      // 3b): zero spawns occurred, so release without leaving a marker even
      // if this settlement happens to land past the reservation's own
      // canary deadline.
      await settleLedger({ kind: 'uncertain', confirmedStop: true });
      await publish('exit.json', { invocationId, exitCode: null, signal: null,
        endedAt: new Date().toISOString(), termination: 'confirmed', descendants: 'not-started', errorCode: error.code ?? 'LAUNCH_REFUSED' });
    } else if (admission.gated) {
      // #2915 review 5 (finding 2a, "leaked capacity"), hardened by #2915
      // review 6 (finding 4, "capture-setup exception after spawn"): a
      // child DID attach, but something thrown here means
      // `captureOneWorker` never reached its own normal settlement call
      // above -- its own internal paths are designed to always resolve a
      // `result` rather than throw, so reaching this branch means an
      // exception escaped that contract entirely (e.g. a synchronous
      // failure building the health observer before `finish()` is even
      // wired). The process may genuinely still be running: actually stop
      // it with the SAME bounded SIGTERM-then-SIGKILL escalation every
      // other "stop before retry" path already uses
      // (`terminateChildWithGrace`), and settle with the evidence that
      // produces, rather than abandoning a potentially-live child on a bare
      // 'uncertain' settlement -- the gap that previously let a second
      // canary launch over this attempt's still-running process once
      // backoff elapsed. An UNCONFIRMED stop leaves the finding-3 blocking
      // marker in place if this settlement also lands past the
      // reservation's own canary deadline; a CONFIRMED stop clears it.
      //
      // Confined to the GATED path (#2915 review 6, finding 6, "changed
      // disabled behavior"): origin/main never attempted this and never
      // installed the listener below, so a disabled-dispatch attempt must
      // behave exactly as it always did -- throw immediately, no stop
      // attempt, no listener.
      //
      // The exception escaped before `captureOneWorker` could attach its
      // own `child.once('error', ...)`/`'exit'` listeners, so ANY
      // subsequent async spawn failure (e.g. ENOENT arriving after this
      // synchronous throw, including one already in flight for this exact
      // child) would otherwise surface as an unhandled 'error' event on an
      // EventEmitter with zero listeners -- installed FIRST, before the
      // stop escalation below, which itself can race the same event.
      outcome.child.on('error', () => {});
      // #2915 round 8 (D4): `resolveStopEvidence` is the ONE evidence
      // source here — for `systemd-unit` mode it stops and queries the
      // OWNED UNIT (`outcome.unit`), never the attached `systemd-run`
      // transport child; for `degraded` mode it never fabricates
      // `confirmedStop: true` from a direct-child exit (see its own doc
      // comment).
      const graceMs = (invocation.health?.terminateGraceSeconds ?? 5) * 1000;
      const { confirmedStop } = await resolveStopEvidence({ isolationMode: outcome.mode,
        unitName: outcome.unit ?? null, child: outcome.child, graceMs });
      await settleLedger({ kind: 'uncertain', confirmedStop });
      // #2915 review 6 (finding 3d): when this bounded stop escalation DOES
      // confirm termination, also call the explicit reconciliation -- a
      // harmless no-op if this exact reservation's own settle() above
      // already resolved its marker, but the one path that still clears a
      // blocking marker left behind by a DIFFERENT reservation for this
      // same invocation (e.g. a prior attempt in the same retry chain whose
      // own token is no longer in scope here).
      if (confirmedStop) {
        try { admission.breaker?.reconcileStopEvidence?.({ invocationId, confirmedStop: true }); } catch { /* best-effort */ }
      }
    }
    if (ledgerDiagnostics.length) error.ledgerDiagnostics = ledgerDiagnostics;
    throw error;
  } finally {
    try { await artifacts?.cleanup(); } finally {
      // Never chmod a worker-replaced pathname; only the inodes we opened.
      for (const handle of handles) { await handle.chmod(0o600).catch(() => {}); await handle.close().catch(() => {}); }
      await inspect(runDir, 'directory');
      await withWorkerPath(runDir, async target => { const handle = await open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await handle.chmod(0o700); } finally { await handle.close(); } });
    }
  }
}

async function captureOneWorker(owner, ctx) {
  const { child, outcome, invocation, invocationId, supervisor, launchTime, monotonicStart, publish, paths, handles, options,
    canaryDeadlineMs = null, canaryNowMs = () => Date.now(), recoveryGated = false } = ctx;
  const hasTransport = outcome.mode === 'systemd-unit' || outcome.transportSupervisor;
  const sampleIdentity = options.sampleIdentity ?? sampleWorkerIdentity;
  // Separate hook from `sampleIdentity` (the worker-side sampler): this one
  // samples the launcher's own trusted transport child, never a worker PID,
  // and tests need to control the two independently (e.g. the transport
  // dies as soon as it is sampled once, while the worker side is never
  // reached at all).
  const sampleNativeSupervisor = options.sampleNativeSupervisor ?? sampleWorkerIdentity;
  // For our own detached child, spawn waits through setsid/exec; one owned leader sample suffices.
  const immediate = !hasTransport ? sampleIdentity(child.pid) : null;
  let identity = immediate?.pid === child.pid && immediate?.pid === immediate?.pgid
    && immediate?.uid === process.getuid?.() && immediate?.parentPid === process.pid ? immediate : null;
  // Pin the transport's own birth identity at the earliest possible moment --
  // synchronously, before any await can let it exit and be reaped. For
  // degraded/attached mode `child` IS the transport process (its PID is
  // `native.mainPid` below), so this sample is as trustworthy as the direct
  // child's `immediate` sample above. Sampling this only inside the polling
  // loop (as before) raced a worker that ran and exited fast enough that the
  // transport itself had already exited by the loop's first `await`,
  // leaving `nativeSupervisor` permanently null -- a dead process can never
  // be resampled back to non-null, so no later retry could recover it,
  // which is exactly the ordering that produced the null `worker` field.
  // For systemd-unit mode the unit's MainPID is not known synchronously; it
  // is still resolved once inside observeIdentity.
  let nativeSupervisor = hasTransport && outcome.mode !== 'systemd-unit' ? sampleNativeSupervisor(child.pid) : null;
  const streams = [handles[0], handles[1], handles[3], handles[4]].map(handle => createWriteStream('', { fd: handle.fd, autoClose: false }));
  let identityObservation = 'pending';
  let reportedWorker = null;
  let output = Buffer.alloc(0);
  let total = 0;
  let timedOut = false;
  let stopRequested = false;
  let stopReason = null;
  let errorCode = null;
  let settled = false;
  let waitCode = null;
  let waitSignal = null;
  let deliveredSignal = null;
  let sawExit = false;
  let sawClose = false;
  const driver = ctx.inputs.drivers[invocation.selected.cli];
  const observationOptions = { provider: driver.qualification.adapter.provider, profile: ctx.profile,
    effectiveHealth: invocation.health, invocationId, startedAt: Number(BigInt(monotonicStart)) / 1e6,
    launchTime, contentDigest: ctx.baselineContent, sessionId: options.healthSessionLog?.sessionId ?? null,
    runId: options.healthSessionLog?.runId ?? null, maxOutputBytes: invocation.maxOutputBytes };
  const observer = driver.createHealthObserver?.(observationOptions) ?? createWorkerHealthObserver(observationOptions);
  const tickRate = qualifyWorkerCpuTickRate();
  let previousCpu = null;
  let stdoutOffset = 0;
  let stderrOffset = 0;
  let logCursor = { inode: null, offset: 0, generation: 0 };
  const reportHealth = async () => {
    const health = observer.snapshot();
    owner.emit('health', health);
    try { await publish('health.json', { origin: 'observer', invocationId, health, evidence: observer.evidence() }); }
    catch { observer.gap('CAPTURE_WRITE'); }
    return health;
  };
  const timers = new Set();
  const later = (fn, ms) => {
    if (settled) return null;
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t;
  };
  const graceMs = (invocation.health?.terminateGraceSeconds ?? 5) * 1000;
  const signal = value => {
    if (settled || !signalOwnedWorker(identity, value, { supervisor })) return false;
    deliveredSignal = value;
    return true;
  };
  const readNative = () => { try { return (options.isolationStatus ?? getWorkerIsolationStatus)(outcome.unit); } catch { return null; } };
  const transportRecord = async filename => {
    const target = join(ctx.runDir, filename);
    try {
      const stat = await lstat(target);
      if (stat.uid !== process.getuid() || (stat.mode & 0o077)) return null;
      const record = JSON.parse((await boundedPrivateRead(target, 65536, ctx.inspect)).toString('utf8'));
      if (filename === 'worker-exit.json' && (!(record.exitCode === null || Number.isInteger(record.exitCode) && record.exitCode >= 0 && record.exitCode <= 255)
        || !(record.signal === null || typeof record.signal === 'string' && /^SIG[A-Z0-9]+$/.test(record.signal))
        || record.errorCode != null && (typeof record.errorCode !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(record.errorCode)))) return null;
      return record.invocationId === invocationId ? record : null;
    } catch { return null; }
  };
  // A systemd unit has no owned-PGID signal lever worth relying on: identity
  // may still be null (observeIdentity races the unit's own start), and a
  // signal against a since-reused PID must never be sent. `systemctl --user
  // stop` plus KillMode=control-group is the actual stop authority here; the
  // unit's own retained state (checked in finish() via readNative()) is what
  // confirms or fails to confirm that the stop took effect.
  const stopUnit = () => { try { return (options.stopUnit ?? stopWorkerUnit)(outcome.unit); } catch { return { ok: false }; } };
  const stop = (cause = errorCode ? 'PROVIDER_ERROR' : 'CANCELLED') => {
    if (settled || stopRequested) return;
    stopRequested = true; stopReason = cause;
    timedOut = ['HARD_DEADLINE', 'STARTUP_DEADLINE', 'NO_PROGRESS'].includes(cause);
    if (outcome.mode === 'systemd-unit' && outcome.unit) {
      stopUnit();
      // Backstop: if the unit's own exit does not reach us promptly, force
      // resolution so the caller is never left hanging. finish() still
      // derives confirmed/uncertain from the unit's retained state, not from
      // the fact that a stop was requested.
      later(() => { if (!settled) finish(); }, Math.min(graceMs, hardRemaining()));
      return;
    }
    signal('SIGTERM');
    const remainingGrace = Math.min(graceMs, hardRemaining());
    if (remainingGrace === 0) { signal('SIGKILL'); later(() => finish(), 100); }
    else later(() => { signal('SIGKILL'); later(() => finish(), 100); }, remainingGrace);
  };
  owner.currentProcess = child;
  owner.workerStop = stop;
  const onSignal = () => stop();
  process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal);
  child.stdout.on('data', chunk => {
    observer.feed(chunk, { kind: 'stdout', id: 'stdout', generation: 0, offset: stdoutOffset }); stdoutOffset += chunk.length;
    total += chunk.length;
    const remaining = Math.max(0, Math.min(invocation.maxOutputBytes ?? 10485760, 10485760) - output.length);
    if (remaining) { const bounded = chunk.subarray(0, remaining); output = Buffer.concat([output, bounded]); streams[0].write(bounded); streams[2].write(bounded); }
    if (remaining < chunk.length) { errorCode = 'OUTPUT_LIMIT'; stop(); }
    owner.emit('stdout', chunk);
  });
  let stderrBytes = 0;
  child.stderr.on('data', chunk => {
    observer.feed(chunk, { kind: 'stderr', id: 'stderr', generation: 0, offset: stderrOffset }); stderrOffset += chunk.length;
    const remaining = Math.max(0, 10485760 - stderrBytes);
    streams[1].write(chunk.subarray(0, remaining)); streams[3].write(chunk.subarray(0, remaining)); stderrBytes += chunk.length;
    if (stderrBytes > 10485760) { errorCode = 'OUTPUT_LIMIT'; stop(); }
    owner.emit('stderr', chunk);
  });
  for (const stream of streams) stream.on('error', () => { errorCode = 'CAPTURE_WRITE'; stop(); });
  child.stdin?.on('error', error => { if (error.code !== 'EPIPE') { errorCode = 'STDIN_WRITE'; stop(); } });
  child.stdin?.end(ctx.stdinBytes ?? undefined);
  const recordProcess = () => publish('process.json', { invocationId, origin: 'launcher', supervisor,
    transportProcess: hasTransport ? sampleWorkerIdentity(child.pid) : null,
    nativeSupervisor,
    worker: identity ?? reportedWorker, identityObservation, launchTime, monotonicStart, ownership: identity ? 'owned-group' : 'unknown',
    isolation: outcome.mode, unit: outcome.unit ?? null });
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const finish = async () => {
    if (settled) return;
    settled = true;
    identityObservation = identity ? 'stable-owned-group' : 'no-stable-owned-group';
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    process.off('SIGTERM', onSignal); process.off('SIGINT', onSignal);
    owner.currentProcess = null; owner.workerStop = null;
    child.stdout.destroy(); child.stderr.destroy(); child.stdin?.destroy(); child.unref();
    for (const stream of streams) await new Promise(resolve => { if (stream.destroyed) resolve(); else stream.end(resolve); });
    const native = outcome.mode === 'systemd-unit' ? readNative() : null;
    const members = identity ? sampleWorkerGroup(identity.pgid) : null;
    // An unconfined group can escape via setsid. Empty PGID alone never proves
    // descendant termination; keep the explicit degraded stop uncertain.
    const confirmed = outcome.mode === 'systemd-unit' ? native?.active === false && [1, 2, 3].includes(native.execMainCode)
      : child.pid === undefined;
    // `worker-exit.json`/`worker-identity.json` are written into a directory
    // the worker itself can reach (same UID, no filesystem confinement), so a
    // worker can plant either file before the trusted transport ever writes
    // it. Treat both as unauthenticated, worker-reported hints only: they may
    // inform diagnostics (`workerTermination`, `nativeSupervisor` fallback)
    // but MUST NOT set exitCode/signal/termination/confirmed. Authority comes
    // from successful launcher-owned signal delivery, the wait() status of its direct
    // child (never the worker — `child` here is the trusted transport or the
    // systemd-run wrapper that mirrors the unit's real exit) or, for
    // systemd-unit mode, from `getWorkerIsolationStatus` queried against the
    // unit by name, also not a worker-writable path.
    const workerExit = hasTransport ? await transportRecord('worker-exit.json') : null;
    // A worker that exits before the launcher sees it alive leaves only the
    // transport's start record. Publish it as a diagnostic, labelled
    // unverified and with ownership unknown: it is never signal authority
    // (`identity` stays null) and needs the supervisor the launcher sampled.
    if (!identity && hasTransport && nativeSupervisor) {
      const workerStart = await transportRecord('worker-identity.json');
      if (workerStart?.worker && sameWorkerIdentity(workerStart.supervisor, nativeSupervisor)
        && workerStart.worker.parentPid === nativeSupervisor.pid) {
        reportedWorker = workerStart.worker;
        identityObservation = 'transport-reported-unverified';
      }
    }
    // Successful owned-group delivery is a fallback only while both wait
    // and unit-native exit status are unavailable. Observed status wins.
    // Failed/refused signals and worker-writable records grant no evidence.
    const nativeExited = outcome.mode === 'systemd-unit' && [1, 2, 3].includes(native?.execMainCode);
    const resultSignal = (outcome.mode === 'systemd-unit' && [2, 3].includes(native?.execMainCode)
      ? signalNumberToName[native.execMainStatus] ?? null : waitSignal)
      ?? (!sawExit && waitCode === null && waitSignal === null && !nativeExited ? deliveredSignal : null);
    const exitCode = resultSignal ? null
      : outcome.mode === 'systemd-unit' && native?.execMainCode === 1 ? native.execMainStatus : waitCode;
    const result = { invocationId, exitCode, signal: resultSignal,
      endedAt: new Date().toISOString(), termination: confirmed ? 'confirmed' : 'uncertain',
      descendants: confirmed ? 'stopped' : 'unknown', timedOut: timedOut || hardRemaining() === 0,
      cancelled: stopReason === 'CANCELLED', stopReason, errorCode: errorCode ?? null, capturedBytes: Math.min(total, output.length),
      // Unauthenticated: reported by the worker-writable transport record, not
      // kernel-observed. Never used above for exitCode/signal/termination.
      workerTermination: hasTransport ? workerExit && !workerExit.errorCode ? 'confirmed' : 'uncertain' : sawExit ? 'confirmed' : 'uncertain',
      workerReportedExit: workerExit ? { exitCode: workerExit.exitCode, signal: workerExit.signal, errorCode: workerExit.errorCode ?? null } : null,
      groupMembersRemaining: members?.length ?? null,
      nativeExitCode: native?.execMainCode === 1 ? native.execMainStatus : null,
      captureCoverage: sawClose ? 'complete' : 'gap', isolation: outcome.mode, nativeResult: native?.result ?? null,
      publishFailures: ctx.publishFailures?.length ? ctx.publishFailures.slice() : null };
    // #2915 (evidence contract): `attemptOutcome` is a SEPARATE launcher-owned
    // fact from `termination`/`descendants` above — whether THIS attempt
    // succeeded, never whether the descendant tree is confirmed stopped.
    // `processLevelOutcome` uses only process-observed facts (the direct
    // child's own wait() exit/signal, the systemd unit's own retained
    // ExecMainCode/Status when applicable, launcher-detected errors,
    // timeout and explicit cancellation) — never worker stderr/stdout text
    // or worker-writable records. A degraded-isolation attempt can reach
    // 'succeeded' here even though its `termination` stays 'uncertain'
    // forever (no descendant-stop confirmation is possible without a
    // systemd unit) — this is exactly the #2915 final-review fix: "give
    // degraded successful execution a valid recovery-success path without
    // falsely declaring descendant termination confirmed."
    const directChildCleanExit = sawExit && waitCode === 0 && waitSignal == null;
    const unitConfirmedClean = outcome.mode !== 'systemd-unit' || (native?.execMainCode === 1 && native?.execMainStatus === 0);
    const processLevelOutcome = result.errorCode || result.cancelled || result.timedOut
      ? 'failed'
      : directChildCleanExit && unitConfirmedClean ? 'succeeded'
      : sawExit ? 'failed' // an exit was observed, but it was not a clean one
      : 'uncertain'; // no direct-child exit was ever observed at all
    let healthFinalValid = false;
    let healthAttemptFinalValid = false;
    try {
      const finalStat = await lstat(paths.final);
      if (!finalStat.isFile() || finalStat.isSymbolicLink() || finalStat.nlink !== 1 || finalStat.size > 262144) throw new Error('Invalid final output');
      await ctx.inspect(paths.final, 'file');
      let extracted = false;
      if (finalStat.size === 0 && driver.extractFinal) {
        const final = driver.extractFinal(output.toString('utf8'));
        if (final === null || final === undefined || final.success === false) throw new Error('Missing or unsuccessful final extraction');
        const bytes = JSON.stringify({ invocationId, source: 'adapter-extraction', candidate: true, verified: false, result: final });
        if (Buffer.byteLength(bytes) > 262144) throw new Error('Final exceeds bound');
        await handles[2].writeFile(bytes); extracted = true;
      }
      const finalBytes = await boundedPrivateRead(paths.final, 262144, ctx.inspect, true);
      if (!finalBytes.length) throw new Error('Missing final output');
      if (!extracted && driver.extractFinal) {
        const parsed = driver.extractFinal(finalBytes.toString('utf8'));
        if (parsed === null || parsed === undefined || parsed.success === false) throw new Error('Invalid final output');
      }
      await publish('final-evidence.json', { invocationId, path: paths.final, digest: bytesDigest(finalBytes),
        source: extracted ? 'adapter-extraction' : 'worker-output', candidate: true, verified: false,
        terminalSuccess: result.exitCode === 0 && !result.timedOut && !result.errorCode });
      // Consume #2890's strict final contract when supplied by the installed
      // driver. Legacy extraction remains a candidate, never health authority.
      if (driver.parseWorkerFinal) {
        try {
          // Strict validation consumes original bytes. A legacy extracted
          // object may already have lost duplicate keys and cannot authorize
          // completion through reserialization.
          const claims = await driver.parseWorkerFinal(extracted ? output : finalBytes, {
            format: extracted && ctx.profile.health?.outputFraming === 'jsonl' ? 'jsonl' : 'json', observation: { transport: 'shell',
            status: result.exitCode === 0 && !result.errorCode && !result.timedOut ? 'completed' : 'failed',
            termination: result.termination, exitCode: result.exitCode } });
          // #2915 review 4 (finding 1): a successful PARSE is not success —
          // the worker's own strict claims carry their own `status`, and a
          // schema-valid `status: 'failed'` claim must never authorize
          // closure through this path either.
          //
          // #2915 review 5 (finding 6, disabled-dispatch equivalence): that
          // stricter check must apply ONLY when recovery is actually
          // gated. origin/main's own baseline (`healthFinalValid = true`
          // once the strict parse itself succeeds, with no `.status`
          // inspection) is what every disabled-dispatch caller must keep
          // seeing byte-for-byte -- review 5 found a failed claim now
          // changed disabled health from baseline `completed` to
          // `failed-to-start`/`FINAL_INVALID`, a behavior change with
          // recovery OFF that origin/main never had.
          healthFinalValid = recoveryGated ? claims?.status === 'completed' : true;
        } catch { /* failed strict claims remain unverified candidate evidence */ }
      }
      // #2915: the attempt-terminal sibling validation, gating
      // `result.attemptOutcome` below — same bytes/format, but asserted
      // against `processLevelOutcome` (never confirmed termination) so a
      // degraded or MCP attempt's strict final can validate even though
      // `termination` can never reach 'confirmed' for it.
      if (recoveryGated && driver.parseWorkerAttemptFinal) {
        try {
          const claims = await driver.parseWorkerAttemptFinal(extracted ? output : finalBytes, {
            format: extracted && ctx.profile.health?.outputFraming === 'jsonl' ? 'jsonl' : 'json', observation: { transport: 'shell',
            status: processLevelOutcome === 'succeeded' ? 'completed' : 'failed',
            attemptOutcome: processLevelOutcome, exitCode: result.exitCode } });
          // #2915 review 4 (finding 1): same fix as above — a schema-valid
          // parse whose claims report `status !== 'completed'` must never
          // close a scope through the degraded/MCP attempt-terminal path.
          healthAttemptFinalValid = claims?.status === 'completed';
        } catch { /* invalid/missing final never recovers (invalid-final-never-recovers) */ }
      }
    } catch { result.errorCode ??= 'FINAL_OUTPUT_INVALID'; }
    // The final exit.json publish must always be attempted, independent of
    // whether the preceding recordProcess() write succeeded: a failing
    // process.json must never suppress the exit.json publication attempt
    // (previously, chaining both in one try block meant a thrown
    // recordProcess() skipped publish('exit.json', ...) entirely, leaving no
    // exit record at all). The finally block runs regardless of the try
    // outcome; either failure marks the result uncertain and tags the error.
    try { await recordProcess(); }
    catch { result.termination = 'uncertain'; result.errorCode = 'METADATA_WRITE'; }
    finally {
      try { await publish('exit.json', result); }
      catch { result.termination = 'uncertain'; result.errorCode = 'METADATA_WRITE'; }
    }
    result.health = observer.finish({ ...result, finalValid: healthFinalValid });
    result.healthEvidence = observer.evidence();
    // #2915 review 4 (finding 1): finalized HERE — after every
    // metadata-write attempt that has run so far (recordProcess() and the
    // first exit.json publish, above), so the field a write failure must
    // gate already reflects every failure observed up to this point. "Exit
    // zero alone is insufficient": a clean process-level exit without a
    // strictly-valid final, or with an earlier metadata-write failure,
    // never reaches 'succeeded' — it downgrades to 'uncertain' (never
    // fabricated as 'failed' either, since neither the process evidence nor
    // a write failure shows a definite task failure). A process-level
    // failure stays 'failed' regardless of final validity (a bad exit is
    // bad regardless of what the final claims say).
    // #2915 review 4 (finding 7): only published when recovery is gated —
    // disabled dispatch must add no new field/behaviour versus origin/main.
    if (recoveryGated) {
      result.attemptOutcome = processLevelOutcome === 'succeeded'
        ? (healthAttemptFinalValid && result.errorCode !== 'METADATA_WRITE' ? 'succeeded' : 'uncertain')
        : processLevelOutcome;
    }
    try { await publish('exit.json', result); }
    catch {
      result.termination = 'uncertain'; result.errorCode = 'METADATA_WRITE'; result.health.termination = 'uncertain';
      // #2915 review 5 (finding 1b): the PRIOR round left this as a
      // documented residual ("attemptOutcome was already finalized by the
      // time it could observe this specific failure") -- review 5 correctly
      // called that unsafe: a failure of THIS LAST exit.json publication
      // still returned 'succeeded' and closed the breaker scope on an
      // attempt whose own terminal record never durably landed. Downgrade
      // here, exactly like every earlier metadata-write failure already
      // downgrades above -- never upgrade a 'failed' outcome, only prevent
      // an unconfirmed 'succeeded' from standing.
      if (recoveryGated && result.attemptOutcome === 'succeeded') result.attemptOutcome = 'uncertain';
    }
    await reportHealth();
    owner.emit('complete', result);
    resolveDone(result);
  };
  child.once('error', error => {
    errorCode = error.code ?? 'SPAWN_ERROR';
    observer.observe(classifyWorkerHealthFailure({ code: errorCode }, { source: { kind: 'stderr' } }));
    later(() => finish(), 0);
  });
  child.once('exit', (code, sig) => {
    if (settled) return;
    sawExit = true; waitCode = code; waitSignal = sig; later(() => finish(), graceMs);
  });
  // sawExit/waitCode/waitSignal come solely from the 'exit' handler above; a
  // failed spawn (e.g. ENOENT) never emits 'exit' in this Node, so they stay
  // at their unset defaults (false/null/null) here, which is already correct
  // — there is no real exit to report.
  child.once('close', () => { sawClose = true; finish(); });
  // #2915 review 4 (finding 3): clipped to the admitted canary's own
  // deadline (min(task deadline, admission+300s)) when this attempt is a
  // canary — backoff/expiry sweeps on the breaker side must never leave a
  // live canary's EXECUTION running past the exact deadline that governs
  // whether a second canary could otherwise be admitted over it.
  const hardRemaining = () => {
    const taskRemainingMs = Math.min(invocation.health?.hardTimeoutSeconds ?? invocation.limits.wallSeconds,
      invocation.limits.wallSeconds) * 1000 - (Number(process.hrtime.bigint() - BigInt(monotonicStart)) / 1e6);
    const canaryRemainingMs = canaryDeadlineMs === null ? Infinity : canaryDeadlineMs - canaryNowMs();
    return Math.max(0, Math.min(taskRemainingMs, canaryRemainingMs));
  };
  // Grace is clipped at stop time; forceful cancellation is never scheduled
  // beyond this fixed ceiling, including tasks shorter than startup/grace.
  later(() => {
    observer.check();
    // Snapshot/IPC diagnostics precede stop. A slow disk cannot postpone the
    // monotonic hard cancellation target.
    reportHealth(); stop('HARD_DEADLINE');
  }, hardRemaining());
  const identityCapture = createWorkerIdentityCapture();
  const observeIdentity = async (firstSample) => {
    if (settled) return;
    let candidate = !hasTransport ? firstSample === undefined ? sampleIdentity(child.pid) : firstSample : null;
    // Once the transport is observed to have exited, stop trying to acquire
    // the worker's identity through it: `nativeSupervisor.pid` is a fixed
    // pid *number*, and after the real transport process is gone the OS can
    // reuse that number for an unrelated process, so a live resample of "its"
    // children or a live-resample match against a stale disk record could
    // silently pivot onto that unrelated process. Nothing further can be
    // learned this way regardless -- a dead transport can never produce a
    // new, valid live sample -- so this is a pure safety stop, not a loss.
    if (hasTransport && !sawExit) {
      const native = outcome.mode === 'systemd-unit' ? readNative() : { mainPid: child.pid };
      const recorded = await transportRecord('worker-identity.json');
      // Re-check, not just `settled`: the transport's exit can be observed
      // while this very call is awaiting the disk read above, and resuming
      // into the containment/children-scan work below on a transport pid
      // the OS may have already reused is exactly what this guard exists to
      // prevent -- checking only at entry is not enough once an await
      // separates the check from the work it is meant to gate.
      if (settled || sawExit) return;
      // The transport's own identity cannot change while it is alive. Once
      // pinned, a later non-null resample is never accepted as a
      // replacement: if the transport's pid were reused after it exited,
      // that unrelated process would otherwise become the trusted ancestor
      // for every containment check below. The first successful sample is
      // either the launcher's own spawn-time pin (captured above, before any
      // await could let the transport exit and be reaped) or, for
      // systemd-unit mode where the unit's MainPID isn't known
      // synchronously, the first live resample here.
      nativeSupervisor ??= sampleNativeSupervisor(native?.mainPid);
      const contained = candidatePid => verifyWorkerContainment(candidatePid, { mode: outcome.mode, unit: outcome.unit, nativeSupervisor });
      // A disk record that merely matches a REAL process on resample is not
      // enough: that real process can be any same-UID process on the host.
      // Containment (cgroup for systemd-unit, kernel ppid ancestry for
      // degraded) must also hold before the record is trusted.
      const current = recorded?.worker ? sampleIdentity(recorded.worker.pid) : null;
      if (recorded && sameWorkerIdentity(recorded.supervisor, nativeSupervisor)
        && sameWorkerIdentity(recorded.worker, current)
        && contained(current?.pid)) {
        candidate = current;
        // The transport spawned this worker itself (its sample is past
        // setsid) and this live sample matches its record field for field:
        // two concordant observations by different observers. Only the
        // children scan below can see a pre-setsid fork.
        if (current.pid === current.pgid && current.uid === process.getuid()) identity ??= current;
      } else {
        const children = (options.sampleChildren ?? sampleWorkerChildren)(nativeSupervisor?.pid);
        if (children?.length === 1 && children[0].uid === process.getuid() && children[0].parentPid === nativeSupervisor.pid
          && contained(children[0].pid)) {
          const current = sampleIdentity(children[0].pid);
          if (current?.parentPid === nativeSupervisor.pid && contained(current.pid)) candidate = current;
        }
      }
    }
    // A third-party children scan requires two matching samples: setsid may be pending.
    // A direct child uses stable capture only when its immediate sample was unusable.
    const observed = identityCapture.observe(candidate);
    // The capture's two-matching-samples stability only proves the *same*
    // process answered twice; it says nothing about whose child it is. A
    // transport-path candidate reaching here is already launcher/transport
    // -parented (verified above, before being assigned to `candidate`), but
    // a direct child's candidate is not -- require it here, or an unrelated
    // same-uid group leader (e.g. the OS reusing `child.pid` for something
    // else entirely after our own child exited before the immediate sample)
    // would be accepted merely for repeating within the window. This is
    // deliberately checked *after* `identityCapture.observe()`, not before:
    // rejecting the candidate earlier would starve the capture's own
    // window/deadline bookkeeping of ever seeing a non-null sample.
    if (observed && (hasTransport || observed.parentPid === process.pid)) identity ??= observed;
    if (identity) observer.processStarted(identity);
    if (!identity && !identityCapture.expired()) {
      later(observeIdentity, identityCapture.started() ? 5 : 50); return;
    }
    const observation = identity ? 'stable-owned-group' : 'no-stable-owned-group';
    if (identityObservation !== observation) {
      identityObservation = observation;
      recordProcess().catch(() => { errorCode = 'PROCESS_RECORD'; stop(); });
    }
    // Keep looking for a fresh candidate after an unsuccessful window.
    if (!identity) later(observeIdentity, 50);
  };
  observeIdentity(immediate);
  const sampleLog = async () => {
    const locator = options.healthSessionLog;
    if (!locator || !ctx.profile.health?.sessionLogLocator || !locator.sessionId) return;
    const filename = locator.path;
    let handle;
    try {
      // Explicit trusted locator only; never search global/private transcripts.
      await ctx.inspect(filename, 'file');
      handle = await withWorkerPath(filename, target => open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unavailable session source');
      if (logCursor.inode !== null && (logCursor.inode !== stat.ino || stat.size < logCursor.offset)) {
        observer.gap('SOURCE_GAP', { kind: 'session-log', id: 'session-log' });
        logCursor = { inode: stat.ino, offset: 0, generation: logCursor.generation + 1 };
      }
      logCursor.inode = stat.ino;
      const bytes = Buffer.alloc(Math.min(65536, Math.max(0, stat.size - logCursor.offset)));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, logCursor.offset);
      observer.feed(bytes.subarray(0, bytesRead), { kind: 'session-log', id: 'session-log', generation: logCursor.generation, offset: logCursor.offset });
      logCursor.offset += bytesRead;
    } catch { observer.gap('SOURCE_GAP', { kind: 'session-log', id: 'session-log' }); }
    finally { await handle?.close(); }
  };
  const sampleHealth = async () => {
    if (settled) return;
    const current = identity ? sampleWorkerIdentity(identity.pid) : null;
    const cpu = identity ? sampleWorkerCpuTime(identity, current, tickRate, previousCpu) : { cpuTimeMs: null };
    previousCpu = current;
    const content = await sampleOwnedWorktreeContent(invocation.cwd, { files: options.healthArtifacts });
    await sampleLog();
    if (settled) return;
    observer.sampleActivity({ running: current && sameWorkerIdentity(identity, current) ? true : null, cpu: cpu.cpuTimeMs, content });
    const health = observer.check();
    await reportHealth(); // diagnostics are captured before requesting stop
    if (settled) return;
    if (observer.shouldStop?.() || ['hung', 'failed-to-start'].includes(health.state) || ['HARD_DEADLINE', 'STEP_LIMIT'].includes(health.reasonCode)) stop(health.reasonCode);
    else later(sampleHealth, Math.min(observer.nextDelayMs(), hardRemaining()));
  };
  sampleHealth().catch(() => { observer.gap(); later(sampleHealth, (invocation.health?.checkSeconds ?? 15) * 1000); });
  // Notification of OS launch stays separate from semantic/task acceptance.
  const launchEvent = { invocationId, pid: identity?.pid ?? null, supervisorPid: process.pid, isolation: outcome.mode };
  owner.emit('started', launchEvent); // Preserve the public OS-launch event API.
  owner.emit('launched', launchEvent);
  return done;
}

/**
 * @typedef {Object} LaunchOptions
 * @property {string} prompt - The prompt to send
 * @property {string} sessionId - Session UUID for tracking
 * @property {string} [model='claude-sonnet-5'] - Pinned model variant (see #1450)
 * @property {number} [budget] - Budget per iteration in USD
 * @property {number} [maxTurns] - Maximum number of turns (requires Claude CLI support)
 * @property {boolean} [verbose=false] - Enable verbose output
 * @property {string} [systemPrompt] - System prompt to append
 * @property {Object} [mcpConfig] - MCP server configuration
 * @property {string} workingDir - Working directory for session
 * @property {string} stdoutPath - Path to capture stdout
 * @property {string} stderrPath - Path to capture stderr
 * @property {string} outputDir - Directory for session artifacts
 * @property {number} [timeoutMs] - Timeout in milliseconds
 */

/**
 * @typedef {Object} SessionResult
 * @property {number} exitCode - Process exit code
 * @property {string} stdoutPath - Path to stdout log
 * @property {string} stderrPath - Path to stderr log
 * @property {string} [transcriptPath] - Path to session transcript (if available)
 * @property {string} [parsedEventsPath] - Path to parsed stream events (if available)
 * @property {number} duration - Duration in milliseconds
 * @property {boolean} timedOut - Whether session timed out
 * @property {string} stdoutBuffer - Last portion of stdout
 * @property {number} [toolCallCount] - Number of tool calls detected
 * @property {number} [errorCount] - Number of errors detected
 * @property {number} [totalTokens] - Total token usage detected from stream events
 * @property {number} [inputTokens] - Input token usage detected from stream events
 * @property {number} [outputTokens] - Output token usage detected from stream events
 * @property {number} [costUsd] - Cost detected from stream events
 */

/**
 * @typedef {Object} StreamEvent
 * @property {string} type - Event type (e.g., 'tool_call', 'completion', 'error')
 * @property {number} timestamp - Unix timestamp
 * @property {Object} data - Event data
 */

/**
 * Stop-before-retry gate (#2915, 03 §11.5 steps 1–3). A retry or fresh-tree
 * replacement for a worker is only issued after the previous attempt's
 * termination is CONFIRMED using the launcher's own termination evidence
 * (`exit.json` `termination`, produced in finish() above). An uncertain
 * termination blocks the retry and is surfaced with a code the conductor
 * can act on — it must never silently spawn a duplicate writer.
 */
export const STOP_BEFORE_RETRY_CODE = 'UNCERTAIN_TERMINATION';
export const UNBOUND_RETRY_EVIDENCE_CODE = 'UNBOUND_RETRY_EVIDENCE';

/**
 * Mandatory stop-before-retry gate (#2915, 03 §11.5 steps 1–3). A retry or
 * fresh-tree replacement is only issued after the previous attempt's
 * termination is CONFIRMED using the launcher's own termination evidence
 * (`exit.json` `termination`, produced in finish() above). The evidence must
 * also be BOUND to the previous owned invocation: any object containing
 * `termination: 'confirmed'` is not enough — its `invocationId` must match
 * the launcher's stored previous attempt, or (for a fresh launcher with no
 * stored attempt, e.g. a cross-restart retry) the caller must supply the
 * evidence explicitly and it is adopted as the chain. An uncertain
 * termination, or confirmed evidence for some other invocation, blocks the
 * retry and is surfaced with a code the conductor can act on — it must never
 * silently spawn a duplicate writer.
 */
export function stopBeforeRetryGate(previousResult, { expectedInvocationId = null } = {}) {
  if (previousResult?.termination !== 'confirmed') {
    return {
      ok: false,
      code: STOP_BEFORE_RETRY_CODE,
      reason: `Previous attempt termination is '${previousResult?.termination ?? 'unknown'}', not confirmed: `
        + 'retry is blocked until owned stop is proven (no duplicate writer while the old tree may continue).',
      previousResult: previousResult === undefined ? undefined : (previousResult ?? null),
    };
  }
  const evidenceId = previousResult?.invocationId ?? null;
  if (expectedInvocationId !== null && evidenceId !== expectedInvocationId) {
    return {
      ok: false,
      code: UNBOUND_RETRY_EVIDENCE_CODE,
      reason: `Confirmed termination evidence is for invocation '${evidenceId ?? 'unknown'}', not the previous owned attempt `
        + `'${expectedInvocationId}': retry is blocked until the previous attempt's own stop is proven.`,
      previousResult: previousResult ?? null,
    };
  }
  return { ok: true };
}

export function assertStopBeforeRetry(previousResult, options) {
  const gate = stopBeforeRetryGate(previousResult, options);
  if (!gate.ok) {
    const error = new Error(gate.reason);
    error.code = gate.code;
    error.previousResult = gate.previousResult;
    throw error;
  }
  return gate;
}

/**
 * #2915 review 4 (finding 4): the STABLE task-chain identity shared by
 * `launchOneWorker`'s `invocation.json.taskDigest` and
 * `verifyRetryPredecessor`'s task-chain binding check. Deliberately
 * excludes every attempt-specific PATH (`final_output`, `brief`, `workdir`)
 * — those legitimately differ on every fresh retry attempt by design — and
 * instead binds on role/task/group plus the brief's CONTENT digest (never
 * its path), so a worker-authored brief swap is still caught while a
 * conductor-assigned fresh output directory for the identical instructions
 * is not mistaken for "a different task".
 */
export async function stableTaskChainDigest(request, briefDigest) {
  const { qualificationDigest } = await importImpl(import.meta.url, 'models/qualification-digest.mjs');
  return qualificationDigest({ role: request?.role ?? null, task: request?.task ?? null,
    group: request?.group ?? null, briefDigest: briefDigest ?? null });
}

// ===========================================================================
// Minimal per-task allowance ledger (#2915 review 4, finding 8; hardened by
// #2915 review 6, findings 3-10)
// ===========================================================================
//
// Design, in six lines:
//  1. One small record per task chain (`stableTaskChainDigest`), under
//     `<captureRoot>/ledger/<digest>.json` (0600, launcher-owned), holding
//     bounded arrays of pending/charged invocation ids against the already-
//     resolved `invocation.limits.maxAttempts` — no new config, no new store.
//  2. Every read/modify/write is guarded by an exclusive-create lock file
//     (`<digest>.lock`, O_CREAT|O_EXCL|O_NOFOLLOW — the same mutual-exclusion
//     primitive `process-monitor.mjs`'s `createStatusObservationOwner`
//     already uses) with a bounded wait; the lock records its own owner's
//     identity so a later acquirer can distinguish a crashed owner (whose
//     orphaned lock is reclaimed) from a genuinely busy one (which still
//     refuses, rather than proceeding unlocked, once the wait is exhausted).
//  3. `reserveDirectWorkerAllowance` atomically checks `pending + a durable
//     cumulative charge COUNT < maxAttempts` and appends the invocation id to
//     `pending` (idempotent if already present); `debitDirectWorkerAllowance`
//     moves it pending -> charged and increments the cumulative count;
//     `refundDirectWorkerAllowance` removes a NOT-yet-charged id from
//     `pending` — all three are no-ops once an id is already charged. The
//     cumulative count, never the bounded recent-id cache, is the budget.
//  4. When no `captureRoot` is supplied (MCP has no server-owned capture
//     root today), OR the caller-supplied `captureRoot` resolves inside any
//     worker-writable location, the SAME three operations run against an
//     in-process-only Map keyed by task-chain digest — real within one
//     process, but it grants NO cross-process guarantee; callers on that
//     path must say so (`admitDirectWorker`'s returned `ledgerDiagnostic`).
//  5. Every pending reservation records the reserving process's own
//     forgery-resistant identity (pid+bootId+startTicks); every lock
//     acquisition opportunistically reconciles (refunds) any pending
//     reservation whose owner is now provably dead — charged history is
//     never touched by reconciliation.
//  6. `admitDirectWorker` reserves (only when gated); `launchOneWorker`
//     debits immediately before calling `launchIsolatedWorker`;
//     `settleDirectWorker` refunds automatically whenever the reservation
//     was never debited — no separate refund call site is needed.

export const ALLOWANCE_EXHAUSTED_CODE = 'ALLOWANCE_EXHAUSTED';
export const LEDGER_LOCK_BUSY_CODE = 'LEDGER_LOCK_BUSY';
export const LEDGER_RECORD_INVALID_CODE = 'LEDGER_RECORD_INVALID';

const LEDGER_LOCK_RETRY_MS = 20;
const LEDGER_LOCK_MAX_WAIT_MS = 2000;
// #2915 review 6 (finding 7): bounds the RECENT-dedup caches only (idempotency
// of a debit/refund replay against an id this process has already seen
// recently) — never the admission budget itself, which `chargedCount` (a
// durable cumulative counter, never truncated) now enforces independently.
const LEDGER_MAX_IDS = 64;
// #2915 review 6 (finding 10), matching the design's own stated global
// bound ("5,000 retained charged IDs"): the hard cap on how many DISTINCT
// task-chain digests the in-process fallback will ever track in this
// process. Existing chains are never evicted to make room (see
// `retireInProcessRecordIfEmpty`); a brand-new digest beyond this bound
// fails closed instead.
const IN_PROCESS_LEDGER_MAX_RECORDS = 5000;

function ledgerFail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function ledgerPaths(captureRoot, taskChainDigest) {
  const dir = join(captureRoot, 'ledger');
  return { dir, name: `${taskChainDigest}.json`, recordPath: join(dir, `${taskChainDigest}.json`), lockPath: join(dir, `${taskChainDigest}.lock`) };
}

/** The bounded size of the RECENT charged-id dedup cache for one record —
 * generous relative to `maxAttempts` so no id legitimately charged within
 * this task's own attempt budget is ever evicted during that budget's
 * lifetime (#2915 review 6, finding 7). */
function chargedCacheCap(maxAttempts) { return Math.max(LEDGER_MAX_IDS, Number.isInteger(maxAttempts) ? maxAttempts : 0); }

/** #2915 review 6 (finding 4): the SAME private-ownership bar
 * `launchOneWorker` already applies to a fresh worker run directory
 * (`stat.uid !== process.getuid() || (stat.mode & 0o077)`) extended to the
 * ledger's own directory (and the caller-supplied root it lives under) — an
 * EXISTING directory with the wrong owner or any group/other bit REFUSES;
 * it is never chmod-repaired, the same "refuse, don't reset" policy applied
 * to ledger record files below. A missing directory is left for the caller
 * to create (via `mkdir(..., { mode: 0o700, recursive: true })`, which
 * applies that mode to every newly-created path segment, not only the
 * leaf) — so a brand-new root+ledger pair is private from its first write. */
async function assertPrivateLedgerDirectory(target) {
  let stat;
  try { stat = await lstat(target); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    ledgerFail(LEDGER_RECORD_INVALID_CODE, `Allowance ledger directory is not inspectable (${error.message})`);
  }
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    ledgerFail(LEDGER_RECORD_INVALID_CODE, 'Allowance ledger directory is not privately owned');
  }
}

async function assertPrivateLedgerRoot(captureRoot, dir) {
  await assertPrivateLedgerDirectory(captureRoot);
  await assertPrivateLedgerDirectory(dir);
}

/** Reads this lock file's own recorded owner identity, or `null` for a
 * missing/unreadable/oversized/malformed one — NEVER throws (a lock whose
 * owner cannot be established is simply never eligible for stale recovery
 * below, which is the safe direction). */
async function readLedgerLockOwner(lockPath) {
  try {
    return await withWorkerPath(lockPath, async target => {
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size === 0 || stat.size > 4096) return null;
        const buffer = Buffer.alloc(stat.size);
        await handle.read(buffer, 0, buffer.length, 0);
        return JSON.parse(buffer.toString('utf8'));
      } finally { await handle.close(); }
    });
  } catch { return null; }
}

/** #2915 review 6 (finding 5): true ONLY when the lock's own recorded owner
 * can be PROVEN dead — no pid/bootId/startTicks at all (an empty or
 * unreadable lock, e.g. a crash in the narrow window between O_CREAT and
 * the owner write, is treated as alive/unknown, never stale, so a
 * genuinely busy lock in that window is never mistaken for orphaned), a pid
 * that no longer exists, or a live pid whose identity no longer matches
 * (PID reuse). A lock recorded by a still-live, still-matching owner is
 * NEVER reclaimed. */
async function isLedgerLockOwnerDead(lockPath, sampleIdentity) {
  const owner = await readLedgerLockOwner(lockPath);
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !owner.bootId || !owner.startTicks) return false;
  const current = sampleIdentity(owner.pid);
  return !current || !sameWorkerIdentity(owner, current);
}

/** Bounded-wait exclusive-create lock — the exact primitive
 * `process-monitor.mjs`'s `createStatusObservationOwner` already uses
 * (`O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW`; `EEXIST` means busy). Records the
 * acquirer's own forgery-resistant identity into the lock file so a FUTURE
 * acquirer that finds it already held can tell a crashed owner from a live
 * one (#2915 review 6, finding 5) instead of waiting out the bounded window
 * on every restart forever. Still never proceeds unlocked: exhausting the
 * bounded wait against a genuinely live (or unprovable) owner still
 * refuses. `sleep`/`nowMs`/`sampleIdentity` are injectable so tests can
 * drive lock contention deterministically, without depending on real
 * elapsed wall-clock time or host scheduling. */
async function acquireLedgerLock(lockPath, { retryMs = LEDGER_LOCK_RETRY_MS, maxWaitMs = LEDGER_LOCK_MAX_WAIT_MS,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), nowMs = () => Date.now(),
  sampleIdentity = sampleWorkerIdentity } = {}) {
  const deadline = nowMs() + maxWaitMs;
  let triedStaleRecovery = false;
  for (;;) {
    try {
      const handle = await withWorkerPath(lockPath, target => open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
      try {
        const owner = sampleIdentity(process.pid);
        if (owner) { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); }
      } catch { /* best-effort: an owner that could not be recorded is simply never recoverable as stale later, only ever busy */ }
      return handle;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!triedStaleRecovery && await isLedgerLockOwnerDead(lockPath, sampleIdentity)) {
        // One stale-owner reclaim attempt per acquisition call: unlink the
        // orphaned lock and retry immediately (no sleep). If a live process
        // wins the re-create race in between, the next EEXIST simply falls
        // through to the ordinary bounded wait below — never a second
        // reclaim attempt against what is now a live lock.
        triedStaleRecovery = true;
        try { await unlink(lockPath); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
        continue;
      }
      if (nowMs() >= deadline) ledgerFail(LEDGER_LOCK_BUSY_CODE, `Allowance ledger lock '${lockPath}' is held; refusing rather than proceeding unlocked`);
      await sleep(retryMs);
    }
  }
}

async function releaseLedgerLock(lock, lockPath) {
  try { await lock.close(); } finally { await unlink(lockPath).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
}

/** #2915 review 6 (finding 5): reconciles pending reservations whose owning
 * process is verifiably dead — removed from `pendingIds` exactly like an
 * ordinary refund, because `pendingIds` by construction holds ONLY
 * not-yet-debited reservations: a dead owner can never still be about to
 * dispatch one. Charged history (`chargedIds`/`chargedCount`) is NEVER
 * touched. Returns `true` when the record changed (caller must persist). */
function reconcileDeadOwners(record, sampleIdentity) {
  let changed = false;
  record.pendingIds = record.pendingIds.filter((entry) => {
    const owner = entry?.owner;
    if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return true; // no recorded owner: never swept
    const current = sampleIdentity(owner.pid);
    const dead = !current || !sameWorkerIdentity(owner, current);
    if (dead) changed = true;
    return !dead;
  });
  return changed;
}

/** #2915 review 6 (finding 8): RFC 8259 leaves repeated object member names
 * to the implementation; `JSON.parse` picks "last wins", which lets a
 * forged record smuggle a second, hidden `chargedIds` (or any other member)
 * past an earlier one. Reuses the `yaml` package's own strict-mapping-key
 * parser (already a direct dependency, already used the same way for
 * authored decision documents in `src/decision/entry.ts`) purely as a
 * duplicate-key VALIDATOR — JSON is a flow-mapping subset of YAML 1.2, so
 * every record this ledger itself ever writes (plain `JSON.stringify`
 * output) parses identically either way; the ordinary, fast `JSON.parse`
 * result is still what is returned. Returns `undefined` on ANY syntax or
 * duplicate-key problem — never throws, so callers can produce one bounded
 * diagnostic. */
function strictLedgerJson(text) {
  let value;
  try { value = JSON.parse(text); } catch { return undefined; }
  let document;
  try { document = parseDocument(text, { uniqueKeys: true }); } catch { return undefined; }
  if (document.errors.length) return undefined;
  return value;
}

/** #2915 review 6 (finding 8): full schema/invariant validation — never
 * merely "parses as JSON". Bounded, unique pending/charged ids; pending and
 * charged disjoint (an id can never be simultaneously reserved-but-not-yet-
 * charged AND charged); every count a non-negative integer consistent with
 * the id sets it summarizes (`chargedCount` can never be smaller than the
 * bounded recent cache it is a superset of). Any failure is a refusal,
 * never a reset. */
function validateLedgerRecordShape(record, taskChainDigest) {
  if (!record || typeof record !== 'object' || record.version !== 1 || record.taskChainDigest !== taskChainDigest
    || !Number.isInteger(record.maxAttempts) || record.maxAttempts < 1
    || !Array.isArray(record.pendingIds) || !Array.isArray(record.chargedIds)
    || !Number.isInteger(record.chargedCount) || record.chargedCount < 0
    || !Number.isInteger(record.corrections) || record.corrections < 0) {
    return false;
  }
  const cap = chargedCacheCap(record.maxAttempts);
  if (record.pendingIds.length > cap || record.chargedIds.length > cap) return false;
  const pendingIds = new Set();
  for (const entry of record.pendingIds) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id || pendingIds.has(entry.id)) return false;
    if (entry.owner !== null && entry.owner !== undefined) {
      const owner = entry.owner;
      if (typeof owner !== 'object' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
        || typeof owner.bootId !== 'string' || !owner.bootId || typeof owner.startTicks !== 'string' || !owner.startTicks) return false;
    }
    pendingIds.add(entry.id);
  }
  const chargedIds = new Set();
  for (const id of record.chargedIds) {
    if (typeof id !== 'string' || !id || chargedIds.has(id)) return false;
    chargedIds.add(id);
  }
  for (const id of pendingIds) if (chargedIds.has(id)) return false; // pending and charged are disjoint
  if (record.chargedCount < chargedIds.size) return false; // the cumulative count can never be smaller than its own bounded cache
  return true;
}

/** Reads the existing record, or a fresh default for a never-seen digest.
 * Any tampering — wrong identity, insecure mode, non-launcher ownership,
 * malformed/duplicate-keyed JSON, invalid shape or invariants — REFUSES; it
 * never silently resets to a fresh record (that would let a
 * corrupted/forged record quietly regrant allowance). */
async function readLedgerRecord(recordPath, inspect, taskChainDigest, maxAttempts) {
  if (!await inspect(recordPath, 'file')) {
    return { version: 1, taskChainDigest, maxAttempts, pendingIds: [], chargedIds: [], chargedCount: 0, corrections: 0 };
  }
  let bytes;
  try {
    // #2915 review 4 (finding 4's sibling fix applied here too):
    // `rejectInsecureMode: true` refuses a non-0600 record instead of
    // chmod-repairing it — the same policy `verifyRetryPredecessor` uses
    // for retry-predecessor metadata.
    bytes = await boundedPrivateRead(recordPath, 65536, inspect, true, true);
  } catch (error) { ledgerFail(LEDGER_RECORD_INVALID_CODE, `Allowance ledger record is missing, insecurely-moded or not owned (${error.message})`); }
  const record = strictLedgerJson(bytes.toString('utf8'));
  if (record === undefined) ledgerFail(LEDGER_RECORD_INVALID_CODE, 'Allowance ledger record is not valid JSON or has a duplicate member name');
  if (!validateLedgerRecordShape(record, taskChainDigest)) {
    ledgerFail(LEDGER_RECORD_INVALID_CODE, 'Allowance ledger record identity, shape or invariants do not match');
  }
  return record;
}

async function writeLedgerRecord(dir, name, record, inspect) {
  await mkdir(dir, { mode: 0o700, recursive: true });
  await publishWorkerRecord(dir, name, record, inspect);
}

// In-process-only fallback (#2915 review 4, finding 8: "If there is no
// launcher-owned root for a path ... the ledger is in-process only for
// that path and the code and docs must say so"). Real mutual exclusion
// and counting within this one process; grants NO guarantee across
// processes sharing the same task chain. Used today by the MCP bridge,
// which has no server-owned capture root, and by the launcher whenever a
// caller-supplied `captureRoot` turns out to be worker-writable
// (#2915 review 6, finding 4).
const _inProcessLedger = new Map(); // taskChainDigest -> record (same shape as the on-disk one, minus owner tagging)

export function resetInProcessAllowanceLedger() { _inProcessLedger.clear(); }

function inProcessLedgerRecord(taskChainDigest, maxAttempts) {
  let record = _inProcessLedger.get(taskChainDigest);
  if (!record) {
    // #2915 review 6 (finding 10): bounded GLOBAL retention — once this
    // process has ever seen `IN_PROCESS_LEDGER_MAX_RECORDS` distinct task
    // chains, a brand-new, never-seen digest fails closed rather than
    // growing without bound. Existing chains are never evicted to make
    // room — see `retireInProcessRecordIfEmpty` for why evicting a charged
    // chain is unsafe at any size.
    if (_inProcessLedger.size >= IN_PROCESS_LEDGER_MAX_RECORDS) {
      ledgerFail(ALLOWANCE_EXHAUSTED_CODE, 'In-process allowance ledger is at its global task-chain bound');
    }
    record = { version: 1, taskChainDigest, maxAttempts, pendingIds: [], chargedIds: [], chargedCount: 0, corrections: 0 };
    _inProcessLedger.set(taskChainDigest, record);
  }
  return record;
}

/**
 * #2915 review 6 (finding 10): a record with no charged history and
 * nothing currently outstanding carries zero information worth keeping —
 * remove it so a long-running process doing many reserve+refund cycles for
 * DISTINCT task chains does not accumulate one permanent empty record per
 * chain (the review's probe: 1,000 reserve+refund cycles left 1,000 empty
 * records).
 *
 * A record with ANY charged history (`chargedCount > 0`) is kept for the
 * remaining lifetime of THIS PROCESS, no matter how long it then stays at
 * zero pending: that count is this process's only record of allowance
 * already spent for this task chain, and discarding it would let a later
 * retry for the exact same digest start over at zero — regranting spent
 * allowance, exactly the failure this ledger exists to prevent. The
 * in-process ledger's retention boundary is therefore the PROCESS's own
 * lifetime, not a fixed per-chain timeout or count;
 * `IN_PROCESS_LEDGER_MAX_RECORDS` is the separate, coarser safety valve
 * against unbounded growth from many DISTINCT chains.
 */
function retireInProcessRecordIfEmpty(taskChainDigest) {
  const record = _inProcessLedger.get(taskChainDigest);
  if (record && record.pendingIds.length === 0 && record.chargedCount === 0 && record.corrections === 0) {
    _inProcessLedger.delete(taskChainDigest);
  }
}

/**
 * Atomically reserve one allowance slot for `invocationId` against
 * `taskChainDigest`. Idempotent: re-reserving the same invocation id is a
 * no-op success. Refuses with `ALLOWANCE_EXHAUSTED_CODE` when
 * `pendingIds.length + chargedCount >= maxAttempts` — the durable
 * cumulative `chargedCount`, never the bounded recent-id cache (#2915
 * review 6, finding 7).
 *
 * `lock` (optional) forwards `{ retryMs, maxWaitMs, sleep, nowMs,
 * sampleIdentity }` to the underlying file lock, letting tests drive
 * contention and crash-recovery deterministically.
 *
 * Returns a mutable handle `{ mode, captureRoot, taskChainDigest,
 * invocationId, debited }` — `debited` starts `false` and is flipped by
 * `debitDirectWorkerAllowance` ONLY once the charge is actually persisted;
 * `settleDirectWorker` reads it to decide whether a refund is owed.
 */
export async function reserveDirectWorkerAllowance({ captureRoot, taskChainDigest, invocationId, maxAttempts, lock } = {}) {
  if (!taskChainDigest || !invocationId || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
    ledgerFail(LEDGER_RECORD_INVALID_CODE, 'reserveDirectWorkerAllowance requires taskChainDigest, invocationId and a positive integer maxAttempts');
  }
  if (!captureRoot) {
    const record = inProcessLedgerRecord(taskChainDigest, maxAttempts);
    if (!record.pendingIds.includes(invocationId) && !record.chargedIds.includes(invocationId)) {
      if (record.pendingIds.length + record.chargedCount >= record.maxAttempts) {
        ledgerFail(ALLOWANCE_EXHAUSTED_CODE, `Task-chain allowance exhausted (${record.maxAttempts} attempt(s), in-process ledger)`);
      }
      record.pendingIds = [...record.pendingIds, invocationId];
    }
    return { mode: 'in-process', captureRoot: null, taskChainDigest, invocationId, debited: false };
  }
  const sampleIdentity = lock?.sampleIdentity ?? sampleWorkerIdentity;
  const { inspectWorkerPath: inspect } = await importImpl(import.meta.url, 'serve/worker-invocation.js');
  const { dir, name, recordPath, lockPath } = ledgerPaths(captureRoot, taskChainDigest);
  await assertPrivateLedgerRoot(captureRoot, dir);
  await mkdir(dir, { mode: 0o700, recursive: true });
  const ledgerLock = await acquireLedgerLock(lockPath, lock);
  try {
    const record = await readLedgerRecord(recordPath, inspect, taskChainDigest, maxAttempts);
    // #2915 review 6 (finding 5): opportunistically refund any pending
    // reservation whose owning process is now provably dead, on every lock
    // acquisition — not only during lock-staleness recovery — so a crash
    // between reserve and debit/refund self-heals the next time ANY caller
    // touches this record, not only one that happens to contend on the lock.
    let changed = reconcileDeadOwners(record, sampleIdentity);
    const already = record.pendingIds.some((entry) => entry.id === invocationId) || record.chargedIds.includes(invocationId);
    if (!already) {
      if (record.pendingIds.length + record.chargedCount >= record.maxAttempts) {
        if (changed) await writeLedgerRecord(dir, name, record, inspect); // persist reclaimed allowance even though THIS reservation is refused
        ledgerFail(ALLOWANCE_EXHAUSTED_CODE, `Task-chain allowance exhausted (${record.maxAttempts} attempt(s))`);
      }
      record.pendingIds = [...record.pendingIds, { id: invocationId, owner: sampleIdentity(process.pid) }];
      changed = true;
    }
    if (changed) await writeLedgerRecord(dir, name, record, inspect);
    return { mode: 'file', captureRoot, taskChainDigest, invocationId, debited: false };
  } finally { await releaseLedgerLock(ledgerLock, lockPath); }
}

/** Moves `invocationId` from pending to charged (idempotent) and increments
 * the durable `chargedCount`. Called immediately before dispatch — so a
 * spawn failure, once reached, is already charged; it is never refunded
 * afterward.
 *
 * #2915 review 6 (finding 9): `ledger.debited` is flipped to `true` ONLY
 * after the charge is actually persisted (or, for the in-process mode,
 * after the synchronous in-memory mutation that cannot partially fail) —
 * never before. A lock-acquisition or write failure throws BEFORE that
 * point, leaving `debited` false so `settleDirectWorker`'s refund check
 * still runs and correctly returns the still-pending reservation, instead
 * of permanently stranding it as "already debited" with nothing ever
 * written. */
export async function debitDirectWorkerAllowance(ledger, { lock } = {}) {
  if (!ledger || ledger.debited) return;
  if (ledger.mode === 'in-process') {
    const record = _inProcessLedger.get(ledger.taskChainDigest);
    if (record && !record.chargedIds.includes(ledger.invocationId)) {
      record.pendingIds = record.pendingIds.filter((id) => id !== ledger.invocationId);
      record.chargedIds = [...record.chargedIds, ledger.invocationId].slice(-chargedCacheCap(record.maxAttempts));
      record.chargedCount += 1;
    }
    ledger.debited = true;
    retireInProcessRecordIfEmpty(ledger.taskChainDigest);
    return;
  }
  const sampleIdentity = lock?.sampleIdentity ?? sampleWorkerIdentity;
  const { inspectWorkerPath: inspect } = await importImpl(import.meta.url, 'serve/worker-invocation.js');
  const { dir, name, recordPath, lockPath } = ledgerPaths(ledger.captureRoot, ledger.taskChainDigest);
  await assertPrivateLedgerRoot(ledger.captureRoot, dir);
  const ledgerLock = await acquireLedgerLock(lockPath, lock);
  try {
    const record = await readLedgerRecord(recordPath, inspect, ledger.taskChainDigest, 1);
    let changed = reconcileDeadOwners(record, sampleIdentity);
    if (!record.chargedIds.includes(ledger.invocationId)) {
      record.pendingIds = record.pendingIds.filter((entry) => entry.id !== ledger.invocationId);
      record.chargedIds = [...record.chargedIds, ledger.invocationId].slice(-chargedCacheCap(record.maxAttempts));
      record.chargedCount += 1;
      changed = true;
    }
    if (changed) await writeLedgerRecord(dir, name, record, inspect);
    ledger.debited = true; // committed only once the write above actually succeeded
  } finally { await releaseLedgerLock(ledgerLock, lockPath); }
}

/** Removes `invocationId` from pending (idempotent; a no-op once charged —
 * a preparation refusal AFTER debit must never refund a spawn/canary
 * attempt that already counted). */
export async function refundDirectWorkerAllowance(ledger, { lock } = {}) {
  if (!ledger || ledger.debited) return;
  if (ledger.mode === 'in-process') {
    const record = _inProcessLedger.get(ledger.taskChainDigest);
    if (record) record.pendingIds = record.pendingIds.filter((id) => id !== ledger.invocationId);
    retireInProcessRecordIfEmpty(ledger.taskChainDigest);
    return;
  }
  const sampleIdentity = lock?.sampleIdentity ?? sampleWorkerIdentity;
  const { inspectWorkerPath: inspect } = await importImpl(import.meta.url, 'serve/worker-invocation.js');
  const { dir, name, recordPath, lockPath } = ledgerPaths(ledger.captureRoot, ledger.taskChainDigest);
  await assertPrivateLedgerRoot(ledger.captureRoot, dir);
  const ledgerLock = await acquireLedgerLock(lockPath, lock);
  try {
    const record = await readLedgerRecord(recordPath, inspect, ledger.taskChainDigest, 1);
    let changed = reconcileDeadOwners(record, sampleIdentity);
    if (!record.chargedIds.includes(ledger.invocationId)) {
      const before = record.pendingIds.length;
      record.pendingIds = record.pendingIds.filter((entry) => entry.id !== ledger.invocationId);
      if (record.pendingIds.length !== before) changed = true;
    }
    if (changed) await writeLedgerRecord(dir, name, record, inspect);
  } finally { await releaseLedgerLock(ledgerLock, lockPath); }
}

/**
 * #2915 review 6 (finding 6): replaces the former peek-then-gate-then-record
 * sequence (three independent steps, no lock spanning them — two concurrent
 * launches could each read zero corrections, both pass the one-correction
 * gate, and leave the ledger recording two) with ONE atomic operation: the
 * read, `startupCorrectionGate` validation and the increment+write all
 * happen inside a single lock acquisition (file mode) or a single
 * synchronous block (in-process mode, which cannot be preempted mid-check).
 * A refused (unqualified reason, or budget already exhausted per the real
 * ledger-recorded count) correction reserves/writes nothing.
 */
export async function reserveLedgerCorrection({ captureRoot, taskChainDigest, maxAttempts, reasonCode, lock } = {}) {
  if (!taskChainDigest) return { ok: false, reason: 'No task chain to correct' };
  if (!captureRoot) {
    const record = inProcessLedgerRecord(taskChainDigest, maxAttempts ?? 1);
    const gate = startupCorrectionGate({ correctionsUsed: record.corrections, reasonCode });
    if (gate.ok) record.corrections += 1;
    return gate;
  }
  const sampleIdentity = lock?.sampleIdentity ?? sampleWorkerIdentity;
  const { inspectWorkerPath: inspect } = await importImpl(import.meta.url, 'serve/worker-invocation.js');
  const { dir, name, recordPath, lockPath } = ledgerPaths(captureRoot, taskChainDigest);
  await assertPrivateLedgerRoot(captureRoot, dir);
  await mkdir(dir, { mode: 0o700, recursive: true });
  const ledgerLock = await acquireLedgerLock(lockPath, lock);
  try {
    const record = await readLedgerRecord(recordPath, inspect, taskChainDigest, maxAttempts ?? 1);
    let changed = reconcileDeadOwners(record, sampleIdentity);
    const gate = startupCorrectionGate({ correctionsUsed: record.corrections, reasonCode });
    if (gate.ok) { record.corrections += 1; changed = true; }
    if (changed) await writeLedgerRecord(dir, name, record, inspect);
    return gate;
  } finally { await releaseLedgerLock(ledgerLock, lockPath); }
}

/**
 * #2915 step 4 (retry linkage). Replaces the deleted `freshAttempt`
 * (unauthenticated caller bypass), `afterAttempt` (caller-asserted
 * evidence) and the path-pair (`invocationPath`+`runDir` equality)
 * inference entirely. A retry is now conductor-DECLARED, never inferred:
 * `retryOf` names the previous attempt's `invocationId` AND the exact
 * `runDir` it ran in; omission means unrelated work and is NEVER refused
 * for retry reasons, no matter what path coincidence exists.
 *
 * When supplied, the predecessor's OWN launcher-written evidence is read
 * directly from disk with the same anchored, no-follow, bounded readers
 * `launchOneWorker` uses for every other worker-adjacent file — never a
 * caller-supplied object. The directory and every file must be privately
 * owned (0700 dir; 0600, single-link, unaliased regular files); identity
 * (`.launch-owner`, `invocation.json.invocationId`, `exit.json.invocationId`)
 * must all agree with `retryOf.invocationId`; `invocation.json.origin` must
 * be `'launcher'` (never a worker-writable record); and the predecessor's
 * `taskDigest` must match the NEW attempt's own task (task-chain binding —
 * a retry can replace only the SAME task's prior attempt, never an
 * unrelated one that merely shares a directory). Missing, unreadable,
 * malformed or identity-mismatched evidence refuses the replacement
 * (`UNBOUND_RETRY_EVIDENCE_CODE`); a present, well-formed, matching record
 * still must show CONFIRMED termination (`stopBeforeRetryGate`) — an
 * uncertain predecessor refuses exactly as before.
 *
 * Returns the predecessor's verified `exit.json` record on success; throws
 * on any refusal.
 */
export async function verifyRetryPredecessor(retryOf, { newInvocationPath, inspect, workerWritableRoots } = {}) {
  const fail = (reason) => {
    const error = new Error(`Retry predecessor evidence refused: ${reason}`);
    error.code = UNBOUND_RETRY_EVIDENCE_CODE;
    throw error;
  };
  if (!retryOf || typeof retryOf.invocationId !== 'string' || !retryOf.invocationId
    || typeof retryOf.runDir !== 'string' || !retryOf.runDir) {
    fail('retryOf requires both a non-empty invocationId and runDir');
  }
  const { invocationId: prevId, runDir: prevRunDir } = retryOf;
  // #2915 review 4 (finding 4): the minimal directory-authority repair —
  // reject a predecessor location inside any worker-writable root, exactly
  // like `launchOneWorker` already refuses for a NEW run directory. This
  // closes the easiest forgery (planting a complete, well-formed fake
  // predecessor inside the worktree the worker itself can write to) but is
  // explicitly NOT a defense against an unconfined malicious same-UID
  // worker in general: such a worker can still write anywhere this
  // conductor process can (e.g. directly under a configured capture root,
  // if that root is not itself outside every worker-writable path, or by
  // racing a legitimate predecessor's own directory before this check
  // runs). A real guarantee needs an enforced filesystem/process boundary
  // protecting conductor-owned metadata, or a different execution
  // identity — same-UID alone never provides it.
  if (Array.isArray(workerWritableRoots)) {
    for (const root of workerWritableRoots) {
      if (await realBeneath(root, prevRunDir)) fail('predecessor location is inside a worker-writable root');
    }
  }
  if (!await inspect(prevRunDir, 'directory')) fail('predecessor run directory is missing');
  const dirStat = await lstat(prevRunDir);
  if (dirStat.uid !== process.getuid() || (dirStat.mode & 0o077)) fail('predecessor run directory is not privately owned');
  let ownerBytes, invocationBytes, exitBytes;
  try {
    // #2915 review 4 (finding 4): `rejectInsecureMode: true` — an insecure
    // mode on predecessor metadata REFUSES the retry instead of silently
    // chmod-repairing it and proceeding (the former behaviour the review
    // found: "the probe's 0666 files were accepted and changed to 0600").
    ownerBytes = await boundedPrivateRead(join(prevRunDir, '.launch-owner'), 256, inspect, true, true);
    invocationBytes = await boundedPrivateRead(join(prevRunDir, 'invocation.json'), 1048576, inspect, true, true);
    exitBytes = await boundedPrivateRead(join(prevRunDir, 'exit.json'), 1048576, inspect, true, true);
  } catch (error) { fail(`predecessor metadata is missing, insecurely-moded, or not a bounded, privately-owned, unaliased regular file (${error.message})`); }
  if (ownerBytes.toString('utf8') !== prevId) fail('.launch-owner does not match retryOf.invocationId');
  let invocationRecord, exitRecord;
  try {
    invocationRecord = JSON.parse(invocationBytes.toString('utf8'));
    exitRecord = JSON.parse(exitBytes.toString('utf8'));
  } catch { fail('predecessor metadata is not valid JSON'); }
  if (invocationRecord?.invocationId !== prevId || invocationRecord?.origin !== 'launcher') {
    fail('invocation.json identity does not match retryOf (or is not launcher-written)');
  }
  if (exitRecord?.invocationId !== prevId) fail('exit.json identity does not match retryOf');
  if (newInvocationPath !== undefined) {
    // #2915 review 4 (finding 4): the SAME stable task-chain identity
    // `launchOneWorker` publishes — role/task/group plus the brief CONTENT
    // digest, never `final_output`/`brief`/`workdir` PATHS, which legitimately
    // differ between a confirmed predecessor and this fresh attempt.
    let newTaskDigest;
    try {
      const newPlanBytes = await boundedPrivateRead(newInvocationPath, 1048576, inspect);
      const newPlan = JSON.parse(newPlanBytes.toString('utf8'));
      newTaskDigest = await stableTaskChainDigest(newPlan.request, newPlan.invocation?.briefDigest ?? null);
    } catch { fail('new attempt plan is missing or invalid; cannot bind the retry to a task'); }
    if (invocationRecord.taskDigest !== newTaskDigest) fail('predecessor task does not match the new attempt (task-chain binding)');
  }
  assertStopBeforeRetry(exitRecord, { expectedInvocationId: prevId });
  return exitRecord;
}

/**
 * One corrected startup retry (#2915, 03 §11.5 step 1). A failed start may
 * correct a demonstrated qualified mechanical cause at most once — and only
 * within the task's existing attempts/budget, which the caller enforces.
 * Auth, trust, resource and unknown causes are never qualified: they need
 * authorized restoration or diagnosis, not a blind relaunch.
 */
export const MAX_STARTUP_CORRECTIONS = 1;
export const QUALIFIED_STARTUP_CORRECTION_CODES = Object.freeze(['STDIN_WAIT', 'NOT_FOUND', 'MODEL']);

export function startupCorrectionGate({ correctionsUsed = 0, reasonCode = null } = {}) {
  if (!QUALIFIED_STARTUP_CORRECTION_CODES.includes(reasonCode)) {
    return { ok: false, reason: `Reason '${reasonCode ?? 'unknown'}' is not a qualified mechanical startup cause` };
  }
  if (correctionsUsed >= MAX_STARTUP_CORRECTIONS) {
    return { ok: false, reason: `Startup already corrected once (${correctionsUsed}); no further blind relaunch` };
  }
  return { ok: true, correctionsRemaining: MAX_STARTUP_CORRECTIONS - correctionsUsed };
}

/**
 * Build the narrowest-scope failure attribution for a failed invocation.
 * Identities come from trusted resolved configuration only: the inference
 * backend is the raw `selected.inferenceProvider` string (never normalized
 * through the CLI/provider-definition registry, which maps backends onto
 * CLI ids and merges the two identities), the installation is
 * `selected.cli`, and the quota account is the installation qualification's
 * `accountScope` (or an explicitly passed trusted account). Reason codes
 * carry an evidence source: only launcher/resolver-classified reasons may
 * widen a scope — worker-derived codes (stderr signatures, worker output,
 * worker-writable files) stay invocation-scoped no matter their text.
 */
export async function buildFailureAttribution(invocation, { reasonCode = null, evidenceSource = null,
  quotaAccount = null, hostId = null, corroboratedBackends = null, installationQualifier = null } = {}) {
  const { attributeFailureScope } = await import('./lib/consecutive-failure-circuit-breaker.mjs');
  const { workerModelKey } = await importImpl(import.meta.url, 'models/provider-policy.js');
  const selected = invocation?.selected ?? {};
  let modelKey = null;
  try {
    const inferenceProvider = selected.inferenceProvider ?? null;
    const apiModelId = selected.apiModelId ?? selected.model ?? null;
    if (inferenceProvider && apiModelId) modelKey = workerModelKey(inferenceProvider, apiModelId);
  } catch { modelKey = null; }
  const account = quotaAccount
    ?? invocation?.qualification?.installation?.accountScope
    ?? selected.accountScope
    ?? null;
  return attributeFailureScope({
    reasonCode,
    evidenceSource,
    invocationId: invocation?.invocationId ?? null,
    modelKey,
    cli: selected.cli ?? null,
    inferenceProvider: selected.inferenceProvider ?? null,
    quotaAccount: account,
    hostId,
    corroboratedBackends,
    installationQualifier,
  });
}

/**
 * Classify a launcher-observed attempt outcome into trusted recovery
 * evidence. Uses ONLY launcher-owned facts (spawn errors on the resolved
 * argv, waitpid exit/signal, timeout and termination flags) — never worker
 * stderr/stdout text, structured worker output, or worker-writable records.
 * Post-spawn outcomes therefore attest only that THIS attempt failed, in
 * its own invocation scope; only a failure to execute the resolved CLI
 * binary itself (pre-spawn ENOENT/EACCES on argv[0]) implicates the
 * installation. 429/transport/auth signatures visible only in worker output
 * are worker-sourced by definition and must not be passed here as
 * launcher evidence.
 */
export function classifyLaunchOutcomeForRecovery(result) {
  if (result?.termination !== 'confirmed') return { reasonCode: null, evidenceSource: null };
  const code = result?.errorCode ?? null;
  if ((code === 'ENOENT' || code === 'EACCES' || code === 'SPAWN_ERROR') && !result?.sawExit && result?.exitCode == null) {
    return { reasonCode: 'NOT_FOUND', evidenceSource: 'launcher' };
  }
  return { reasonCode: null, evidenceSource: 'launcher' };
}

/**
 * Process-scoped recovery breaker owner for the S1 direct dispatch path
 * (#2915A). Both direct launch functions (`launchWorker` below and
 * `planDirectWorkerLaunch`) construct-and-consult this one breaker, so
 * repeated conductor attempts in this process share scope state: `canLaunch`
 * before a launch, failure attribution after an attempt, probe/canary
 * gating before a paused scope resumes.
 *
 * State lives in-memory in this process (see ScopedFailureBreaker restart
 * notes): a process restart comes up with every scope CLOSED, coupled with
 * the stop-before-retry gate below. Tests inject a synthetic-clock breaker
 * via `setDirectRecoveryBreaker`; production uses the lazy default.
 */
let _directRecoveryBreaker = null;

export function getDirectRecoveryBreaker() {
  if (!_directRecoveryBreaker) _directRecoveryBreaker = new ScopedFailureBreaker();
  return _directRecoveryBreaker;
}

export function setDirectRecoveryBreaker(breaker) {
  _directRecoveryBreaker = breaker;
}

export function resetDirectRecoveryBreaker() {
  try { _directRecoveryBreaker?.destroy(); } catch { /* never fail teardown */ }
  _directRecoveryBreaker = null;
}

/**
 * Synchronous, process-local digest of a resolved selection (#2915 review 6,
 * finding 1, "unauthenticated/reused authority"): used ONLY to cross-check a
 * BORROWED admission's claimed selection against the invocation we are about
 * to dispatch for -- never persisted, never a stable public identity, never
 * part of any scope key. Deliberately synchronous (no dynamic import):
 * `planDirectWorkerLaunch`'s borrowed-admission branch must throw
 * synchronously (see its own doc comment), so this cannot await the lazy
 * `qualificationDigest` module load the rest of this file otherwise prefers.
 */
export function selectionDigestFor(invocation) {
  const selected = invocation?.selected ?? null;
  if (!selected) return null;
  const payload = JSON.stringify({ cli: selected.cli ?? null, model: selected.model ?? null,
    apiModelId: selected.apiModelId ?? null, inferenceProvider: selected.inferenceProvider ?? null });
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Derive the recovery scope keys covering a resolved invocation, from
 * trusted resolved configuration only (selected cli/backend, installation
 * accountScope, model). The invocation key uses the launcher-minted
 * invocationId. Unresolvable identities are omitted — never defaulted to a
 * shared scope, EXCEPT `host:local`, which always covers every direct
 * dispatch today (single-host S1 scope; #2915 review: model/host scopes
 * could open but nothing ever checked them, since this function omitted
 * both). `installationQualifier`, when supplied, distinguishes
 * separately-qualified installations that share a CLI name (e.g. the
 * installed binary's boundary digest) so two different installations of
 * the same CLI never share one `installation:<cli>` scope.
 */
export async function recoveryScopeKeysForInvocation(invocation, { invocationId = null, quotaAccount = null,
  installationQualifier = null } = {}) {
  const selected = invocation?.selected ?? {};
  const keys = [];
  if (invocationId != null) keys.push(`invocation:${invocationId}`);
  let modelKey = null;
  try {
    const { workerModelKey } = await importImpl(import.meta.url, 'models/provider-policy.js');
    const inferenceProvider = selected.inferenceProvider ?? null;
    const apiModelId = selected.apiModelId ?? selected.model ?? null;
    if (inferenceProvider && apiModelId) modelKey = workerModelKey(inferenceProvider, apiModelId);
  } catch { modelKey = null; }
  if (modelKey) keys.push(`model:${modelKey}`);
  if (selected.cli) keys.push(installationQualifier ? `installation:${selected.cli}:${installationQualifier}` : `installation:${selected.cli}`);
  if (selected.inferenceProvider) keys.push(`provider:${selected.inferenceProvider}`);
  const account = quotaAccount
    ?? invocation?.qualification?.installation?.accountScope
    ?? selected.accountScope
    ?? null;
  if (account) keys.push(`quota:${account}`);
  keys.push('host:local');
  return keys;
}

export const RECOVERY_SCOPE_OPEN_CODE = 'RECOVERY_SCOPE_OPEN';

/**
 * ONE admission entry point (#2915 final review step 3), shared by
 * `launchOneWorker`, `planDirectWorkerLaunch` and the MCP `run()` bridge
 * (`src/mcp/tools/worker-invoke.mjs`). Replaces the three independent
 * `canLaunch`+`noteLaunched` call sites the review found — one of which
 * (MCP shell dispatch) re-gated and rejected its own already-admitted
 * canary, and none of which released capacity uniformly on every pre-spawn
 * exception.
 *
 * Global dispatch (`gateEnabled`, resolved by the caller's own
 * `checkWorkerDispatch()`/dispatch-gate result) AND per-CLI enablement
 * (`config.parallelism.clis[<cli>].enabled`) are checked FIRST, before any
 * import, scope derivation or breaker construction — either disabled
 * returns `{ gated: false }` ("not-gated"): the recovery breaker is never
 * constructed or consulted, so behaviour is byte-for-byte what it was
 * before this feature existed (#2915 final review, finding 1: the planner
 * checked only the global switch, so a per-CLI-disabled selection still
 * constructed and consulted the breaker).
 *
 * Returns one of:
 *   - `{ gated: false }` — recovery is not in effect for this attempt.
 *   - `{ gated: true, refused: { code, blockedBy, nextEligibleAt } }` — a
 *     covering scope is open and not due; nothing was reserved.
 *   - `{ gated: true, breaker, token, quotaAccount, installationQualifier }`
 *     — admitted (ordinarily or as the canary for `token.canaryKeys`).
 *     `token` MUST be passed to exactly one later `settleDirectWorker` call.
 */
export async function admitDirectWorker({ gateEnabled, config, invocation, invocationId, drivers = {},
  scopedBreaker, quotaAccount = null, installationQualifier = null,
  // #2915 review 4 (finding 8): the allowance ledger is consulted ONLY when
  // gated — disabled dispatch (or an ineligible CLI, or a covering scope
  // that's open) performs ZERO ledger operations, the same "not-gated"
  // posture as the breaker itself. `taskChainDigest`/`maxAttempts` are
  // required to reserve; omitting either (a caller with no resolved task,
  // e.g. a flat-option standalone planner call) simply skips the ledger.
  // Test-only passthrough to the ledger's own file-lock contention knobs
  // (`retryMs`/`maxWaitMs`/`sleep`/`nowMs`/`sampleIdentity`) — production
  // omits this and gets the real bounded wait / real clock / real `/proc`
  // identity sampling; tests can drive lock contention and crash recovery
  // deterministically without depending on real elapsed wall-clock time.
  taskChainDigest = null, maxAttempts = null, captureRoot = null, ledgerLock } = {}) {
  if (!gateEnabled) return { gated: false };
  const cli = invocation?.selected?.cli ?? null;
  if (cli && config?.parallelism?.clis?.[cli]?.enabled === false) return { gated: false };
  // #2915 follow-up: an adapter whose `parseWorkerFinal`/`parseWorkerAttemptFinal`
  // can NEVER validate a final (Warp, Copilot — `canVerifyAttempt: false`,
  // see worker-installation.mjs) can never report a verified success back
  // to the breaker. Admitting a canary for such a CLI would gate it behind
  // a success that is structurally unreachable, not merely unlikely — so
  // this CLI is never eligible for recovery-breaker gating at all, exactly
  // like the global/per-CLI dispatch switch being off.
  if (cli && drivers?.[cli]?.canVerifyAttempt === false) return { gated: false, reason: 'cli-cannot-verify-final' };
  const breaker = scopedBreaker !== undefined ? scopedBreaker : getDirectRecoveryBreaker();
  if (!breaker) return { gated: false };
  const resolvedInstallationQualifier = installationQualifier
    ?? drivers?.[cli]?.qualification?.installation?.boundary?.digest ?? null;
  const resolvedQuotaAccount = quotaAccount ?? drivers?.[cli]?.qualification?.installation?.accountScope ?? null;
  const scopeKeys = invocation?.selected
    ? await recoveryScopeKeysForInvocation(invocation, { quotaAccount: resolvedQuotaAccount, installationQualifier: resolvedInstallationQualifier })
    : [];
  // #2915 round 8 (D3): the selection digest is bound onto the breaker's own
  // FROZEN reservation token at admission time — never only a separate
  // mutable field on this function's returned wrapper — so `beginDispatch`
  // later has an authoritative, breaker-owned value to compare against.
  const selectionDigest = selectionDigestFor(invocation);
  const admission = breaker.admit({ invocationId, scopeKeys, selectionDigest });
  if (!admission.ok) {
    return { gated: true, refused: { code: RECOVERY_SCOPE_OPEN_CODE, blockedBy: admission.blockedBy, nextEligibleAt: admission.nextEligibleAt } };
  }
  let ledger = null;
  let ledgerDiagnostic = null;
  if (taskChainDigest != null && Number.isInteger(maxAttempts) && maxAttempts >= 1) {
    // #2915 round 8 (C, "admitDirectWorker rolls back its own partial
    // acquisition"): the breaker already minted a reservation above — root
    // resolution (the worker-writable-root exclusion below) AND the ledger
    // reserve itself are now BOTH covered by one try/catch. Any throw here
    // releases that reservation before propagating, exactly like every
    // other refused admission; previously only the ledger reserve call was
    // protected, leaking the reservation on a root-resolution exception
    // (#2915 round 8 critique, finding "root-resolution exceptions after
    // internal breaker admission; caller-side cleanup cannot recover an
    // unreturned handle").
    try {
      // #2915 review 6 (finding 4): the SAME worker-writable-root exclusion
      // `launchOneWorker` already applies to the run directory, applied here
      // to the ledger's own persistence root — a caller-supplied `captureRoot`
      // inside any worker-writable location (including the invocation's own
      // cwd) is never trusted as cross-process storage: a worker with write
      // access there could delete/replace the ledger record to regrant
      // allowance. Rather than refuse the whole admission, fall back to the
      // in-process ledger (real within this one process) and say so in the
      // returned diagnostics — never silently trust a worker-writable
      // directory as the persistent root.
      let safeCaptureRoot = captureRoot;
      if (safeCaptureRoot != null) {
        const candidateRoots = [invocation?.cwd, ...(drivers?.[cli]?.qualification?.installation?.workerWritableRoots ?? [])].filter(Boolean);
        for (const root of candidateRoots) {
          if (await realBeneath(root, safeCaptureRoot)) {
            ledgerDiagnostic = 'ledger capture root is inside a worker-writable location; using the in-process ledger instead';
            safeCaptureRoot = null;
            break;
          }
        }
      }
      ledger = await reserveDirectWorkerAllowance({ captureRoot: safeCaptureRoot, taskChainDigest, invocationId, maxAttempts, lock: ledgerLock });
    } catch (error) {
      // Release the breaker-side reservation before deciding how to report
      // the failure — never leak it regardless of which branch below runs.
      try { breaker.settle(admission.token, { kind: 'uncertain', confirmedStop: true }); } catch { /* never fail a refusal */ }
      // Preserve the EXISTING behavior for a ledger-reserve-specific
      // failure (exhausted/busy/invalid record): report it as an ordinary
      // refusal, which every caller (`launchOneWorker`, `planDirectWorkerLaunch`,
      // `src/mcp/tools/worker-invoke.mjs`'s `run()`) already handles
      // uniformly. Anything else (e.g. an unexpected root-resolution
      // failure) rethrows — every one of those same callers already treats
      // a thrown `admitDirectWorker` as fail-closed.
      if ([ALLOWANCE_EXHAUSTED_CODE, LEDGER_LOCK_BUSY_CODE, LEDGER_RECORD_INVALID_CODE].includes(error?.code)) {
        return { gated: true, refused: { code: error.code, blockedBy: [], nextEligibleAt: null,
          reason: error.message, ledgerDiagnostic } };
      }
      throw error;
    }
  }
  // `invocationId`/`selectionDigest` (#2915 review 6, finding 1): identity
  // the BORROWED-admission path cross-checks against the invocation it is
  // actually about to dispatch for, so a reservation minted for one
  // invocation/selection cannot authorize a launch for a different one.
  // These are convenience/diagnostic copies ONLY — the authoritative
  // comparison (#2915 round 8, D3) happens inside `beginDispatch` against
  // the breaker's own frozen token fields, never against this object.
  return { gated: true, breaker, token: admission.token, quotaAccount: resolvedQuotaAccount, installationQualifier: resolvedInstallationQualifier,
    ledger, invocationId, selectionDigest, ledgerDiagnostic };
}

/**
 * Settle exactly one `admitDirectWorker` admission. A no-op for a
 * `{ gated: false }` or `{ refused }` admission (nothing was reserved).
 * Never throws: recovery accounting must never fail a launch whose own
 * outcome is already decided.
 */
// #2915 review 4 (finding 8): returns a Promise (resolved once any owed
// ledger refund completes, or immediately if none is owed) so a caller
// that needs deterministic ordering (tests; `launchOneWorker`'s own
// catch blocks) can `await settleDirectWorker(...)`. Production call sites
// in `launchOneWorker` now await it (#2915 review 6, finding 9); a caller
// that still does not await is harmless — the breaker settlement above
// still runs synchronously first, and the refund (if any) still completes
// on its own.
//
// #2915 review 6 (finding 9): the returned promise NEVER rejects (a
// refund failure must never fail a launch whose own outcome is already
// decided) but now resolves to a bounded diagnostic STRING naming the
// refund failure, or `null` when nothing went wrong, instead of silently
// swallowing it into `undefined` — a caller that awaits can surface that
// diagnostic (`launchOneWorker` does, into its thrown error or returned
// result) rather than the failure being entirely invisible.
export function settleDirectWorker(admission, outcome = { kind: 'uncertain' }) {
  // A reservation that was never debited is ALWAYS refunded on settlement,
  // regardless of `outcome` — a preparation refusal or proven pre-spawn
  // exit never reaches the debit point (immediately before dispatch, in
  // `launchOneWorker`), so this is the one place every such path already
  // calls that can return it. Once debited, settlement never touches the
  // ledger again (a dispatched attempt — including a spawn failure or
  // canary — stays charged no matter how it concludes).
  const refund = admission?.ledger && !admission.ledger.debited
    ? refundDirectWorkerAllowance(admission.ledger).then(() => null, (error) => `allowance refund failed: ${error?.message ?? String(error)}`)
    : Promise.resolve(null);
  if (!admission?.gated || !admission.token) return refund;
  // #2915 round 8: callers that construct and consume the D2 dispatch-commit
  // hook (`launchOneWorker`'s attached path, `planDirectWorkerLaunch`'s
  // borrowed/standalone branches) call `abortDispatch` THEMSELVES on a hook
  // failure — never here. `settleDirectWorker` always finalizes with the
  // caller's own reported `outcome` through the ordinary `settle()`, exactly
  // as before: every existing proven-pre-spawn-refusal call site already
  // reports `{ kind: 'uncertain', confirmedStop: true }`, which `settle()`
  // handles identically to `abortDispatch` (itself defined in terms of it).
  try { admission.breaker.settle(admission.token, outcome); } catch { /* recovery accounting must never fail a launch */ }
  return refund;
}

/**
 * Build the `settleDirectWorker` outcome for a launcher-observed direct
 * attempt result, from the evidence-contract `result.attemptOutcome`
 * (#2915 evidence contract — NEVER `result.termination`, which a degraded
 * or MCP attempt can never confirm even on genuine success). A `'failed'`
 * outcome attributes through the same launcher-only evidence
 * `classifyLaunchOutcomeForRecovery` always used, so post-spawn task
 * failures land in the invocation scope however loudly the worker blamed
 * the provider; only a launcher-observed pre-spawn missing-binary failure
 * implicates the installation.
 *
 * `confirmedStop` (#2915 review 5, "a second worker over unresolved
 * execution") is a SEPARATE fact from `kind`: whether THIS attempt's own
 * descendant tree is launcher-confirmed stopped (`result.termination ===
 * 'confirmed'`), independent of whether the attempt succeeded or failed.
 * `ScopedFailureBreaker.settle()` reads it only when this settlement
 * arrives against a reservation whose own canary deadline already passed
 * unresolved — it resolves that reservation's bounded blocking marker, never
 * the ordinary success/failure transition. A degraded-isolation attempt can
 * never confirm descendant termination (`captureOneWorker`'s own `confirmed`
 * computation), so its marker — if any — stays blocking until some other
 * owned isolation evidence resolves it.
 */
export function classifyAttemptForSettlement(invocation, result, { quotaAccount = null, installationQualifier = null } = {}) {
  const kind = result?.attemptOutcome ?? 'uncertain';
  const confirmedStop = result?.termination === 'confirmed';
  if (kind !== 'failed') return { kind, confirmedStop };
  const selected = invocation?.selected ?? {};
  const { reasonCode, evidenceSource } = classifyLaunchOutcomeForRecovery(result);
  return { kind, confirmedStop, reasonCode, evidenceSource, cli: selected.cli ?? null,
    inferenceProvider: selected.inferenceProvider ?? null, quotaAccount, installationQualifier };
}

export class SessionLauncher extends EventEmitter {
  constructor() {
    super();
    // Informational bookkeeping only (#2915 step 4): the retry gate itself
    // no longer reads these — see `launchWorker`'s `options.retryOf`,
    // verified fresh against disk evidence on every call.
    this.lastAttemptResult = null;
    this.lastAttemptInvocationId = null;
    this.currentProcess = null;
    this.startTime = null;
    /** @type {import('./lib/provider-adapter.mjs').ProviderAdapter|null} */
    this.providerAdapter = null;
  }

  /**
   * Set the provider adapter for CLI abstraction
   * @param {import('./lib/provider-adapter.mjs').ProviderAdapter} adapter
   */
  setProviderAdapter(adapter) {
    this.providerAdapter = adapter;
  }

  /**
   * Attached direct attempt; no Ralph state, monitor constructor, retry or legacy args.
   *
   * Stop-before-retry is MANDATORY, not opt-in (#2915B). #2915 step 4
   * DELETED the path-pair (`invocationPath`+`runDir` equality) inference,
   * `afterAttempt` (caller-asserted evidence) and `freshAttempt` (an
   * unauthenticated bypass of the whole gate) entirely. A retry is now
   * conductor-DECLARED, never inferred: `options.retryOf = { invocationId,
   * runDir }` names the previous attempt explicitly. Omission means
   * UNRELATED work and is never refused for retry reasons, no matter what
   * path coincidence exists (#2915 review: an unrelated sequential launch
   * on the same launcher was being refused as if it were a retry). When
   * supplied, `verifyRetryPredecessor` reads the predecessor's OWN
   * launcher-written, privately-owned evidence directly from disk — never
   * a caller-supplied claim — and refuses on anything missing, unreadable,
   * identity-mismatched, or not CONFIRMED terminal.
   *
   * `options.correctStartup: { reasonCode, correctionsUsed }` enforces the
   * one-qualified-startup-correction budget on a conductor-declared
   * correction retry (startupCorrectionGate): unqualified causes and second
   * corrections are refused, within the task's existing allowance. There is
   * no automatic correction loop.
   *
   * Both checks are gated recovery behavior, not a general launch
   * precondition: enforcement happens entirely INSIDE `launchOneWorker`,
   * after admission has determined whether recovery is actually gated for
   * this attempt (global `worker_dispatch` AND per-CLI enablement — see
   * `admitDirectWorker`). Retry-predecessor verification runs there every
   * time `options.retryOf` is supplied, same as any other run; the
   * correction-budget check there only runs once a real ledger exists
   * (`admission.ledger`), never against a caller-supplied `correctionsUsed`.
   * `launchWorker` itself must never pre-empt either refusal before a plan
   * is even loaded — a prior round's early, UNGATED `correctStartup` check
   * here refused calls origin/main would have let through unmodified, since
   * neither option exists on origin/main at all (#2915 review 5, "changed
   * disabled behavior"). Stop-before-retry is MANDATORY regardless of
   * `worker_dispatch`, by design (#2915B) — it is a distinct, always-on
   * safety control, not part of the opt-in scoped-failure-breaker feature
   * the dispatch switch gates.
   */
  async launchWorker(options) {
    if (this.currentProcess || this.workerLaunchPending) throw new Error('A worker is already attached to this launcher');
    this.workerLaunchPending = true;
    // Informational-only `lastAttemptResult`/`lastAttemptInvocationId`
    // bookkeeping (no longer consulted by the retry gate, which is now
    // `options.retryOf`-driven and disk-verified every time) is set inside
    // `launchOneWorker` itself, gated on whether recovery actually admitted
    // this attempt (#2915 review 6, finding 6) — never here unconditionally.
    try { return await launchOneWorker(this, options); }
    finally { this.workerLaunchPending = false; }
  }

  /** Explicit manual observation grants no signal authority, with or without scratch. */
  async adoptWorker({ runDir, invocationId = null, worker, paths = null, request } = {}) {
    const { inspectWorkerPath: inspect } = await importImpl(import.meta.url, 'serve/worker-invocation.js');
    let record = {};
    if (runDir) {
      if (!await inspect(runDir, 'directory')) throw new Error('Manual run directory is missing');
      const stat = await lstat(runDir);
      if (stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Manual run directory must be private and owned');
      const filename = join(runDir, 'process.json');
      if (await inspect(filename, 'file')) {
        const fileStat = await lstat(filename);
        if (fileStat.uid !== process.getuid() || (fileStat.mode & 0o077)) throw new Error('Manual metadata must be private and owned');
        record = JSON.parse((await boundedPrivateRead(filename, 65536, inspect)).toString('utf8'));
      }
    }
    const known = worker ?? record.worker ?? {};
    const fields = ['pid', 'pgid', 'uid', 'host', 'bootId', 'startTicks', 'executable', 'parentPid', 'sessionId'];
    const identity = Object.fromEntries(fields.map(key => [key, known[key] ?? null]));
    const binding = request ?? record.request ?? {};
    const requestFields = ['serverRef', 'requestId', 'sessionId', 'taskTokenRef', 'endpointIdentity'];
    const requestIdentity = Object.fromEntries(requestFields.map(key => [key, binding[key] ?? null]));
    const observedWorker = Number.isSafeInteger(identity.pid) ? sampleWorkerIdentity(identity.pid) : null;
    const health = createWorkerHealthObserver({ invocationId: invocationId ?? record.invocationId ?? 'manual',
      health: { handshake: 'unobserved', outputFraming: 'opaque', coverage: 'unobserved' } }).snapshot();
    health.startupDeadlineAt = null; health.hardDeadlineAt = null;
    health.termination = 'uncertain'; health.unavailableSignals.push('enforced-deadline', 'confirmed-stop');
    return { origin: 'manual', invocationId: invocationId ?? record.invocationId ?? null, worker: identity,
      request: requestIdentity,
      supervisor: null, paths, runDir: runDir ?? null, coverage: runDir ? 'known-files-only' : 'conductor-context-only',
      termination: 'uncertain', exitCode: null, signal: null, ownership: 'unknown',
      unavailable: [...fields.filter(key => identity[key] === null), ...requestFields.filter(key => requestIdentity[key] === null), 'enforced-deadline', 'confirmed-stop'],
      observedWorker, health };
  }

  /**
   * Build Claude CLI arguments
   * @param {LaunchOptions} options
   * @returns {string[]}
   */
  buildArgs(options) {
    const args = [
      // SECURITY: This flag bypasses ALL permission prompts
      // Required for headless operation but enables:
      // - Unrestricted file read/write
      // - Arbitrary command execution
      // - Network access without confirmation
      // See docs/ralph-external-security.md
      '--dangerously-skip-permissions',
      '--print',
      '--output-format', 'stream-json',
      '--session-id', options.sessionId,
    ];

    // Verbose mode
    if (options.verbose) {
      args.push('--verbose');
    }

    // Model selection
    if (options.model) {
      args.push('--model', options.model);
    }

    // Budget control
    if (options.budget) {
      args.push('--max-budget-usd', String(options.budget));
    }

    // Max turns control (if supported by Claude CLI)
    if (options.maxTurns) {
      args.push('--max-turns', String(options.maxTurns));
    }

    // MCP configuration
    if (options.mcpConfig) {
      const configJson = typeof options.mcpConfig === 'string'
        ? options.mcpConfig
        : JSON.stringify(options.mcpConfig);
      args.push('--mcp-config', configJson);
    }

    // System prompt injection
    if (options.systemPrompt) {
      args.push('--append-system-prompt', options.systemPrompt);
    }

    // The prompt itself
    args.push(options.prompt);

    return args;
  }

  /**
   * Launch a Claude Code session
   * @param {LaunchOptions} options
   * @returns {Promise<SessionResult>}
   */
  async launch(options) {
    const sessionResult = await this._launchSession(options);

    // Post-session artifact capture
    await this._captureSessionArtifacts(options, sessionResult);

    return sessionResult;
  }

  /**
   * Internal method to launch session and capture basic output
   * @private
   * @param {LaunchOptions} options
   * @returns {Promise<SessionResult>}
   */
  _launchSession(options) {
    return new Promise((resolve, reject) => {
      // Ensure output directories exist
      mkdirSync(dirname(options.stdoutPath), { recursive: true });
      mkdirSync(dirname(options.stderrPath), { recursive: true });
      if (options.outputDir) {
        mkdirSync(options.outputDir, { recursive: true });
      }

      // Use adapter for args if available, otherwise use legacy buildArgs
      const args = this.providerAdapter
        ? this.providerAdapter.buildSessionArgs({
            prompt: options.prompt,
            // AIWG's tracking UUID is not an OMP native session to resume.
            sessionId: this.providerAdapter.getName() === 'omp' ? options.resumeSession : options.sessionId,
            model: options.model,
            budget: options.budget,
            maxTurns: options.maxTurns,
            verbose: options.verbose,
            systemPrompt: options.systemPrompt,
            mcpConfig: options.mcpConfig,
            thinking: options.thinking,
            tools: options.tools,
          })
        : this.buildArgs(options);
      this.startTime = Date.now();

      // Create write streams for output capture
      const stdoutStream = createWriteStream(options.stdoutPath);
      const stderrStream = createWriteStream(options.stderrPath);
      // Listen for capture-stream errors from the start, so a disk error before
      // the child closes cannot surface as an unhandled 'error' event.
      let captureError = null;
      for (const stream of [stdoutStream, stderrStream]) {
        stream.on('error', (error) => { captureError ??= error; });
      }
      // child.stdout/child.stderr are the child's pipes, distinct from these
      // disk-backed capture streams. The child 'close' event only proves the
      // child's own pipes drained into our 'data' handlers below; it says
      // nothing about whether createWriteStream's internal buffer has been
      // flushed to disk. Resolving on 'close' without waiting for these
      // streams' 'finish' event races the capture file write against callers
      // (e.g. the launcher's own caller) reading stdoutPath/stderrPath
      // immediately after launch() resolves, and can hand back a truncated
      // file under I/O load (#2981).
      // A failed write destroys the stream at once, but WriteStream emits
      // 'error' only after its async fd close, so wait for 'close' (which
      // follows both 'finish' and 'error') rather than returning early on
      // `destroyed`; otherwise launch() can resolve before captureError lands.
      const finalizeCaptureStream = stream => new Promise(res => {
        if (stream.closed) { res(); return; }
        stream.once('close', res);
        if (!stream.destroyed && !stream.writableEnded) stream.end();
      });

      // Buffer for last portion of stdout (for quick analysis)
      let stdoutBuffer = '';
      const isOmp = this.providerAdapter?.getName() === 'omp';
      let ompOutput = '';
      const ompTextDecoder = new StringDecoder('utf8');
      let ompInvalid = false;
      const maxBufferSize = 100000; // 100KB

      // Spawn process using provider adapter or legacy Claude defaults
      const binary = this.providerAdapter ? this.providerAdapter.getBinary() : 'claude';
      const envOverrides = this.providerAdapter ? this.providerAdapter.getEnvOverrides() : { CI: 'true' };

      const abortInput = this.providerAdapter?.getAbortInput?.();
      this.currentProcess = spawn(binary, args, {
        cwd: options.workingDir,
        detached: isOmp && process.platform !== 'win32',
        stdio: [abortInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...envOverrides,
        },
      });

      const child = this.currentProcess;
      const terminate = (signal) => { try { if (isOmp && process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* process already exited */ } };

      // Capture stdout
      child.stdout.on('data', (chunk) => {
        if (isOmp && !ompInvalid) {
          ompOutput += ompTextDecoder.write(chunk);
          if (Buffer.byteLength(ompOutput) > 64 * 1024 * 1024) { ompInvalid = true; ompOutput = ''; terminate('SIGKILL'); }
        }
        stdoutStream.write(chunk);
        stdoutBuffer += chunk.toString();
        // Keep buffer size manageable
        if (stdoutBuffer.length > maxBufferSize) {
          stdoutBuffer = stdoutBuffer.slice(-maxBufferSize);
        }
        this.emit('stdout', chunk);
      });

      // Capture stderr
      child.stderr.on('data', (chunk) => {
        stderrStream.write(chunk);
        this.emit('stderr', chunk);
      });

      // Handle timeout
      let timeoutId = null;
      let timedOut = false;
      // Escalation timers armed by the timeout path. They are unref'd so a
      // child that settles during the abort grace window does not hold the
      // loop process open for the full TERM/KILL schedule, and cleared on
      // close so nothing fires against a reaped pid (#2550).
      const escalationTimers = new Set();
      const armEscalation = (fn, delayMs) => {
        const timer = setTimeout(() => { escalationTimers.delete(timer); fn(); }, delayMs);
        if (typeof timer.unref === 'function') timer.unref();
        escalationTimers.add(timer);
        return timer;
      };
      const clearEscalation = () => {
        for (const timer of escalationTimers) clearTimeout(timer);
        escalationTimers.clear();
      };
      this.pendingEscalationTimers = escalationTimers;

      if (options.timeoutMs) {
        timeoutId = setTimeout(() => {
          timedOut = true;
          this.emit('timeout');
          if (abortInput && child.stdin?.writable) child.stdin.write(abortInput);
          const terminateDelay = abortInput ? 2000 : 0;
          armEscalation(() => terminate('SIGTERM'), terminateDelay);
          // Force kill after bounded graceful-abort and termination windows.
          armEscalation(() => {
            if (child.exitCode === null && child.signalCode === null) {
              terminate('SIGKILL');
            }
          }, terminateDelay + 5000);
        }, options.timeoutMs);
      }

      // Handle process completion
      child.on('close', (code) => {
        if (isOmp) terminate('SIGKILL');
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        clearEscalation();

        const duration = Date.now() - this.startTime;
        this.currentProcess = null;

        // Close streams and wait for the capture files to actually finish
        // writing to disk before handing stdoutPath/stderrPath back to the
        // caller (see finalizeCaptureStream above for why 'close' alone is
        // not sufficient).
        Promise.all([finalizeCaptureStream(stdoutStream), finalizeCaptureStream(stderrStream)]).then(() => {
          // A failed capture means stdoutPath/stderrPath are incomplete; report
          // it rather than hand back a truncated transcript as a result.
          captureError ??= stdoutStream.errored ?? stderrStream.errored;
          if (captureError) {
            this.emit('error', captureError);
            reject(captureError);
            return;
          }
          const result = {
            exitCode: isOmp && (ompInvalid || !this.providerAdapter.parseOutput(ompOutput, { exitCode: code ?? 1 })?.success) ? (code || 1) : (code ?? 1),
            stdoutPath: options.stdoutPath,
            stderrPath: options.stderrPath,
            duration,
            timedOut,
            stdoutBuffer,
          };

          this.emit('complete', result);
          resolve(result);
        });
      });

      // Handle process errors
      child.on('error', (err) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        clearEscalation();

        this.currentProcess = null;

        // Close streams before surfacing the error; no result is returned on
        // this path, so there is nothing to race against, but we still avoid
        // leaving the capture streams dangling.
        Promise.all([finalizeCaptureStream(stdoutStream), finalizeCaptureStream(stderrStream)]).then(() => {
          this.emit('error', err);
          reject(err);
        });
      });

      this.emit('started', { pid: child.pid, args });
    });
  }

  /**
   * Capture session artifacts after completion
   * @private
   * @param {LaunchOptions} options
   * @param {SessionResult} result
   */
  async _captureSessionArtifacts(options, result) {
    if (!options.outputDir) {
      return; // No output directory specified
    }

    try {
      // Copy session transcript if available
      const transcriptPath = await this.copySessionTranscript(
        options.sessionId,
        options.workingDir,
        options.outputDir
      );
      if (transcriptPath) {
        result.transcriptPath = transcriptPath;
      }

      // Parse stream events from stdout
      const { path: eventsPath, stats } = await this.parseStreamEvents(
        options.stdoutPath,
        options.outputDir
      );
      if (eventsPath) {
        result.parsedEventsPath = eventsPath;
        result.toolCallCount = stats.toolCallCount;
        result.errorCount = stats.errorCount;
        result.inputTokens = stats.inputTokens;
        result.outputTokens = stats.outputTokens;
        result.totalTokens = stats.totalTokens;
        result.costUsd = stats.costUsd;
        // Whether the provider actually reported token/cost usage this session.
        // Distinguishes "observed 0" from "cannot observe" so token/spend
        // ceilings aren't silently inert on providers that emit no usage (#1766).
        result.tokenUsageObserved = stats.tokenFieldSeen;
        result.costObserved = stats.costFieldSeen;
      }
    } catch (err) {
      // Log but don't fail the session
      this.emit('artifact-error', err);
    }
  }

  /**
   * Copy session transcript from Claude's project directory
   *
   * Claude stores session transcripts at:
   * ~/.claude/projects/{encoded-path}/{session-id}.jsonl
   *
   * Path encoding: Replace `/` with `-`, prepend `-`
   * Example: /foo/bar → -foo-bar
   *
   * @param {string} sessionId - Session UUID
   * @param {string} workingDir - Working directory path
   * @param {string} outputDir - Destination directory
   * @returns {Promise<string|null>} Path to copied transcript or null if not found
   */
  async copySessionTranscript(sessionId, workingDir, outputDir) {
    try {
      // Use adapter for transcript path if available
      let sourcePath;
      if (this.providerAdapter) {
        sourcePath = this.providerAdapter.getTranscriptPath(sessionId, workingDir);
        if (!sourcePath) {
          // Provider doesn't support transcripts
          this.emit('transcript-not-found', { reason: 'Provider does not support transcripts' });
          return null;
        }
      } else {
        // Legacy Claude-specific path
        const encodedPath = workingDir.replace(/\//g, '-');
        sourcePath = join(
          homedir(),
          '.claude',
          'projects',
          encodedPath,
          `${sessionId}.jsonl`
        );
      }

      // Check if transcript exists
      if (!existsSync(sourcePath)) {
        this.emit('transcript-not-found', { sourcePath });
        return null;
      }

      // Copy to output directory
      const destPath = join(outputDir, 'session-transcript.jsonl');
      copyFileSync(sourcePath, destPath);

      this.emit('transcript-copied', { sourcePath, destPath });
      return destPath;
    } catch (err) {
      this.emit('transcript-error', err);
      return null;
    }
  }

  /**
   * Parse stream-json events from stdout capture
   *
   * Extracts structured events from Claude's stream-json output format.
   * Tracks tool calls, completions, and errors.
   *
   * @param {string} stdoutPath - Path to stdout capture file
   * @param {string} outputDir - Directory to save parsed events
   * @returns {Promise<{path: string|null, stats: Object}>} Parsed events path and statistics
   */
  async parseStreamEvents(stdoutPath, outputDir) {
    const stats = {
      toolCallCount: 0,
      errorCount: 0,
      completionCount: 0,
      totalEvents: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      usageEvents: 0,
      tokenFieldSeen: false,
      costFieldSeen: false,
    };

    try {
      // Read stdout file
      const content = readFileSync(stdoutPath, 'utf-8');

      // Parse stream-json events (each line is a JSON object)
      const events = [];
      const lines = content.split('\n').filter(line => line.trim());

      for (const line of lines) {
        try {
          const event = JSON.parse(line);

          // Categorize event
          const eventType = this._categorizeStreamEvent(event);

          const structuredEvent = {
            type: eventType,
            timestamp: Date.now(), // Could extract from event if available
            data: event,
          };

          events.push(structuredEvent);
          stats.totalEvents++;

          // Update stats
          if (eventType === 'tool_call') {
            stats.toolCallCount++;
          } else if (eventType === 'error') {
            stats.errorCount++;
          } else if (eventType === 'completion') {
            stats.completionCount++;
          }

          const usage = this._extractUsageStats(event);
          if (usage.hasTokenField) {
            stats.tokenFieldSeen = true;
          }
          if (usage.hasCostField) {
            stats.costFieldSeen = true;
          }
          if (usage.hasUsage) {
            stats.inputTokens += usage.inputTokens;
            stats.outputTokens += usage.outputTokens;
            stats.cacheCreationInputTokens += usage.cacheCreationInputTokens;
            stats.cacheReadInputTokens += usage.cacheReadInputTokens;
            stats.totalTokens += usage.totalTokens;
            stats.costUsd += usage.costUsd;
            stats.usageEvents++;
          }
        } catch (parseErr) {
          // Skip malformed lines
          continue;
        }
      }

      // Save parsed events
      const eventsPath = join(outputDir, 'parsed-events.json');
      const eventsData = {
        stats,
        events,
        parsedAt: new Date().toISOString(),
      };

      mkdirSync(dirname(eventsPath), { recursive: true });
      const fs = await import('fs/promises');
      await fs.writeFile(eventsPath, JSON.stringify(eventsData, null, 2));

      this.emit('events-parsed', { eventsPath, stats });
      return { path: eventsPath, stats };
    } catch (err) {
      this.emit('parse-error', err);
      return { path: null, stats };
    }
  }

  /**
   * Categorize a stream-json event
   * @private
   * @param {Object} event - Raw event object
   * @returns {string} Event type
   */
  _categorizeStreamEvent(event) {
    // Check for tool-related events first (before checking type field)
    // This handles events like { type: 'tool_use', name: 'read_file' }
    if (event.type === 'tool_use' || event.tool || event.tool_use || event.name?.includes('tool')) {
      return 'tool_call';
    }

    // Check for error events
    // Note: message can be a string or object, so check type before calling includes
    if (event.type === 'error' || event.error || (typeof event.message === 'string' && event.message.includes('error'))) {
      return 'error';
    }

    // Check for other common type fields
    if (event.type) {
      return event.type;
    }

    // Heuristic categorization based on content
    if (event.stop_reason || event.content?.some?.(c => c.type === 'text')) {
      return 'completion';
    }

    if (event.delta || event.content_block_delta) {
      return 'content_delta';
    }

    if (event.message_start || event.content_block_start) {
      return 'start';
    }

    if (event.message_stop || event.content_block_stop) {
      return 'stop';
    }

    return 'unknown';
  }

  /**
   * Get current process PID
   * @returns {number|null}
   */
  getPid() {
    return this.currentProcess?.pid || null;
  }

  /**
   * Check if a process is running
   * @returns {boolean}
   */
  isRunning() {
    return this.currentProcess !== null && !this.currentProcess.killed;
  }

  /**
   * Kill current process
   * @param {string} [signal='SIGTERM']
   */
  kill(signal = 'SIGTERM') {
    if (this.workerStop) { this.workerStop(); return; }
    if (this.currentProcess && !this.currentProcess.killed) {
      if (this.providerAdapter?.getName() === 'omp' && process.platform !== 'win32') {
        const child = this.currentProcess;
        try { process.kill(-child.pid, signal); } catch { /* already exited */ }
        const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } } }, 500);
        timer.unref();
      } else this.currentProcess.kill(signal);
    }
  }

  /**
   * Get elapsed time since start
   * @returns {number|null}
   */
  getElapsed() {
    return this.startTime ? Date.now() - this.startTime : null;
  }

  /**
   * Extract token/cost usage from provider stream events.
   *
   * Providers differ here: Claude stream-json commonly reports usage on message
   * or result events, while other providers may use camelCase or aggregate cost
   * fields. This method intentionally reads only numeric fields and returns a
   * zero-usage result when the event has no observable accounting data.
   *
   * @private
   * @param {Object} event - Raw event object
   * @returns {Object} Usage counters
   */
  _extractUsageStats(event) {
    // Usage can live at event.usage (result events) OR event.message.usage
    // (assistant events). Reading only the former lost all usage on timed-out
    // sessions, whose terminal result event never arrives (#1766).
    const usage =
      (event?.usage && typeof event.usage === 'object' && event.usage) ||
      (event?.message?.usage && typeof event.message.usage === 'object' && event.message.usage) ||
      {};
    const numberFrom = (...values) => {
      for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
      }
      return undefined;
    };
    let hasTokenField = false;
    const tokenFrom = (...values) => {
      const value = numberFrom(...values);
      if (value !== undefined) hasTokenField = true;
      return value;
    };

    const inputTokens = tokenFrom(
      usage.input_tokens,
      usage.inputTokens,
      event.input_tokens,
      event.inputTokens
    ) ?? 0;
    const outputTokens = tokenFrom(
      usage.output_tokens,
      usage.outputTokens,
      event.output_tokens,
      event.outputTokens
    ) ?? 0;
    const cacheCreationInputTokens = tokenFrom(
      usage.cache_creation_input_tokens,
      usage.cacheCreationInputTokens,
      event.cache_creation_input_tokens,
      event.cacheCreationInputTokens
    ) ?? 0;
    const cacheReadInputTokens = tokenFrom(
      usage.cache_read_input_tokens,
      usage.cacheReadInputTokens,
      event.cache_read_input_tokens,
      event.cacheReadInputTokens
    ) ?? 0;
    const explicitTotal = tokenFrom(
      usage.total_tokens,
      usage.totalTokens,
      event.total_tokens,
      event.totalTokens
    );
    const totalTokens = explicitTotal ??
      inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens;
    const costCandidates = [
      event.cost_usd,
      event.total_cost_usd,
      event.costUsd,
      event.totalCostUsd,
      usage.cost_usd,
      usage.costUsd,
    ];
    const hasCostField = costCandidates.some(
      (v) => typeof v === 'number' && Number.isFinite(v)
    );
    const costUsd = numberFrom(...costCandidates) ?? 0;

    return {
      inputTokens,
      outputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      totalTokens,
      costUsd,
      hasCostField,
      hasTokenField,
      hasUsage: hasTokenField || hasCostField,
    };
  }
}

/**
 * Check if Claude CLI is available
 * @returns {Promise<boolean>}
 */
export async function isClaudeAvailable() {
  return new Promise((resolve) => {
    const child = spawn('claude', ['--version'], {
      stdio: 'pipe',
    });

    child.on('close', (code) => {
      resolve(code === 0);
    });

    child.on('error', () => {
      resolve(false);
    });
  });
}

/**
 * Get Claude CLI version
 * @returns {Promise<string|null>}
 */
export async function getClaudeVersion() {
  return new Promise((resolve) => {
    let output = '';

    const child = spawn('claude', ['--version'], {
      stdio: 'pipe',
    });

    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(output.trim());
      } else {
        resolve(null);
      }
    });

    child.on('error', () => {
      resolve(null);
    });
  });
}

/**
 * Bounded settlement observer for a STANDALONE non-attached systemd-unit
 * launch (#2915 review 6, finding 5): `launchIsolatedWorker`'s non-attached
 * systemd-unit path returns `{ mode: 'systemd-unit', unit, pid }` with no
 * `child` handle in this process at all, so the direct-child backstop below
 * (`result.child.once('exit', ...)`) can never attach here — leaving an
 * ordinary (non-canary, `Infinity`-deadline) reservation with no settlement
 * observer whatsoever if the caller never settles it itself.
 *
 * Poll the SAME native unit-status query every other systemd-unit
 * stop/finish path already uses (`getWorkerIsolationStatus`), bounded by
 * `boundMs`, and settle once the unit itself reports inactive. `now >=
 * deadline` (#2915 round 8, D5) is the one deadline comparison this
 * function makes, consistently with the rest of this module.
 *
 * #2915 round 8 (D4, critique "an operator command does not replace a live
 * observer"): at the bound, this does NOT simply abandon observation with a
 * bare `settleDirectWorker({ kind: 'uncertain' })` (the former behavior,
 * which could release a still-live unit's reservation with no stop evidence
 * at all) — it initiates the SAME bounded isolation-specific stop every
 * other stop path already uses (`stopUnit`), re-checks the unit's own
 * retained state exactly once more, and settles with `confirmedStop` set
 * EXPLICITLY (never omitted) from that evidence: `true` only when the unit
 * is now genuinely inactive with a terminal exec status, `false` otherwise
 * — retaining unresolved ownership (a breaker-side stop-evidence marker, for
 * a reservation this observer's admission happens to hold as a canary)
 * rather than fabricating a confirmed stop it never observed.
 * `settleDirectWorker` is idempotent, so an explicit caller settlement with
 * real evidence still wins if it happens first; this is purely a backstop
 * against "forgot to settle", exactly like the direct-child listener it
 * complements.
 */
export function observeStandaloneUnitSettlement(unit, admission, {
  pollIntervalMs = 2000, boundMs = 300_000, getStatus = getWorkerIsolationStatus, stopUnit = stopWorkerUnit,
  nowMs = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), unrefTimer = timer => timer?.unref?.(),
} = {}) {
  const deadline = nowMs() + boundMs;
  const confirmedFromStatus = status => !!status && status.active === false && [1, 2, 3].includes(status.execMainCode);
  const poll = () => {
    let status = null;
    try { status = getStatus(unit); } catch { status = null; }
    if (status && status.active === false) {
      settleDirectWorker(admission, { kind: 'uncertain', confirmedStop: confirmedFromStatus(status) });
      return;
    }
    if (nowMs() >= deadline) {
      try { stopUnit(unit); } catch { /* best-effort: still re-check status below */ }
      let after = null;
      try { after = getStatus(unit); } catch { after = null; }
      settleDirectWorker(admission, { kind: 'uncertain', confirmedStop: confirmedFromStatus(after) });
      return;
    }
    unrefTimer(setTimer(poll, pollIntervalMs));
  };
  poll();
}

/**
 * Tier 0 direct-dispatch gate-then-launch helper (FR-OG-107/108, #2954, #2888).
 *
 * `SessionLauncher` above is the Claude-headless-loop launcher and is
 * untouched by this addition. A conductor following the subagent-scoping
 * Tier 0 procedure that wants to launch a *non-Claude* resolved worker
 * command (step 6: "Launch within caps") through this module's existing
 * primitives composes the already-qualified host-resource gate
 * (`checkWorkerDispatch`, #2954) with the isolated-launch builder
 * (`launchIsolatedWorker`, #2954) in the fixed order the rule documents:
 * gate first, launch only on a passing gate, never the reverse. This is a
 * pure composition — it adds no new subsystem, store, or mandatory command;
 * callers that already gate and launch themselves may keep doing so.
 *
 * A blocked gate never spawns. A gate that is off (`parallelism.worker_dispatch`
 * disabled) is legacy behavior and launches unconditionally, matching
 * `checkWorkerDispatch`'s own `{ enabled: false, ok: true }` contract.
 *
 * Accepts the complete resolved #2887 invocation (`src/serve/worker-invocation.ts`
 * `prepareWorkerInvocation()` / `aiwg models resolve --format json`) via the
 * `invocation` option and preserves its contract end to end — argv, cwd, stdin
 * source (the brief), the `envNames` allowlist and the separate stdout/stderr
 * destinations — through both `launchIsolatedWorker`'s confined (systemd-unit)
 * path and its degraded path. Flat options (`command`/`args`/`cwd`/`stdinPath`/
 * `envNames`/`stdoutPath`/`stderrPath`) remain accepted directly and win over
 * `invocation` when both are given, for callers that assemble their own plan.
 * `allowDegraded` only ever permits an *unconfined* launch when the caller
 * explicitly opts in, and even then the worker's environment is still built
 * from the `envNames` allowlist alone (never `process.env`) — the functional
 * equivalent of `env -i NAME=value ...`; there is no code path in this helper
 * that inherits the conductor's full environment.
 *
 * @param {object} options
 * @param {string} [options.name] - Human-readable worker label for the unit name.
 * @param {number} options.memoryMaxGb - Resource ceiling for the isolated worker.
 * @param {import('../../src/mission-protocol/types.js').WorkerResolvedInvocation} [options.invocation] -
 *   The resolved #2887 invocation to launch; supplies defaults for the flat
 *   options below when they are not given directly.
 * @param {string} [options.command] - Absolute path to the resolved worker binary
 *   (defaults to `invocation.argv[0]`).
 * @param {string[]} [options.args] - Resolved worker argv, never shell-assembled
 *   (defaults to `invocation.argv.slice(1)`).
 * @param {string} [options.cwd] - Absolute worktree path (defaults to `invocation.cwd`).
 * @param {string} [options.logFile] - Absolute combined stdout/stderr log path,
 *   used only when `stdoutPath`/`stderrPath` are not given.
 * @param {string} [options.stdinPath] - Absolute path the worker reads its brief
 *   from (defaults to `invocation.briefPath` for `brief-text`, none for `closed`,
 *   matching the frozen 'closed' meaning of empty stdin from #2887's shell renderer).
 *   A `brief-json` invocation needs a conductor-framed params file passed
 *   explicitly; the raw brief is never fed to such a worker.
 * @param {string} [options.stdoutPath] - Absolute stdout destination (defaults to
 *   `invocation.stdoutPath`).
 * @param {string} [options.stderrPath] - Absolute stderr destination, distinct from
 *   `stdoutPath` (defaults to `invocation.stderrPath`).
 * @param {string[]} [options.envNames] - Environment-variable allowlist; only these
 *   names are ever forwarded to the worker, confined or degraded (defaults to
 *   `invocation.envNames`, then `['PATH', 'HOME']`).
 * @param {Record<string, string>} [options.env] - Source of allowlisted values
 *   (defaults to the conductor's own `process.env`; never forwarded wholesale).
 * @param {import('../../src/config/aiwg-config.js').AiwgConfig} [options.config] - Current effective config.
 * @param {string[]} [options.paths] - Filesystems to sample free disk on
 *   (defaults to the worker `cwd`/worktree, never the conductor's cwd).
 * @param {boolean} [options.allowDegraded] - Explicit opt-in to an unconfined launch
 *   when no systemd user manager is reachable (recorded as degraded, never silent).
 * @param {boolean} [options.attached] - Launch with live stdio pipes instead of
 *   file redirection (#2892 B2), for an in-process client (e.g. an MCP stdio
 *   client) that needs to read/write the worker's stdin/stdout directly.
 * @returns {{ launched: boolean, blocked?: boolean, failures?: unknown[], mode?: string }}
 *   Same result shape as `launchIsolatedWorker`; a blocked result carries the
 *   dispatch gate's typed failures and never reaches a spawn call. A
 *   recovery-scope refusal (`#2915`) returns `blocked: true` with
 *   `recoveryBlocked` (covering scope keys) and a `diagnostic`, and likewise
 *   never spawns.
 */
export function planDirectWorkerLaunch({
  name = 'worker',
  memoryMaxGb,
  invocation,
  command = invocation?.argv?.[0],
  args = invocation?.argv?.slice(1) ?? [],
  cwd = invocation?.cwd,
  logFile,
  stdinPath = invocation?.stdin === 'brief-text' ? invocation.briefPath : undefined,
  stdoutPath = invocation?.stdoutPath,
  stderrPath = invocation?.stderrPath,
  envNames = invocation?.envNames,
  env,
  config,
  allowDegraded = false,
  // Test-only passthroughs mirroring checkWorkerDispatch's own injectable
  // signals/isolation detector; production callers omit these and sample
  // the real host / systemd user manager.
  live,
  readers,
  thresholdOverlay,
  paths,
  isolation,
  spawn,
  spawnAsync,
  proposeUnit,
  kind,
  attached = false,
  ownedGroup = false, onSpawnAttempt,
  // #2892: forwarded only when explicitly given, so every existing caller
  // (which omits it) keeps #2895's own `attached` default (`stdin: 'closed'`
  // -> stdio[0] 'ignore') unchanged. An MCP stdio worker passes `'open'` to
  // get a live, writable stdin pipe for JSON-RPC requests.
  stdin,
  // #2915A: scoped-breaker consultation for this dispatch. Defaults to the
  // process-shared direct-recovery breaker; `null` disables the gate for
  // callers that own recovery themselves. Flat-option callers without a
  // resolved invocation have no trusted identities, so the gate is skipped
  // for them (never defaulted to a shared scope).
  scopedBreaker,
  recoveryScopeKeys,
  // #2915 final (one admission, step 3): a caller that already called
  // `admitDirectWorker` itself (the MCP `run()` bridge, so its own
  // try/finally owns settlement end-to-end) passes the resulting admission
  // here. The planner then BORROWS it — it neither re-admits nor settles —
  // instead of re-gating and potentially rejecting its own already-admitted
  // canary (#2915 final review, finding 4: "MCP shell dispatch consults the
  // breaker again... blocked, zero spawns, reservation still active").
  admission: borrowedAdmission,
  invocationId,
  // #2915 review 4 (finding 7): forwarded to `admitDirectWorker` for the
  // STANDALONE admission path below, so a driver's `canVerifyAttempt:
  // false` (Warp, Copilot — adapters that can never report a verified
  // success) actually reaches this planner instead of being silently lost
  // to a hardcoded `drivers: {}`. Omitted (the common case: most standalone
  // callers have no resolved driver map at all) never defaults to eligible
  // OR ineligible — `admitDirectWorker` simply has nothing to check, same
  // as before.
  drivers,
  // #2915 review 6 (finding 3, "MCP and standalone planner never debit"):
  // forwarded to `admitDirectWorker` for the STANDALONE admission path
  // below so a resolvable task chain gets ledger allowance identity/
  // enforcement too — a borrowed admission already carries these from its
  // own caller's `admitDirectWorker` call and never re-resolves them here.
  taskChainDigest,
  maxAttempts,
  captureRoot,
  // #2915 review 6 (finding 5): test-only injection for the standalone
  // non-attached systemd-unit settlement observer below (production omits
  // these and polls the real `getWorkerIsolationStatus` on a real bounded
  // timer).
  isolationStatus,
  unitSettlementPollMs,
  unitSettlementBoundMs,
} = {}) {
  if (invocation?.stdin === 'brief-json' && stdinPath === undefined) {
    throw new Error('brief-json stdin requires an explicit conductor-framed params file (stdinPath)');
  }
  // #2915 final (step 6, compatibility): the dispatch switch is consulted
  // FIRST, and legacy behaviour (`worker_dispatch` off, or the resource gate
  // itself refusing) returns SYNCHRONOUSLY — this function is deliberately
  // NOT declared `async` so neither path ever manufactures a Promise where
  // none existed before #2915 (#2915 final review, finding 1: "the planner
  // now returns a Promise even when off; existing production callers await
  // it" — literal API equivalence requires the disabled/resource-refused
  // path to match pre-#2915 byte-for-byte, Promise-wrapping included). Free
  // disk is sampled on the worktree filesystem the worker will actually
  // write to — never the conductor's process cwd. Without live signals or
  // caller-supplied paths, an unknown worktree fails closed in the gate.
  const gate = checkWorkerDispatch({
    config, live, readers, thresholdOverlay,
    paths: paths ?? (typeof cwd === 'string' && cwd ? [cwd] : undefined),
  });
  if (!gate.ok) return { launched: false, blocked: true, failures: gate.failures ?? [], gate };
  // `onDispatchCommit` (#2915 round 8, D2) is OPTIONAL and omitted entirely
  // for the not-gated/disabled-CLI paths below, which must stay
  // synchronous and byte-for-byte legacy — passing `undefined` through to
  // `launchIsolatedWorker` is the dual-mode contract that keeps it so.
  const launch = (onDispatchCommit) => launchIsolatedWorker({ name, memoryMaxGb, command, args, cwd, logFile, stdinPath, stdoutPath, stderrPath,
    gate, config, allowDegraded, attached, ownedGroup, onSpawnAttempt,
    ...(envNames !== undefined ? { envNames } : {}), ...(env !== undefined ? { env } : {}),
    ...(isolation !== undefined ? { isolation } : {}), ...(spawn !== undefined ? { spawn } : {}),
    ...(spawnAsync !== undefined ? { spawnAsync } : {}), ...(proposeUnit !== undefined ? { proposeUnit } : {}),
    ...(kind !== undefined ? { kind } : {}), ...(stdin !== undefined ? { stdin } : {}),
    ...(onDispatchCommit ? { onDispatchCommit } : {}) });
  if (!gate.enabled) return launch(); // not-gated: synchronous, byte-for-byte legacy behaviour
  // #2915 review 4 (finding 7): per-CLI disablement is ALSO checked
  // synchronously, before any admission (borrowed or standalone) — a
  // disabled CLI must stay exactly as inert as the global switch being
  // off: synchronous, and the returned result carries no `admission`
  // field at all (the former code only special-cased the global switch,
  // so a per-CLI-disabled standalone call still went through the async
  // admission branch and attached `admission` to its result).
  if (invocation?.selected?.cli && config?.parallelism?.clis?.[invocation.selected.cli]?.enabled === false) {
    return launch();
  }
  if (borrowedAdmission !== undefined) {
    // #2915 review 5 (finding 4), hardened by #2915 review 6 (finding 1,
    // "unauthenticated/reused authority"): the borrowed admission must be a
    // value `admitDirectWorker` itself returned -- never a caller-
    // fabricated stand-in -- and may authorize at most ONE launch. A
    // genuine admission is either exactly `{ gated: false }` (not gated), a
    // refusal (`{ gated: true, refused: {...} }`), or a successful one
    // carrying both `token` and a REAL `ScopedFailureBreaker` instance (the
    // exact objects `admit()` minted) -- never anything else. `instanceof
    // ScopedFailureBreaker` (rather than duck-typing `breaker.settle` as a
    // function) is what actually closes the fabrication gap: a plain
    // `{ settle(){} }` stand-in satisfied the old duck-typed shape check and
    // then dispatched with zero real breaker protection.
    if (borrowedAdmission === null || typeof borrowedAdmission !== 'object' || typeof borrowedAdmission.gated !== 'boolean'
      || (borrowedAdmission.gated && !borrowedAdmission.refused && (!borrowedAdmission.token || !(borrowedAdmission.breaker instanceof ScopedFailureBreaker)))) {
      throw new Error('Borrowed admission is not a value admitDirectWorker returned; refusing to dispatch on unauthenticated authority');
    }
    // A `gated: false` CLAIM is never trusted on its own: by the time this
    // branch runs, the planner's OWN dispatch/eligibility checks above
    // (`gate.enabled`, per-CLI disablement) have already determined gating
    // IS active for this dispatch -- a borrowed admission claiming
    // `gated: false` here contradicts that and is refused rather than
    // honored as a free bypass. Only the launcher's own checks decide
    // not-gated-ness; a caller cannot assert it after the fact.
    if (!borrowedAdmission.gated) {
      throw new Error('Borrowed admission claims not-gated while this dispatch is gated; refusing to dispatch on unauthenticated authority');
    }
    // Borrowed: never re-admit, never settle — the outer caller's own
    // try/finally owns settlement of this exact admission end-to-end.
    if (borrowedAdmission.refused) {
      return { launched: false, blocked: true, recoveryBlocked: borrowedAdmission.refused.blockedBy,
        diagnostic: `recovery scope open: ${borrowedAdmission.refused.blockedBy.join(', ')}` };
    }
    // #2915 round 8 (D2/D3, replaces the former synchronous `claimLaunch`
    // call and its paired mutable-wrapper-field pre-checks): identity,
    // single-use consumption and the deadline are now ALL authenticated by
    // `beginDispatch` itself, inside the dispatch-commit hook, against the
    // breaker's own FROZEN token fields — never against this borrowed
    // wrapper object's own `invocationId`/`selectionDigest` copies (#2915
    // round 8 critique: "stored identity is only useful if compared against
    // the actual launch"; a caller that deletes or rewrites those copies on
    // the wrapper can no longer bypass anything, because they are never
    // what gets compared). Comparison values are derived HERE from this
    // exact call's own trusted, resolved `invocation`/`invocationId` —
    // falling back to the borrowed wrapper's own copies only when this call
    // was given no fresher identity to derive them from.
    const resolvedInvocationId = invocationId ?? borrowedAdmission.invocationId ?? null;
    const resolvedSelectionDigest = selectionDigestFor(invocation) ?? borrowedAdmission.selectionDigest ?? null;
    const onDispatchCommit = async () => {
      const began = borrowedAdmission.breaker.beginDispatch(borrowedAdmission.token,
        { invocationId: resolvedInvocationId, selectionDigest: resolvedSelectionDigest });
      if (!began.ok) {
        throw new Error(`Borrowed admission is not a live, unclaimed reservation on its breaker; refusing to dispatch on unauthenticated authority (${began.reason})`);
      }
      try {
        if (borrowedAdmission.ledger) await debitDirectWorkerAllowance(borrowedAdmission.ledger);
      } catch (error) {
        try { borrowedAdmission.breaker.abortDispatch(borrowedAdmission.token); } catch { /* best-effort */ }
        throw error;
      }
      const committed = borrowedAdmission.breaker.commitDispatch(borrowedAdmission.token);
      if (!committed.ok) {
        try { borrowedAdmission.breaker.abortDispatch(borrowedAdmission.token); } catch { /* best-effort */ }
        throw new Error(`Worker dispatch refused: ${committed.reason}`);
      }
    };
    return launch(onDispatchCommit);
  }
  // Standalone: the planner performs its own admission. It settles LOCALLY
  // only on a pre-spawn refusal/exception (no observer exists to report a
  // post-spawn outcome back here); a successful launch returns its
  // `admission` so a caller that wants to track completion can call
  // `settleDirectWorker` itself once the attempt concludes (#2915 final
  // review: "standalone planner launches explicitly transfer settlement
  // responsibility to their bounded observer; pre-spawn exits settle
  // locally").
  return (async () => {
    const mintedInvocationId = invocationId ?? randomUUID();
    let admission;
    try {
      // `recoveryScopeKeys` (legacy flat-option override) is intentionally
      // not consulted: `admitDirectWorker` derives covering keys from the
      // trusted resolved `invocation` only, or skips the gate entirely for
      // flat-option callers with no resolved invocation (never defaulted to
      // a shared scope).
      admission = await admitDirectWorker({ gateEnabled: gate.enabled, config, invocation,
        invocationId: mintedInvocationId, scopedBreaker, drivers: drivers ?? {},
        taskChainDigest, maxAttempts, captureRoot });
    } catch (error) {
      return { launched: false, blocked: true,
        diagnostic: `recovery admission failed closed: ${error?.message ?? String(error)}` };
    }
    if (admission.refused) {
      return { launched: false, blocked: true, recoveryBlocked: admission.refused.blockedBy,
        diagnostic: `recovery scope open: ${admission.refused.blockedBy.join(', ')}` };
    }
    // #2915 round 8 (D2/D3, replaces the former "debit immediately before
    // this call" comment): the hook below is passed to
    // `launchIsolatedWorker`, which invokes it AFTER its own preparation
    // checks and immediately before the real process-start call — never
    // here, before even the resource/isolation checks `launch()` itself
    // still has to run. `beginDispatch`/`commitDispatch` consume this
    // reservation's own launch authority exactly once, at that same leaf
    // boundary (#2915 round 8, D3).
    const onDispatchCommit = async () => {
      const began = admission.breaker.beginDispatch(admission.token,
        { invocationId: admission.invocationId, selectionDigest: admission.selectionDigest });
      if (!began.ok) throw new Error(`Worker dispatch refused: ${began.reason}`);
      try {
        if (admission.ledger) await debitDirectWorkerAllowance(admission.ledger);
      } catch (error) {
        try { admission.breaker.abortDispatch(admission.token); } catch { /* best-effort */ }
        throw error;
      }
      const committed = admission.breaker.commitDispatch(admission.token);
      if (!committed.ok) {
        try { admission.breaker.abortDispatch(admission.token); } catch { /* best-effort */ }
        throw new Error(`Worker dispatch refused: ${committed.reason}`);
      }
    };
    let result;
    try {
      result = await launch(onDispatchCommit);
    } catch (error) {
      settleDirectWorker(admission, { kind: 'uncertain' });
      throw error;
    }
    if (!result?.launched) { settleDirectWorker(admission, { kind: 'uncertain' }); return result; }
    // #2915 review 5 (finding 2c, "leaked capacity"): a standalone
    // successful launch previously transferred settlement responsibility
    // entirely to the caller via this function's own documented contract
    // ("a caller that wants to track completion can call
    // settleDirectWorker itself") -- but a NON-canary admission's token has
    // an `Infinity` deadline (only a canary gets the breaker's own bounded
    // `canaryTimeoutMs`; see `ScopedFailureBreaker.admit`), so a caller
    // that never settles leaks this reservation forever; the breaker's own
    // sweep can never reclaim it. For the direct-child isolation modes
    // (not `systemd-unit`, which has no simple exit event here), attach a
    // bounded safety-net settlement tied to the actual child's own exit,
    // so an unsettled admission is cleaned up once the process it gated
    // has genuinely ended, regardless of whether the caller ever settles.
    // `settleDirectWorker` is idempotent, so an explicit caller settlement
    // with real evidence still wins if it happens first; this is purely a
    // backstop against "forgot to settle", never a replacement for real
    // evidence-based settlement.
    if (result.child && typeof result.child.once === 'function') {
      result.child.once('exit', () => settleDirectWorker(admission, { kind: 'uncertain' }));
      result.child.once('error', () => settleDirectWorker(admission, { kind: 'uncertain' }));
    } else if (result.mode === 'systemd-unit' && result.unit) {
      // #2915 review 6 (finding 5): the non-attached systemd-unit mode has
      // no direct child to observe here at all -- give it the same kind of
      // bounded backstop via the native unit-status query instead of
      // leaving this reservation with no settlement observer whatsoever.
      observeStandaloneUnitSettlement(result.unit, admission,
        { getStatus: isolationStatus, pollIntervalMs: unitSettlementPollMs, boundMs: unitSettlementBoundMs });
    }
    return { ...result, admission };
  })();
}

export default SessionLauncher;
