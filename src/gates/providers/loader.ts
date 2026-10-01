import { createHash } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { GateProviderEntrySchema, type GateProviderEntry } from '../../extensions/manifest.js';
import { artifactDigest } from '../../decision/validate.js';
import { providerSourceDigest } from './types.js';
import type { BundleMetricProvider } from './types.js';
import type { GateMetricsDocument, ProviderAllowlistEntry, Sha256Digest } from '../types.js';
import { ISOLATED_CHILD_SOURCE } from './isolated-child-source.js';

export type { BundleMetricProvider } from './types.js';

/**
 * Addon/extension metric-provider loading, isolated rework (P1-P5).
 *
 * Providers run ONLY in a separate child Node process started with the Node
 * permission model (`--permission`: fs-read allowed only for the provider
 * snapshot dir; no fs-write, no worker, no addons/wasi; child-process spawn
 * denied) with provider code evaluated in a `vm` context exposing only frozen
 * records, a frozen clock, a seeded RNG and a minimal pure standard library.
 * The `vm` context alone is NOT the boundary; the permission-restricted child
 * process (plus the parent's SIGKILL timeout and output caps) is.
 *
 * Provider code is the entire declared provider directory, copied into a
 * fresh private snapshot dir (no symlinks: lstat-checked, symlinks and
 * non-regular files refuse); the code digest covers the snapshot's sorted
 * module paths and bytes; the child loads only from that snapshot. Modules
 * must be self-contained relative `.mjs` with static string specifiers only:
 * dynamic `import()`, `require`, bare/external imports and non-`.mjs`
 * relatives refuse at load. Bare package imports are FORBIDDEN in phase 1.
 *
 * The trust root is the project config (`aiwg.config` `gates.providers`
 * allowlist): a provider registers only with a matching entry (bundle id,
 * provider id, code digest, reviewer, review timestamp). In-bundle review
 * files are informational (integrity-checked for consistency) only.
 * Unknown or mismatched entries refuse.
 *
 * Loading requires BOTH an explicit `allowBundleProviders: true` option AND
 * an allowlist entry. No environment variable activates it. With no opt-in,
 * resolution and evaluation stay byte-identical to the core-only path.
 */

export const GATE_PROVIDER_MAX_FILE_BYTES = 256 * 1024;
export const GATE_PROVIDER_MAX_FILES = 20;
export const GATE_PROVIDER_MAX_TOTAL_BYTES = 1024 * 1024;
export const GATE_PROVIDER_MAX_REVIEW_BYTES = 8 * 1024;
export const GATE_PROVIDER_DEFAULT_TIMEOUT_MS = 5000;
export const GATE_PROVIDER_MAX_TIMEOUT_MS = 30000;
export const GATE_PROVIDER_DEFAULT_MAX_RECORDS = 50000;
/** Largest accepted isolated-run stdout body (single JSON message). */
export const GATE_PROVIDER_MAX_OUTPUT_BYTES = 1024 * 1024;

export class GateProviderError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'disabled' | 'path-escape' | 'oversize' | 'missing-attestation' | 'attestation-mismatch'
      | 'invalid-module' | 'external-forbidden' | 'unregistered' | 'timeout' | 'cancelled' | 'rejected'
      | 'budget-exceeded' | 'invalid-records' | 'duplicate',
  ) {
    super(message);
    this.name = 'GateProviderError';
  }
}

/** One hashed file contributing to a provider code digest (posix-relative path). */
export interface ProviderFileDigest {
  path: string;
  sha256: string;
}

/** Phase-1 providers cannot have externals; the field stays for shape stability. */
export interface ProviderExternalPin {
  specifier: string;
  version: string;
  integrity: string;
}

export interface ProviderCodeDigest {
  codeDigest: Sha256Digest;
  files: ProviderFileDigest[];
  externals: ProviderExternalPin[];
  /** Private snapshot dir the digest was computed over (and the child loads). */
  snapshotDir: string;
}

