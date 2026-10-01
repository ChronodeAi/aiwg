import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDecisionJson, parseDecisionYaml } from '../decision/entry.js';
import { artifactDigest } from '../decision/validate.js';
import { discoverShippedGatePacks, loadGatePackFile, registerBundleGatePacks } from './discovery.js';
import { evaluateGates, sealGateHoldout, sealUpstream } from './evaluate.js';
import { MetricProviderRegistry } from './providers/index.js';
import { createCoreProviderRegistry } from './providers/index.js';
import { GateRegistry, splitPackId, validateResolvedPack } from './registry.js';
import { validateGateDocument } from './schema.js';
import type {
  GateBinding, GateMetricsDocument, GatePack, GateReport, Sha256Digest, UpstreamCeiling,
} from './types.js';

export interface GatesDriverOptions {
  cwd?: string;
  aiwgRoot?: string;
  packDirs?: string[];
}

function baseDir(options: GatesDriverOptions = {}): string {
  return path.resolve(options.cwd ?? process.cwd());
}

function rootDir(options: GatesDriverOptions = {}): string {
  return path.resolve(options.aiwgRoot ?? options.cwd ?? process.cwd());
}

function resolvePath(candidate: string, base: string): string {
  if (!candidate) throw new Error('Path is required');
  return path.resolve(base, candidate);
}

