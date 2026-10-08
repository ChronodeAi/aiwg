/**
 * T-OG-16 Conductor direct lifecycle (S1 partial coverage; #2888).
 *
 * Three independent tasks, a self-counted cap, real fixture-CLI finals,
 * fallback-only-after-stop semantics and the explicit absence of any
 * Mission/MC state file. These exercise the Tier 0 procedure documented in
 * `agentic/code/addons/aiwg-utils/rules/subagent-scoping.md` against the
 * already-shipped resolver (#2883), direct invocation renderer (#2887) and
 * host-resource gate / worker isolation (#2954) — no new production
 * subsystem. Managed-runtime assertions stay with their owning S2+
 * checkpoints; this pack proves the S1 mapping with synthetic fixtures only.
 */
import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveWorkerPlan, type WorkerPlanRequest } from '../../../src/models/resolver.js';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { checkWorkerDispatch } from '../../../tools/scripts/resource-preflight.mjs';
import { planDirectWorkerLaunch } from '../../../tools/ralph-external/session-launcher.mjs';

const fixtureRoot = path.resolve('test/fixtures');
const digestOf = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/**
 * Trusted-check integration gate (Rule 9 step 8/9): runs a REAL check
 * process (`verify-worker-final.mjs`) outside the worker's own process —
 * the conductor-side helper the rule requires — and binds integration to
 * its outcome plus the exact digest it verified. A later change to the
 * artifact, including a tamper after verification, must invalidate the
 * acceptance rather than being silently re-accepted, and a failing check
 * (corrupt/incomplete output) must block integration outright.
 */
function runTrustedCheck(finalPath: string, expectDigest: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    // Exercise current source without requiring a pre-existing compiled checkout.
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(fixtureRoot, 'verify-worker-final.mjs'), '--final', finalPath, '--expect-digest', expectDigest], {
      stdio: 'pipe', env: { AIWG_RESOLVE_IMPL_FROM: 'src' },
    });
    children.push(child);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

async function integrateVerifiedFinal(finalPath: string, verifiedDigest: string): Promise<{ accepted: boolean; digest: string; checkStdout: string; checkStderr: string }> {
  const digest = digestOf(await readFile(finalPath));
  const check = await runTrustedCheck(finalPath, verifiedDigest);
  return { accepted: check.code === 0 && digest === verifiedDigest, digest, checkStdout: check.stdout, checkStderr: check.stderr };
}

/**
 * Rule 9 step 7/10 classification: a timeout is its own outcome, distinct
 * from success/failure — "uncertain until reconciled", never silent
 * permission to launch a second writer against the same output.
 */
function classifyLifecycleOutcome({ timedOut, code, final }: { timedOut: boolean; code: number | null; final: { type: string } | null }):
  'success' | 'failure' | 'uncertain' {
  if (timedOut) return 'uncertain';
  if (code === 0 && final?.type === 'result') return 'success';
  return 'failure';
}

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function worktree() {
  const root = await mkdtemp(path.join(tmpdir(), 'aiwg-direct-lifecycle-'));
  roots.push(root);
  return root;
}

function spawnFixtureCli(configPath: string, root: string, timeoutMs = 5000) {
  const child = spawn(process.execPath, [path.join(fixtureRoot, 'ralph-worker-cli.mjs')], {
    cwd: root, env: { AIWG_FAKE_WORKER_CONFIG: configPath }, stdio: 'pipe',
  });
  children.push(child);
  let stdout = ''; let stderr = ''; let timedOut = false;
  const watchdog = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('close', (code, signal) => { clearTimeout(watchdog); resolve({ code, signal }); });
  });
  child.stdin.end('synthetic brief');
  return { child, closed, output: () => ({ stdout, stderr, timedOut }) };
}

