// Resume file effects from durable observations, including the write/ack crash window.
import { appendFile, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionConductor, type MissionPlan, type RunWorker } from '../../../src/serve/mission-conductor.js';
import type { ExecutorRegistration } from '../../../src/serve/executor-registry.js';
import { effectId, lookupEffect, payloadDigest, recordOutcome, verifyLedger } from '../../../src/effects/index.js';
import { harness, type Harness } from '../effects/helpers.js';

let h: Harness;
const bytes = 'one synthetic effect\n';
const oldBytes = 'unchanged original\n';
const executor: ExecutorRegistration = {
  executorId: 'local-codex', name: 'offline executor', version: '1.0.0',
  specVersion: 'executor.aiwg.io/v1', transportEndpoints: {}, capabilities: ['runtime:codex'],
  token: 'synthetic', connected: true, registeredAt: '2026-09-24T10:00:00.000Z', currentMissions: new Set(),
};
const plan = (previousDigest?: string): MissionPlan => ({
  missionId: 'recover-file', goal: 'write one file', completionCriterion: 'intended file exists once',
  cycles: [{ id: 'write-file', runtime: 'codex', prompt: 'write the synthetic file',
    fileEffect: { target: `file:applied.txt@${payloadDigest(bytes)}`, payloadDigest: payloadDigest(bytes),
      ...(previousDigest ? { previousDigest } : {}) } }],
});
function id(p: MissionPlan) {
  return effectId({ scope: h.ledger().scope, kind: 'file.digest', target: p.cycles[0].fileEffect!.target,
    context: { missionId: p.missionId, cycleId: p.cycles[0].id,
      ...(p.cycles[0].fileEffect!.previousDigest ? { previousDigest: p.cycles[0].fileEffect!.previousDigest! } : {}) } });
}
function conduct(p: MissionPlan, runWorker: RunWorker, resume?: Awaited<ReturnType<MissionConductor['conduct']>>) {
  return new MissionConductor({ effectLedger: h.ledger({ writer: resume ? 'restarted' : 'original' }), runWorker })
    .conduct(p, [executor], resume);
}
const apply: RunWorker = async () => {
  await appendFile(join(h.dir, 'writes.log'), 'write\n');
  await writeFile(join(h.dir, 'applied.txt'), bytes);
  return { output: 'written', cost: 7 };
};
beforeEach(() => { h = harness(); });
afterEach(() => h.cleanup());