export interface BundleProviderOptions {
  allowBundleProviders?: boolean;
  /** P3 trust root: project-config `gates.providers` allowlist. Required to register. */
  allowlist?: ProviderAllowlistEntry[];
  now?: string;
  timeoutMs?: number;
  maxRecords?: number;
  maxOutputBytes?: number;
  /** Frozen clock (epoch ms) injected into the isolated context. Defaults to the real clock. */
  clockMs?: number;
  signal?: AbortSignal;
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MODULE_PATTERN = /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.mjs$/;
const REVIEW_PATTERN = /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.json$/;
const HARNESS_PREFIX = '__aiwg_';

export function isBundleProvidersEnabled(options?: Pick<BundleProviderOptions, 'allowBundleProviders'>): boolean {
  return options?.allowBundleProviders === true;
}

function bundleRootReal(bundleRoot: string): string {
  const resolved = resolve(bundleRoot);
  try {
    return realpathSync(resolved);
  } catch {
    throw new GateProviderError(`bundle root is unavailable: ${bundleRoot}`, 'path-escape');
  }
}

function assertDeclaredPath(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new GateProviderError(`${label} escapes the bundle: ${String(value)}`, 'path-escape');
  }
  if (isAbsolute(value)) throw new GateProviderError(`${label} must be bundle-relative: ${value}`, 'path-escape');
  return value;
}

/** Deterministic seed for the isolated RNG: pinned by code and records digests. */
export function deriveIsolatedSeed(codeDigest: string, recordsDigest: string): number {
  return parseInt(createHash('sha256').update(`${codeDigest}${recordsDigest}`).digest('hex').slice(0, 8), 16);
}

interface SnapshotWalk {
  /** Bundle-relative posix path -> bytes, sorted by path. */
  modules: Array<{ path: string; bytes: Buffer }>;
}

/**
 * Copies the provider directory (the directory containing the entry module)
 * into a fresh private snapshot dir. Every entry is lstat-checked: symlinks
 * (files or dirs) and non-regular files refuse; only regular `.mjs` files are
 * copied (other regular files are inert: the loader never serves them, so
 * they are neither copied nor digested). The walk is sorted, so the snapshot
 * (and its digest) is deterministic.
 */
export function snapshotProviderDir(bundleRoot: string, entryModule: string): {
  snapshotDir: string; files: ProviderFileDigest[]; codeDigest: Sha256Digest; entryRel: string;
} {
  const rel = assertDeclaredPath(entryModule, MODULE_PATTERN, 'provider module');
  const rootReal = bundleRootReal(bundleRoot);
  const entryAbs = resolve(rootReal, rel);
  let entryReal: string;
  try {
    entryReal = realpathSync(entryAbs);
  } catch {
    throw new GateProviderError(`provider module is missing inside the bundle: ${rel}`, 'path-escape');
  }
  if (entryReal !== rootReal && !entryReal.startsWith(rootReal + sep)) {
    throw new GateProviderError(`provider module escapes the bundle root: ${rel}`, 'path-escape');
  }
  let entryStatus;
  try {
    entryStatus = lstatSync(entryReal);
  } catch {
    throw new GateProviderError(`provider module is missing inside the bundle: ${rel}`, 'path-escape');
  }
  if (entryStatus.isSymbolicLink() || !entryStatus.isFile()) {
    throw new GateProviderError(`provider module must be a regular file: ${rel}`, 'path-escape');
  }
  const providerDir = dirname(entryReal);
  const walk: SnapshotWalk = { modules: [] };
  let total = 0;
  const visit = (dirAbs: string): void => {
    let names: string[];
    try {
      names = readdirSync(dirAbs).sort();
    } catch {
      throw new GateProviderError(`provider directory is unreadable: ${relative(rootReal, dirAbs)}`, 'path-escape');
    }
    for (const name of names) {
      if (name.startsWith(HARNESS_PREFIX)) {
        throw new GateProviderError(`provider file uses the reserved prefix: ${name}`, 'invalid-module');
      }
      const abs = join(dirAbs, name);
      let status;
      try {
        status = lstatSync(abs);
      } catch {
        throw new GateProviderError(`provider file is unreadable: ${relative(rootReal, abs)}`, 'path-escape');
      }
      if (status.isSymbolicLink()) {
        throw new GateProviderError(`provider file must not be a symlink: ${relative(rootReal, abs)}`, 'path-escape');
      }
      if (status.isDirectory()) {
        if (name.endsWith('.mjs')) {
          throw new GateProviderError(`provider module must be a regular file: ${relative(rootReal, abs)}`, 'invalid-module');
        }
        visit(abs);
        continue;
      }
      if (!status.isFile()) {
        throw new GateProviderError(`provider file is not a regular file: ${relative(rootReal, abs)}`, 'path-escape');
      }
      if (!name.endsWith('.mjs')) continue;
      if (walk.modules.length >= GATE_PROVIDER_MAX_FILES) {
        throw new GateProviderError(`provider exceeds ${GATE_PROVIDER_MAX_FILES} files`, 'oversize');
      }
      let bytes: Buffer;
      try {
        bytes = readFileSync(abs);
      } catch {
        throw new GateProviderError(`provider file is unreadable: ${relative(rootReal, abs)}`, 'path-escape');
      }
      if (bytes.length > GATE_PROVIDER_MAX_FILE_BYTES) {
        throw new GateProviderError(`provider file exceeds size limit: ${relative(rootReal, abs)}`, 'oversize');
      }
      total += bytes.length;
      if (total > GATE_PROVIDER_MAX_TOTAL_BYTES) {
        throw new GateProviderError('provider exceeds total size limit', 'oversize');
      }
      walk.modules.push({ path: relative(rootReal, abs).split(sep).join('/'), bytes });
    }
  };
  visit(providerDir);
  walk.modules.sort((a, b) => (a.path < b.path ? -1 : 1));
  if (!walk.modules.some(file => file.path === relative(rootReal, entryReal).split(sep).join('/'))) {
    throw new GateProviderError(`provider module is missing from its snapshot: ${rel}`, 'path-escape');
  }
  const snapshotDir = mkdtempSync(join(tmpdir(), 'aiwg-gates-provider-'));
  const files: ProviderFileDigest[] = [];
  for (const file of walk.modules) {
    const target = join(snapshotDir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.bytes);
    files.push({ path: file.path, sha256: createHash('sha256').update(file.bytes).digest('hex') });
  }
  writeFileSync(join(snapshotDir, `${HARNESS_PREFIX}child.mjs`), ISOLATED_CHILD_SOURCE, 'utf8');
  const codeDigest = artifactDigest({ externals: [], files }) as Sha256Digest;
  return { snapshotDir, files, codeDigest, entryRel: relative(rootReal, entryReal).split(sep).join('/') };
}

