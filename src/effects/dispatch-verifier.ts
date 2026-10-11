/**
 * Worker-dispatch effect verification (#2891, S1 direct/shared checkpoint).
 *
 * Modelled on the ledger lock recovery (`src/effects/lock-recovery.ts`): an
 * extension kind whose verifier is registered only when the evidence it
 * checks actually exists. Here the evidence is Tier 0 supervisor evidence
 * held by the conductor — the dispatch record digest for one invocation,
 * plus optional `file.digest` artifacts. Without supervisor evidence the
 * factory returns null and the kind stays unregistered, so reconciliation
 * through the existing ledger answers `unknown` / `verifier-missing` instead
 * of manufacturing proof.
 *
 * Artifact checks reuse the built-in `file.digest` verifier by delegation;
 * this module owns no second ledger and no file hashing of its own.
 *
 * Managed (S2+) durable dispatch proof and Tier 1 registration are out of
 * scope; this verifier covers direct/shared supervisor evidence only.
 *
 * @see docs/contracts/effect-ledger.v1.md "Verifier interface"
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EffectLedgerError } from './errors.js';
import { fileDigestVerifier } from './verifiers/file.js';
import { EffectVerifierError, type EffectVerifier } from './verifiers/types.js';

export const DISPATCH_KIND = 'x.aiwg.worker-dispatch' as const;
export const DISPATCH_VERIFIER_VERSION = '1.0.0';

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
/**
 * Canonical invocation-ID shape for dispatch evidence (#2891). This is the
 * SINGLE definition: `tools/ralph-external/lib/dispatch-evidence.mjs`
 * imports this exact binding (through `tools/_resolve-impl.mjs`'s
 * `importImpl`, since `tools/` cannot import `src/*.js` directly) rather
 * than duplicating the literal, so the two can never drift.
 */
export const INVOCATION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/** Conductor-owned evidence directories and files are owner-only. */
export const DISPATCH_EVIDENCE_DIR_MODE = 0o700;
export const DISPATCH_EVIDENCE_FILE_MODE = 0o600;

/** Supervisor evidence the conductor holds for one direct dispatch. */
export interface DispatchSupervisorEvidence {
  /** The dispatched invocation this evidence supervises. */
  invocationId: string;
  /** `sha256:<hex>` over the supervisor's dispatch record. */
  evidenceDigest: string;
  /** Optional artifact verified through `file.digest`, relative to the project root. */
  artifactPath?: string;
  /** `sha256:<hex>` of the artifact; required when `artifactPath` is set. */
  artifactDigest?: string;
}

export function dispatchEffectTarget(invocationId: string): string {
  return `x-aiwg:dispatch/${invocationId}`;
}

/**
 * Test-only race-injection seam (#2891 R1/R7), mirroring the equivalent hook
 * in `tools/ralph-external/lib/dispatch-evidence.mjs`. No-op in production
 * (`afterOpen` defaults to `null`); this package's own conformance suite
 * sets it to a one-shot callback that performs a deterministic TOCTOU swap
 * between `loadSupervisorEvidence`'s two `open()` calls, then clears
 * itself. Never read outside `openTraced` below.
 */
export const __raceTestHooks: { afterOpen: ((targetPath: string) => void | Promise<void>) | null } = { afterOpen: null };

async function openTraced(path: string, flags: number) {
  const handle = await open(path, flags);
  if (__raceTestHooks.afterOpen) await __raceTestHooks.afterOpen(path);
  return handle;
}

/**
 * Read supervisor evidence from the conductor-owned evidence location. The
 * evidence directory is opened `O_NOFOLLOW` ONCE and kept open for the
 * whole read: the file `<invocationId>.json` is then opened through that
 * SAME still-open directory descriptor, via `/proc/self/fd/<dirfd>/<name>`,
 * never by re-resolving `<evidenceDir>/<invocationId>.json` as a fresh path
 * string. This means a swap of `evidenceDir`'s path between validating the
 * directory and reading the file cannot redirect the read onto an attacker-
 * controlled location — the descriptor still refers to the original,
 * validated directory regardless of what the path now names.
 *
 * Every check runs against an open fd: the evidence directory must be a
 * real directory owned by us with mode exactly 0700, and the evidence file
 * must be a regular file owned by us with mode exactly 0600 and exactly one
 * link (no surprise hardlink). Supervisor evidence is never read from a
 * worker-writable path: any symlink, wrong mode, wrong owner, extra link or
 * unbound invocationId throws instead of verifying.
 *
 * When `expectedRecordDigest` is supplied (the sha256 of the evidence
 * file's raw bytes, recorded by the conductor at capture time — for
 * example from the effect ledger intent this evidence backs), the freshly
 * read bytes must hash to it or the load throws. Shape and permission
 * checks alone cannot detect in-place mutation of an already-captured
 * evidence file; this closes that gap for any caller that has an earlier
 * recorded digest to check against.
 */