describe('MissionConductor file-effect reconciliation', () => {
  it.each(['intent', 'completed'])('skips a written file after a crash with only %s acknowledged', async boundary => {
    const p = plan();
    const first = await conduct(p, async (...args) => {
      await apply(...args);
      if (boundary === 'completed') {
        const { reconcileEffect, createVerifierRegistry, fileDigestVerifier } = await import('../../../src/effects/index.js');
        await reconcileEffect(h.ledger(), id(p), {
          verifiers: createVerifierRegistry([fileDigestVerifier({ root: h.dir })]),
        });
      }
      throw new Error('crash before worker acknowledgement');
    });
    expect(first.checkpoint.failed).toEqual(['write-file']);
    expect(await readFile(join(h.dir, 'applied.txt'), 'utf8')).toBe(bytes);
    const before = await lookupEffect(h.ledger(), id(p));
    expect(before.records.filter(r => r.phase === 'completed')).toHaveLength(boundary === 'completed' ? 1 : 0);
    h.clock.advance(1000);
    const replay = vi.fn(apply);
    const resumed = await conduct(p, replay, first);
    expect(replay).not.toHaveBeenCalled();
    expect(resumed.checkpoint).toEqual({ completed: ['write-file'], failed: [], pending: [] });
    expect(resumed.cycles[0].reason).toContain('worker replay skipped');
    expect(resumed.totalCost).toBe(0);
    expect(await readFile(join(h.dir, 'writes.log'), 'utf8')).toBe('write\n');
    const records = (await lookupEffect(h.ledger(), id(p))).records;
    expect(records.filter(r => r.phase === 'intent')).toHaveLength(1);
    expect(records.filter(r => r.phase === 'completed')).toHaveLength(1);
    if (boundary === 'intent') expect(records.at(-1)!.recordedAt).toBe(new Date(h.clock.now).toISOString());
    expect((await verifyLedger(h.ledger())).ok).toBe(true);
  });

  it.each(['absent', 'unchanged'])('applies once after a crash before writing an %s file', async state => {
    const p = plan(state === 'unchanged' ? payloadDigest(oldBytes) : undefined);
    if (state === 'unchanged') await writeFile(join(h.dir, 'applied.txt'), oldBytes);
    const first = await conduct(p, () => { throw new Error('crash before write'); });
    expect((await lookupEffect(h.ledger(), id(p))).records.map(r => r.phase)).toEqual(['intent', 'reconciled']);
    h.clock.advance(1000);
    const replay = vi.fn(apply);
    const resumed = await conduct(p, replay, first);
    expect(replay).toHaveBeenCalledTimes(1);
    expect(resumed.checkpoint.completed).toEqual(['write-file']);
    expect(resumed.totalCost).toBe(7);
    expect(await readFile(join(h.dir, 'applied.txt'), 'utf8')).toBe(bytes);
    expect(await readFile(join(h.dir, 'writes.log'), 'utf8')).toBe('write\n');
    const again = await conduct(p, replay, resumed);
    expect(replay).toHaveBeenCalledTimes(1);
    expect(again.checkpoint.completed).toEqual(['write-file']);
    expect((await lookupEffect(h.ledger(), id(p))).records.filter(r => r.phase === 'completed')).toHaveLength(1);
  });

  it.each(['foreign', 'unreadable'])('blocks replay when the target becomes %s after a crash', async state => {
    const p = plan();
    const first = await conduct(p, () => { throw new Error('crash before write'); });
    if (state === 'foreign') await writeFile(join(h.dir, 'applied.txt'), 'foreign modification');
    else await symlink(join(h.dir, '..', 'outside-root'), join(h.dir, 'applied.txt'));
    const replay = vi.fn(apply);
    const resumed = await conduct(p, replay, first);
    expect(replay).not.toHaveBeenCalled();
    expect(resumed.checkpoint).toEqual({ completed: [], pending: [], failed: ['write-file'] });
    const reason = state === 'foreign' ? 'evidence-conflict' : 'container-unreadable';
    expect(resumed.cycles[0].reason).toContain(`replay blocked: ${reason}`);
    expect((await lookupEffect(h.ledger(), id(p))).records.at(-1)!.verification).toMatchObject({ result: 'unknown', reason });
    if (state === 'foreign') expect(await readFile(join(h.dir, 'applied.txt'), 'utf8')).toBe('foreign modification');
  });

  it('requires a host ledger and never dispatches an untracked file effect', async () => {
    const runWorker = vi.fn(apply);
    const result = await new MissionConductor({ runWorker }).conduct(plan(), [executor]);
    expect(result.cycles[0].reason).toContain('requires a host-configured effect ledger');
    expect(runWorker).not.toHaveBeenCalled();
  });

  it('leaves a worker with no verified file pending recovery', async () => {
    const p = plan();
    const result = await conduct(p, () => ({ output: 'claimed success' }));
    expect(result.cycles[0].reason).toContain('completion unverified: complete-query-no-match');
    expect(result.checkpoint.failed).toEqual(['write-file']);
    expect((await lookupEffect(h.ledger(), id(p))).records.some(r => r.phase === 'completed')).toBe(false);
  });

  it('blocks an effect with a recorded failed terminal outcome', async () => {
    const p = plan();
    const first = await conduct(p, () => { throw new Error('before write'); });
    await recordOutcome(h.ledger(), id(p), { phase: 'failed', payloadDigest: payloadDigest(bytes), failure: { reason: 'target-rejected' } });
    const replay = vi.fn(apply);
    const resumed = await conduct(p, replay, first);
    expect(replay).not.toHaveBeenCalled();
    expect(resumed.cycles[0].reason).toContain('replay blocked: terminal outcome or tombstone');
  });
});