/**
 * Digest of provider CODE: the snapshot bytes (sorted module paths plus
 * content hashes) of the entire provider directory. Any byte change anywhere
 * in the directory moves the digest, so a binding pinned to the old digest
 * refuses until re-pinned. Bare/external imports are forbidden in phase 1;
 * the child linker is authoritative at load/invoke. Side effect: creates a
 * fresh private snapshot dir (mode 0700, OS-tmp reclamation) and returns it
 * for loading; digest-only callers may ignore it.
 */
export function computeProviderCodeDigest(bundleRoot: string, entryModule: string): ProviderCodeDigest {
  const snapshot = snapshotProviderDir(bundleRoot, entryModule);
  return {
    codeDigest: snapshot.codeDigest, files: snapshot.files, externals: [],
    snapshotDir: snapshot.snapshotDir,
  };
}

const METRIC_KINDS = new Set(['proportion', 'paired', 'scalar', 'differences', 'evidence']);

function readReview(rootReal: string, entry: GateProviderEntry): { reviewer: string; reviewedAt: string; codeDigest: Sha256Digest } {
  if (entry.review !== undefined) {
    if (typeof entry.review.codeDigest !== 'string') {
      throw new GateProviderError(`provider ${entry.id} review digest is unknown`, 'missing-attestation');
    }
    return {
      reviewer: entry.review.reviewer,
      reviewedAt: entry.review.reviewedAt,
      codeDigest: entry.review.codeDigest as Sha256Digest,
    };
  }
  const rel = assertDeclaredPath(entry.reviewFile, REVIEW_PATTERN, 'provider review');
  const abs = resolve(rootReal, rel);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw new GateProviderError(`provider ${entry.id} review file is unreadable: ${rel}`, 'missing-attestation');
  }
  if (real !== rootReal && !real.startsWith(rootReal + sep)) {
    throw new GateProviderError(`provider review escapes the bundle root: ${rel}`, 'path-escape');
  }
  let raw: string;
  try {
    if (statSync(real).size > GATE_PROVIDER_MAX_REVIEW_BYTES) {
      throw new GateProviderError(`provider review exceeds size limit: ${rel}`, 'oversize');
    }
    raw = readFileSync(real, 'utf8');
  } catch (error) {
    if (error instanceof GateProviderError) throw error;
    throw new GateProviderError(`provider ${entry.id} review file is unreadable: ${rel}`, 'missing-attestation');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new GateProviderError(`provider ${entry.id} review file is not JSON: ${rel}`, 'missing-attestation');
  }
  const validated = GateProviderEntrySchema.safeParse({ ...entry, review: parsed, reviewFile: undefined });
  if (!validated.success) {
    throw new GateProviderError(`provider ${entry.id} review file is invalid`, 'missing-attestation');
  }
  if (validated.data.review === undefined) {
    throw new GateProviderError(`provider ${entry.id} review file is invalid`, 'missing-attestation');
  }
  return {
    reviewer: validated.data.review.reviewer,
    reviewedAt: validated.data.review.reviewedAt,
    codeDigest: validated.data.review.codeDigest as Sha256Digest,
  };
}