export async function loadSupervisorEvidence(options: {
  evidenceDir: string;
  invocationId: string;
  expectedRecordDigest?: string;
}): Promise<DispatchSupervisorEvidence> {
  const invocationId = options?.invocationId;
  if (typeof invocationId !== 'string' || !INVOCATION_PATTERN.test(invocationId)) {
    throw new EffectVerifierError('malformed-response', 'Supervisor evidence needs a valid invocation ID');
  }
  if (!options || typeof options.evidenceDir !== 'string' || !options.evidenceDir) {
    throw new EffectVerifierError('container-unreadable', 'Supervisor evidence needs a conductor-owned evidence directory');
  }
  const dirResolved = resolve(options.evidenceDir);
  let dirHandle;
  try {
    dirHandle = await openTraced(dirResolved, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | constants.O_NOFOLLOW);
  } catch {
    throw new EffectVerifierError('container-unreadable', `Supervisor evidence directory is not a real directory: ${dirResolved}`);
  }
  try {
    const dirStat = await dirHandle.stat();
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!dirStat.isDirectory() || (dirStat.mode & 0o777) !== DISPATCH_EVIDENCE_DIR_MODE
      || (uid !== null && dirStat.uid !== uid)) {
      throw new EffectVerifierError('container-unreadable', `Supervisor evidence directory is not owner-only 0700: ${dirResolved}`);
    }
    const name = `${invocationId}.json`;
    const ref = `/proc/self/fd/${dirHandle.fd}/${name}`;
    let handle;
    try {
      handle = await openTraced(ref, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      throw new EffectVerifierError('container-unreadable', `Supervisor evidence is unreadable: ${dirResolved}/${name}`);
    }
    try {
      const stat = await handle.stat();
      const fileUid = typeof process.getuid === 'function' ? process.getuid() : null;
      if (!stat.isFile() || (stat.mode & 0o777) !== DISPATCH_EVIDENCE_FILE_MODE
        || (fileUid !== null && stat.uid !== fileUid) || stat.nlink !== 1) {
        throw new EffectVerifierError(
          'container-unreadable',
          `Supervisor evidence is not an owner-only 0600 regular file with a single link: ${dirResolved}/${name}`,
        );
      }
      const raw = await handle.readFile('utf8');
      if (typeof options.expectedRecordDigest === 'string' && options.expectedRecordDigest) {
        const actual = `sha256:${createHash('sha256').update(raw, 'utf8').digest('hex')}`;
        if (actual !== options.expectedRecordDigest) {
          throw new EffectVerifierError(
            'malformed-response',
            'Supervisor evidence does not match its recorded digest; mutation after capture is not trusted',
          );
        }
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new EffectVerifierError('malformed-response', 'Supervisor evidence is not valid JSON');
      }
      if (!hasSupervisorEvidence(parsed) || parsed.invocationId !== invocationId) {
        throw new EffectVerifierError('malformed-response', 'Supervisor evidence is not bound to this invocation');
      }
      return parsed;
    } finally {
      await handle.close();
    }
  } finally {
    await dirHandle.close();
  }
}

/** True only when actual supervisor evidence exists: a bound invocation and digest. */
export function hasSupervisorEvidence(evidence: unknown): evidence is DispatchSupervisorEvidence {
  if (!evidence || typeof evidence !== 'object') return false;
  const record = evidence as Record<string, unknown>;
  if (typeof record.invocationId !== 'string' || !INVOCATION_PATTERN.test(record.invocationId)) return false;
  if (typeof record.evidenceDigest !== 'string' || !DIGEST_PATTERN.test(record.evidenceDigest)) return false;
  if (record.artifactPath !== undefined || record.artifactDigest !== undefined) {
    if (typeof record.artifactPath !== 'string' || !record.artifactPath) return false;
    if (typeof record.artifactDigest !== 'string' || !DIGEST_PATTERN.test(record.artifactDigest)) return false;
  }
  return true;
}

