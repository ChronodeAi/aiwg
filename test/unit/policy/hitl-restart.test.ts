// Keep persisted deny, revoke and expiry authoritative when old receipts are replayed.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyConfig } from '../../../src/config/aiwg-config.js';
import { recordHitlAuthorization } from '../../../src/policy/hitl-receipt.js';
import { loadHitlLayers } from '../../../src/policy/hitl-config.js';
import { lookupEffect, reconcileEffect } from '../../../src/effects/ledger.js';
import { createVerifierRegistry, fileDigestVerifier, verifyLedger } from '../../../src/effects/index.js';
import { action, policy } from '../../fixtures/policy/hitl.js';
import { harness, testKeySeedHex, type Harness } from '../effects/helpers.js';

let h: Harness;
beforeEach(async () => {
  h = harness();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-27T01:00:00Z'));
  h.clock.now = Date.now();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('AIWG_EFFECT_LEDGER_TEST_KEY', testKeySeedHex('a'));
  await mkdir(join(h.dir, '.aiwg'));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); h.cleanup(); });

async function persist(p: ReturnType<typeof policy>) {
  const config = emptyConfig();
  config.authorization = { version: '1', default_effect: 'deny', resources: {}, permissions: {}, roles: {}, assignments: [], hitl: p };
  await writeFile(join(h.dir, '.aiwg', 'aiwg.config'), JSON.stringify(config));
}
async function recordCurrent() {
  const { layers } = await loadHitlLayers(h.dir);
  h.clock.now = Date.now();
  return recordHitlAuthorization(h.ledger(), action(), { layers, now: new Date().toISOString() });
}

describe('HITL authorization restart persistence', () => {
  it.each([
    ['deny', 'deny', 'explicit-deny'],
    ['revoke', 'escalate', 'policy-revoked'],
    ['policy-expiry', 'escalate', 'policy-expired'],
    ['profile-expiry', 'escalate', 'outside-profile-or-expired'],
  ])('keeps %s effective after restart and replay of an approved receipt', async (kind, decision, reason) => {
    const p = policy();
    // Separate expiry from stale review, and exercise the exact expiration boundary.
    p.maxAgeSeconds = 172800;
    if (kind === 'policy-expiry') p.profiles.testnet.expiresAt = '2026-10-29T00:00:00Z';
    if (kind === 'profile-expiry') p.profiles.testnet.expiresAt = '2026-10-27T02:00:00Z';
    await persist(p);
    const approved = await recordCurrent();
    expect(approved.resolution.decision).toBe('auto-authorized');
    const approvedBytes = await readFile(approved.file, 'utf8');

    if (kind === 'deny') p.deny = [{ categories: ['repo.edit'] }];
    if (kind === 'revoke') p.enabled = false;
    await persist(p);
    if (kind === 'policy-expiry') vi.setSystemTime(new Date(p.expiresAt));
    if (kind === 'profile-expiry') vi.setSystemTime(new Date(p.profiles.testnet.expiresAt));
    const rejected = await recordCurrent();
    expect(rejected.resolution).toMatchObject({ decision, reason });
    expect(JSON.parse(await readFile(rejected.file, 'utf8'))).toMatchObject({ decision, reason });
    expect(rejected.intent.effectId).not.toBe(approved.intent.effectId);

    // The old artifact still exists and verifies: existence is historical proof, not a fresh grant.
    const replay = await reconcileEffect(h.ledger({ writer: 'restarted' }), approved.intent.effectId, {
      verifiers: createVerifierRegistry([fileDigestVerifier({ root: join(h.dir, '.aiwg') })]),
    });
    expect(replay.result.verification.result).toBe('present');
    expect(await readFile(approved.file, 'utf8')).toBe(approvedBytes);

    vi.resetModules();
    const { checkHitlAuthorization } = await import('../../../src/policy/hitl-check.js');
    for (let attempt = 0; attempt < 2; attempt++) {
      const checked = await checkHitlAuthorization(h.dir, action());
      expect(checked).toMatchObject({ decision, reason });
      expect(checked.receipt).toBeUndefined();
      const persisted = await recordCurrent();
      expect(persisted.intent).toMatchObject({ effectId: rejected.intent.effectId, idempotent: true });
      expect(persisted.resolution).toMatchObject({ decision, reason });
    }
    const historical = await lookupEffect(h.ledger(), rejected.intent.effectId);
    expect(historical.records.filter(record => record.phase === 'intent')).toHaveLength(1);
    expect(historical.records.filter(record => record.phase === 'completed')).toHaveLength(1);
    expect((await verifyLedger(h.ledger())).ok).toBe(true);
  });
});