interface IsolatedRunArgs {
  snapshotDir: string;
  entryRel: string;
  files: string[];
  expectedId: string;
  expectedVersion: string;
  mode: 'inspect' | 'invoke';
  recordsJson?: string;
  clockMs: number;
  seed: number;
}

interface IsolatedRunLimits {
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

function childArgs(snapshotDir: string): string[] {
  return [
    '--experimental-vm-modules',
    '--permission',
    `--allow-fs-read=${snapshotDir}`,
    join(snapshotDir, `${HARNESS_PREFIX}child.mjs`),
  ];
}

function writeIsolatedRequest(snapshotDir: string, args: IsolatedRunArgs): void {
  writeFileSync(join(snapshotDir, `${HARNESS_PREFIX}request.json`), JSON.stringify({
    entry: args.entryRel,
    files: args.files,
    mode: args.mode,
    ...(args.recordsJson === undefined ? {} : { recordsJson: args.recordsJson }),
    clockMs: args.clockMs,
    seed: args.seed,
    expectedId: args.expectedId,
    expectedVersion: args.expectedVersion,
  }), 'utf8');
}

function parseIsolatedResponse(stdout: string, stderr: string, providerId: string): { descriptor?: Record<string, unknown>; result?: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim()) as unknown;
  } catch {
    throw new GateProviderError(
      `provider ${providerId} returned an unreadable message${stderr ? `: ${stderr.slice(0, 300)}` : ''}`, 'rejected');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GateProviderError(`provider ${providerId} returned an unreadable message`, 'rejected');
  }
  const body = parsed as { ok?: unknown; error?: unknown; descriptor?: unknown; result?: unknown };
  if (body.ok !== true) {
    throw new GateProviderError(
      `provider ${providerId} rejected: ${typeof body.error === 'string' && body.error ? body.error.slice(0, 300) : 'unknown'}`,
      'rejected');
  }
  return { descriptor: body.descriptor as Record<string, unknown> | undefined, result: body.result };
}