describe('T-OG-16 self-counted caps obey project/group/profile limits (no host-enforcement claim)', () => {
  // `maxParallel` is a capacity CEILING, never an active-worker count. This
  // regression guard proves the inverted instruction (pass the raw active
  // count straight through) actually inverts the check: a resolver with
  // group cap 2 would deny when zero workers are active (nobody is using
  // capacity — should be eligible) and admit at/over the cap (no room left
  // — should be denied). The fixed Rule 9 computes `remaining = ceiling -
  // active` instead; the second test below exercises that computation.
  it('regression guard: passing the raw active-worker count as maxParallel inverts admission (documents the bug this rule fixed)', () => {
    const f = workerResolutionFixture();
    const zeroActiveWorkersPassedDirectly = resolveWorkerPlan(f.snapshot, { ...f.request, role: 'coding', group: 'workers', maxParallel: 0 });
    expect(zeroActiveWorkersPassedDirectly.selected).toBeNull(); // wrongly denied: capacity is fully free
    const atCapacityActiveWorkersPassedDirectly = resolveWorkerPlan(f.snapshot, { ...f.request, role: 'coding', group: 'workers', maxParallel: 2 });
    expect(atCapacityActiveWorkersPassedDirectly.status).toBe('eligible'); // wrongly admitted: already at the cap
  });

  it('cap 2, one native worker already active, three ready tasks: exactly one more launch is admitted via remaining = ceiling - active', () => {
    const f = workerResolutionFixture();
    const groupCap = f.snapshot.config.parallelism!.groups!.workers.maxParallel!; // 2, read from fixture config, not a literal
    let active = 1; // one native worker already active in this conductor
    const admissions: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      // The documented Rule 9 computation: remaining slots across the
      // applicable dimension, floored at zero, passed as the ceiling on
      // top of the resolver's own static group/member/cli/model caps.
      const remaining = Math.max(0, groupCap - active);
      const request: WorkerPlanRequest = { ...f.request, role: 'coding', group: 'workers', maxParallel: remaining };
      const plan = resolveWorkerPlan(f.snapshot, request);
      const admitted = plan.status === 'eligible' && plan.selected !== null;
      admissions.push(admitted);
      if (admitted) active += 1; // the just-admitted launch becomes another active worker
    }
    expect(admissions).toEqual([true, false, false]);
    expect(admissions.filter(Boolean)).toHaveLength(1);
  });
});

describe('T-OG-16 the #2954 dispatch gate and launchIsolatedWorker are the documented gate-then-launch step', () => {
  it('refuses to launch a resolved worker command when the live host-resource gate blocks', () => {
    const outcome = planDirectWorkerLaunch({
      name: 'lifecycle-demo', memoryMaxGb: 2, command: '/usr/bin/fixture-worker',
      config: { parallelism: { worker_dispatch: true } },
      live: { supported: true, availMemGb: 1, loadRatio: 3, memPsiAvg10: 90, memPsiAvg60: 90, workers: 50, freeDiskGb: 0.5 },
      spawn: (() => { throw new Error('must not spawn: gate must block first'); }) as never,
    });
    expect(outcome).toMatchObject({ launched: false, blocked: true });
  });

  it('checkWorkerDispatch alone (no config.parallelism.worker_dispatch) is legacy no-signal pass-through', () => {
    expect(checkWorkerDispatch({ config: {} })).toMatchObject({ enabled: false, ok: true });
  });
});

