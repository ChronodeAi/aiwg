import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GateProviderEntrySchema, type GateProviderEntry } from '../../extensions/manifest.js';
import { artifactDigest } from '../../decision/validate.js';
import { providerSourceDigest, type MetricProvider } from './types.js';
import type { GateMetricsDocument, Sha256Digest } from '../types.js';

/**
 * Addon/extension metric-provider loading (#2831).
 *
 * Providers load ONLY through the gates registry from paths declared in the
 * bundle manifest (`gateProviders`), inside the bundle root, never by
 * arbitrary import. Core providers remain the default: this module is
 * disabled unless the caller passes `allowBundleProviders: true` (or sets
 * `AIWG_GATES_BUNDLE_PROVIDERS=1`). An absent opt-in keeps resolution and
 * evaluation byte-identical to the core-only path.
 */

export const GATE_PROVIDER_MAX_FILE_BYTES = 256 * 1024;
export const GATE_PROVIDER_MAX_FILES = 20;
export const GATE_PROVIDER_MAX_TOTAL_BYTES = 1024 * 1024;
export const GATE_PROVIDER_MAX_REVIEW_BYTES = 8 * 1024;
export const GATE_PROVIDER_DEFAULT_TIMEOUT_MS = 5000;
export const GATE_PROVIDER_MAX_TIMEOUT_MS = 30000;
export const GATE_PROVIDER_DEFAULT_MAX_RECORDS = 50000;

export class GateProviderError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'disabled' | 'path-escape' | 'oversize' | 'missing-attestation' | 'attestation-mismatch'
      | 'invalid-module' | 'external-unpinned' | 'timeout' | 'cancelled' | 'rejected'
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

/** One bare external import pinned by the bundle lockfile integrity hash. */
export interface ProviderExternalPin {
  specifier: string;
  version: string;
  integrity: string;
}

export interface ProviderCodeDigest {
  codeDigest: Sha256Digest;
  files: ProviderFileDigest[];
  externals: ProviderExternalPin[];
}

/** A bundle provider with its trusted code digest and review attestation. */
export type BundleMetricProvider = MetricProvider & {
  codeDigest: Sha256Digest;
  review: { reviewer: string; reviewedAt: string; codeDigest: Sha256Digest };
  bundleId: string;
  modulePath: string;
};

