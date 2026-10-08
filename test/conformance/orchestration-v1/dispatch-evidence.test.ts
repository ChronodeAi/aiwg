/**
 * T-OG-09/10 S1 dispatch-evidence checkpoint (#2891, epic #2875).
 *
 * S1 direct/shared mapping assertions with synthetic fixtures only: optional
 * direct activity receipts, 08 brief/evidence storage discipline (0700/0600,
 * prompt cleanup after confirmed stop, dirty/uncertain retention,
 * disk-pressure admission), required-storage-failure blocking, redacted
 * query/export with retained usage confidence, and digest-only effect links
 * verified through the EXISTING effect ledger with the dispatch verifier
 * registered only when supervisor evidence exists.
 *
 * Each probe below is a regression test for a review finding: pre-planted
 * symlink/regular files, symlinked directories, traversal invocation IDs,
 * cleanup outside the root, bogus retention digests, redaction with planted
 * secrets, verifier context omission, and effect-link symlinks.
 *
 * No paid calls, no credentials, no Mission/MC state. Managed-runtime
 * assertions (required evidence, leases, Tier 1 registration) stay with S2+.
 */
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildDirectActivityReceipt,
  checkDispatchAdmission,
  cleanupPromptFile,
  digestOnlyEffectLinks,
  ensureProtectedDir,
  fileDigestTarget,
  INVOCATION_PATTERN as EVIDENCE_INVOCATION_PATTERN,
  isTerminalOrUncertain,
  normalizeUsageForReceipt,
  prepareDirectAttemptPaths,
  redactReceiptForExport,
  requireArtifactRoot,
  settleAttemptDisposition,
  writeProtectedFile,
} from '../../../tools/ralph-external/lib/dispatch-evidence.mjs';
import {
  checkWorkerDispatch,
  evaluateDispatchGate,
  readLiveHostResources,
  resolveDispatchThresholds,
} from '../../../tools/scripts/resource-preflight.mjs';
import {
  DISPATCH_KIND,
  INVOCATION_PATTERN,
  createDispatchVerifierIfSupervised,
  createVerifierRegistry,
  dispatchEffectTarget,
  hasSupervisorEvidence,
  loadSupervisorEvidence,
  openEffectLedger,
  reconcileEffect,
  recordIntent,
  staticKeyProvider,
} from '../../../src/effects/index.js';
import { validateWorkerPayload } from '../../../src/mission-protocol/codecs.js';
import { harness as effectHarness, scope as effectScope, testKey } from '../../unit/effects/helpers.js';

const digestOf = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
// CI runs as root: permission bits cannot be proven under uid 0, so mode-bit
// assertions skip there while behavior assertions still run.
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch() {
  const root = await mkdtemp(path.join(tmpdir(), 'aiwg-dispatch-evidence-'));
  roots.push(root);
  return root;
}

const healthyLive = (over: Record<string, unknown> = {}) => ({
  supported: true, availMemGb: 32, load1: 2, cores: 8, loadRatio: 0.25,
  memPsiAvg10: 1, memPsiAvg60: 1, workers: 0, freeDiskGb: 32, ...over,
});

/** One attempt with a prompt file and a proven redacted artifact. */
async function provenAttempt(root: string, invocationId = 'inv-cleanup') {
  const paths = await prepareDirectAttemptPaths(root, invocationId);
  const prompt = path.join(paths.attempt, 'prompt.md');
  await writeFile(prompt, 'cli prompt');
  const redacted = await writeProtectedFile(path.join(paths.evidenceDir, 'redacted.json'), '{"task":"t"}');
  return {
    ...paths,
    prompt,
    redactedDigest: redacted.digest,
    redactedPath: 'evidence/redacted.json',
    confirmedDisposition: settleAttemptDisposition('completed'),
  };
}