describe('T-OG-16 real fixture-CLI finals: wait, read, verify outside the worker sandbox, exact-digest integration', () => {
  it('a successful worker final is read, re-digested outside the sandbox, and the integrated digest matches exactly', async () => {
    const root = await worktree();
    const record = path.join(root, 'record.json');
    const final = path.join(root, 'final.json');
    const config = path.join(root, 'config.json');
    await writeFile(config, JSON.stringify({ scenario: 'success', recordPath: record, outputPaths: { final } }));
    const running = spawnFixtureCli(config, root);
    expect(await running.closed).toEqual({ code: 0, signal: null });
    // "Verify outside the worker sandbox": this assertion runs in the
    // conductor-controlled test process, never inside the spawned worker.
    const finalBytes = await readFile(final);
    const claims = JSON.parse(finalBytes.toString());
    expect(claims).toMatchObject({ type: 'result', result: { version: 1, status: 'completed' } });
    const verifiedDigest = digestOf(finalBytes);
    // Integration binds the exact digest just verified, and the check that
    // decides it is a REAL process — `verify-worker-final.mjs` — spawned by
    // the conductor-side `runTrustedCheck` helper and run outside the
    // worker's own process, never a same-process function call pretending
    // to be a check. A passing check against the unmodified artifact plus
    // an exact digest integrates...
    const accepted = await integrateVerifiedFinal(final, verifiedDigest);
    expect(accepted).toMatchObject({ accepted: true, digest: verifiedDigest });
    expect(accepted.checkStdout.trim()).toBe(verifiedDigest);
    expect(accepted.checkStderr).toBe('');
    // ...but a later change to the artifact — even a single appended byte,
    // simulating a tamper after verification — must be rejected, not
    // silently re-accepted under the old digest. The spawned check process
    // itself reports the mismatch on stderr with a nonzero exit.
    await writeFile(final, `${finalBytes.toString()} `);
    const tampered = await integrateVerifiedFinal(final, verifiedDigest);
    expect(tampered.accepted).toBe(false);
    expect(tampered.digest).not.toBe(verifiedDigest);
    expect(tampered.checkStderr).toContain('digest mismatch');
  });

  it('a failing trusted check blocks integration even when the digest the caller supplies happens to match', async () => {
    const root = await worktree();
    const record = path.join(root, 'record.json');
    const final = path.join(root, 'final.json');
    const config = path.join(root, 'config.json');
    // "missing-final": the fixture worker exits 0 but the recorded event is
    // a progress message, never a completed result claim — exactly the
    // shape the trusted check (not merely the digest) must catch.
    await writeFile(config, JSON.stringify({ scenario: 'missing-final', recordPath: record, outputPaths: { final } }));
    const running = spawnFixtureCli(config, root);
    expect(await running.closed).toEqual({ code: 0, signal: null });
    const finalBytes = await readFile(final);
    const notAccepted = await integrateVerifiedFinal(final, digestOf(finalBytes));
    expect(notAccepted.accepted).toBe(false);
    expect(notAccepted.checkStderr).toContain('not a completed result claim');
  });

  it.each(['exit-zero-error', 'missing-final'])('exit zero with %s is classified as failure, not accepted as a completed claim', async scenario => {
    const root = await worktree();
    const record = path.join(root, 'record.json');
    const final = path.join(root, 'final.json');
    const config = path.join(root, 'config.json');
    await writeFile(config, JSON.stringify({ scenario, recordPath: record, outputPaths: { final } }));
    const running = spawnFixtureCli(config, root);
    expect(await running.closed).toEqual({ code: 0, signal: null });
    const finalBytes = await readFile(final);
    const event = JSON.parse(finalBytes.toString());
    // Exit zero alone never proves success: the recorded event type is not
    // a result, so the conductor must reject this claim regardless of the
    // process exit code.
    expect(event.type).not.toBe('result');
    expect(['error', 'message']).toContain(event.type);
  });

  it('a hung worker stays uncertain until an explicit kill is confirmed; the sent signal alone is not termination proof', async () => {
    const root = await worktree();
    const record = path.join(root, 'record.json');
    const config = path.join(root, 'config.json');
    await writeFile(config, JSON.stringify({ scenario: 'hang', recordPath: record }));
    const running = spawnFixtureCli(config, root, 60000);
    // Give the fixture a moment to reach the EOF-triggered hang branch, then
    // send the kill ourselves rather than trusting a short wall-clock wait.
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(running.child.exitCode).toBeNull();
    expect(running.child.signalCode).toBeNull();
    running.child.kill('SIGKILL');
    // A sent signal is not proof of termination (ADR-OG-10): Node only
    // flips exitCode/signalCode once the OS actually reports the exit —
    // which is asynchronous relative to kill() returning — so the process
    // must still read as unconfirmed in this same tick, deterministically,
    // not merely "possibly still unconfirmed or possibly already closed".
    expect(running.child.exitCode).toBeNull();
    expect(running.child.signalCode).toBeNull();
    // Only the awaited close event is termination proof, and it must name
    // the exact signal that ended the process.
    const closedResult = await running.closed;
    expect(closedResult).toEqual({ code: null, signal: 'SIGKILL' });
    expect(running.child.signalCode).toBe('SIGKILL');
  });

  it('a timeout classifies as uncertain (never success or failure), and the replacement decision follows the resolver\'s own attempt policy', async () => {
    const root = await worktree();
    const record = path.join(root, 'record.json');
    const config = path.join(root, 'config.json');
    await writeFile(config, JSON.stringify({ scenario: 'hang', recordPath: record }));
    // A short watchdog models a real hang timeout rather than a manual kill.
    const running = spawnFixtureCli(config, root, 300);
    const closedResult = await running.closed;
    expect(running.output().timedOut).toBe(true);
    // The timeout decision: uncertain, not success and not failure, even
    // though the process is now confirmed terminated (SIGKILL by the
    // watchdog) — termination proof and outcome classification are
    // separate questions (Rule 9 step 7/10).
    const outcome = classifyLifecycleOutcome({ timedOut: running.output().timedOut, code: closedResult.code, final: null });
    expect(outcome).toBe('uncertain');
    expect(outcome).not.toBe('success');
    expect(outcome).not.toBe('failure');

    // The replacement decision follows policy, not a bare retry: the
    // resolver's own attempt ceiling governs whether another attempt may
    // launch. One attempt was just spent on the uncertain outcome above.
    const f = workerResolutionFixture();
    const attemptsRemainingAfterThisUncertainAttempt = 2; // perRun/perTask default is 3 (resolver.ts); one was just spent
    const replacement = resolveWorkerPlan(f.snapshot, { ...f.request, role: 'coding', group: 'workers',
      ceilings: { maxAttempts: attemptsRemainingAfterThisUncertainAttempt } });
    expect(replacement.status).toBe('eligible');
    expect(replacement.ceilings.maxAttempts).toBe(attemptsRemainingAfterThisUncertainAttempt);

    // Once the attempt budget is actually exhausted, the resolver issues a
    // typed stop rather than permitting an unbounded retry loop.
    const exhausted = resolveWorkerPlan(f.snapshot, { ...f.request, role: 'coding', group: 'workers', ceilings: { maxAttempts: 0 } });
    expect(exhausted.selected).toBeNull();
    expect(exhausted.diagnostics.some(d => d.code === 'OG_BUDGET_UNMEASURABLE' && /no task attempts remain/i.test(d.message))).toBe(true);
  });
});