export interface BundleProviderOptions {
  allowBundleProviders?: boolean;
  now?: string;
  timeoutMs?: number;
  maxRecords?: number;
  signal?: AbortSignal;
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MODULE_PATTERN = /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.mjs$/;
const REVIEW_PATTERN = /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.json$/;

/** Determinism denylist: filesystem, process and network access (#2831). */
const FORBIDDEN_BUILTINS = new Set([
  'fs', 'fs/promises', 'child_process', 'cluster', 'net', 'http', 'https', 'http2',
  'dgram', 'dns', 'tls', 'worker_threads',
]);

export function isBundleProvidersEnabled(options?: Pick<BundleProviderOptions, 'allowBundleProviders'>): boolean {
  if (options?.allowBundleProviders === true) return true;
  return process.env.AIWG_GATES_BUNDLE_PROVIDERS === '1';
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

function resolveInsideBundle(rootReal: string, rel: string, label: string): string {
  const abs = resolve(rootReal, rel);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw new GateProviderError(`${label} is missing inside the bundle: ${rel}`, 'path-escape');
  }
  if (real !== rootReal && !real.startsWith(rootReal + sep)) {
    throw new GateProviderError(`${label} escapes the bundle root: ${rel}`, 'path-escape');
  }
  return real;
}

const IMPORT_PATTERN = /(?:import\s+[^'"]*?from\s*|export\s+[^'"]*?from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;

function parseSpecifiers(source: string): string[] {
  const found = new Set<string>();
  IMPORT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMPORT_PATTERN.exec(source)) !== null) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  return [...found];
}

function builtinName(specifier: string): string | null {
  const bare = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  if (specifier.startsWith('node:') || isBuiltin(specifier) || isBuiltin(`node:${bare}`)) return bare;
  return null;
}

function packageNameOf(specifier: string): string {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return specifier.split('/')[0] as string;
}

function lockfileIntegrity(rootReal: string, name: string): { version: string; integrity: string } {
  let lock: unknown;
  try {
    lock = JSON.parse(readFileSync(resolve(rootReal, 'package-lock.json'), 'utf8')) as unknown;
  } catch {
    throw new GateProviderError(`external import '${name}' requires a bundle package-lock.json integrity pin`, 'external-unpinned');
  }
  const packages = (lock as { packages?: Record<string, { version?: unknown; integrity?: unknown }> }).packages;
  const entry = packages?.[`node_modules/${name}`];
  const version = entry?.version;
  const integrity = entry?.integrity;
  if (typeof version !== 'string' || !version || typeof integrity !== 'string' || !integrity) {
    throw new GateProviderError(`external import '${name}' has no lockfile integrity pin`, 'external-unpinned');
  }
  return { version, integrity };
}

/**
 * Digest of provider CODE: the entry module bytes plus every resolved local
 * import within the bundle. Bare externals contribute only their lockfile
 * `{version, integrity}` pin. Any byte change moves the digest, so a binding
 * pinned to the old digest refuses until re-pinned.
 */
export function computeProviderCodeDigest(bundleRoot: string, entryModule: string): ProviderCodeDigest {
  const rel = assertDeclaredPath(entryModule, MODULE_PATTERN, 'provider module');
  const rootReal = bundleRootReal(bundleRoot);
  const entryReal = resolveInsideBundle(rootReal, rel, 'provider module');
  const files: ProviderFileDigest[] = [];
  const externals = new Map<string, ProviderExternalPin>();
  const visited = new Set<string>();
  const queue: string[] = [entryReal];
  let total = 0;
  while (queue.length) {
    const abs = queue.shift() as string;
    if (visited.has(abs)) continue;
    visited.add(abs);
    if (visited.size > GATE_PROVIDER_MAX_FILES) {
      throw new GateProviderError(`provider exceeds ${GATE_PROVIDER_MAX_FILES} files`, 'oversize');
    }
    let bytes: Buffer;
    try {
      const size = statSync(abs).size;
      if (size > GATE_PROVIDER_MAX_FILE_BYTES) {
        throw new GateProviderError(`provider file exceeds size limit: ${relative(rootReal, abs)}`, 'oversize');
      }
      total += size;
      if (total > GATE_PROVIDER_MAX_TOTAL_BYTES) throw new GateProviderError('provider exceeds total size limit', 'oversize');
      bytes = readFileSync(abs);
    } catch (error) {
      if (error instanceof GateProviderError) throw error;
      throw new GateProviderError(`provider file is unreadable: ${relative(rootReal, abs)}`, 'path-escape');
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const posix = relative(rootReal, abs).split(sep).join('/');
    files.push({ path: posix, sha256 });
    if (!abs.endsWith('.mjs')) continue;
    for (const specifier of parseSpecifiers(bytes.toString('utf8'))) {
      const builtin = builtinName(specifier);
      if (builtin !== null) {
        if (FORBIDDEN_BUILTINS.has(builtin)) {
          throw new GateProviderError(
            `provider must be deterministic: '${specifier}' filesystem/network access is not allowed`, 'invalid-module');
        }
        continue;
      }
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        const next = resolve(dirname(abs), specifier);
        let nextReal: string;
        try {
          nextReal = realpathSync(next);
        } catch {
          throw new GateProviderError(`provider import escapes or is missing: ${specifier}`, 'path-escape');
        }
        if (nextReal !== rootReal && !nextReal.startsWith(rootReal + sep)) {
          throw new GateProviderError(`provider import escapes the bundle root: ${specifier}`, 'path-escape');
        }
        queue.push(nextReal);
        continue;
      }
      if (specifier.startsWith('/') || specifier.includes('..')) {
        throw new GateProviderError(`provider import escapes the bundle: ${specifier}`, 'path-escape');
      }
      const name = packageNameOf(specifier);
      if (!externals.has(name)) {
        const pin = lockfileIntegrity(rootReal, name);
        externals.set(name, { specifier: name, version: pin.version, integrity: pin.integrity });
      }
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const sortedExternals = [...externals.values()].sort((a, b) => (a.specifier < b.specifier ? -1 : 1));
  const codeDigest = artifactDigest({ externals: sortedExternals, files }) as Sha256Digest;
  return { codeDigest, files, externals: sortedExternals };
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
  const abs = resolveInsideBundle(rootReal, rel, 'provider review');
  let raw: string;
  try {
    if (statSync(abs).size > GATE_PROVIDER_MAX_REVIEW_BYTES) {
      throw new GateProviderError(`provider review exceeds size limit: ${rel}`, 'oversize');
    }
    raw = readFileSync(abs, 'utf8');
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

/**
 * Load and register every `gateProviders` entry from a bundle manifest. The
 * manifest entry is re-validated here so direct callers cannot bypass Zod;
 * modules import ONLY from declared bundle-relative paths. Registration
 * refuses absent attestations, digest mismatches, undeclared providers and
 * any byte change until re-pinned. Disabled by default: pass
 * `allowBundleProviders: true` (or `AIWG_GATES_BUNDLE_PROVIDERS=1`).
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
  const rootReal = bundleRootReal(bundleRoot);
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
    const { codeDigest } = computeProviderCodeDigest(rootReal, entry.module);
    const review = readReview(rootReal, entry);
    if (review.codeDigest !== codeDigest) {
      throw new GateProviderError(`provider ${entry.id} review digest does not match its code digest`, 'attestation-mismatch');
    }
    const reviewedMs = Date.parse(review.reviewedAt);
    if (!Number.isFinite(reviewedMs)) throw new GateProviderError(`provider ${entry.id} review date is invalid`, 'missing-attestation');
    if (reviewedMs > nowMs) throw new GateProviderError(`provider ${entry.id} review is dated in the future`, 'missing-attestation');
    const moduleAbs = resolveInsideBundle(rootReal, entry.module, 'provider module');
    let exported: Record<string, unknown>;
    try {
      exported = (await import(pathToFileURL(moduleAbs).href)) as Record<string, unknown>;
    } catch {
      throw new GateProviderError(`provider ${entry.id} module cannot be imported: ${entry.module}`, 'invalid-module');
    }
    const candidate = (exported as { provider?: unknown; default?: unknown }).provider
      ?? (exported as { default?: unknown }).default ?? exported;
    const module = candidate as { id?: unknown; version?: unknown; description?: unknown; metrics?: unknown; compute?: unknown };
    if (module.id !== entry.id || module.version !== entry.version) {
      throw new GateProviderError(`provider ${entry.id} module identity does not match its manifest declaration`, 'invalid-module');
    }
    if (typeof module.description !== 'string' || !module.description) {
      throw new GateProviderError(`provider ${entry.id} description is invalid`, 'invalid-module');
    }
    if (!module.metrics || typeof module.metrics !== 'object' || Array.isArray(module.metrics)) {
      throw new GateProviderError(`provider ${entry.id} metrics declaration is invalid`, 'invalid-module');
    }
    for (const [name, declared] of Object.entries(module.metrics as Record<string, unknown>)) {
      const kind = (declared as { kind?: unknown }).kind;
      if (typeof name !== 'string' || !name || !METRIC_KINDS.has(kind as string)) {
        throw new GateProviderError(`provider ${entry.id} metric ${name} has an unknown kind`, 'invalid-module');
      }
    }
    if (typeof module.compute !== 'function') {
      throw new GateProviderError(`provider ${entry.id} compute is not a function`, 'invalid-module');
    }
    if (!DIGEST_PATTERN.test(codeDigest)) {
      throw new GateProviderError(`provider ${entry.id} code digest is unknown`, 'attestation-mismatch');
    }
    const metrics = module.metrics as BundleMetricProvider['metrics'];
    const sourceDigest = providerSourceDigest({ id: entry.id, version: entry.version, metrics });
    loaded.push({
      id: entry.id, version: entry.version, description: module.description,
      metrics, sourceDigest, codeDigest, review, bundleId: manifest.id, modulePath: entry.module,
      compute: module.compute as BundleMetricProvider['compute'],
    });
  }
  return loaded;
}

/** Reserve-then-dispatch provider invocation with a timeout (#2831). */
export async function invokeBundleProvider(
  provider: Pick<BundleMetricProvider, 'id' | 'compute'>,
  records: readonly unknown[],
  options?: BundleProviderOptions,
): Promise<unknown> {
  const timeoutMs = options?.timeoutMs ?? GATE_PROVIDER_DEFAULT_TIMEOUT_MS;
  const maxRecords = options?.maxRecords ?? GATE_PROVIDER_DEFAULT_MAX_RECORDS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > GATE_PROVIDER_MAX_TIMEOUT_MS) {
    throw new GateProviderError('provider timeout must be a positive integer within bounds', 'invalid-records');
  }
  if (!Number.isSafeInteger(maxRecords) || maxRecords <= 0) {
    throw new GateProviderError('provider record budget is invalid', 'invalid-records');
  }
  if (!Array.isArray(records)) throw new GateProviderError('provider records must be an array', 'invalid-records');
  if (records.length > maxRecords) throw new GateProviderError(`provider ${provider.id} exceeds its record budget`, 'budget-exceeded');
  if (options?.signal?.aborted === true) throw new GateProviderError(`provider ${provider.id} was cancelled before dispatch`, 'cancelled');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new GateProviderError(`provider ${provider.id} timed out`, 'timeout')), timeoutMs);
  });
  const aborted = options?.signal === undefined ? null : new Promise<never>((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(new GateProviderError(`provider ${provider.id} was cancelled`, 'cancelled')), { once: true });
  });
  try {
    const pending = Promise.resolve().then(() => (provider.compute as (rows: readonly unknown[]) => unknown)(records));
    return await (aborted === null ? Promise.race([pending, timeout]) : Promise.race([pending, timeout, aborted]));
  } catch (error) {
    if (error instanceof GateProviderError) throw error;
    throw new GateProviderError(
      `provider ${provider.id} rejected: ${error instanceof Error ? error.message : 'unknown'}`, 'rejected');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
