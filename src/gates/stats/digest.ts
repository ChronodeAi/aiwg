import { createHash } from 'node:crypto';
import { canonicalJson } from '../../security/artifact-trust.js';

/**
 * Digest modes for qualification evidence. Canonical is written for new evidence
 * and is the only default. Legacy (`JSON.stringify`) digests verify only when a
 * caller explicitly allowlists them for a pre-migration record: a legacy digest
 * on newly written evidence never verifies by default (fail closed on unknown).
 */
export type EvidenceDigestMode = 'canonical' | 'legacy';

export const evidenceDigestModes = (modes: readonly EvidenceDigestMode[] | undefined): readonly EvidenceDigestMode[] =>
  modes ?? ['canonical'];

/** Canonical-JSON sha256 digest. All new gates and qualification evidence uses this. */
export function canonicalSha256(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

/**
 * Versioned legacy mode: pre-migration `quality.ts`/`release.ts` digests hashed
 * `JSON.stringify` output, which depends on key order. Accepts exactly those bytes
 * so existing evidence still verifies without re-pinning (operator default).
 */
export function legacySha256(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

/** Returns the first matching mode, or null when neither digest matches. Null digests never match. Canonical-only by default; legacy requires an explicit allowlist. */
export function matchEvidenceDigest(value: unknown, digest: unknown, modes: readonly EvidenceDigestMode[] = ['canonical'],
): EvidenceDigestMode | null {
  if (typeof digest !== 'string') return null;
  for (const mode of evidenceDigestModes(modes)) {
    if ((mode === 'canonical' ? canonicalSha256(value) : legacySha256(value)) === digest) return mode;
  }
  return null;
}