describe('T-OG-09 08 brief/evidence storage: 0700 dirs, 0600 files, unavailable root blocks', () => {
  it('creates brief/evidence dirs and files with owner-only modes, umask-independent', async () => {
    const root = await scratch();
    const paths = await prepareDirectAttemptPaths(root, 'inv-001');
    expect(paths.briefDir.endsWith(path.join('inv-001', 'brief'))).toBe(true);
    expect(paths.evidenceDir.endsWith(path.join('inv-001', 'evidence'))).toBe(true);
    const written = await writeProtectedFile(path.join(paths.briefDir, 'brief.json'), '{"objective":"demo"}');
    expect(written.digest).toBe(digestOf('{"objective":"demo"}'));
    if (!isRoot) {
      expect((await stat(paths.briefDir)).mode & 0o777).toBe(0o700);
      expect((await stat(paths.evidenceDir)).mode & 0o777).toBe(0o700);
      expect((await stat(written.path)).mode & 0o777).toBe(0o600);
    }
  });

  it('an unavailable artifact root blocks preparation', async () => {
    const missing = path.join(await scratch(), 'no-such-root');
    await expect(prepareDirectAttemptPaths(missing, 'inv-002')).rejects.toMatchObject({ code: 'artifact-root-unavailable' });
    await expect(requireArtifactRoot(path.join(missing, 'deeper'))).rejects.toMatchObject({ code: 'artifact-root-unavailable' });
  });

  it('a file root (not a directory) blocks preparation', async () => {
    const root = await scratch();
    const file = path.join(root, 'file-not-dir');
    await writeFile(file, 'x');
    await expect(requireArtifactRoot(file)).rejects.toMatchObject({ code: 'artifact-root-unavailable' });
  });

  it('a pre-planted symlink at an evidence path is never followed: the victim survives, the write fails', async () => {
    const root = await scratch();
    const victimDir = await scratch();
    const victim = path.join(victimDir, 'victim.txt');
    await writeFile(victim, 'victim-bytes');
    await chmod(victim, 0o644);
    const link = path.join(root, 'planted.txt');
    await symlink(victim, link);
    await expect(writeProtectedFile(link, 'attacker-bytes')).rejects.toMatchObject({ code: 'storage-failure' });
    expect(await readFile(victim, 'utf8')).toBe('victim-bytes');
    expect((await stat(victim)).mode & 0o777).toBe(0o644);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });

  it('a pre-planted regular file is never truncated or chmodded: the write fails', async () => {
    const root = await scratch();
    const target = path.join(root, 'brief.json');
    await writeFile(target, 'original');
    await chmod(target, 0o644);
    await expect(writeProtectedFile(target, 'attacker-bytes')).rejects.toMatchObject({ code: 'storage-failure' });
    expect(await readFile(target, 'utf8')).toBe('original');
    expect((await stat(target)).mode & 0o777).toBe(0o644);
  });

  it('a pre-planted symlinked directory is rejected before any mode change: the victim keeps 0755', async () => {
    const root = await scratch();
    const victim = await scratch();
    await chmod(victim, 0o755);
    await symlink(victim, path.join(root, 'inv-sym'));
    await expect(prepareDirectAttemptPaths(root, 'inv-sym')).rejects.toMatchObject({ code: 'storage-failure' });
    expect((await stat(victim)).mode & 0o777).toBe(0o755);
  });

  it('traversal invocation IDs never reach the join: ../escaped and a/b are rejected', async () => {
    const root = await scratch();
    for (const bad of ['../escaped', 'a/b', '', '..', '.hidden']) {
      await expect(prepareDirectAttemptPaths(root, bad)).rejects.toMatchObject({ code: 'invalid-invocation' });
    }
    expect(() => buildDirectActivityReceipt({
      taskId: 't', invocationId: '../escaped', transport: 'shell' as const,
    })).toThrow(/invocation/i);
    expect(await stat(path.join(root, 'escaped')).catch((error: NodeJS.ErrnoException) => error?.code)).toBe('ENOENT');
  });

  it('the invocation pattern is shared: evidence and verifier literals stay identical', async () => {
    expect(EVIDENCE_INVOCATION_PATTERN.source).toBe(INVOCATION_PATTERN.source);
    for (const good of ['inv-001', 'A9', 'a.b_c-d']) {
      expect(INVOCATION_PATTERN.test(good)).toBe(true);
      expect(EVIDENCE_INVOCATION_PATTERN.test(good)).toBe(true);
    }
    for (const bad of ['../escaped', 'a/b', '', '.hidden', '-lead']) {
      expect(INVOCATION_PATTERN.test(bad)).toBe(false);
    }
  });
});

