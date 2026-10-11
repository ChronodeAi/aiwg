/**
 * #2891 R1-R4 fix-pass regression tests (round 2, roctinam/aiwg#2891).
 *
 * Deterministic TOCTOU/race-injection probes for the fd-pinned primitives in
 * `tools/ralph-external/lib/dispatch-evidence.mjs` and the fd-pinned read in
 * `src/effects/dispatch-verifier.ts`'s `loadSupervisorEvidence`, plus the
 * #2891 R2 every-field redaction probe, the R3 verifier evidenceDir-omission
 * and captured-evidence-mutation probes, and the R4 shared invocation-ID
 * pattern probe.
 *
 * Race injection uses each module's own `__raceTestHooks` seam (a no-op,
 * `null`-by-default object consulted only after an internal `open`/`mkdir`
 * call succeeds) rather than `vi.mock('node:fs/promises', ...)`: this
 * conformance config runs with `isolate: false` across many files sharing
 * one worker, where a global builtin-module mock proved order-dependent and
 * flaky (it could intermittently miss its own target call when other files'
 * module graphs were evaluated in between). A plain object both modules
 * already export is deterministic regardless of file execution order. Each
 * test's hook matches on the specific path it cares about and self-clears
 * the moment it fires, so it runs exactly once, at the exact point between
 * two of our own filesystem steps where an attacker-controlled swap (rename
 * the real directory away, plant a symlink to an external victim at its old
 * name) would have to land to matter. Node is single-threaded and every
 * step below is a plain `await`, so performing the swap synchronously
 * inside the hook reliably reproduces the race without any real concurrency
 * or flakiness. Each test asserts the FIX holds: the operation still acts
 * on the original, fd-pinned location, and the external victim is never
 * touched.
 *
 * No paid calls, no credentials, no Mission/MC state.
 */
