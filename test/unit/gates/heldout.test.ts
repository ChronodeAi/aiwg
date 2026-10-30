// Public holdout boundary controls use synthetic records, throwaway signing keys and independently retained host pins.
import { generateKeyPairSync } from 'node:crypto';
import { LedgerSigningKey } from '../../../src/effects/keys.js';
import { createGenesisKeyring, rotateKeyring } from '../../../src/effects/keyring.js';
import { signHeldoutAccess } from '../../../src/decision/heldout/access.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkHeldoutSchema, heldoutDigest } from '../../../src/decision/heldout/contract.js';
import type { HeldoutBundle } from '../../../src/decision/heldout/types.js';
import * as publicGates from '../../../src/gates/index.js';
import { evaluateGatesFromHeldoutFrozen, sealGateHoldoutFromFrozen } from '../../../src/gates/index.js';
import { evaluateGates, sealGateHoldout, sealUpstream } from '../../../src/gates/evaluate.js';
import { resolveProjectFloors } from '../../../src/gates/floors.js';
import { makeBinding, passingMetrics, testRegistry, NOW } from '../../conformance/gates-v1/helper.js';

import { syntheticIntegrity } from '../decision/integrity-ceiling-fixtures.js';
import { prepare } from '../../../agentic/code/addons/decision-engine/examples/heldout-collector-offline.mjs';

let baseBundle: HeldoutBundle;
beforeAll(async () => {
  const { corpus, preregistration } = await prepare('holdout-boundary');
  const pin = heldoutDigest('synthetic-host-pin');
  baseBundle = { corpus, preregistration, approval: {
    schemaVersion: 'decision-heldout-approval/v1', approved: true, study: 'D17', runId: 'offline',
    reviewer: 'fixture', approvalReference: 'fixture-only', sourceCommit: 'a'.repeat(40), exactHeadCi: 'fixture',
    stagingHost: 'titan', stagingWorkspace: 'fixture', model: 'jev-1.13.0', servedModel: 'jev-1.13.0',
    region: 'fixture', credentialRef: 'openbao-approle.fixture.typesafe-jev', credentialResolverDigest: pin,
    corpusDigest: heldoutDigest(corpus), preregistrationDigest: pin, executionDigest: pin,
    calibration: { mode: 'uncalibrated-diagnostic' }, providerTermsReference: 'fixture-only',
    priceBound: { inputUsdPerMTok: 0, outputUsdPerMTok: 0, perRequestUsd: 0,
      evidenceReferences: ['fixture-only'], approvalReference: 'fixture-only' },
    budget: { calls: 10, tokens: 10000, usd: 1 }, priorStudySpendUsd: 0, priorPortfolioSpendUsd: 0,
  } };
});

const FIRST_ACCESS = '2026-09-02T01:00:00.000Z';
function fixture() {
  const binding = makeBinding();
  const analysis = { gateBinding: binding, description: 'Synthetic boundary control' };
  const bundle = structuredClone(baseBundle);
  bundle.preregistration.studyAnalysisDigest = heldoutDigest(analysis);
  bundle.approval.preregistrationDigest = heldoutDigest(bundle.preregistration);
  const pin = heldoutDigest('fixture-baseline');
  const frozen = { schemaVersion: 'decision-heldout-frozen/v1', bundle, digest: heldoutDigest(bundle),
    source: 'injected-transport', approval: { study: 'D17', runId: 'offline' }, priorRuns: [],
    baselineDigests: { study: pin, portfolio: pin }, testPhaseAccessAt: FIRST_ACCESS };
  const signingKey = new LedgerSigningKey(generateKeyPairSync('ed25519').privateKey);
  const keyring = createGenesisKeyring({ tenant: 'test', project: 'gates', subsystem: 'delivery' }, signingKey, binding.spec.frozenAt);
  const access = signHeldoutAccess({ schemaVersion: 'decision-d29-access/v2', analysisDigest: heldoutDigest(analysis),
    frozenBundleDigest: frozen.digest, runId: bundle.approval.runId,
    anchoredAt: binding.spec.frozenAt, firstTestAccessAt: FIRST_ACCESS, reference: 'offline-fixture' }, { signingKey, keyring });
  return { binding, analysis, frozen, access, signingKey, keyring, trustedAccessDigest: heldoutDigest(access),
    registry: testRegistry().registry, metrics: passingMetrics(), upstream: sealUpstream(syntheticIntegrity()),
    floors: resolveProjectFloors({}), now: NOW };
}