describe('T-OG-09 prompt-file cleanup only after a CONFIRMED stop with proven retention', () => {
  it('removes the prompt file after confirmed stop, recorded disposition and proven redacted artifact', async () => {
    const root = await scratch();
    const attempt = await provenAttempt(root);
    const done = await cleanupPromptFile({
      attemptRoot: attempt.attempt,
      promptPath: attempt.prompt,
      termination: 'confirmed',
      disposition: attempt.confirmedDisposition,
      redactedArtifactDigest: attempt.redactedDigest,
      redactedArtifactPath: attempt.redactedPath,
    });
    expect(done).toMatchObject({ removed: true });
    await expect(readFile(attempt.prompt)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never deletes uncertain evidence: uncertain, live and unrecorded-redaction prompts are retained', async () => {
    const root = await scratch();
    for (const [name, options] of [
      ['uncertain', { termination: 'uncertain' }],
      ['live', { termination: 'running' }],
      ['unrecorded', { termination: 'confirmed' }],
    ] as const) {
      const attempt = await provenAttempt(root, `inv-${name}`);
      const prompt = path.join(attempt.attempt, 'prompt.md');
      await writeFile(prompt, 'evidence');
      const kept = await cleanupPromptFile({
        attemptRoot: attempt.attempt,
        promptPath: prompt,
        disposition: attempt.confirmedDisposition,
        redactedArtifactDigest: name === 'unrecorded' ? null : attempt.redactedDigest,
        redactedArtifactPath: name === 'unrecorded' ? null : attempt.redactedPath,
        ...options,
      });
      expect(kept.removed).toBe(false);
      expect(await readFile(prompt, 'utf8')).toBe('evidence');
    }
  });

  it('a prompt file outside the attempt root throws and survives', async () => {
    const root = await scratch();
    const attempt = await provenAttempt(root, 'inv-inside');
    const outside = path.join(root, 'prompt.md');
    await writeFile(outside, 'outside prompt');
    await expect(cleanupPromptFile({
      attemptRoot: attempt.attempt,
      promptPath: outside,
      termination: 'confirmed',
      disposition: attempt.confirmedDisposition,
      redactedArtifactDigest: attempt.redactedDigest,
      redactedArtifactPath: attempt.redactedPath,
    })).rejects.toMatchObject({ code: 'prompt-escape' });
    expect(await readFile(outside, 'utf8')).toBe('outside prompt');
  });

  it('a symlinked prompt file throws and the link target survives', async () => {
    const root = await scratch();
    const attempt = await provenAttempt(root, 'inv-link');
    const victimDir = await scratch();
    const victim = path.join(victimDir, 'victim-prompt.txt');
    await writeFile(victim, 'victim prompt');
    const link = path.join(attempt.attempt, 'prompt.md');
    await rm(link, { force: true });
    await symlink(victim, link);
    await expect(cleanupPromptFile({
      attemptRoot: attempt.attempt,
      promptPath: link,
      termination: 'confirmed',
      disposition: attempt.confirmedDisposition,
      redactedArtifactDigest: attempt.redactedDigest,
      redactedArtifactPath: attempt.redactedPath,
    })).rejects.toMatchObject({ code: 'prompt-escape' });
    expect(await readFile(victim, 'utf8')).toBe('victim prompt');
  });

  it('a bogus retention digest retains: malformed, missing and mismatched proofs all refuse removal', async () => {
    const root = await scratch();
    for (const [name, digest, artifactPath] of [
      ['malformed', 'not-even-a-digest', 'evidence/redacted.json'],
      ['missing', digestOf('no such artifact'), 'evidence/missing.json'],
      ['mismatch', digestOf('other bytes'), 'evidence/redacted.json'],
    ] as const) {
      const attempt = await provenAttempt(root, `inv-${name}`);
      const prompt = path.join(attempt.attempt, 'prompt.md');
      await writeFile(prompt, 'evidence');
      const kept = await cleanupPromptFile({
        attemptRoot: attempt.attempt,
        promptPath: prompt,
        termination: 'confirmed',
        disposition: attempt.confirmedDisposition,
        redactedArtifactDigest: digest,
        redactedArtifactPath: artifactPath,
      });
      expect(kept.removed).toBe(false);
      expect(await readFile(prompt, 'utf8')).toBe('evidence');
    }
  });

  it('a non-prompt filename is never removed through cleanup', async () => {
    const root = await scratch();
    const attempt = await provenAttempt(root, 'inv-name');
    const other = path.join(attempt.attempt, 'notes.md');
    await writeFile(other, 'notes');
    await expect(cleanupPromptFile({
      attemptRoot: attempt.attempt,
      promptPath: other,
      termination: 'confirmed',
      disposition: attempt.confirmedDisposition,
      redactedArtifactDigest: attempt.redactedDigest,
      redactedArtifactPath: attempt.redactedPath,
    })).rejects.toMatchObject({ code: 'invalid-prompt-path' });
    expect(await readFile(other, 'utf8')).toBe('notes');
  });

  it('settleAttemptDisposition retains failed/cancelled/timed-out work without an explicit disposition', () => {
    expect(settleAttemptDisposition('uncertain').removable).toBe(false);
    expect(settleAttemptDisposition('running').removable).toBe(false);
    expect(settleAttemptDisposition('completed')).toMatchObject({ removable: true });
    expect(settleAttemptDisposition('failed')).toMatchObject({ removable: false });
    expect(settleAttemptDisposition('cancelled')).toMatchObject({ removable: false });
    expect(settleAttemptDisposition('timed-out')).toMatchObject({ removable: false });
    expect(settleAttemptDisposition('failed', 'discarded by conductor')).toMatchObject({ removable: true });
    expect(settleAttemptDisposition('cancelled', { removable: true })).toMatchObject({ removable: true });
  });

  it('failed work keeps its prompt file until the conductor records a disposition', async () => {
    const root = await scratch();
    const attempt = await provenAttempt(root, 'inv-failed');
    const base = {
      attemptRoot: attempt.attempt,
      promptPath: attempt.prompt,
      termination: 'confirmed' as const,
      redactedArtifactDigest: attempt.redactedDigest,
      redactedArtifactPath: attempt.redactedPath,
    };
    const retained = await cleanupPromptFile({ ...base, disposition: settleAttemptDisposition('failed') });
    expect(retained.removed).toBe(false);
    expect(await readFile(attempt.prompt, 'utf8')).toBe('cli prompt');
    const released = await cleanupPromptFile({
      ...base, disposition: settleAttemptDisposition('failed', 'integrated by conductor'),
    });
    expect(released).toMatchObject({ removed: true });
  });

  it('every direct attempt resolves terminal or uncertain before capacity release', () => {
    expect(isTerminalOrUncertain({ status: 'completed', termination: 'confirmed' })).toBe(true);
    expect(isTerminalOrUncertain({ status: 'failed', termination: 'confirmed' })).toBe(true);
    expect(isTerminalOrUncertain({ status: 'uncertain', termination: 'uncertain' })).toBe(true);
    expect(isTerminalOrUncertain({ status: 'completed', termination: 'uncertain' })).toBe(true);
    expect(isTerminalOrUncertain({ status: 'running', termination: 'confirmed' })).toBe(false);
    expect(isTerminalOrUncertain({ status: 'pending', termination: 'confirmed' })).toBe(false);
    expect(isTerminalOrUncertain(null)).toBe(false);
  });
});

describe('T-OG-09/T-OG-10 disk-pressure admission through the #2954 resolver', () => {
  it('the default resolver carries the 08 2 GiB free-disk floor', () => {
    expect(resolveDispatchThresholds()).toMatchObject({ min_free_disk_gb: 2 });
  });

  it('under-threshold free disk blocks naming the free-disk signal', () => {
    const result = evaluateDispatchGate(healthyLive({ freeDiskGb: 0.5 }), resolveDispatchThresholds());
    expect(result.ok).toBe(false);
    expect(result.failures.map(failure => failure.signal)).toContain('free-disk');
  });

  it('undetectable free disk fails closed', () => {
    const { freeDiskGb: _dropped, ...noDisk } = healthyLive();
    const result = evaluateDispatchGate(noDisk, resolveDispatchThresholds());
    expect(result.ok).toBe(false);
    expect(result.failures.map(failure => failure.signal)).toContain('free-disk');
  });

  it('pre-sampled NaN, Infinity and negative readings fail closed, never pass', () => {
    for (const poisoned of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const result = evaluateDispatchGate(healthyLive({ freeDiskGb: poisoned }), resolveDispatchThresholds());
      expect(result.ok).toBe(false);
      expect(result.failures.map(failure => failure.signal)).toContain('free-disk');
    }
  });

  it('sampling without caller-supplied filesystems leaves free disk unknown', () => {
    const live = readLiveHostResources({
      readText: () => { throw Object.assign(new Error('no proc'), { code: 'ENOENT' }); },
      coreCount: () => 8,
      countWorkers: () => 0,
    });
    expect(live.freeDiskGb).toBeUndefined();
  });

  it('checkWorkerDispatch without live signals or paths fails closed on free disk', () => {
    const result = checkWorkerDispatch({ config: { parallelism: { worker_dispatch: true } } });
    expect(result).toMatchObject({ enabled: true, ok: false });
    expect(result.failures.map(failure => failure.signal)).toContain('free-disk');
  });

  it('checkDispatchAdmission samples the attempt root and worktree filesystems', () => {
    const seen: string[] = [];
    const gate = checkDispatchAdmission({
      config: { parallelism: { worker_dispatch: true } },
      attemptRoot: '/evidence/attempt-1',
      worktree: '/work/tree-1',
      readers: {
        readText: () => { throw Object.assign(new Error('no proc'), { code: 'ENOENT' }); },
        coreCount: () => 8,
        countWorkers: () => 0,
        statfsPath: (sampled: string) => {
          seen.push(sampled);
          return { bavail: 64n * 1024n * 1024n * 1024n, bsize: 1n };
        },
      },
    });
    expect(seen.sort()).toEqual(['/evidence/attempt-1', '/work/tree-1']);
    expect(gate.live.freeDiskGb).toBe(64);
  });

  it('checkWorkerDispatch blocks a disk-pressured host before any launch', () => {
    const blocked = checkWorkerDispatch({
      config: { parallelism: { worker_dispatch: true } },
      live: healthyLive({ freeDiskGb: 1.2 }),
    });
    expect(blocked).toMatchObject({ enabled: true, ok: false });
    expect(blocked.failures.map(failure => failure.signal)).toContain('free-disk');
    const allowed = checkWorkerDispatch({
      config: { parallelism: { worker_dispatch: true } },
      live: healthyLive(),
    });
    expect(allowed).toMatchObject({ enabled: true, ok: true });
  });
});

describe('T-OG-09 optional direct activity receipts; T-OG-10 no command text in receipts', () => {
  const fields = {
    taskId: 'task-17', invocationId: 'inv-017', transport: 'shell' as const,
    profileRef: 'codex/host-0.160.1', profileVersion: '0.160.1',
    commandDigest: digestOf('codex --no-daemon exec [...]'),
    requested: { model: 'gpt-6.1-sol', effort: 'medium' },
    observed: { model: 'gpt-6.1-sol', effort: 'medium' },
    identityConfidence: 'runtime-configured-only',
    termination: 'confirmed',
    checks: [{ checkId: 'final-schema', exitCode: 0 }],
    usage: { inputTokens: 1200, outputTokens: 300, costUsd: null, quality: 'reported' as const },
  };

  it('builds an optional receipt in the current activity append format', () => {
    const { receipt, operation, summary } = buildDirectActivityReceipt(fields);
    expect(operation).toBe('create');
    expect(receipt).toMatchObject({ mode: 'direct', taskId: 'task-17', transport: 'shell', termination: 'confirmed' });
    expect(summary).toContain('task-17');
    expect(summary).toContain('inv-017');
    expect(summary).not.toContain('--no-daemon');
  });

  it('rejects raw command text where only a descriptor digest may appear', () => {
    expect(() => buildDirectActivityReceipt({ ...fields, commandDigest: 'codex --no-daemon exec' })).toThrow(/digest/);
  });

  it('redacted export retains usage confidence: unknown stays unknown', () => {
    const unknownUsage = buildDirectActivityReceipt({
      ...fields, transport: 'mcp', toolDigest: digestOf('worker-invoke args'),
      usage: { inputTokens: null, outputTokens: null, costUsd: null, quality: 'unknown' as const },
      worktree: '/work/task-17/tree', handle: 'pid:4242',
    });
    const exported = redactReceiptForExport(unknownUsage.receipt);
    expect(exported.usage).toMatchObject({ inputTokens: null, outputTokens: null, costUsd: null, quality: 'unknown' });
    expect(validateWorkerPayload('workerUsage', exported.usage)).toMatchObject({ valid: true });
    expect(exported).toMatchObject({ redacted: true });
    expect(exported).not.toHaveProperty('worktree');
    expect(exported).not.toHaveProperty('handle');
    expect(normalizeUsageForReceipt(undefined)).toMatchObject({ quality: 'unknown', inputTokens: null });
  });

  it('redacted export is an allowlist: planted secrets in every input field never appear', () => {
    const secret = (tag: string) => `SECRET-${tag}-7f3a9c1e`;
    const secrets = [
      secret('requested-prompt'), secret('observed-model'), secret('check-blob'),
      secret('acceptance'), secret('worktree'), secret('handle'),
      secret('profile'), secret('revision'), secret('top-extra'),
    ];
    const { receipt } = buildDirectActivityReceipt({
      taskId: 'task-secrets', invocationId: 'inv-sec1', transport: 'shell' as const,
      profileRef: secrets[6], profileVersion: '9.9.9',
      commandDigest: digestOf('worker command'),
      requested: { model: 'm', prompt: secrets[0] },
      observed: { model: secrets[1], effort: 'high' },
      identityConfidence: 'backend-attested',
      worktree: secrets[4], baseRevision: secrets[7], handle: secrets[5],
      termination: 'confirmed',
      checks: [{ checkId: 'final-schema', exitCode: 0, evidence: { blob: secrets[2] }, log: secrets[2] }],
      acceptance: { status: secrets[3] },
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01, quality: 'reported' as const },
    });
    (receipt as Record<string, unknown>).topExtra = secrets[8];
    (receipt as Record<string, unknown>).requestedPrompt = secrets[0];
    const exported = redactReceiptForExport(receipt);
    const text = JSON.stringify(exported);
    for (const planted of secrets) expect(text).not.toContain(planted);
    expect(exported).toMatchObject({ taskId: 'task-secrets', redacted: true });
    expect(exported.descriptorDigest).toBe(digestOf('worker command'));
    for (const dropped of ['requested', 'observed', 'acceptance', 'worktree', 'handle', 'profileRef', 'baseRevision', 'topExtra', 'requestedPrompt']) {
      expect(exported).not.toHaveProperty(dropped);
    }
    expect(exported.checks).toEqual([{ checkId: 'final-schema', exitCode: 0 }]);
  });

  it('worker usage enforces the #2890 contract: unknown drops numerics, every output validates', () => {
    expect(normalizeUsageForReceipt({ inputTokens: 7, outputTokens: 8, costUsd: 1.5, quality: 'unknown' }))
      .toMatchObject({ inputTokens: null, outputTokens: null, costUsd: null, quality: 'unknown' });
    expect(normalizeUsageForReceipt({ inputTokens: 1200, outputTokens: 300, costUsd: 0.5, quality: 'reported' }))
      .toMatchObject({ inputTokens: 1200, outputTokens: 300, costUsd: 0.5, quality: 'reported' });
    for (const sample of [
      undefined, null, {},
      { inputTokens: 1, quality: 'unknown' },
      { inputTokens: -3, outputTokens: 1.5, costUsd: -1, quality: 'reported', reservedTokens: -1 },
      { inputTokens: 4, outputTokens: 2, quality: 'estimated', cacheTokens: 1, reasoningTokens: 1, reservedTokens: 3, reservedUsd: 0.2 },
    ]) {
      expect(validateWorkerPayload('workerUsage', normalizeUsageForReceipt(sample))).toMatchObject({ valid: true });
    }
  });
});