function assertContextShape(context: Record<string, unknown>, target: string): DispatchSupervisorEvidence {
  const invocationId = context.invocationId;
  const evidenceDigest = context.evidenceDigest;
  if (typeof invocationId !== 'string' || !INVOCATION_PATTERN.test(invocationId)
    || target !== dispatchEffectTarget(invocationId)) {
    throw new EffectVerifierError('malformed-response', 'Dispatch effect has an unexpected target or invocation');
  }
  if (typeof evidenceDigest !== 'string' || !DIGEST_PATTERN.test(evidenceDigest)) {
    throw new EffectVerifierError('malformed-response', 'Dispatch effect has no evidence digest');
  }
  return {
    invocationId,
    evidenceDigest,
    ...(typeof context.artifactPath === 'string' ? { artifactPath: context.artifactPath } : {}),
    ...(typeof context.artifactDigest === 'string' ? { artifactDigest: context.artifactDigest } : {}),
  };
}

/**
 * Build the dispatch verifier bound to one project's supervisor evidence, or
 * null when no actual supervisor evidence exists. Callers register the
 * returned verifier (for example through the `extensions` of
 * `buildCliVerifierRegistry`) only when it is non-null; a null result means
 * the kind stays unregistered and reconciliation reports unknown.
 */
export function createDispatchVerifierIfSupervised(options: {
  projectDir: string;
  evidence?: unknown;
  /**
   * Conductor-owned 0700 evidence directory holding this dispatch's
   * artifacts. `file.digest` delegation roots here — NEVER at the broad
   * project directory, and never falls back to it — so a supervised
   * artifact cannot name files outside the evidence tree. Omitting this
   * when the supervised evidence names an artifact (`artifactPath` set) is
   * not verifiable: `verify()` reports `evidence-conflict`, it does not
   * fall back to `projectDir`. Omit only when the supervised evidence names
   * no artifact at all; callers that bind supervisor evidence through
   * {@link loadSupervisorEvidence} already hold this directory.
   */
  evidenceDir?: string;
}): EffectVerifier | null {
  if (!options || typeof options.projectDir !== 'string' || !options.projectDir) {
    throw new EffectLedgerError('usage', 'Dispatch verification needs a project directory', 'invalid-project');
  }
  if (!hasSupervisorEvidence(options.evidence)) return null;
  const supervised = options.evidence;
  // The record never picks its own strictness: artifacts root ONLY at the
  // conductor-owned evidence directory, and the branch below is driven by
  // what the SUPERVISOR evidence names, not by what the ledger context
  // offers. No evidenceDir means no delegation target: `verify()` below
  // reports `evidence-conflict` for an artifact check rather than silently
  // widening the trusted root to `projectDir`.
  const files = options.evidenceDir ? fileDigestVerifier({ root: options.evidenceDir }) : null;
  return {
    kind: DISPATCH_KIND,
    version: DISPATCH_VERIFIER_VERSION,
    canReportAbsent: true,
    async verify(request) {
      const context = assertContextShape((request.context ?? {}) as Record<string, unknown>, request.target);
      if (context.invocationId !== supervised.invocationId) {
        throw new EffectVerifierError('malformed-response', 'Dispatch evidence is bound to a different invocation');
      }
      const expected = request.expected.digest ?? request.payloadDigest;
      if (expected !== supervised.evidenceDigest || context.evidenceDigest !== supervised.evidenceDigest) {
        return { result: 'unknown', reason: 'evidence-conflict', complete: false };
      }
      // Supervisor-driven: when supervised evidence names an artifact the
      // verifier ALWAYS delegates to file.digest. A context that omits the
      // artifact (or mismatches it), or a missing evidenceDir to delegate
      // into, is evidence-conflict, never a present/complete downgrade and
      // never a projectDir fallback.
      if (supervised.artifactPath !== undefined) {
        if (!files) {
          return { result: 'unknown', reason: 'evidence-conflict', complete: false };
        }
        if (context.artifactPath !== supervised.artifactPath || context.artifactDigest !== supervised.artifactDigest) {
          return { result: 'unknown', reason: 'evidence-conflict', complete: false };
        }
        const observation = await files.verify({
          ...request,
          kind: 'file.digest',
          target: `file:${supervised.artifactPath}@${supervised.artifactDigest}`,
          expected: { digest: supervised.artifactDigest },
        });
        if (observation.result !== 'present') return observation;
        return {
          result: 'present', reason: 'state-match', complete: true,
          evidence: { invocationId: context.invocationId, evidenceDigest: supervised.evidenceDigest, artifact: supervised.artifactPath },
        };
      }
      return {
        result: 'present', reason: 'state-match', complete: true,
        evidence: { invocationId: context.invocationId, evidenceDigest: supervised.evidenceDigest },
      };
    },
  };
}
