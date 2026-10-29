// Replays signed approvals through the real Pi edit gate using only fixed-time disk state.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeAiwgPiEdit, evaluateAiwgPiAction } from '../../../agentic/code/providers/pi/aiwg-bridge.js';
import { emptyConfig } from '../../../src/config/aiwg-config.js';
import { checkHitlAuthorization } from '../../../src/policy/hitl-check.js';
import { recordHitlAuthorization } from '../../../src/policy/hitl-receipt.js';
import { loadHitlLayers } from '../../../src/policy/hitl-config.js';
import { hitlDigest } from '../../../src/policy/hitl.js';
import { assertDigestOnly } from '../../../src/effects/redaction.js';
import { lookupEffect, recordIntent, reconcileEffect } from '../../../src/effects/ledger.js';
import { payloadDigest } from '../../../src/effects/identity.js';
import { createVerifierRegistry, fileDigestVerifier, verifyLedger } from '../../../src/effects/index.js';
import { policy } from '../../fixtures/policy/hitl.js';
import { harness, scope, testKeySeedHex, type Harness } from '../effects/helpers.js';

const now = '2026-10-27T01:00:00Z';
const input = { path: 'src/index.ts', oldText: 'before', newText: 'after\n' };
let h: Harness;
let config: ReturnType<typeof emptyConfig>;
const ledger = () => h.ledger({ scope: { ...scope, subsystem: 'custom' }, writer: 'restarted' });
const save = () => writeFile(join(h.dir, '.aiwg/aiwg.config'), JSON.stringify(config));
const edit = () => describeAiwgPiEdit(h.dir, 'edit', input);

beforeEach(async () => {
  h = harness(); h.clock.now = Date.parse(now);
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('AIWG_EFFECT_LEDGER_TEST_KEY', testKeySeedHex('a'));
  await mkdir(join(h.dir, '.aiwg')); await mkdir(join(h.dir, 'src'));
  config = emptyConfig();
  const p = policy(); p.profiles.testnet.repos = [basename(h.dir)]; p.profiles.testnet.environments = ['local'];
  config.effects = { project: scope.project };
  config.authorization = { version: '1', default_effect: 'deny', resources: {}, permissions: {}, roles: {}, assignments: [], hitl: p };
  await save();
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); h.cleanup(); });

async function approve() {
  const approved = await checkHitlAuthorization(h.dir, edit(), { now });
  expect(approved.decision).toBe('auto-authorized');
  expect((await lookupEffect(ledger(), approved.receipt!.effectId)).status).toBe('completed');
  return approved;
}