describe('T-OG-16 429/quota: stop, confirm the old worker stopped, then resolve an explicit permitted fallback', () => {
  it('never silently unpins: an excluded member requires an explicit rationale-carrying substitution to a declared fallback', () => {
    const f = workerResolutionFixture();
    const initial = resolveWorkerPlan(f.snapshot, { ...f.request, role: 'coding', group: 'workers' });
    expect(initial.selected?.member).toBe('primary');

    // Observe a synthetic 429 against the "primary" member/account: the
    // conductor confirms the old attempt stopped (not modeled here; this is
    // a pure resolver call) and then marks that member unavailable for the
    // cooldown window via the resolver's own trusted-restriction input.
    (f.snapshot as any).constraints = { unavailableMembers: ['workers/primary'] };
    const excluded = resolveWorkerPlan(f.snapshot, { ...f.request, role: 'coding', group: 'workers' });
    expect(excluded.eligible.some(t => t.member === 'primary')).toBe(false);
    expect(excluded.exclusions.some(e => e.member === 'primary' && e.diagnostics.some(d => d.code === 'OG_ADAPTER_UNQUALIFIED' && /unavailable/.test(d.message)))).toBe(true);

    // A bare request for the pinned member without an explicit, rationale'd
    // substitution is denied outright — this is the "never silently unpin"
    // guarantee; only a declared fallback member with a stated reason may
    // stand in.
    const silentPin = resolveWorkerPlan(f.snapshot, { ...f.request, role: 'coding', group: 'workers', member: 'primary', model: 'synthetic/a%b' });
    expect(silentPin.selected).toBeNull();

    // The conductor was pinned to "primary"; only an explicit, rationale'd
    // substitution to the declared fallback is permitted to depart from
    // that exact pin while primary is excluded.
    const explicitFallback = resolveWorkerPlan(f.snapshot, {
      ...f.request, role: 'coding', group: 'workers', member: 'primary', model: 'synthetic/a%b',
      substitution: { group: 'workers', member: 'alternate', model: 'synthetic-alternate', effort: 'medium', rationale: 'primary account returned 429; alternate is the declared fallback and cooldown-independent' },
    });
    expect(explicitFallback.selected?.member).toBe('alternate');
    expect(explicitFallback.choice?.substitution?.rationale.length).toBeGreaterThan(0);
  });

  it('confirms the prior attempt actually terminated — not merely signaled — before resolving the fallback launch', async () => {
    const root = await worktree();
    const record = path.join(root, 'record.json');
    const config = path.join(root, 'config.json');
    await writeFile(config, JSON.stringify({ scenario: 'hang', recordPath: record }));
    const running = spawnFixtureCli(config, root, 60000);
    await new Promise(resolve => setTimeout(resolve, 200));
    // Observe the synthetic 429 and send the kill, but do not yet trust it.
    running.child.kill('SIGKILL');
    expect(running.child.exitCode).toBeNull();
    expect(running.child.signalCode).toBeNull();
    // Only the confirmed close is grounds to resolve a fallback; resolving
    // it before this point would race a still-live attempt (two writers).
    const closedResult = await running.closed;
    expect(closedResult.signal).toBe('SIGKILL');
    const f = workerResolutionFixture();
    (f.snapshot as any).constraints = { unavailableMembers: ['workers/primary'] };
    const fallback = resolveWorkerPlan(f.snapshot, {
      ...f.request, role: 'coding', group: 'workers', member: 'primary', model: 'synthetic/a%b',
      substitution: { group: 'workers', member: 'alternate', model: 'synthetic-alternate', effort: 'medium',
        rationale: 'primary hung past its timeout and was confirmed killed (SIGKILL observed on close) before alternate was resolved' },
    });
    expect(fallback.selected?.member).toBe('alternate');
  });

  it('honours reset timing: the pinned member stays excluded until an explicit resetAt elapses, never on the resolver\'s own schedule', () => {
    const f = workerResolutionFixture();
    const now = f.request.now;
    const resetAt = new Date(new Date(now).getTime() + 60000).toISOString(); // 60s cooldown the caller is independently tracking
    (f.snapshot as any).constraints = { unavailableMembers: ['workers/primary'] };
    const duringCooldown = resolveWorkerPlan(f.snapshot, { ...f.request, now, role: 'coding', group: 'workers', member: 'primary', model: 'synthetic/a%b' });
    expect(duringCooldown.selected).toBeNull();
    // One tick before resetAt: still excluded — this is what "exercise
    // reset timing" means: the boundary is enforced by the caller's own
    // clock comparison against resetAt, not by clearing the restriction
    // early for convenience.
    const justBeforeReset = new Date(new Date(resetAt).getTime() - 1).toISOString();
    const stillCooling = resolveWorkerPlan(f.snapshot, { ...f.request, now: justBeforeReset, role: 'coding', group: 'workers', member: 'primary', model: 'synthetic/a%b' });
    expect((f.snapshot as any).constraints.unavailableMembers).toContain('workers/primary');
    expect(stillCooling.selected).toBeNull();
    // The resolver has no internal clock for the cooldown; it only ever
    // reflects the caller's own trusted-restriction input. "Reset" means
    // the caller clears that restriction once its own now >= resetAt check
    // says the quota/backoff window has actually elapsed.
    const nowAfterReset = resetAt;
    if (nowAfterReset >= resetAt) (f.snapshot as any).constraints = {};
    const afterReset = resolveWorkerPlan(f.snapshot, { ...f.request, now: nowAfterReset, role: 'coding', group: 'workers', member: 'primary', model: 'synthetic/a%b' });
    expect(afterReset.selected?.member).toBe('primary');
  });

  /**
   * Both 'primary' and 'alternate' in the fixture's 'workers' group use
   * `cli: 'codex'` (test/fixtures/worker-resolution.ts) — i.e. the same
   * installed CLI/account. Once that installation's `quotaScope` is
   * declared, every member routed through it shares the same upstream
   * quota domain, so a 429 against one of them is evidence the WHOLE
   * domain is rate-limited, not just the member that happened to be
   * running when it hit.
   */
  function membersSharingQuotaDomain(snapshot: ReturnType<typeof workerResolutionFixture>['snapshot'], groupId: string, memberId: string): string[] {
    const group = (snapshot.config.parallelism!.groups as any)[groupId];
    const member = group.members.find((m: any) => m.id === memberId);
    const quotaScope = (snapshot.config.parallelism!.clis as any)?.[member.cli]?.quotaScope;
    if (quotaScope === undefined) return [`${groupId}/${memberId}`];
    return group.members
      .filter((m: any) => (snapshot.config.parallelism!.clis as any)?.[m.cli]?.quotaScope === quotaScope)
      .map((m: any) => `${groupId}/${m.id}`);
  }

  it('a 429 cools the whole shared-quota domain: a peer member on the same CLI/account is excluded too, and both reset together', () => {
    const f = workerResolutionFixture();
    (f.snapshot.config.parallelism as any).clis = {
      // accountScope must match the fixture's installation accountScope
      // ('synthetic' — test/fixtures/worker-resolution.ts) or the resolver
      // denies on a scope mismatch unrelated to this quota-domain scenario.
      // adapter points at the fixture's own registry.providers.codex.workerAdapter.
      codex: { adapter: 'providers:codex', accountScope: 'synthetic', quotaScope: 'shared-account' },
    };
    const now = f.request.now;
    const resetAt = new Date(new Date(now).getTime() + 60000).toISOString();
    // 429 observed against 'primary'; the procedure computes every member
    // sharing its quota domain — here that is both 'primary' AND
    // 'alternate', since both route through the same 'codex' installation.
    const affected = membersSharingQuotaDomain(f.snapshot, 'workers', 'primary');
    expect(affected.sort()).toEqual(['workers/alternate', 'workers/primary']);
    (f.snapshot as any).constraints = { unavailableMembers: affected };
    // Neither the explicit pin nor an unpinned request can get a worker
    // out of this group while the whole domain is cooling — this is the
    // "shared-quota peer" guarantee: it is not enough to exclude only the
    // member that was pinned when the 429 happened.
    const pinnedDuringCooldown = resolveWorkerPlan(f.snapshot, { ...f.request, now, role: 'coding', group: 'workers', member: 'primary', model: 'synthetic/a%b' });
    expect(pinnedDuringCooldown.selected).toBeNull();
    const unpinnedDuringCooldown = resolveWorkerPlan(f.snapshot, { ...f.request, now, role: 'coding', group: 'workers' });
    expect(unpinnedDuringCooldown.selected).toBeNull();
    expect(unpinnedDuringCooldown.eligible.some(t => t.member === 'alternate')).toBe(false);
    expect(unpinnedDuringCooldown.exclusions.some(e => e.member === 'alternate' && e.diagnostics.some(d => d.code === 'OG_ADAPTER_UNQUALIFIED'))).toBe(true);
    // Once the caller's own clock says resetAt has elapsed, it clears the
    // restriction for the whole domain at once (not member-by-member on a
    // staggered schedule it never declared), and both become eligible
    // again together.
    (f.snapshot as any).constraints = {};
    const afterReset = resolveWorkerPlan(f.snapshot, { ...f.request, now: resetAt, role: 'coding', group: 'workers', member: 'primary', model: 'synthetic/a%b' });
    expect(afterReset.selected?.member).toBe('primary');
    const alternateAfterReset = resolveWorkerPlan(f.snapshot, { ...f.request, now: resetAt, role: 'coding', group: 'workers', member: 'alternate', model: 'synthetic-alternate' });
    expect(alternateAfterReset.selected?.member).toBe('alternate');
  });
});