describe('HeldoutFrozen public evaluator boundary (#3730, #2319 slice)', () => {
  it('valid records seal and evaluate byte-identically to the established evaluator', () => {
    const input = fixture();
    expect(() => checkHeldoutSchema('Frozen', input.frozen)).not.toThrow();
    const sealed = sealGateHoldoutFromFrozen(input);
    expect(sealed.trustedBindingDigest).toBe(heldoutDigest(input.analysis.gateBinding));
    expect(sealed.holdout).toEqual(sealGateHoldout({ frozenDigest: sealed.trustedBindingDigest, firstAccessedAt: FIRST_ACCESS }));
    const report = evaluateGatesFromHeldoutFrozen(input);
    expect(report.decision).toBe('PROMOTE');
    expect(report).toEqual(evaluateGates({ ...input, ...sealed }));
  });

  it('refuses an edited bundle under its original frozen digest', () => {
    const input = fixture();
    input.frozen.bundle.approval.runId = 'edited';
    expect(() => evaluateGatesFromHeldoutFrozen(input)).toThrow('frozen bundle digest');
  });

  it('refuses an invalid frozen digest', () => {
    const input = fixture();
    input.frozen.digest = heldoutDigest('invalid frozen digest');
    expect(() => evaluateGatesFromHeldoutFrozen(input)).toThrow('frozen bundle digest');
  });

  it('refuses an edited analysis containing a different binding', () => {
    const input = fixture();
    input.analysis.gateBinding = makeBinding({ spec: { ceiling: 'HOLD' } });
    expect(() => evaluateGatesFromHeldoutFrozen(input)).toThrow('analysis digest');
  });

  it('refuses a wrong caller binding even with caller-minted replacement pins', () => {
    const input = fixture();
    const binding = makeBinding({ spec: { ceiling: 'HOLD' } });
    // Runtime callers cannot override the pin derived from the verified record.
    expect(() => evaluateGatesFromHeldoutFrozen({ ...input, binding,
      ...{ trustedBindingDigest: heldoutDigest(binding), holdout: sealGateHoldout({
        frozenDigest: heldoutDigest(binding), firstAccessedAt: FIRST_ACCESS }) } })).toThrow('binding digest');
  });

  it('refuses a fabricated first-access time under the retained access digest', () => {
    const input = fixture();
    input.access.firstTestAccessAt = '2026-09-02T02:00:00.000Z';
    expect(() => evaluateGatesFromHeldoutFrozen(input)).toThrow('first-access digest');
  });

  it('refuses an independently pinned access record for a different analysis and binding', () => {
    const input = fixture();
    input.access.analysisDigest = heldoutDigest({ gateBinding: makeBinding({ spec: { ceiling: 'HOLD' } }) });
    input.trustedAccessDigest = heldoutDigest(input.access);
    expect(() => evaluateGatesFromHeldoutFrozen(input)).toThrow('does not belong to the frozen analysis and binding');
  });

  it('refuses an absent independent access pin', () => {
    const input = fixture();
    expect(() => evaluateGatesFromHeldoutFrozen({ ...input, trustedAccessDigest: undefined! })).toThrow('first-access digest');
  });

  it('refuses an invalid first-access timestamp even when independently pinned', () => {
    const input = fixture();
    input.access.firstTestAccessAt = 'invalid';
    input.trustedAccessDigest = heldoutDigest(input.access);
    expect(() => evaluateGatesFromHeldoutFrozen(input)).toThrow('first-access timestamp');
  });

  it('refuses the #3730 forgery: an earlier valid timestamp with a recomputed pin', () => {
    const input = fixture();
    const earlier = '2026-09-02T00:30:00.000Z';
    expect(Date.parse(earlier)).toBeGreaterThan(Date.parse(input.binding.spec.frozenAt));
    expect(Date.parse(earlier)).toBeLessThan(Date.parse(FIRST_ACCESS));
    expect(Date.parse(earlier)).toBeLessThan(Date.parse(input.now));
    input.access.firstTestAccessAt = earlier;
    input.trustedAccessDigest = heldoutDigest(input.access);
    expect(() => evaluateGatesFromHeldoutFrozen(input)).toThrow('first-access signature signature-invalid');
  });

  it.each(['missing', 'bad', 'unknown'] as const)('refuses a %s signature even with a recomputed pin', kind => {
    const input = fixture();
    if (kind === 'missing') delete (input.access as Partial<typeof input.access>).signature;
    if (kind === 'bad') input.access.signature.sig = Buffer.alloc(64).toString('base64');
    if (kind === 'unknown') input.access.signature.keyid = heldoutDigest('unknown-key');
    input.trustedAccessDigest = heldoutDigest(input.access);
    expect(() => evaluateGatesFromHeldoutFrozen(input)).toThrow(kind === 'missing'
      ? 'first-access signature missing' : kind === 'unknown' ? 'first-access signature unknown-keyid' : 'first-access signature signature-invalid');
  });

  it('refuses an unsigned historical v1 record with a recomputed pin', () => {
    const input = fixture();
    const { signature: _signature, frozenBundleDigest: _frozen, runId: _run, ...legacy } = input.access;
    const access = { ...legacy, schemaVersion: 'decision-d29-access/v1' } as unknown as typeof input.access;
    expect(() => evaluateGatesFromHeldoutFrozen({ ...input, access, trustedAccessDigest: heldoutDigest(access) }))
      .toThrow('first-access signature missing');
  });

  it.each(['analysis', 'frozen', 'run'] as const)('refuses a correctly signed %s mismatch', kind => {
    const input = fixture();
    if (kind === 'analysis') input.access.analysisDigest = heldoutDigest('other analysis');
    if (kind === 'frozen') input.access.frozenBundleDigest = heldoutDigest('other bundle');
    if (kind === 'run') input.access.runId = 'other-run';
    const { signature: _signature, ...body } = input.access;
    input.access = signHeldoutAccess(body, input);
    input.trustedAccessDigest = heldoutDigest(input.access);
    expect(() => evaluateGatesFromHeldoutFrozen(input)).toThrow(kind === 'analysis'
      ? 'does not belong to the frozen analysis and binding' : kind === 'frozen' ? 'first-access frozen-bundle digest' : 'first-access run ID');
  });

  it.each(['not-yet-valid', 'expired', 'revoked'] as const)('refuses a signing key that is %s at access time', kind => {
    const input = fixture();
    if (kind === 'not-yet-valid') input.keyring.keys[0].validFrom = '2026-09-02T01:00:01.000Z';
    if (kind === 'expired') input.keyring.keys[0].validUntil = FIRST_ACCESS;
    if (kind === 'revoked') Object.assign(input.keyring.keys[0], { status: 'revoked', revokedAt: FIRST_ACCESS });
    expect(() => evaluateGatesFromHeldoutFrozen(input)).toThrow('first-access signature key-window');
  });

  it('verifies a retired key at access time after a legitimate rotation', () => {
    const input = fixture(), next = new LedgerSigningKey(generateKeyPairSync('ed25519').privateKey);
    input.keyring = rotateKeyring(input.keyring, input.signingKey, next, '2026-09-02T01:30:00.000Z');
    expect(evaluateGatesFromHeldoutFrozen(input).decision).toBe('PROMOTE');
  });

  it('refuses an unrotated attacker key appended to the host keyring', () => {
    const input = fixture(), attacker = new LedgerSigningKey(generateKeyPairSync('ed25519').privateKey);
    const attackerRing = createGenesisKeyring(input.keyring.scope, attacker, input.binding.spec.frozenAt);
    const { signature: _signature, ...body } = input.access;
    input.access = signHeldoutAccess(body, { signingKey: attacker, keyring: attackerRing });
    input.trustedAccessDigest = heldoutDigest(input.access);
    input.keyring.keys.push(attackerRing.keys[0]);
    expect(() => evaluateGatesFromHeldoutFrozen(input)).toThrow('first-access keyring invalid');
  });

  it('refuses an absent or malformed host keyring', () => {
    const input = fixture();
    expect(() => evaluateGatesFromHeldoutFrozen({ ...input, keyring: undefined! })).toThrow('first-access keyring invalid');
    input.keyring.keys[0].keyid = heldoutDigest('altered public key identity');
    expect(() => evaluateGatesFromHeldoutFrozen(input)).toThrow('first-access keyring invalid');
  });
});

it('keeps the unverified sealGateHoldout off the public gates API', () => {
  // Callers outside src/gates must seal through the verified HeldoutFrozen entry point (#3730).
  expect('sealGateHoldout' in publicGates).toBe(false);
  expect(typeof publicGates.sealGateHoldoutFromFrozen).toBe('function');
});