import { createHash } from 'node:crypto';
import {
  mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const {
  __raceTestHooks: evidenceRaceHooks,
  buildDirectActivityReceipt,
  cleanupPromptFile,
  ensureProtectedDir,
  fileDigestTarget,
  INVOCATION_PATTERN: EVIDENCE_INVOCATION_PATTERN,
  prepareDirectAttemptPaths,
  redactReceiptForExport,
  settleAttemptDisposition,
  writeProtectedFile,
} = await import('../../../tools/ralph-external/lib/dispatch-evidence.mjs');
const {
  __raceTestHooks: verifierRaceHooks,
  createDispatchVerifierIfSupervised,
  dispatchEffectTarget,
  INVOCATION_PATTERN,
  loadSupervisorEvidence,
} = await import('../../../src/effects/dispatch-verifier.js');
const {
  createVerifierRegistry, openEffectLedger, recordIntent, reconcileEffect, staticKeyProvider,
} = await import('../../../src/effects/index.js');
const { harness: effectHarness, scope: effectScope, testKey } = await import('../../unit/effects/helpers.js');

const digestOf = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const roots: string[] = [];
afterEach(async () => {
  evidenceRaceHooks.afterOpen = null;
  evidenceRaceHooks.afterMkdir = null;
  verifierRaceHooks.afterOpen = null;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch() {
  const root = await mkdtemp(path.join(tmpdir(), 'aiwg-dispatch-evidence-races-'));
  roots.push(root);
  return root;
}

describe('#2891 R4: one shared invocation-ID pattern, imported not duplicated', () => {
  it('dispatch-evidence imports the SAME pattern dispatch-verifier exports, never a second literal', () => {
    // `tools/` resolves this through `importImpl`, which may load a
    // compiled `dist/src/` copy of `dispatch-verifier.ts` — a different
    // module INSTANCE than vitest's own `.ts`-source resolution used here,
    // so the two regex objects are not always `===`. What must never drift
    // is the pattern itself: both sides trace to this one source
    // definition, never a hand-copied second literal.
    expect(EVIDENCE_INVOCATION_PATTERN.source).toBe(INVOCATION_PATTERN.source);
    expect(EVIDENCE_INVOCATION_PATTERN.flags).toBe(INVOCATION_PATTERN.flags);
  });
});

describe('#2891 R1 races: ensureProtectedDir refuses a symlinked ancestor', () => {
  it('a symlinked parent is refused outright; nothing is created through it', async () => {
    const root = await scratch();
    const victim = await scratch();
    await symlink(victim, path.join(root, 'mid'));
    await expect(ensureProtectedDir(path.join(root, 'mid', 'leaf')))
      .rejects.toMatchObject({ code: 'storage-failure' });
    expect(await readdir(victim)).toEqual([]);
  });
});

describe('#2891 R1 races: prepareDirectAttemptPaths survives an attempt-dir swap', () => {
  it('swapping the attempt directory right after creation cannot redirect brief/evidence into the victim', async () => {
    const root = await scratch();
    const victim = await scratch();
    const invocationId = 'inv-race-attempt';
    let swapped: string | null = null;
    evidenceRaceHooks.afterOpen = async (targetPath: string) => {
      // Fires after the attempt directory itself has been created AND
      // successfully reopened/validated (mkdir, then open+fstat) — the
      // precise moment before `brief`/`evidence` are created through the
      // now-pinned attempt handle.
      if (!targetPath.endsWith(`/${invocationId}`)) return;
      evidenceRaceHooks.afterOpen = null;
      const real = path.join(root, invocationId);
      swapped = `${real}-real`;
      await rename(real, swapped);
      await symlink(victim, real);
    };

    const paths = await prepareDirectAttemptPaths(root, invocationId);

    expect(swapped).not.toBeNull();
    expect(await readdir(victim)).toEqual([]);
    expect(await readdir(swapped as string)).toEqual(expect.arrayContaining(['brief', 'evidence']));
    expect(paths.attempt).toBe(path.join(root, invocationId));
  });
});

describe('#2891 R1 races: cleanupPromptFile survives a root swap during retention verification', () => {
  it('swapping the attempt root after it is pinned cannot redirect the unlink onto an external prompt.md', async () => {
    const root = await scratch();
    const invocationId = 'inv-race-cleanup';
    const paths = await prepareDirectAttemptPaths(root, invocationId);
    const prompt = path.join(paths.attempt, 'prompt.md');
    await writeFile(prompt, 'cli prompt');
    const redacted = await writeProtectedFile(path.join(paths.evidenceDir, 'redacted.json'), '{"task":"t"}');
    const disposition = settleAttemptDisposition('completed');

    const victim = await scratch();
    const victimPrompt = path.join(victim, 'prompt.md');
    await writeFile(victimPrompt, 'victim prompt');

    let swapped = false;
    evidenceRaceHooks.afterOpen = async (targetPath: string) => {
      if (targetPath !== paths.attempt) return;
      evidenceRaceHooks.afterOpen = null;
      swapped = true;
      await rename(paths.attempt, `${paths.attempt}-real`);
      await symlink(victim, paths.attempt);
    };

    const result = await cleanupPromptFile({
      attemptRoot: paths.attempt,
      promptPath: prompt,
      termination: 'confirmed',
      disposition,
      redactedArtifactDigest: redacted.digest,
      redactedArtifactPath: 'evidence/redacted.json',
    });

    expect(swapped).toBe(true);
    expect(result).toMatchObject({ removed: true });
    expect(await readFile(victimPrompt, 'utf8')).toBe('victim prompt');
    await expect(readFile(path.join(`${paths.attempt}-real`, 'prompt.md')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('#2891 R1 races: fileDigestTarget survives an ancestor swap mid-walk', () => {
  it('swapping an intermediate directory after it is pinned cannot mint a digest of external bytes', async () => {
    const root = await scratch();
    await mkdir(path.join(root, 'mid'), { recursive: false });
    await writeFile(path.join(root, 'mid', 'leaf.json'), '{"real":true}');
    const victim = await scratch();
    await writeFile(path.join(victim, 'leaf.json'), '{"forged":true}');

    let swapped = false;
    evidenceRaceHooks.afterOpen = async (targetPath: string) => {
      if (!targetPath.endsWith('/mid')) return;
      evidenceRaceHooks.afterOpen = null;
      swapped = true;
      const real = path.join(root, 'mid');
      await rename(real, `${real}-real`);
      await symlink(victim, real);
    };

    const { target, digest } = await fileDigestTarget({ root, path: 'mid/leaf.json' });

    expect(swapped).toBe(true);
    expect(digest).toBe(digestOf('{"real":true}'));
    expect(target).toBe(`file:mid/leaf.json@${digest}`);
  });
});

describe('#2891 R1 races: loadSupervisorEvidence survives an evidence-directory swap', () => {
  it('swapping the evidence directory after it is pinned cannot redirect the read onto forged evidence', async () => {
    const dir = await scratch();
    const record = { invocationId: 'inv-race-evidence', evidenceDigest: digestOf('real supervisor record') };
    await writeProtectedFile(path.join(dir, 'inv-race-evidence.json'), JSON.stringify(record));

    const victim = await scratch();
    const forged = { invocationId: 'inv-race-evidence', evidenceDigest: digestOf('forged supervisor record') };
    await writeFile(path.join(victim, 'inv-race-evidence.json'), JSON.stringify(forged));

    let swapped = false;
    verifierRaceHooks.afterOpen = async (targetPath: string) => {
      if (targetPath !== dir) return;
      verifierRaceHooks.afterOpen = null;
      swapped = true;
      await rename(dir, `${dir}-real`);
      await symlink(victim, dir);
    };

    const loaded = await loadSupervisorEvidence({ evidenceDir: dir, invocationId: 'inv-race-evidence' });

    expect(swapped).toBe(true);
    expect(loaded).toMatchObject(record);
  });
});

describe('#2891 R3: loadSupervisorEvidence detects mutation of already-captured evidence', () => {
  it('a content change after capture fails the recorded-digest check even though shape/permissions still pass', async () => {
    const dir = await scratch();
    const record = { invocationId: 'inv-mutate', evidenceDigest: digestOf('captured at write time') };
    const raw = JSON.stringify(record);
    await writeProtectedFile(path.join(dir, 'inv-mutate.json'), raw);
    const capturedDigest = `sha256:${createHash('sha256').update(raw, 'utf8').digest('hex')}`;

    const first = await loadSupervisorEvidence({
      evidenceDir: dir, invocationId: 'inv-mutate', expectedRecordDigest: capturedDigest,
    });
    expect(first).toMatchObject(record);

    // Mutate the captured file in place (delete + recreate with the SAME
    // shape/permissions but different artifactPath) — shape/permission
    // checks alone cannot see this.
    await rm(path.join(dir, 'inv-mutate.json'));
    const mutated = { ...record, artifactPath: 'elsewhere.json', artifactDigest: digestOf('x') };
    await writeProtectedFile(path.join(dir, 'inv-mutate.json'), JSON.stringify(mutated));

    await expect(loadSupervisorEvidence({
      evidenceDir: dir, invocationId: 'inv-mutate', expectedRecordDigest: capturedDigest,
    })).rejects.toMatchObject({ reason: 'malformed-response' });
  });
});

describe('#2891 R3: the dispatch verifier never falls back to projectDir', () => {
  it('a supervised artifact with no evidenceDir is evidence-conflict, never present', async () => {
    const h = effectHarness();
    try {
      const evidenceDigest = digestOf('supervisor record naming an artifact');
      const evidence = {
        invocationId: 'inv-no-evidence-dir',
        evidenceDigest,
        artifactPath: 'final.json',
        artifactDigest: digestOf('{"status":"completed"}'),
      };
      // The project directory DOES contain a file at the named artifact
      // path with the matching digest: if the verifier ever fell back to
      // projectDir this would wrongly reconcile present.
      await writeFile(path.join(h.dir, 'final.json'), '{"status":"completed"}');
      const verifier = createDispatchVerifierIfSupervised({ projectDir: h.dir, evidence });
      const ledger = openEffectLedger({
        projectDir: h.dir, scope: effectScope, writer: 'dispatch-conductor',
        keyProvider: staticKeyProvider(testKey('dispatch-2891-r3')),
        clock: h.clock.read, sink: h.sink, verifiers: createVerifierRegistry([verifier!]),
      });
      const intent = await recordIntent(ledger, {
        kind: 'x.aiwg.worker-dispatch',
        target: dispatchEffectTarget('inv-no-evidence-dir'),
        context: {
          invocationId: 'inv-no-evidence-dir', evidenceDigest,
          artifactPath: evidence.artifactPath, artifactDigest: evidence.artifactDigest,
        },
        payloadDigest: evidenceDigest,
      });
      const outcome = await reconcileEffect(ledger, intent.effectId, { expected: { digest: evidenceDigest } });
      expect(outcome.result.verification.result).toBe('unknown');
      expect(outcome.result.verification.reason).toBe('evidence-conflict');
      expect(outcome.completed).toBeNull();
    } finally {
      h.cleanup();
    }
  });
});

describe('#2891 R2: redaction validates every exported value, not just field names', () => {
  it('a secret planted into any of taskId/invocationId/profileVersion/identityConfidence/termination/checks[].checkId never survives, even when the receipt bypasses construction-time validation', () => {
    // Shaped to violate every strict id/enum pattern below (contains '/',
    // ' ' and '=', none of which TASK_ID_PATTERN/INVOCATION_PATTERN/
    // CHECK_ID_PATTERN/PROFILE_VERSION_PATTERN allow, and none of which is a
    // member of the closed identityConfidence/termination enums) — a value
    // that merely LOOKS like a well-formed id would pass format validation
    // on syntax alone, which would not exercise the check this test probes.
    const secret = (tag: string) => `secret/${tag} leak=9b2f7e1c`;
    const planted = {
      taskId: secret('task'),
      invocationId: secret('invocation'),
      transport: 'shell' as const,
      profileRef: 'ignored',
      profileVersion: secret('profile-version'),
      descriptorDigest: digestOf('worker command'),
      requested: { model: secret('requested') },
      observed: { model: secret('observed') },
      identityConfidence: secret('identity'),
      worktree: secret('worktree'),
      baseRevision: secret('revision'),
      handle: secret('handle'),
      termination: secret('termination'),
      checks: [{ checkId: secret('check'), exitCode: 0 }],
      acceptance: { status: secret('acceptance') },
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quality: 'reported' as const },
    };
    // Constructed directly (not through buildDirectActivityReceipt, which
    // would reject most of these at construction time): this is the shape a
    // legacy/loaded receipt could carry, and redaction is the actual
    // security boundary that must hold regardless of how the object arose.
    const exported = redactReceiptForExport(planted);
    const text = JSON.stringify(exported);
    const secretValues = [
      planted.taskId, planted.invocationId, planted.profileVersion, planted.identityConfidence,
      planted.termination, planted.worktree, planted.baseRevision, planted.handle,
      planted.requested.model, planted.observed.model, planted.acceptance.status,
      planted.checks[0].checkId,
    ];
    for (const value of secretValues) expect(text).not.toContain(value);
    // Every validated field is either absent or the fixed marker — never
    // the planted secret.
    for (const field of ['taskId', 'invocationId', 'profileVersion', 'identityConfidence', 'termination'] as const) {
      if (field in exported) expect((exported as Record<string, unknown>)[field]).toBe('[redacted:invalid]');
    }
    expect(exported.checks).toEqual([{ checkId: '[redacted:invalid]', exitCode: 0 }]);
    expect(exported).not.toHaveProperty('requested');
    expect(exported).not.toHaveProperty('observed');
    expect(exported).not.toHaveProperty('acceptance');
    expect(exported).not.toHaveProperty('worktree');
    expect(exported).not.toHaveProperty('baseRevision');
    expect(exported).not.toHaveProperty('handle');
    expect(exported).not.toHaveProperty('profileRef');
  });

  it('valid ids/enums pass through unredacted; buildDirectActivityReceipt output still exports cleanly', () => {
    const { receipt } = buildDirectActivityReceipt({
      taskId: 'task-valid-1', invocationId: 'inv-valid-1', transport: 'shell' as const,
      profileVersion: '1.2.3', identityConfidence: 'backend-attested', termination: 'confirmed',
      checks: [{ checkId: 'final-schema', exitCode: 0 }],
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quality: 'reported' as const },
    });
    const exported = redactReceiptForExport(receipt);
    expect(exported).toMatchObject({
      taskId: 'task-valid-1', invocationId: 'inv-valid-1', profileVersion: '1.2.3',
      identityConfidence: 'backend-attested', termination: 'confirmed',
    });
    expect(exported.checks).toEqual([{ checkId: 'final-schema', exitCode: 0 }]);
  });
});