describe('T-OG-16 effort escalation stays within policy: ultra is denied through the resolver, not merely advised against', () => {
  it('an explicit request for "ultra" effort is denied even though the model observation reports it as a supported effort', () => {
    const f = workerResolutionFixture();
    // The fixture's own observation lists 'ultra' among supported efforts
    // (test/fixtures/worker-resolution.ts), but the configured role
    // guidance's effortLadder is only ['medium', 'high'] and 'ultra'
    // self-delegates — either independently denies it.
    const ultra = resolveWorkerPlan(f.snapshot, { ...f.request, role: 'coding', group: 'workers', effort: 'ultra' });
    expect(ultra.selected).toBeNull();
    expect(ultra.exclusions.length).toBeGreaterThan(0);
    expect(ultra.exclusions.every(e => e.diagnostics.some(d => d.code === 'OG_EFFORT_DENIED'))).toBe(true);
    // The ladder's own top rung ("high") still resolves normally: denial is
    // specific to the escalation past policy, not a broken fixture.
    const withinLadder = resolveWorkerPlan(f.snapshot, { ...f.request, role: 'coding', group: 'workers', effort: 'high' });
    expect(withinLadder.selected?.effort).toBe('high');
  });
});

describe('T-OG-16 EPERM is environment evidence, not a passing or a proven code-defect result', () => {
  it('a write-denied worktree directory produces a non-zero exit that must be diagnosed, not bypassed', async context => {
    // Root bypasses DAC permission bits, so chmod cannot deny writes there
    // (CI containers run as root). Skip explicitly rather than pass vacuously.
    if (process.getuid?.() === 0) { context.skip(); return; }
    const root = await worktree();
    const locked = path.join(root, 'locked');
    await mkdir(locked);
    const record = path.join(locked, 'record.json');
    const config = path.join(root, 'config.json');
    await writeFile(config, JSON.stringify({ scenario: 'success', recordPath: record }));
    await chmod(locked, 0o500); // read + execute only: no write permission
    try {
      const running = spawnFixtureCli(config, root);
      const result = await running.closed;
      expect(result.code).not.toBe(0);
      expect(running.output().stderr).toMatch(/EACCES|EPERM/);
    } finally {
      await chmod(locked, 0o700); // restore so afterEach can remove the tree
    }
  });
});

describe('T-OG-16 receipts off / failed optional storage: never required, and no Mission/MC file appears', () => {
  it('a completed lifecycle leaves no .aiwg mission/session state in the worktree', async () => {
    const root = await worktree();
    const record = path.join(root, 'record.json');
    const final = path.join(root, 'final.json');
    const config = path.join(root, 'config.json');
    await writeFile(config, JSON.stringify({ scenario: 'success', recordPath: record, outputPaths: { final } }));
    const running = spawnFixtureCli(config, root);
    expect(await running.closed).toEqual({ code: 0, signal: null });
    await readFile(final); // verified above; receipts remain optional and were never written
    const entries = await readdir(root);
    expect(entries).not.toContain('.aiwg');
    expect(entries.some(name => /mission|session/i.test(name))).toBe(false);
  });
});
