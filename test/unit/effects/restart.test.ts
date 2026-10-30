// Exercise durable recovery through the ledger's host-facing idempotence protocol.
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { appendFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkpointDigest, createVerifierRegistry, fileDigestVerifier, gitRefCheckpointSink, lookupEffect,
  payloadDigest, reconcileEffect, recordIntent, recordOutcome, verifyLedger, writeCheckpoint,
  type EffectReceipt, type RecordIntentInput } from '../../../src/effects/index.js';
import { observeChildClose, stopAndReap } from '../../helpers/worker-lifecycle.mjs';
import { harness, present, testKeySeedHex, type Harness } from './helpers.js';

let h: Harness;
beforeEach(() => {
  h = harness();
  execFileSync('git', ['init', '-q', h.dir], { timeout: 30_000 });
});
afterEach(() => h.cleanup());
const restarted = () => h.ledger({ writer: 'after-crash',
  sink: gitRefCheckpointSink({ repoDir: h.dir, subsystem: 'delivery' }) });

describe('effect restart and reconciliation', () => {
  it.each(['applied', 'completed'])('recovers after %s but before acknowledgment without replay or loss', async boundary => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/effects-runtime/restart-process.mjs',
      h.dir, testKeySeedHex('a'), boundary], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const closed = observeChildClose(child);
    let errors = '';
    child.stderr!.on('data', chunk => { errors += String(chunk); });
    try {
      const state = await new Promise<{ intent: EffectReceipt; input: RecordIntentInput }>((resolve, reject) => {
        child.once('message', message => resolve(message as never));
        child.once('error', reject);
        child.once('close', code => reject(new Error(`Boundary not reached: ${code}: ${errors}`)));
      });
      const file = join(h.dir, 'applied.txt');
      expect(await readFile(file, 'utf8')).toBe('one synthetic effect\n');
      const before = await lookupEffect(restarted(), state.intent.effectId);
      expect(before.records.map(record => record.phase)).toEqual(boundary === 'applied'
        ? ['intent'] : ['intent', 'reconciled', 'completed']);
      await stopAndReap(child, closed);

      const ledger = restarted();
      const previous = await ledger.sink.latest(ledger.scope);
      expect(previous).toMatchObject({ sequence: 0 });
      expect((await verifyLedger(ledger)).ok).toBe(true);
      // Follow the public host protocol: a deduplicated intent must never be applied again.
      const replay = await recordIntent(ledger, state.input);
      if (!replay.idempotent) await appendFile(file, 'one synthetic effect\n');
      expect(replay).toEqual({ ...state.intent, idempotent: true });
      const options = { verifiers: createVerifierRegistry([fileDigestVerifier({ root: h.dir })]) };
      const recovered = await reconcileEffect(ledger, replay.effectId, options);
      expect(recovered.result).toMatchObject({ exitCode: 0, verification: { result: 'present' } });
      expect(recovered.completed).toMatchObject({ phase: 'completed', idempotent: boundary === 'completed' });
      const again = await reconcileEffect(restarted(), replay.effectId, options);
      expect(again.completed).toMatchObject({ recordHash: recovered.completed!.recordHash, idempotent: true });
      expect(await readFile(file, 'utf8')).toBe('one synthetic effect\n');
      const records = (await lookupEffect(restarted(), replay.effectId)).records;
      expect(records.filter(record => record.phase === 'intent')).toHaveLength(1);
      expect(records.filter(record => record.phase === 'completed')).toHaveLength(1);
      expect(await readdir(ledger.paths().index)).toHaveLength(2);
      const checkpoint = await writeCheckpoint(restarted());
      expect(checkpoint.checkpoint.sequence).toBe(1);
      expect(checkpoint.checkpoint.previousCheckpoint).toBe(checkpointDigest(previous!));
      expect(checkpoint.checkpoint.writers.reduce((sum, writer) => sum + writer.count, 0)).toBe(records.length);
      expect(await verifyLedger(restarted())).toMatchObject({ ok: true, failures: [] });
    } finally { await stopAndReap(child, closed); }
  });

  it('refuses changed payloads and terminal outcomes for the same key after restart', async () => {
    const input = { kind: 'file.digest', target: `file:applied.txt@${payloadDigest('one')}`,
      context: {}, payloadDigest: payloadDigest('one') };
    const intent = await recordIntent(restarted(), input);
    expect(await recordIntent(restarted(), input)).toEqual({ ...intent, idempotent: true });
    await expect(recordIntent(restarted(), { ...input, payloadDigest: payloadDigest('two') }))
      .rejects.toMatchObject({ code: 'conflict', exitCode: 5 });
    const failed = { phase: 'failed' as const, payloadDigest: input.payloadDigest, failure: { reason: 'target-rejected' as const } };
    const outcome = await recordOutcome(restarted(), intent.effectId, failed);
    expect(await recordOutcome(restarted(), intent.effectId, failed)).toEqual({ ...outcome, idempotent: true });
    await expect(recordOutcome(restarted(), intent.effectId, { phase: 'completed', payloadDigest: input.payloadDigest,
      verification: present('file.digest') })).rejects.toMatchObject({ code: 'conflict', reason: 'outcome-conflict', exitCode: 5 });
    await expect(recordOutcome(restarted(), intent.effectId, { ...failed, payloadDigest: payloadDigest('two') }))
      .rejects.toMatchObject({ code: 'conflict', exitCode: 5 });
    expect((await lookupEffect(restarted(), intent.effectId)).records.map(record => record.phase)).toEqual(['intent', 'failed']);
    expect((await verifyLedger(restarted())).ok).toBe(true);
  });
});
