// Exercises signed HITL decision receipts against real local effect-ledger primitives.
import { describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { recordHitlAuthorization } from '../../../src/policy/hitl-receipt.js';
import { lookupEffect, reconcileEffect } from '../../../src/effects/ledger.js';
import { verifyLedger } from '../../../src/effects/verify.js';
import { readAllSegments } from '../../../src/effects/reader.js';
import { join } from 'node:path';
import { emptyConfig } from '../../../src/config/aiwg-config.js';
import { createEffectHandler } from '../../../src/cli/handlers/effect.js';
import { fileDigestVerifier } from '../../../src/effects/verifiers/file.js';
import { createVerifierRegistry } from '../../../src/effects/verifiers/registry.js';
import { resolveProjectAiwgDir } from '../../../src/config/project-artifacts.js';
import { action, context } from '../../fixtures/policy/hitl.js';
import { harness, testKeySeedHex } from '../effects/helpers.js';
import type { HandlerContext } from '../../../src/cli/handlers/types.js';

describe('HITL effect receipts', () => {
  it('records policy, action, scope, decision and provenance and reconciles with aiwg effect', async () => {
    const h = harness();
    try {
      const c = context(); h.clock.now = Date.parse(c.now); const ledger = h.ledger();
      const result = await recordHitlAuthorization(ledger, action(), c);
      expect(result.reconciled.result.verification.result).toBe('present');
      const data = JSON.parse(await readFile(result.file, 'utf8'));
      expect(data).toMatchObject({ policyVersion: result.resolution.policyVersion, decision: 'auto-authorized',
        provenance: 'project-policy', action: { category: 'repo.edit', descriptorDigest: expect.stringMatching(/^sha256:/) },
        scope: { environmentClass: 'testnet', repoDigest: expect.stringMatching(/^sha256:/), resourceDigests: [expect.stringMatching(/^sha256:/)] } });
      const lookup = await lookupEffect(ledger, result.intent.effectId);
      expect(lookup.status).toBe('completed');
      const segments = await readAllSegments(ledger.paths());
      expect(segments[0].lines[0].decoded!.statement.predicate.context).toMatchObject({ policyVersion: data.policyVersion, decision: data.decision });
      expect((await verifyLedger(ledger)).exitCode).toBe(0);
      const again = await recordHitlAuthorization(ledger, action(), c);
      expect(again.intent.effectId).toBe(result.intent.effectId);
      await mkdir(join(h.dir, '.aiwg'), { recursive: true });
      await writeFile(join(h.dir, '.aiwg', 'aiwg.config'), JSON.stringify({ ...emptyConfig(), effects: { project: 'example/repo' } }));
      const handler = createEffectHandler({ env: { NODE_ENV: 'test', AIWG_EFFECT_LEDGER_TEST_KEY: testKeySeedHex('a') }, clock: h.clock.read });
      const response = await handler.execute({ args: ['reconcile', result.intent.effectId, '--subsystem', 'delivery'], cwd: h.dir } as HandlerContext);
      expect(response.exitCode).toBe(0);
    } finally { h.cleanup(); }
  });
  it('digests credentials and injection text even in a rejected descriptor', async () => {
    const h = harness();
    try {
      const credential = 'Bearer synthetic-private-canary-123456';
      const c = context(); c.layers[0].source = credential;
      const result = await recordHitlAuthorization(h.ledger(), { ...action(), issueBody: credential }, c);
      expect(result.resolution.decision).toBe('escalate');
      expect(await readFile(result.file, 'utf8')).not.toContain(credential);
      const records = await lookupEffect(h.ledger(), result.intent.effectId);
      expect(JSON.stringify(records)).not.toContain(credential);
      await writeFile(result.file, '{}\n');
      const altered = await reconcileEffect(h.ledger(), result.intent.effectId, {
        verifiers: createVerifierRegistry([fileDigestVerifier({ root: resolveProjectAiwgDir(h.dir) })]),
      });
      expect(altered.result.verification.result).not.toBe('present');
    } finally { h.cleanup(); }
  });
});