describe('T-OG-09 digest-only effect links verify through the EXISTING effect ledger', () => {
  it('links carry file.digest targets only; escapes refuse', async () => {
    const root = await scratch();
    await writeFile(path.join(root, 'final.json'), '{"status":"completed"}');
    const { target, digest } = await fileDigestTarget({ root, path: 'final.json' });
    expect(target).toBe(`file:final.json@${digest}`);
    const { links, fileTargets } = digestOnlyEffectLinks({ traceId: 'ab'.repeat(16), fileTargets: [target] });
    expect(links).toMatchObject({ traceId: 'ab'.repeat(16) });
    expect(fileTargets).toEqual([target]);
    await expect(fileDigestTarget({ root, path: '../escape.json' })).rejects.toMatchObject({ code: 'link-escape' });
    expect(() => digestOnlyEffectLinks({ fileTargets: ['file:x@not-a-digest'] })).toThrow(/file\.digest/);
  });

  it('a symlink out of the root refuses instead of minting an unreconcilable digest', async () => {
    const root = await scratch();
    const outsideDir = await scratch();
    const outside = path.join(outsideDir, 'outside.json');
    await writeFile(outside, '{"out":"of-root-bytes"}');
    await symlink(outside, path.join(root, 'linked.json'));
    await expect(fileDigestTarget({ root, path: 'linked.json' })).rejects.toMatchObject({ code: 'link-escape' });
  });

  it('dot-dot spellings emit the canonical relative path', async () => {
    const root = await scratch();
    const paths = await prepareDirectAttemptPaths(root, 'inv-link');
    const written = await writeProtectedFile(path.join(paths.evidenceDir, 'x.json'), '{"x":1}');
    const { target } = await fileDigestTarget({ root: paths.attempt, path: 'evidence/../evidence/x.json' });
    expect(target).toBe(`file:evidence/x.json@${written.digest}`);
  });

  it('the dispatch verifier registers only with supervisor evidence and reconciles present', async () => {
    expect(createDispatchVerifierIfSupervised({ projectDir: '/tmp/x', evidence: null })).toBeNull();
    expect(createDispatchVerifierIfSupervised({ projectDir: '/tmp/x', evidence: {} })).toBeNull();
    expect(hasSupervisorEvidence({ invocationId: 'inv-1' })).toBe(false);
    const evidenceDigest = digestOf('supervisor dispatch record inv-090');
    expect(hasSupervisorEvidence({ invocationId: 'inv-090', evidenceDigest })).toBe(true);

    const h = effectHarness();
    try {
      const verifier = createDispatchVerifierIfSupervised({ projectDir: h.dir, evidence: { invocationId: 'inv-090', evidenceDigest } });
      expect(verifier?.kind).toBe(DISPATCH_KIND);
      const ledger = openEffectLedger({
        projectDir: h.dir, scope: effectScope, writer: 'dispatch-conductor',
        keyProvider: staticKeyProvider(testKey('dispatch-2891')),
        clock: h.clock.read, sink: h.sink, verifiers: createVerifierRegistry([verifier!]),
      });
      const intent = await recordIntent(ledger, {
        kind: DISPATCH_KIND,
        target: dispatchEffectTarget('inv-090'),
        context: { invocationId: 'inv-090', evidenceDigest },
        payloadDigest: evidenceDigest,
        links: { traceId: 'ab'.repeat(16) },
      });
      const outcome = await reconcileEffect(ledger, intent.effectId, { expected: { digest: evidenceDigest } });
      expect(outcome.result.verification.result).toBe('present');
      expect(outcome.completed?.phase).toBe('completed');
      expect(outcome.receipt.exitCode).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  it('supervised artifacts drive the branch: a context that omits the artifact is evidence-conflict, never present', async () => {
    const h = effectHarness();
    try {
      const evidenceDir = await scratch();
      await ensureProtectedDir(evidenceDir);
      const evidenceDigest = digestOf('supervisor record with artifact');
      const artifact = await writeProtectedFile(path.join(evidenceDir, 'final.json'), '{"status":"completed"}');
      const evidence = {
        invocationId: 'inv-artifact',
        evidenceDigest,
        artifactPath: 'final.json',
        artifactDigest: artifact.digest,
      };
      expect(hasSupervisorEvidence(evidence)).toBe(true);
      const verifier = createDispatchVerifierIfSupervised({ projectDir: h.dir, evidenceDir, evidence });
      const ledger = openEffectLedger({
        projectDir: h.dir, scope: effectScope, writer: 'dispatch-conductor',
        keyProvider: staticKeyProvider(testKey('dispatch-2891')),
        clock: h.clock.read, sink: h.sink, verifiers: createVerifierRegistry([verifier!]),
      });
      const omitted = await recordIntent(ledger, {
        kind: DISPATCH_KIND,
        target: dispatchEffectTarget('inv-artifact'),
        context: { invocationId: 'inv-artifact', evidenceDigest },
        payloadDigest: evidenceDigest,
      });
      const downgrade = await reconcileEffect(ledger, omitted.effectId, { expected: { digest: evidenceDigest } });
      expect(downgrade.result.verification.result).toBe('unknown');
      expect(downgrade.result.verification.reason).toBe('evidence-conflict');
      expect(downgrade.completed).toBeNull();

      const stated = await recordIntent(ledger, {
        kind: DISPATCH_KIND,
        target: dispatchEffectTarget('inv-artifact'),
        context: { invocationId: 'inv-artifact', evidenceDigest, artifactPath: 'final.json', artifactDigest: artifact.digest },
        payloadDigest: evidenceDigest,
      });
      const proven = await reconcileEffect(ledger, stated.effectId, { expected: { digest: evidenceDigest } });
      expect(proven.result.verification.result).toBe('present');
      expect(proven.completed?.phase).toBe('completed');
    } finally {
      h.cleanup();
    }
  });

  it('file.digest delegation roots at the evidence directory, not the project directory', async () => {
    const h = effectHarness();
    try {
      const evidenceDir = await scratch();
      await ensureProtectedDir(evidenceDir);
      // The artifact exists under the project dir but NOT under the evidence dir.
      const projectArtifact = path.join(h.dir, 'final.json');
      await writeFile(projectArtifact, '{"status":"completed"}');
      const evidenceDigest = digestOf('supervisor record rooted elsewhere');
      const evidence = {
        invocationId: 'inv-rooted',
        evidenceDigest,
        artifactPath: 'final.json',
        artifactDigest: digestOf('{"status":"completed"}'),
      };
      const verifier = createDispatchVerifierIfSupervised({ projectDir: h.dir, evidenceDir, evidence });
      const ledger = openEffectLedger({
        projectDir: h.dir, scope: effectScope, writer: 'dispatch-conductor',
        keyProvider: staticKeyProvider(testKey('dispatch-2891')),
        clock: h.clock.read, sink: h.sink, verifiers: createVerifierRegistry([verifier!]),
      });
      const intent = await recordIntent(ledger, {
        kind: DISPATCH_KIND,
        target: dispatchEffectTarget('inv-rooted'),
        context: { invocationId: 'inv-rooted', evidenceDigest, artifactPath: 'final.json', artifactDigest: evidence.artifactDigest },
        payloadDigest: evidenceDigest,
      });
      const outcome = await reconcileEffect(ledger, intent.effectId, { expected: { digest: evidenceDigest } });
      expect(outcome.result.verification.result).not.toBe('present');
    } finally {
      h.cleanup();
    }
  });

  it('supervisor evidence loads fd-pinned from the conductor-owned evidence location', async () => {
    const dir = await scratch();
    await ensureProtectedDir(dir);
    const evidenceDigest = digestOf('supervisor record on disk');
    const record = { invocationId: 'inv-disk', evidenceDigest };
    await writeProtectedFile(path.join(dir, 'inv-disk.json'), JSON.stringify(record));
    const loaded = await loadSupervisorEvidence({ evidenceDir: dir, invocationId: 'inv-disk' });
    expect(loaded).toMatchObject(record);

    // A symlink in place of the evidence file refuses instead of following.
    const victimDir = await scratch();
    const victim = path.join(victimDir, 'victim-evidence.json');
    await writeFile(victim, JSON.stringify({ invocationId: 'inv-disk', evidenceDigest: digestOf('forged') }));
    await rm(path.join(dir, 'inv-disk.json'));
    await symlink(victim, path.join(dir, 'inv-disk.json'));
    await expect(loadSupervisorEvidence({ evidenceDir: dir, invocationId: 'inv-disk' })).rejects.toThrow();
    expect(await readFile(victim, 'utf8')).toContain(digestOf('forged'));

    // A group-readable evidence file refuses.
    await rm(path.join(dir, 'inv-disk.json'), { force: true });
    await writeFile(path.join(dir, 'inv-disk.json'), JSON.stringify(record));
    await chmod(path.join(dir, 'inv-disk.json'), 0o644);
    await expect(loadSupervisorEvidence({ evidenceDir: dir, invocationId: 'inv-disk' })).rejects.toThrow();

    // Traversal invocation IDs never become filenames.
    await expect(loadSupervisorEvidence({ evidenceDir: dir, invocationId: '../escaped' })).rejects.toThrow();
  });

  it('without registration the same effect reconciles unknown through the existing ledger — no second ledger', async () => {
    const h = effectHarness();
    try {
      const ledger = h.ledger();
      const evidenceDigest = digestOf('supervisor dispatch record inv-091');
      const intent = await recordIntent(ledger, {
        kind: DISPATCH_KIND,
        target: dispatchEffectTarget('inv-091'),
        context: { invocationId: 'inv-091', evidenceDigest },
        payloadDigest: evidenceDigest,
      });
      const outcome = await reconcileEffect(ledger, intent.effectId, { expected: { digest: evidenceDigest } });
      expect(outcome.result.verification.result).toBe('unknown');
      expect(outcome.result.verification.reason).toBe('verifier-missing');
      expect(outcome.completed).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it('T-OG-10 forged evidence digest reconciles unknown, never present', async () => {
    const h = effectHarness();
    try {
      const evidenceDigest = digestOf('real supervisor record');
      const verifier = createDispatchVerifierIfSupervised({ projectDir: h.dir, evidence: { invocationId: 'inv-092', evidenceDigest } });
      const ledger = openEffectLedger({
        projectDir: h.dir, scope: effectScope, writer: 'dispatch-conductor',
        keyProvider: staticKeyProvider(testKey('dispatch-2891')),
        clock: h.clock.read, sink: h.sink, verifiers: createVerifierRegistry([verifier!]),
      });
      const intent = await recordIntent(ledger, {
        kind: DISPATCH_KIND,
        target: dispatchEffectTarget('inv-092'),
        context: { invocationId: 'inv-092', evidenceDigest },
        payloadDigest: evidenceDigest,
      });
      const forged = await reconcileEffect(ledger, intent.effectId, { expected: { digest: digestOf('forged record') } });
      expect(forged.result.verification.result).toBe('unknown');
      expect(forged.result.verification.reason).toBe('evidence-conflict');
      expect(forged.completed).toBeNull();
    } finally {
      h.cleanup();
    }
  });
});