/** Synchronous isolated run (evaluator re-runs): SIGKILL timeout, output cap. */
export function runIsolatedProviderSync(
  provider: Pick<BundleMetricProvider, 'id' | 'version' | 'snapshotDir' | 'modulePath' | 'snapshotFiles'>,
  args: { mode: 'inspect' | 'invoke'; recordsJson?: string; clockMs: number; seed: number },
  limits: IsolatedRunLimits,
): { descriptor?: Record<string, unknown>; result?: unknown } {
  if (!provider.snapshotDir || !provider.modulePath || !provider.snapshotFiles) {
    throw new GateProviderError(`provider ${provider.id} snapshot is unavailable`, 'invalid-module');
  }
  writeIsolatedRequest(provider.snapshotDir, {
    snapshotDir: provider.snapshotDir,
    entryRel: provider.modulePath,
    files: [...provider.snapshotFiles],
    expectedId: provider.id,
    expectedVersion: provider.version,
    mode: args.mode,
    ...(args.recordsJson === undefined ? {} : { recordsJson: args.recordsJson }),
    clockMs: args.clockMs,
    seed: args.seed,
  });
  const completed = spawnSync(process.execPath, childArgs(provider.snapshotDir), {
    timeout: limits.timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: limits.maxOutputBytes,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = typeof completed.stderr === 'string' ? completed.stderr : '';
  if (completed.error !== undefined) {
    const code = (completed.error as NodeJS.ErrnoException).code;
    if (code === 'ETIMEDOUT' || completed.signal === 'SIGKILL') {
      throw new GateProviderError(`provider ${provider.id} timed out`, 'timeout');
    }
    if (code === 'ENOBUFS') {
      throw new GateProviderError(`provider ${provider.id} exceeds its output cap`, 'rejected');
    }
    throw new GateProviderError(`provider ${provider.id} failed to start: ${completed.error.message}`, 'rejected');
  }
  if (completed.status !== 0) {
    throw new GateProviderError(
      `provider ${provider.id} rejected${stderr ? `: ${stderr.slice(0, 300)}` : ''}`, 'rejected');
  }
  return parseIsolatedResponse(completed.stdout as string, stderr, provider.id);
}

/** Asynchronous isolated run (loader + interactive invoke): abortable, SIGKILL timeout, output cap. */
export function runIsolatedProvider(
  provider: Pick<BundleMetricProvider, 'id' | 'version' | 'snapshotDir' | 'modulePath' | 'snapshotFiles'>,
  args: { mode: 'inspect' | 'invoke'; recordsJson?: string; clockMs: number; seed: number },
  limits: IsolatedRunLimits,
): Promise<{ descriptor?: Record<string, unknown>; result?: unknown }> {
  if (!provider.snapshotDir || !provider.modulePath || !provider.snapshotFiles) {
    return Promise.reject(new GateProviderError(`provider ${provider.id} snapshot is unavailable`, 'invalid-module'));
  }
  if (limits.signal?.aborted === true) {
    return Promise.reject(new GateProviderError(`provider ${provider.id} was cancelled before dispatch`, 'cancelled'));
  }
  writeIsolatedRequest(provider.snapshotDir, {
    snapshotDir: provider.snapshotDir,
    entryRel: provider.modulePath,
    files: [...provider.snapshotFiles],
    expectedId: provider.id,
    expectedVersion: provider.version,
    mode: args.mode,
    ...(args.recordsJson === undefined ? {} : { recordsJson: args.recordsJson }),
    clockMs: args.clockMs,
    seed: args.seed,
  });
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      limits.signal?.removeEventListener('abort', onAbort);
      action();
    };
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, childArgs(provider.snapshotDir), { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      rejectPromise(new GateProviderError(
        `provider ${provider.id} failed to start: ${error instanceof Error ? error.message : 'unknown'}`, 'rejected'));
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      settle(() => rejectPromise(new GateProviderError(`provider ${provider.id} timed out`, 'timeout')));
    }, limits.timeoutMs);
    const onAbort = (): void => {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      settle(() => rejectPromise(new GateProviderError(`provider ${provider.id} was cancelled`, 'cancelled')));
    };
    limits.signal?.addEventListener('abort', onAbort, { once: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let capped = false;
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limits.maxOutputBytes) {
        capped = true;
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
        settle(() => rejectPromise(new GateProviderError(`provider ${provider.id} exceeds its output cap`, 'rejected')));
        return;
      }
      chunks.push(chunk);
    });
    const errors: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => {
      if (Buffer.concat([...errors, chunk]).length <= 4096) errors.push(chunk);
    });
    child.on('error', (error) => {
      settle(() => rejectPromise(new GateProviderError(
        `provider ${provider.id} failed to start: ${error.message}`, 'rejected')));
    });
    child.on('close', (code) => {
      if (capped) return;
      if (code !== 0) {
        const stderr = Buffer.concat(errors).toString('utf8');
        settle(() => rejectPromise(new GateProviderError(
          `provider ${provider.id} rejected${stderr ? `: ${stderr.slice(0, 300)}` : ''}`, 'rejected')));
        return;
      }
      // Parse BEFORE settling: a throwing parse must still reach the
      // rejection below (settling first would swallow the settlement).
      const stderr = Buffer.concat(errors).toString('utf8');
      let parsed: { descriptor?: Record<string, unknown>; result?: unknown };
      try {
        parsed = parseIsolatedResponse(Buffer.concat(chunks).toString('utf8'), stderr, provider.id);
      } catch (error) {
        settle(() => rejectPromise(error));
        return;
      }
      settle(() => resolvePromise(parsed));
    });
  });
}