async function readDocument(filePath: string): Promise<unknown> {
  const content = await readFile(filePath, 'utf8');
  return filePath.toLowerCase().endsWith('.json') ? parseDecisionJson(content) : parseDecisionYaml(content);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Build an offline registry from shipped packs plus explicit pack dirs/files (tests). */
export function buildGatesRegistry(options: GatesDriverOptions = {}): { registry: GateRegistry; loaded: string[] } {
  const registry = new GateRegistry(createCoreProviderRegistry());
  const loaded: string[] = [];
  const root = rootDir(options);
  try {
    loaded.push(...discoverShippedGatePacks(root, registry));
  } catch (error) {
    throw new Error(`shipped gate packs rejected: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const dir of options.packDirs ?? []) {
    const resolved = resolvePath(dir, baseDir(options));
    const lower = resolved.toLowerCase();
    if (lower.endsWith('.gatepack.yaml') || lower.endsWith('.gatepack.yml') || lower.endsWith('.gatepack.json')
      || lower.endsWith('.json') || lower.endsWith('.yaml') || lower.endsWith('.yml')) {
      const pack = loadGatePackFile(resolved);
      const { namespace, rest } = splitPackId(pack.metadata.id);
      const bundle = namespace === 'project' ? undefined : rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : undefined;
      try {
        registry.registerPack(pack, bundle === undefined ? { namespace } : { namespace, bundle });
      } catch (error) {
        throw new Error(`gate pack rejected: ${resolved}: ${error instanceof Error ? error.message : String(error)}`);
      }
      loaded.push(pack.metadata.id);
      continue;
    }
    const origin = inferPackOrigin(resolved);
    loaded.push(...registerBundleGatePacks(registry, resolved, origin));
  }
  return { registry, loaded };
}

function inferPackOrigin(dir: string): { namespace: 'framework' | 'addon' | 'extension' | 'project' | 'aiwg'; bundle?: string } {
  const normalized = dir.replace(/\\/g, '/');
  const bundle = basenameOf(dir);
  if (normalized.includes('/frameworks/')) return { namespace: 'framework', bundle };
  if (normalized.includes('/addons/')) return { namespace: 'addon', bundle };
  if (normalized.includes('/extensions/')) return { namespace: 'extension', bundle };
  if (normalized.endsWith('/gate-packs') || normalized.includes('/.aiwg/')) return { namespace: 'project' };
  return { namespace: 'project' };
}

function basenameOf(dir: string): string {
  const parts = dir.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? 'unknown';
}

export type GateValidateKind = 'pack' | 'binding' | 'report';

export interface GateValidateResult {
  schema: 'aiwg-gates-validation/v1';
  kind: GateValidateKind;
  source: string;
  valid: boolean;
  summary: { id: string | null; version: string | null; apiVersion: string | null };
  errors: string[];
}

/** Offline validation for one pack/binding/report file. Never throws for invalid content. */
export async function validateGateFile(
  kind: GateValidateKind | 'auto',
  filePath: string,
  options: GatesDriverOptions = {},
): Promise<GateValidateResult> {
  const resolved = resolvePath(filePath, baseDir(options));
  let document: unknown;
  try {
    document = await readDocument(resolved);
  } catch (error) {
    return {
      schema: 'aiwg-gates-validation/v1', kind: kind === 'auto' ? 'pack' : kind, source: 'path',
      valid: false, summary: { id: null, version: null, apiVersion: null },
      errors: [error instanceof Error ? error.message : 'unreadable-file'],
    };
  }
  const detected: GateValidateKind = kind !== 'auto'
    ? kind
    : isRecord(document) && document.kind === 'GateBinding' ? 'binding'
    : isRecord(document) && document.kind === 'GateReport' ? 'report' : 'pack';
  const summary = {
    id: isRecord(document) && isRecord(document.metadata) && typeof document.metadata.id === 'string' ? document.metadata.id : null,
    version: isRecord(document) && isRecord(document.metadata) && typeof document.metadata.version === 'string' ? document.metadata.version : null,
    apiVersion: isRecord(document) && typeof document.apiVersion === 'string' ? document.apiVersion : null,
  };
  const errors: string[] = [];
  try {
    if (detected === 'pack') {
      const pack = validateGateDocument<GatePack>(document);
      if (pack.kind !== 'GatePack') throw new Error(`expected kind GatePack, got '${String((document as { kind?: unknown }).kind)}'`);
      const { registry } = buildGatesRegistry(options);
      const providers: MetricProviderRegistry = (registry as unknown as { providers: MetricProviderRegistry }).providers
        ?? createCoreProviderRegistry();
      validateResolvedPack(pack, providers);
    } else if (detected === 'binding') {
      const { registry } = buildGatesRegistry(options);
      registry.resolveBinding(document);
    } else {
      // Full report validation needs the trusted evaluation context
      // (`validateGateReport` re-derives the report byte-identically).
      // `validate` checks the closed schema, the kind and the self-digest,
      // so rewritten evidence with a stale digest still fails here.
      const report = validateGateDocument(document);
      if (!isRecord(document) || document.kind !== 'GateReport') throw new Error('expected kind GateReport');
      const { digest, ...fields } = report as unknown as Record<string, unknown>;
      if (typeof digest !== 'string' || artifactDigest(fields) !== digest) {
        throw new Error('report digest does not match its content');
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'validation-failed');
  }
  return { schema: 'aiwg-gates-validation/v1', kind: detected, source: 'path', valid: errors.length === 0, summary, errors };
}

export interface GatesEvaluateFiles {
  bindingPath: string;
  metricsPath: string;
  holdoutPath: string;
  upstreamPath?: string;
  now: string;
}

/** Load a sealed holdout record from disk. A present digest is re-derived; a missing digest is sealed. */
export async function loadHoldoutFile(filePath: string, cwd: string) {
  const resolved = resolvePath(filePath, cwd);
  const document = await readDocument(resolved);
  if (!isRecord(document)) throw new Error(`holdout file must be an object: ${resolved}`);
  const { frozenDigest, firstAccessedAt, digest } = document as {
    frozenDigest?: unknown; firstAccessedAt?: unknown; digest?: unknown;
  };
  if (typeof frozenDigest !== 'string' || !(firstAccessedAt === null || typeof firstAccessedAt === 'string')) {
    throw new Error(`holdout file must carry {frozenDigest, firstAccessedAt}: ${resolved}`);
  }
  if (digest !== undefined) {
    if (typeof digest !== 'string') throw new Error(`holdout digest must be a string: ${resolved}`);
    const expected = artifactDigest({ frozenDigest, firstAccessedAt });
    if (expected !== digest) throw new Error(`holdout record seal does not match its content: ${resolved}`);
    return { frozenDigest: frozenDigest as Sha256Digest, firstAccessedAt: firstAccessedAt as string | null, digest: digest as Sha256Digest };
  }
  return sealGateHoldout({ frozenDigest: frozenDigest as Sha256Digest, firstAccessedAt: firstAccessedAt as string | null });
}

/** Load a sealed upstream record from disk. A present digest is re-derived; raw metadata is sealed. */
export async function loadUpstreamFile(filePath: string, cwd: string): Promise<UpstreamCeiling> {
  const resolved = resolvePath(filePath, cwd);
  const document = await readDocument(resolved);
  if (!isRecord(document)) throw new Error(`upstream file must be an object: ${resolved}`);
  if (isRecord(document.metadata) && typeof document.digest === 'string') {
    const expected = artifactDigest(document.metadata);
    if (expected !== document.digest) throw new Error(`upstream integrity digest does not match its report: ${resolved}`);
    return { metadata: document.metadata as unknown as UpstreamCeiling['metadata'], digest: document.digest as Sha256Digest };
  }
  return sealUpstream(document as unknown as UpstreamCeiling['metadata']);
}

/**
 * Offline evaluation from files. Packs resolve through the offline registry;
 * digests, pins and the holdout seal are re-derived inside the evaluator.
 * Returns the report object (the CLI prints it as JSON).
 */
export async function evaluateGatesFromFiles(
  files: GatesEvaluateFiles,
  options: GatesDriverOptions = {},
): Promise<GateReport> {
  const cwd = baseDir(options);
  const binding = await readDocument(resolvePath(files.bindingPath, cwd)) as GateBinding;
  const metrics = await readDocument(resolvePath(files.metricsPath, cwd)) as GateMetricsDocument;
  const holdout = await loadHoldoutFile(files.holdoutPath, cwd);
  const upstream = files.upstreamPath ? await loadUpstreamFile(files.upstreamPath, cwd) : null;
  const { registry } = buildGatesRegistry(options);
  const trustedBindingDigest = artifactDigest(binding) as Sha256Digest;
  return evaluateGates({ binding, registry, trustedBindingDigest, holdout, metrics, upstream, now: files.now });
}

export interface GatePackSummary {
  id: string;
  version: string;
  description: string;
  digest: string;
  resolvedDigest: string;
  namespace: string;
  gates: number;
}

/** List registered packs, optionally filtered by namespace. */
export function listGatePacks(
  options: GatesDriverOptions & { namespace?: string } = {},
): GatePackSummary[] {
  const { registry } = buildGatesRegistry(options);
  const entries = [...(registry as unknown as {
    packs: Map<string, { authored: GatePack; digest: Sha256Digest; namespace: string }>;
  }).packs.entries()];
  const summaries = entries.map(([id, entry]) => {
    let resolvedDigest: string = entry.digest;
    try {
      resolvedDigest = String(artifactDigest(registry.resolvePack(id).resolved));
    } catch {
      resolvedDigest = entry.digest;
    }
    return {
      id, version: entry.authored.metadata.version, description: entry.authored.metadata.description,
      digest: entry.digest, resolvedDigest, namespace: entry.namespace, gates: entry.authored.spec.gates.length,
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (options.namespace) return summaries.filter(entry => entry.namespace === options.namespace);
  return summaries;
}

/**
 * Packs referenced by one rule's `enforcedBy` frontmatter (#2830 stub; full
 * coverage is #2839). Scans bundled and project-local `rules/*.md` for an
 * `enforcedBy: [aiwg:<bundle>/<pack>#<gate>]` list naming the rule. Returns
 * the referenced pack ids (without gate fragments). Empty when no rule
 * declares `enforcedBy` — rules remain guidance until they name a check.
 */
export async function packsReferencedByRule(ruleId: string, options: GatesDriverOptions = {}): Promise<string[]> {
  const { readdir, readFile: readRuleFile, stat } = await import('node:fs/promises');
  const roots: string[] = [];
  const root = rootDir(options);
  for (const sub of ['frameworks', 'addons', 'extensions'] as const) {
    roots.push(path.join(root, 'agentic/code', sub));
  }
  roots.push(path.join(baseDir(options), '.aiwg'));
  const ruleFiles: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 5 || ruleFiles.length > 500) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (ruleFiles.length > 500) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue;
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        if (!full.replace(/\\/g, '/').includes('/rules/')) continue;
        ruleFiles.push(full);
      }
    }
  };
  for (const dir of roots) await walk(dir, 0);
  const referenced = new Set<string>();
  for (const file of ruleFiles) {
    let content: string;
    try {
      const st = await stat(file);
      if (st.size > 65_536) continue;
      content = await readRuleFile(file, 'utf8');
    } catch {
      continue;
    }
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    if (!match) continue;
    const frontmatter = match[1];
    if (!frontmatter.includes('enforcedBy')) continue;
    const ruleName = path.basename(file, '.md');
    const dirName = path.basename(path.dirname(file));
    const names = new Set([ruleName, dirName === 'rules' ? null : `${dirName}/${ruleName}`, file]);
    if (!names.has(ruleId) && ![...names].filter(Boolean).some(name => ruleId.endsWith(String(name)))) continue;
    for (const line of frontmatter.split('\n')) {
      const trimmed = line.trim().replace(/^-\s*/, '');
      const id = trimmed.match(/(aiwg|framework|addon|extension|project):[^\s,'"\]]+/)?.[1]
        ? trimmed.match(/((?:aiwg|framework|addon|extension|project):[^\s,'"\]]+)/)?.[1]
        : null;
      if (id) referenced.add(id.split('#')[0]);
    }
  }
  return [...referenced].sort();
}

/** Show one pack by full id, rest-path or short pack name. */
export function showGatePack(id: string, options: GatesDriverOptions = {}) {
  const { registry } = buildGatesRegistry(options);
  let resolved;
  try {
    resolved = registry.resolvePack(id);
  } catch (error) {
    // Rest-path lookup needs the full `<bundle>/<name>` rest; a short pack
    // name (`integrity-ceiling`) resolves when exactly one pack owns it.
    const needle = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
    if (needle.includes('/') || /\s/.test(needle)) throw error;
    const entries = [...(registry as unknown as {
      packs: Map<string, { authored: GatePack; digest: Sha256Digest; namespace: string }>;
    }).packs.keys()].filter(key => {
      const rest = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
      return rest === needle || rest.endsWith(`/${needle}`);
    }).sort();
    if (entries.length !== 1) throw error;
    resolved = registry.resolvePack(entries[0] as string);
  }
  return {
    schema: 'aiwg-gates-show/v1' as const,
    id: resolved.authored.metadata.id,
    version: resolved.authored.metadata.version,
    description: resolved.authored.metadata.description,
    digest: resolved.digest,
    resolvedDigest: resolved.resolvedDigest,
    pack: resolved.resolved,
  };
}