describe('exact repo.edit approval consumption', () => {
  it('allows the exact actor and input through the existing consumer and persists digests only', async () => {
    const approved = await approve();
    const bytes = await readFile(approved.receipt!.file, 'utf8');
    const receipt = JSON.parse(bytes);
    expect(receipt.action).toMatchObject({ actorDigest: hitlDigest(edit().actor), inputDigest: edit().inputDigest,
      descriptorDigest: hitlDigest(edit()) });
    expect(() => assertDigestOnly(receipt)).not.toThrow();
    for (const raw of [edit().actor!, input.path, input.newText, h.dir]) expect(bytes).not.toContain(raw);
    const confirm = vi.fn(async () => false);
    const gate = await evaluateAiwgPiAction(h.dir, edit(), false, confirm, async () => approved,
      (dir, action, receipt) => checkHitlAuthorization(dir, action, { now, receipt }));
    expect(gate).toBeUndefined(); expect(confirm).not.toHaveBeenCalled();
    if (!gate) await writeFile(join(h.dir, input.path), input.newText);
    expect(await readFile(join(h.dir, input.path), 'utf8')).toBe(input.newText);
    expect((await verifyLedger(ledger())).ok).toBe(true);
  });

  it.each([
    ['actor', 'approval-actor-mismatch'], ['input', 'approval-input-mismatch'],
    ['expired', 'approval-expired'], ['revoked-restarted', 'policy-revoked'],
  ])('refuses %s with a specific reason before writing', async (kind, reason) => {
    const approved = await approve();
    const approvedBytes = await readFile(approved.receipt!.file, 'utf8');
    let proposed = edit(); let consumeNow = now;
    if (kind === 'actor') proposed = { ...proposed, actor: 'pi:other-user' };
    if (kind === 'input') proposed = describeAiwgPiEdit(h.dir, 'edit', { ...input, newText: 'different\n' });
    if (kind === 'expired') consumeNow = approved.expiresAt!;
    if (kind === 'revoked-restarted') {
      config.authorization!.hitl!.enabled = false; await save();
      const { layers } = await loadHitlLayers(h.dir);
      const revoked = await recordHitlAuthorization(ledger(), edit(), { now, layers });
      expect(JSON.parse(await readFile(revoked.file, 'utf8')).reason).toBe('policy-revoked');
      expect((await lookupEffect(ledger(), revoked.intent.effectId)).status).toBe('completed');
      vi.resetModules();
    }
    const restarted = await import('../../../src/policy/hitl-check.js');
    const confirm = vi.fn(async () => true);
    const gate = await evaluateAiwgPiAction(h.dir, proposed, true, confirm, async () => approved,
      (dir, action, receipt) => restarted.checkHitlAuthorization(dir, action, { now: consumeNow, receipt }));
    expect(gate).toEqual({ block: true, reason }); expect(confirm).not.toHaveBeenCalled();
    if (!gate) await writeFile(join(h.dir, input.path), input.newText);
    await expect(readFile(join(h.dir, input.path))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(approved.receipt!.file, 'utf8')).toBe(approvedBytes);
    expect((await verifyLedger(ledger())).ok).toBe(true);
  });

  it.each(['legacy', 'tampered', 'unrecorded', 'different-resource'])('refuses %s receipt replay', async kind => {
    const approved = await approve();
    const reference = { ...approved.receipt! };
    let proposed = edit();
    if (kind === 'tampered') await writeFile(reference.file, '{}\n');
    if (kind === 'unrecorded') reference.effectId = `sha256:${'f'.repeat(64)}`;
    if (kind === 'different-resource') proposed = { ...proposed, resources: ['src/other.ts'] };
    if (kind === 'legacy') {
      const receipt = JSON.parse(await readFile(reference.file, 'utf8'));
      delete receipt.action.actorDigest; delete receipt.action.inputDigest; delete receipt.expiresAt;
      const bytes = JSON.stringify(receipt) + '\n'; const digest = payloadDigest(bytes);
      reference.file = join(h.dir, '.aiwg/effects/authorization', `${digest.slice(7)}.json`);
      await writeFile(reference.file, bytes);
      const intent = await recordIntent(ledger(), { kind: 'file.digest', target: `file:${reference.file}@${digest}`,
        payloadDigest: digest, context: { receiptDigest: digest } });
      reference.effectId = intent.effectId;
      await reconcileEffect(ledger(), intent.effectId, { verifiers: createVerifierRegistry([fileDigestVerifier({ root: join(h.dir, '.aiwg') })]) });
    }
    const result = await checkHitlAuthorization(h.dir, proposed, { now, receipt: reference });
    expect(result).toMatchObject({ decision: 'escalate', reason: kind === 'legacy' ? 'approval-missing-bindings'
      : kind === 'different-resource' ? 'approval-descriptor-mismatch' : 'approval-unverified' });
  });

  it('rejects absent or malformed repo.edit bindings and binds all native input fields', async () => {
    for (const change of [{ actor: undefined }, { inputDigest: undefined }, { inputDigest: 'not-a-digest' }, { actor: '' }]) {
      expect(await checkHitlAuthorization(h.dir, { ...edit(), ...change }, { now })).toMatchObject({ reason: 'invalid-action-descriptor' });
    }
    expect(describeAiwgPiEdit(h.dir, 'write', input).inputDigest).not.toBe(edit().inputDigest);
    expect(describeAiwgPiEdit(h.dir, 'edit', { ...input, oldText: 'changed' }).inputDigest).not.toBe(edit().inputDigest);
  });
});