/**
 * Load and register every `gateProviders` entry from a bundle manifest. The
 * manifest entry is re-validated here so direct callers cannot bypass Zod.
 * Registration requires BOTH an explicit `allowBundleProviders: true` option
 * AND a matching project-config allowlist entry (bundle id, provider id,
 * isolated code digest, reviewer, review timestamp); in-bundle reviews are
 * integrity-checked for consistency but are informational only. The provider
 * module graph is validated by the isolated child (parse + link over the
 * snapshot) before anything registers — nothing executes in-process, ever.
 */
export async function loadGateBundleProviders(
  bundleRoot: string,
  manifest: { id: string; gateProviders?: unknown },
  options?: BundleProviderOptions,
): Promise<BundleMetricProvider[]> {
  if (!isBundleProvidersEnabled(options)) {
    throw new GateProviderError('bundle metric providers are disabled: pass allowBundleProviders', 'disabled');
  }
  const entries: unknown[] = Array.isArray(manifest.gateProviders) ? [...manifest.gateProviders] : [];
  if (!Array.isArray(manifest.gateProviders) && manifest.gateProviders !== undefined) {
    throw new GateProviderError('bundle gateProviders must be an array', 'invalid-module');
  }
  if (!entries.length) return [];
  const nowMs = Date.parse(options?.now ?? new Date().toISOString());
  if (!Number.isFinite(nowMs)) throw new GateProviderError('provider review clock is not a valid date-time', 'invalid-records');
  const timeoutMs = options?.timeoutMs ?? GATE_PROVIDER_DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > GATE_PROVIDER_MAX_TIMEOUT_MS) {
    throw new GateProviderError('provider timeout must be a positive integer within bounds', 'invalid-records');
  }
  const maxOutputBytes = options?.maxOutputBytes ?? GATE_PROVIDER_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > 8 * 1024 * 1024) {
    throw new GateProviderError('provider output cap is invalid', 'invalid-records');
  }
  const rootReal = bundleRootReal(bundleRoot);
  const allowlist = options?.allowlist ?? [];
  const seen = new Set<string>();
  const loaded: BundleMetricProvider[] = [];
  for (const raw of entries) {
    const parsed = GateProviderEntrySchema.safeParse(raw);
    if (!parsed.success) {
      throw new GateProviderError(
        `bundle provider declaration is invalid: ${parsed.error.issues[0]?.message ?? 'invalid'}`, 'invalid-module');
    }
    const entry = parsed.data;
    if (seen.has(entry.id)) throw new GateProviderError(`duplicate bundle provider: ${entry.id}`, 'duplicate');
    seen.add(entry.id);
    const snapshot = snapshotProviderDir(rootReal, entry.module);
    const review = readReview(rootReal, entry);
    if (review.codeDigest !== snapshot.codeDigest) {
      throw new GateProviderError(`provider ${entry.id} review digest does not match its code digest`, 'attestation-mismatch');
    }
    const reviewedMs = Date.parse(review.reviewedAt);
    if (!Number.isFinite(reviewedMs)) throw new GateProviderError(`provider ${entry.id} review date is invalid`, 'missing-attestation');
    if (reviewedMs > nowMs) throw new GateProviderError(`provider ${entry.id} review is dated in the future`, 'missing-attestation');
    // P3 trust root: the project-config allowlist authorizes registration.
    const trusted = allowlist.find(candidate =>
      candidate.bundleId === manifest.id && candidate.providerId === entry.id);
    if (trusted === undefined) {
      throw new GateProviderError(
        `provider ${entry.id} is not allowlisted for bundle ${manifest.id}: refusing registration`, 'unregistered');
    }
    if (trusted.codeDigest !== snapshot.codeDigest) {
      throw new GateProviderError(`provider ${entry.id} code digest does not match its allowlist entry`, 'attestation-mismatch');
    }
    if (trusted.reviewer !== review.reviewer || trusted.reviewedAt !== review.reviewedAt) {
      throw new GateProviderError(`provider ${entry.id} review does not match its allowlist entry`, 'attestation-mismatch');
    }
    if (!DIGEST_PATTERN.test(snapshot.codeDigest)) {
      throw new GateProviderError(`provider ${entry.id} code digest is unknown`, 'attestation-mismatch');
    }
    // Validate the module graph in the isolated child (parse + link over the
    // snapshot, identity-checked against the manifest). Dynamic import(),
    // require, bare/absolute/escaping/non-.mjs specifiers refuse here.
    const provisional: Pick<BundleMetricProvider, 'id' | 'version' | 'snapshotDir' | 'modulePath' | 'snapshotFiles'> = {
      id: entry.id, version: entry.version,
      snapshotDir: snapshot.snapshotDir, modulePath: entry.module,
      snapshotFiles: snapshot.files.map(file => file.path),
    };
    let descriptor: Record<string, unknown>;
    try {
      const inspected = await runIsolatedProvider(provisional, {
        mode: 'inspect', clockMs: nowMs, seed: 1,
      }, { timeoutMs, maxOutputBytes, signal: options?.signal });
      if (!inspected.descriptor || typeof inspected.descriptor !== 'object') {
        throw new GateProviderError(`provider ${entry.id} module has no provider export`, 'invalid-module');
      }
      descriptor = inspected.descriptor;
    } catch (error) {
      if (error instanceof GateProviderError
        && (error.code === 'timeout' || error.code === 'cancelled')) throw error;
      throw new GateProviderError(
        `provider ${entry.id} module is invalid: ${error instanceof Error ? error.message : 'unknown'}`, 'invalid-module');
    }
    const metrics = descriptor.metrics;
    if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) {
      throw new GateProviderError(`provider ${entry.id} metrics declaration is invalid`, 'invalid-module');
    }
    for (const [name, declared] of Object.entries(metrics as Record<string, unknown>)) {
      const kind = (declared as { kind?: unknown }).kind;
      if (typeof name !== 'string' || !name || !METRIC_KINDS.has(kind as string)) {
        throw new GateProviderError(`provider ${entry.id} metric ${name} has an unknown kind`, 'invalid-module');
      }
    }
    const sourceDigest = providerSourceDigest({ id: entry.id, version: entry.version, metrics });
    loaded.push({
      id: entry.id, version: entry.version, description: descriptor.description as string,
      metrics: metrics as BundleMetricProvider['metrics'], sourceDigest,
      codeDigest: snapshot.codeDigest,
      review: { reviewer: trusted.reviewer, reviewedAt: trusted.reviewedAt, codeDigest: snapshot.codeDigest },
      bundleId: manifest.id, modulePath: entry.module,
      snapshotDir: snapshot.snapshotDir, snapshotFiles: snapshot.files.map(file => file.path),
      compute: () => {
        throw new GateProviderError(
          `provider ${entry.id} cannot run in-process: use invokeBundleProvider (isolated child)`, 'invalid-module');
      },
    });
  }
  return loaded;
}

