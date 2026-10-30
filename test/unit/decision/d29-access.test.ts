// Synthetic first-access creation and governed-schema controls; never load host key material.
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LedgerSigningKey } from '../../../src/effects/keys.js';
import { createGenesisKeyring, rotateKeyring } from '../../../src/effects/keyring.js';
import { createHeldoutAccess, signHeldoutAccess, validateHeldoutAccess, verifyHeldoutAccess,
  type HeldoutAccessBody } from '../../../src/decision/heldout/access.js';
import { heldoutDigest } from '../../../src/decision/heldout/contract.js';
import type { HeldoutBundle } from '../../../src/decision/heldout/types.js';
import { validateStudyArtifact } from '../../../tools/decision/studies/d29.mjs';

const host = vi.hoisted(() => ({ session: vi.fn(), open: vi.fn(), read: vi.fn(), signing: vi.fn() }));
vi.mock('../../../src/effects/host.js', () => ({ effectSession: host.session, openLedger: host.open }));
vi.mock('../../../src/effects/ledger.js', () => ({ readLedgerKeyring: host.read }));
const scope = { tenant: 'test', project: 'd29-access', subsystem: 'delivery' } as const;
const freshKey = () => new LedgerSigningKey(generateKeyPairSync('ed25519').privateKey);
const readFixture = (name: string) => JSON.parse(readFileSync(new URL(`../../fixtures/decision/d29-signed-access/${name}.json`, import.meta.url), 'utf8'));
function fixture() {
  const signingKey = freshKey();
  const keyring = createGenesisKeyring(scope, signingKey, '2026-01-01T00:00:00.000Z');
  const bundle = { preregistration: { studyAnalysisDigest: heldoutDigest('analysis'), frozenAt: '2026-10-01T00:00:00.000Z' },
    approval: { runId: 'synthetic-access' } } as HeldoutBundle;
  return { signingKey, keyring, bundle };
}
beforeEach(() => { vi.resetAllMocks(); });

describe('D29 signed first-access creation (#3747)', () => {
  it('signs every record field using the existing host-selected ledger', async () => {
    const trust = fixture();
    host.session.mockResolvedValue({ scope }); host.open.mockReturnValue({ signingKey: host.signing });
    host.read.mockResolvedValue(trust.keyring); host.signing.mockResolvedValue(trust.signingKey);
    const at = '2026-10-02T00:00:00.000Z';
    const access = await createHeldoutAccess(trust.bundle, at, '/synthetic/project');
    expect(host.session).toHaveBeenCalledExactlyOnceWith('/synthetic/project');
    expect(host.open).toHaveBeenCalledExactlyOnceWith({ scope });
    expect(access).toMatchObject({ schemaVersion: 'decision-d29-access/v2', firstTestAccessAt: at,
      analysisDigest: trust.bundle.preregistration.studyAnalysisDigest, frozenBundleDigest: heldoutDigest(trust.bundle),
      runId: trust.bundle.approval.runId, signature: { keyid: trust.signingKey.keyid } });
    expect(() => verifyHeldoutAccess(access, trust.keyring)).not.toThrow();
    const edits = { anchoredAt: '2026-10-01T01:00:00.000Z', reference: 'forged', runId: 'other-run',
      firstTestAccessAt: '2026-10-01T12:00:00.000Z', analysisDigest: heldoutDigest('other-analysis'),
      frozenBundleDigest: heldoutDigest('other-frozen-bundle') };
    for (const [field, value] of Object.entries(edits)) {
      const forged = { ...access, [field]: value };
      expect(() => verifyHeldoutAccess(forged, trust.keyring)).toThrow('signature-invalid');
    }
  });

  it('fails closed without an initialized host keyring, before loading a signing key', async () => {
    const { bundle } = fixture();
    host.open.mockReturnValue({ signingKey: host.signing }); host.read.mockResolvedValue(null);
    await expect(createHeldoutAccess(bundle, '2026-10-02T00:00:00.000Z', '/synthetic/project'))
      .rejects.toThrow('first-access effect-ledger keyring unavailable');
    expect(host.signing).not.toHaveBeenCalled();
  });

  it('uses injected throwaway trust without consulting host configuration', async () => {
    const trust = fixture();
    const access = await createHeldoutAccess(trust.bundle, '2026-10-02T00:00:00.000Z', '/synthetic/project', trust);
    expect(() => verifyHeldoutAccess(access, trust.keyring)).not.toThrow();
    expect(host.session).not.toHaveBeenCalled(); expect(host.read).not.toHaveBeenCalled();
  });

  it('refuses a retired signing key even for a timestamp inside its old window', () => {
    const trust = fixture(), next = freshKey();
    const keyring = rotateKeyring(trust.keyring, trust.signingKey, next, '2026-10-03T00:00:00.000Z');
    const { signature: _signature, ...body } = readFixture('valid');
    expect(() => signHeldoutAccess(body as HeldoutAccessBody, { ...trust, keyring })).toThrow('signing key is not active');
  });

  it('refuses creating a record outside the active key validity window', () => {
    const trust = fixture();
    trust.keyring.keys[0].validFrom = '2026-10-03T00:00:00.000Z';
    const { signature: _signature, ...body } = readFixture('valid');
    expect(() => signHeldoutAccess(body as HeldoutAccessBody, trust)).toThrow('signature key-window');
  });

  it('validates the recorded v2 schema fixture and signs it with a fresh test key', () => {
    const valid = readFixture('valid'), { signature: _signature, ...body } = valid;
    const trust = fixture(), access = signHeldoutAccess(body as HeldoutAccessBody, trust);
    expect(() => validateHeldoutAccess(valid)).not.toThrow();
    expect(() => validateStudyArtifact(access)).not.toThrow();
    expect(() => verifyHeldoutAccess(access, trust.keyring)).not.toThrow();
    // The committed fixture is shape-only: its signature must never verify.
    expect(() => verifyHeldoutAccess(valid, trust.keyring)).toThrow();
  });

  it.each(['unsigned', 'missing-bundle', 'bad-time', 'unknown-field'])('refuses the governed %s fixture', name => {
    expect(() => validateHeldoutAccess(readFixture(name))).toThrow('first-access record schema invalid');
  });
});
