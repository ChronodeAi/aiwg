// Sign and verify D29 first-access records with the existing effect-ledger trust.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { activeKey, assertKeyring, checkSignature } from '../../effects/keyring.js';
import type { LedgerSigningKey } from '../../effects/keys.js';
import type { EffectKeyring } from '../../effects/types.js';
import { canonicalJson } from '../../security/artifact-trust.js';
import { heldoutDigest } from './contract.js';
import type { Digest, HeldoutBundle } from './types.js';

export const HELDOUT_ACCESS_PAYLOAD_TYPE = 'application/vnd.aiwg.decision-d29-access+json';
export interface HeldoutAccessBody {
  schemaVersion: 'decision-d29-access/v2';
  runId: string;
  analysisDigest: Digest;
  frozenBundleDigest: Digest;
  anchoredAt: string;
  firstTestAccessAt: string;
  reference: string;
}
export interface HeldoutAccessRecord extends HeldoutAccessBody {
  signature: { keyid: string; sig: string };
}
export interface HeldoutAccessSigning { keyring: EffectKeyring; signingKey: LedgerSigningKey }

let validator: ValidateFunction | undefined;
export function validateHeldoutAccess(value: unknown): asserts value is HeldoutAccessRecord {
  if (!validator) {
    const here = dirname(fileURLToPath(import.meta.url));
    const name = 'D29Study.v10.schema.json';
    const root = [resolve(here, '../../../schemas/decision'), resolve(here, '../../../../schemas/decision')]
      .find(path => existsSync(resolve(path, name)));
    if (!root) throw new Error('first-access schema unavailable');
    const schema = JSON.parse(readFileSync(resolve(root, name), 'utf8'));
    const ajv = new Ajv2020({ strict: true }); addFormats(ajv);
    validator = ajv.compile(schema);
  }
  if (!validator(value)) throw new Error('first-access record schema invalid');
}

const payload = (body: HeldoutAccessBody) => Buffer.from(canonicalJson(body), 'utf8');

/** The keyring must come from protected host state, never from the access record. */
export function verifyHeldoutAccess(access: HeldoutAccessRecord, keyring: EffectKeyring): void {
  if (!access?.signature) throw new Error('first-access signature missing');
  if (typeof access.firstTestAccessAt !== 'string' || !Number.isFinite(Date.parse(access.firstTestAccessAt))) {
    throw new Error('first-access timestamp is not a valid date-time');
  }
  validateHeldoutAccess(access);
  try { assertKeyring(keyring); } catch { throw new Error('first-access keyring invalid or unavailable'); }
  const { signature, ...body } = access;
  const result = checkSignature(keyring, signature.keyid, signature.sig, HELDOUT_ACCESS_PAYLOAD_TYPE,
    payload(body), access.firstTestAccessAt);
  if (result !== 'ok') throw new Error(`first-access signature ${result}`);
}

/** Called at first access, before any test dispatch; never re-sign records during scoring. */
export function signHeldoutAccess(body: HeldoutAccessBody, trust: HeldoutAccessSigning): HeldoutAccessRecord {
  assertKeyring(trust.keyring);
  if (activeKey(trust.keyring).keyid !== trust.signingKey.keyid) throw new Error('first-access signing key is not active');
  const record = { ...body, signature: { keyid: trust.signingKey.keyid,
    sig: trust.signingKey.signPae(HELDOUT_ACCESS_PAYLOAD_TYPE, payload(body)) } };
  verifyHeldoutAccess(record, trust.keyring);
  return record;
}

/** Uses the same configured delivery ledger as worker qualification; does not provision keys. */
export async function createHeldoutAccess(bundle: HeldoutBundle, firstTestAccessAt: string, projectDir: string,
  injected?: HeldoutAccessSigning, anchoredAt = bundle.preregistration.frozenAt): Promise<HeldoutAccessRecord> {
  let trust = injected;
  if (!trust) {
    const { effectSession, openLedger } = await import('../../effects/host.js');
    const { readLedgerKeyring } = await import('../../effects/ledger.js');
    const ledger = openLedger(await effectSession(projectDir));
    const keyring = await readLedgerKeyring(ledger);
    if (!keyring) throw new Error('first-access effect-ledger keyring unavailable');
    trust = { keyring, signingKey: await ledger.signingKey() };
  }
  return signHeldoutAccess({ schemaVersion: 'decision-d29-access/v2', runId: bundle.approval.runId,
    analysisDigest: bundle.preregistration.studyAnalysisDigest, frozenBundleDigest: heldoutDigest(bundle),
    anchoredAt, firstTestAccessAt, reference: `heldout-run:${bundle.approval.runId}` }, trust);
}