/** Reserve-then-dispatch isolated provider invocation with a SIGKILL timeout. */
export async function invokeBundleProvider(
  provider: Pick<BundleMetricProvider, 'id' | 'version' | 'snapshotDir' | 'modulePath' | 'snapshotFiles'>,
  records: readonly unknown[],
  options?: BundleProviderOptions,
): Promise<unknown> {
  const timeoutMs = options?.timeoutMs ?? GATE_PROVIDER_DEFAULT_TIMEOUT_MS;
  const maxRecords = options?.maxRecords ?? GATE_PROVIDER_DEFAULT_MAX_RECORDS;
  const maxOutputBytes = options?.maxOutputBytes ?? GATE_PROVIDER_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > GATE_PROVIDER_MAX_TIMEOUT_MS) {
    throw new GateProviderError('provider timeout must be a positive integer within bounds', 'invalid-records');
  }
  if (!Number.isSafeInteger(maxRecords) || maxRecords <= 0) {
    throw new GateProviderError('provider record budget is invalid', 'invalid-records');
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > 8 * 1024 * 1024) {
    throw new GateProviderError('provider output cap is invalid', 'invalid-records');
  }
  if (!Array.isArray(records)) throw new GateProviderError('provider records must be an array', 'invalid-records');
  if (records.length > maxRecords) throw new GateProviderError(`provider ${provider.id} exceeds its record budget`, 'budget-exceeded');
  if (options?.signal?.aborted === true) throw new GateProviderError(`provider ${provider.id} was cancelled before dispatch`, 'cancelled');
  let recordsJson: string;
  try {
    const serialized = JSON.stringify(records);
    if (typeof serialized !== 'string') throw new Error('unserializable');
    recordsJson = serialized;
  } catch {
    throw new GateProviderError(`provider ${provider.id} records are not JSON-serializable`, 'invalid-records');
  }
  let recordsDigest: Sha256Digest;
  try {
    recordsDigest = artifactDigest(records) as Sha256Digest;
  } catch {
    throw new GateProviderError(`provider ${provider.id} records are not digestible`, 'invalid-records');
  }
  const clockMs = options?.clockMs ?? Date.now();
  if (!Number.isSafeInteger(clockMs)) throw new GateProviderError('provider clock is not an integer', 'invalid-records');
  const codeDigest = (provider as { codeDigest?: unknown }).codeDigest;
  if (typeof codeDigest !== 'string' || !DIGEST_PATTERN.test(codeDigest)) {
    throw new GateProviderError(`provider ${provider.id} code digest is unknown`, 'attestation-mismatch');
  }
  try {
    const ran = await runIsolatedProvider(provider, {
      mode: 'invoke', recordsJson, clockMs, seed: deriveIsolatedSeed(codeDigest, recordsDigest),
    }, { timeoutMs, maxOutputBytes, signal: options?.signal });
    if (ran.result === undefined) throw new GateProviderError(`provider ${provider.id} returned no metrics`, 'rejected');
    return ran.result;
  } catch (error) {
    if (error instanceof GateProviderError) throw error;
    throw new GateProviderError(
      `provider ${provider.id} rejected: ${error instanceof Error ? error.message : 'unknown'}`, 'rejected');
  }
}

/**
 * Builds the binding pin for a bundle provider over caller-supplied records,
 * including the records digest the evaluator reproduces (records binding).
 */
export function providerBindingPin(
  provider: Pick<BundleMetricProvider, 'id' | 'version' | 'sourceDigest' | 'codeDigest'>,
  records: readonly unknown[],
): { id: string; version: string; sourceDigest: Sha256Digest; codeDigest: Sha256Digest; recordsDigest: Sha256Digest } {
  if (typeof provider.codeDigest !== 'string' || !DIGEST_PATTERN.test(provider.codeDigest)) {
    throw new GateProviderError(`provider ${provider.id} code digest is unknown`, 'attestation-mismatch');
  }
  if (!Array.isArray(records)) throw new GateProviderError('provider records must be an array', 'invalid-records');
  let recordsDigest: Sha256Digest;
  try {
    recordsDigest = artifactDigest(records) as Sha256Digest;
  } catch {
    throw new GateProviderError(`provider ${provider.id} records are not digestible`, 'invalid-records');
  }
  return {
    id: provider.id, version: provider.version,
    sourceDigest: provider.sourceDigest, codeDigest: provider.codeDigest, recordsDigest,
  };
}

/**
 * Bind a provider result to its trusted code digest and input-records digest.
 * The returned section overwrites any self-declared `version`/`sourceDigest`:
 * callers must use the sealed values, and the evaluator verifies the pin
 * against the loaded provider, never against provider-declared fields.
 */
export function sealProviderSection(
  provider: Pick<BundleMetricProvider, 'id' | 'version' | 'sourceDigest' | 'codeDigest'>,
  records: readonly unknown[],
  result: { metrics?: unknown },
): GateMetricsDocument['providers'][string] {
  if (!Array.isArray(records)) throw new GateProviderError('provider records must be an array', 'invalid-records');
  let recordsDigest: Sha256Digest;
  try {
    recordsDigest = artifactDigest(records) as Sha256Digest;
  } catch {
    throw new GateProviderError(`provider ${provider.id} records are not digestible`, 'invalid-records');
  }
  if (!result || typeof result !== 'object' || !result.metrics || typeof result.metrics !== 'object') {
    throw new GateProviderError(`provider ${provider.id} returned no metrics`, 'rejected');
  }
  if (typeof provider.codeDigest !== 'string' || !DIGEST_PATTERN.test(provider.codeDigest)) {
    throw new GateProviderError(`provider ${provider.id} code digest is unknown`, 'attestation-mismatch');
  }
  return {
    version: provider.version,
    sourceDigest: provider.sourceDigest,
    codeDigest: provider.codeDigest,
    recordsDigest,
    metrics: result.metrics as GateMetricsDocument['providers'][string]['metrics'],
  } as GateMetricsDocument['providers'][string];
}
