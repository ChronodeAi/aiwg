import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { resolveProjectAiwgDir } from '../config/project-artifacts.js';
import { storageConfigPath, validateStorageConfig, resolveSubsystemRootRuntime } from '../storage/config.js';
import { projectMemoryHome, projectMemoryManifestPath } from './project-registry.js';
import { listProviderMemoryAdapters, type ProviderMemoryAdapter } from './provider-memory-adapter.js';
import { getProviderConfigPath, type InjectProvider } from '../mcp/registry.js';
import { getProviderDefinition } from '../providers/provider-definitions.js';
import { MemoryObservationSchema, type MemoryObservation } from './taxonomy.js';
import { MemoryRecordSchema, loadMemoryRecord, memoryRecordId, parseMemoryMarkdown, indexMemoryAliases, detectMemoryIncludeCycles, type MemoryRecord } from './maintenance-record.js';
import { sha256 } from './context-pack.js';
import { classifyContextMemory, type ContextMemoryMetadata } from './firewall-classification.mjs';

const ExposureSchema = z.object({
  path: z.string(), provider: z.string().nullable(),
  kind: z.enum(['eligible', 'include', 'reference', 'store', 'tool-description']),
  chain: z.array(z.string()), detail: z.string(),
}).strict();
const ItemSchema = z.object({
  id: z.string(), sourcePath: z.string(), digest: z.string().nullable(), sourceDigest: z.string().nullable().optional(),
  record: MemoryRecordSchema.nullable(), category: z.string(), bytes: z.number().nullable(),
  observation: MemoryObservationSchema, exposures: z.array(ExposureSchema),
  trust: z.string(), reviewStatus: z.string(), managed: z.boolean(),
}).strict();
export const MemoryAuditSchema = z.object({
  schemaVersion: z.literal('aiwg.memory-audit.v1'),
  at: z.string().datetime(), workspace: z.string(), scope: z.enum(['workspace', 'global', 'project', 'provider']),
  providers: z.array(z.object({
    id: z.string(), support: z.string(), limits: z.array(z.string()), diagnostic: z.string().nullable(),
    precedence: z.array(z.string()),
  }).strict()),
  items: z.array(ItemSchema),
  findings: z.array(z.object({ code: z.string(), paths: z.array(z.string()), detail: z.string() }).strict()),
  coverage: z.object({
    mode: z.literal('static'), complete: z.boolean(), roots: z.array(z.string()),
    limits: z.object({ maxDepth: z.number(), maxFiles: z.number(), maxEntries: z.number(), maxMs: z.number(), maxFileBytes: z.number(), maxExposures: z.number() }).strict(),
    limitsHit: z.array(z.string()), files: z.number(), entries: z.number(),
    exclusions: z.array(z.string()),
  }).strict(),
}).strict();
export type MemoryAudit = z.infer<typeof MemoryAuditSchema>;
type AuditItem = MemoryAudit['items'][number];
type Exposure = z.infer<typeof ExposureSchema>;
export const DEFAULT_AUDIT_LIMITS = Object.freeze({
  maxDepth: 12, maxFiles: 5000, maxEntries: 20000, maxMs: 5000,
  maxFileBytes: 2 * 1024 * 1024, maxExposures: 20000,
});
export interface MemoryAuditOptions {
  workspace?: string;
  scope?: MemoryAudit['scope'];
  provider?: string;
  limits?: Partial<Record<keyof typeof DEFAULT_AUDIT_LIMITS, number>>;
  /** Deterministic monotonic clock for bounded scan tests. */
  clock?: () => number;
  at?: string;
}
const TEXT = new Set(['.md', '.mdc', '.txt', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.rst']);
const SKIP = new Set(['.git', 'node_modules', 'dist', 'coverage', '.venv', 'vendor']);
// Do not open credential files, even when linked from instruction text.
function sensitive(file: string): boolean {
  return /(?:^|[/\\])(?:\.env(?:\..*)?|auth(?:entication)?(?:\.[^/\\]+)?|credentials?(?:\.[^/\\]+)?|tokens?(?:\.[^/\\]+)?|secrets?(?:\.[^/\\]+)?|id_rsa|id_ed25519)$/i.test(file);
}
function within(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

/** Static, read-only inventory. Never constructs storage adapters or owner writers. */
export async function auditMemory(options: MemoryAuditOptions = {}): Promise<MemoryAudit> {
  const workspace = path.resolve(options.workspace ?? process.cwd());
  const scope = options.scope ?? 'workspace';
  const limits = { ...DEFAULT_AUDIT_LIMITS, ...options.limits };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} must be a positive integer`);
  }
  const adapters = listProviderMemoryAdapters().filter(a => !options.provider || a.providerId === options.provider);
  if (!adapters.length) throw new Error(`Unknown memory provider '${options.provider}'`);
  if (scope === 'provider' && !options.provider) throw new Error('--scope provider requires --provider <id>');
  const at = options.at ?? new Date().toISOString();
  const clock = options.clock ?? (() => performance.now());
  const started = clock();
  const items = new Map<string, AuditItem>();
  const findings: MemoryAudit['findings'] = [];
  const findingKeys = new Set<string>();
  const limitsHit = new Set<string>();
  const roots = new Set<string>();
  const allowedRoots = new Set<string>(scope === 'global' ? [] : [workspace]);
  const includeGraph: Record<string, string[]> = Object.create(null);
  const cache = new Map<string, { item: AuditItem; content: string }>();
  const physicalSources = new Map<string, Set<string>>();
  let files = 0;
  let entries = 0;
  let exposures = 0;
  let incomplete = false;
  const label = (file: string): string => within(workspace, file) ? path.relative(workspace, file).split(path.sep).join('/') || '.' : file;
  const evidence = (source: string, provider: string | null, status: MemoryObservation['status']): MemoryObservation => ({
    status, evidence: { source, at, provider, session: null, version: null },
  });
  const finding = (code: string, paths: string[], detail: string): void => {
    const value = { code, paths, detail };
    const key = JSON.stringify(value);
    if (!findingKeys.has(key)) { findingKeys.add(key); findings.push(value); }
  };
  function hit(bound: string, file: string): void {
    limitsHit.add(bound);
    incomplete = true;
    finding('scan-truncated', [label(file)], `${bound} reached; coverage is incomplete`);
  }
  function bounded(file: string, depth: number): boolean {
    if (clock() - started >= limits.maxMs) { hit('maxMs', file); return true; }
    if (depth > limits.maxDepth) { hit('maxDepth', file); return true; }
    if (entries >= limits.maxEntries) { hit('maxEntries', file); return true; }
    if (exposures >= limits.maxExposures) { hit('maxExposures', file); return true; }
    return false;
  }
  function expose(item: AuditItem, exposure: Exposure): void {
    if (exposures >= limits.maxExposures) { hit('maxExposures', exposure.path); return; }
    if (!item.exposures.some(e => JSON.stringify(e) === JSON.stringify(exposure))) {
      item.exposures.push(exposure);
      exposures++;
    }
  }
  function unavailable(file: string, exposure: Exposure, status: MemoryObservation['status'], detail: string): void {
    const sourcePath = label(file);
    const id = `unavailable:${status}:${sourcePath}`;
    let item = items.get(id);
    if (!item) {
      item = { id, sourcePath, digest: null, record: null, category: 'coverage', bytes: null,
        observation: evidence(detail, exposure.provider, status), exposures: [], trust: 'unknown', reviewStatus: 'unknown', managed: false };
      items.set(id, item);
    }
    expose(item, exposure);
    if (status === 'inaccessible' || status === 'opaque') incomplete = true;
  }
  function errorStatus(error: unknown): 'absent' | 'inaccessible' {
    return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '') ? 'absent' : 'inaccessible';
  }
  const rootExposure = (file: string, provider: string | null, kind: Exposure['kind'] = 'eligible'): Exposure => ({
    path: label(file), provider, kind, chain: [label(file)], detail: 'Static discovery; live activation and enabled state unverified',
  });
  async function readBounded(file: string): Promise<string | null> {
    if (files >= limits.maxFiles) { hit('maxFiles', file); return null; }
    if (clock() - started >= limits.maxMs) { hit('maxMs', file); return null; }
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o444) === 0) throw Object.assign(new Error('Unreadable regular file'), { code: 'EACCES' });
      if (stat.size > limits.maxFileBytes) { hit('maxFileBytes', file); return null; }
      files++;
      // One extra byte detects a growing file without allocating unbounded input.
      const buffer = Buffer.alloc(Math.min(stat.size + 1, limits.maxFileBytes + 1));
      let bytes = 0;
      while (bytes < buffer.length) {
        const result = await handle.read(buffer, bytes, buffer.length - bytes, null);
        if (!result.bytesRead) break;
        bytes += result.bytesRead;
      }
      if (bytes > stat.size || bytes > limits.maxFileBytes) {
        hit('maxFileBytes', file);
        return null;
      }
      return buffer.subarray(0, bytes).toString('utf8');
    } finally { await handle.close(); }
  }
  const metadataCache = new Map<string, Record<string, unknown> | null>();
  const metadataStates = new Map<string, 'ok' | 'absent' | 'unavailable'>();
  async function metadata(file: string): Promise<Record<string, unknown> | null> {
    if (metadataCache.has(file)) return metadataCache.get(file)!;
    metadataCache.set(file, null);
    metadataStates.set(file, 'unavailable');
    try {
      const real = await fs.realpath(file);
      if (sensitive(real) || ![...allowedRoots].some(root => within(root, real))) {
        unavailable(file, rootExposure(file, null, 'store'), 'opaque', 'Metadata outside selected scope or credential target excluded');
        return null;
      }
      const text = await readBounded(real);
      if (text === null) return null;
      const value: unknown = JSON.parse(text);
      const result = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
      metadataCache.set(file, result);
      if (result) metadataStates.set(file, 'ok');
      return result;
    } catch (error) {
      if (errorStatus(error) === 'absent') metadataStates.set(file, 'absent');
      else {
        unavailable(file, rootExposure(file, null, 'store'), 'inaccessible', 'Metadata could not be read or parsed');
      }
      return null;
    }
  }

  let baseline: Record<string, unknown> = {};
  let artifactRoot: string | null = null;
  const storeWorkspace = scope === 'global' ? homedir() : workspace;
  if (scope !== 'provider') {
    try { artifactRoot = resolveProjectAiwgDir(storeWorkspace); }
    catch {
      artifactRoot = null;
      const pointer = path.join(storeWorkspace, '.aiwg-location');
      unavailable(pointer, rootExposure(pointer, null, 'store'), 'inaccessible', 'Artifact root resolution failed; no fallback scan performed');
    }
  }
  if (scope !== 'provider' && artifactRoot) {
    allowedRoots.add(artifactRoot);
    const raw = await metadata(path.join(artifactRoot, 'context-memory-firewall-baseline.json'));
    if (raw?.schemaVersion === 'aiwg.context-memory-firewall-baseline/v1' && raw.files && typeof raw.files === 'object') {
      baseline = raw.files as Record<string, unknown>;
    }
  }
  async function visit(file: string, exposure: Exposure, depth: number, category: string, directoryChain: string[] = []): Promise<void> {
    if (bounded(file, depth)) return;
    entries++;
    if (sensitive(file)) {
      unavailable(file, exposure, 'opaque', 'Credential path excluded without reading');
      return;
    }
    let real: string;
    let stat;
    try {
      real = await fs.realpath(file);
      if (![...allowedRoots].some(root => within(root, real))) {
        unavailable(file, exposure, 'opaque', 'Outside selected scope; external reference was not followed');
        finding('external-reference', [label(file)], 'Select the owning scope to inventory this target');
        return;
      }
      if (sensitive(real)) { unavailable(file, exposure, 'opaque', 'Credential target excluded without reading'); return; }
      stat = await fs.stat(real);
      if ((stat.mode & 0o444) === 0 || (stat.isDirectory() && (stat.mode & 0o111) === 0)) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
    } catch (error) {
      const status = errorStatus(error);
      unavailable(file, exposure, status, `Filesystem ${status}: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`);
      if (exposure.kind === 'include' || exposure.kind === 'reference') finding('stale-reference', [exposure.chain.at(-2) ?? exposure.path, label(file)], `Reference target is ${status}`);
      return;
    }
    if (stat.isDirectory()) {
      if (directoryChain.includes(real)) { finding('include-cycle', [...directoryChain.map(label), label(real)], 'Directory symlink cycle'); return; }
      try {
        const directory = await fs.opendir(real);
        for await (const entry of directory) {
          if (bounded(file, depth)) break;
          if (SKIP.has(entry.name)) continue;
          const child = path.join(file, entry.name);
          if (entry.isDirectory() || entry.isSymbolicLink() || TEXT.has(path.extname(entry.name))) {
            await visit(child, { ...exposure, path: label(child), chain: [...exposure.chain, label(child)] }, depth + 1, category, [...directoryChain, real]);
          } else {
            entries++;
          }
        }
      } catch (error) {
        unavailable(file, exposure, 'inaccessible', `Directory enumeration failed: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`);
      }
      return;
    }
    if (!stat.isFile()) { unavailable(file, exposure, 'opaque', 'Non-regular file excluded'); return; }
    const cached = cache.get(real);
    let item: AuditItem;
    let content: string;
    if (cached) ({ item, content } = cached);
    else {
      if (files >= limits.maxFiles) { hit('maxFiles', file); return; }
      if (stat.size > limits.maxFileBytes) {
        hit('maxFileBytes', file);
        unavailable(file, exposure, 'on-disk', 'File exceeds scan byte bound; body and includes uninspected');
        return;
      }
      try {
        const text = await readBounded(real);
        if (text === null) { unavailable(file, exposure, 'on-disk', 'Scan bound reached; content uninspected'); return; }
        content = text;
      }
      catch (error) { unavailable(file, exposure, 'inaccessible', `File read failed: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`); return; }
      const sourcePath = label(real);
      const digest = sha256(content);
      const observation = evidence(`Filesystem read: ${sourcePath}; no live session telemetry`, exposure.provider, 'on-disk');
      const indexed = category === 'skill' || /(?:^|\/)(memory|kb|wiki|index)(?:\/|$)/.test(sourcePath);
      const owner = sourcePath.includes('compound-memory') ? 'compound-memory' : sourcePath.includes('line-memory') ? 'line-memory' : indexed ? 'semantic-memory' : exposure.provider ?? 'project-context';
      let record: MemoryRecord = {
        schemaVersion: 'aiwg.memory-record.v1', id: memoryRecordId(sourcePath, digest), sourcePath, digest,
        version: 1, aliases: [], supersedes: [], mergedFrom: [], splitFrom: [],
        scope: scope === 'global' ? 'global' : exposure.provider ? 'provider-native' : 'project',
        placement: category === 'prompt' ? 'task-context' : indexed ? 'indexed' : 'resident', lifecycle: 'active',
        authority: { owner, source: 'operator', protection: 'unprotected' }, observation,
      };
      if (path.extname(file) === '.json') {
        try {
          const parsed = JSON.parse(content);
          if (parsed?.schemaVersion === 'aiwg.memory-record.v1') record = { ...loadMemoryRecord(parsed), observation };
        } catch { finding('unverified-metadata', [label(file)], 'JSON metadata is invalid; no owner authority inferred'); }
      }
      if (['.md', '.mdc'].includes(path.extname(file))) {
        try {
          const { data, body } = parseMemoryMarkdown(content);
          if (data.memoryRecord !== undefined) {
            const stamped = loadMemoryRecord(data.memoryRecord);
            if (stamped.sourcePath !== sourcePath || stamped.digest !== sha256(body)) throw new Error('Stale owner metadata');
            record = { ...stamped, observation };
          }
          if (data.pinned === true) record = { ...record, authority: { ...record.authority, protection: 'pinned' } };
        } catch {
          finding('conflicting-owner-metadata', [sourcePath], 'Invalid or stale Markdown owner metadata; source review required');
        }
      }
      const manifestData = await metadata(path.join(path.dirname(real), '.aiwg-manifest.json'));
      const managedEntries = manifestData?.managed as Record<string, ContextMemoryMetadata> | undefined;
      const manifest = managedEntries?.[path.basename(real)] ?? null;
      let managed = Boolean(manifest) || /aiwg[-:]managed/i.test(content.slice(0, 8192));
      if (!managed && path.basename(real) === 'SKILL.md') {
        const marker = path.join(path.dirname(real), '.aiwg-managed');
        try { managed = (await fs.lstat(marker)).isFile(); }
        catch (error) { if (errorStatus(error) !== 'absent') unavailable(marker, exposure, 'inaccessible', 'Skill ownership marker could not be inspected'); }
      }
      const state = classifyContextMemory({ digest, managed, manifest, baselineEntry: baseline[label(real)] as ContextMemoryMetadata | undefined });
      const prior = items.get(record.id);
      if (prior?.record && JSON.stringify({ ...prior.record, observation: null }) !== JSON.stringify({ ...record, observation: null })) {
        finding('conflicting-owner-metadata', [...prior.exposures.map(e => e.path), label(file)], 'Copies share immutable identity but disagree on owner metadata; no metadata winner is established');
      }
      const copies = physicalSources.get(record.id) ?? new Set<string>();
      copies.add(real);
      physicalSources.set(record.id, copies);
      if (copies.size > 1 && record.placement === 'resident') finding('duplicate-resident-copy', [...copies].map(label), 'The same resident record identity has multiple physical copies');
      item = prior ?? { id: record.id, sourcePath: record.sourcePath, digest: record.digest, sourceDigest: digest, record,
        category, bytes: stat.size, observation, exposures: [], trust: state.trust, reviewStatus: state.reviewStatus, managed };
      items.set(item.id, item);
      cache.set(real, { item, content });
      if (!managed && exposure.provider) finding('unmanaged-artifact', [label(file)], 'No managed marker or deployment manifest entry; ownership is unverified');
      for (const code of state.findings) finding(code, [label(file)], state.reviewStatus);
      // Trust findings do not silently change the owning record's lifecycle or authority.
    }
    expose(item, exposure);
    const adapter = adapters.find(a => a.providerId === exposure.provider);
    if (adapter?.context.maxContextBytes && stat.size > adapter.context.maxContextBytes) finding('provider-truncation-risk', [label(file)], 'Durable bytes exceed the declared provider ceiling; injected bytes are unknown');
    if (category === 'tool-description' || category === 'tool-config') {
      try {
        const parsed = JSON.parse(content);
        const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
        for (const tool of tools) {
          if (bounded(file, depth)) break;
          entries++;
          if (!tool || typeof tool.name !== 'string' || /[\r\n\0]/.test(tool.name)) continue;
          const locator = `${label(file)}#tools/${encodeURIComponent(tool.name)}`;
          const digest = sha256(JSON.stringify({ name: tool.name, description: tool.description ?? null, inputSchema: tool.inputSchema ?? null }));
          const id = memoryRecordId(locator, digest);
          let descriptor = items.get(id);
          if (!descriptor) {
            descriptor = { id, sourcePath: locator, digest, record: null, category: 'tool-description',
              bytes: typeof tool.description === 'string' ? Buffer.byteLength(tool.description) : null,
              observation: evidence(`Static tool declaration: ${label(file)}; runtime registration unverified`, exposure.provider, 'on-disk'),
              exposures: [], trust: 'unknown', reviewStatus: 'unreviewed', managed: false };
            items.set(id, descriptor);
          }
          expose(descriptor, { ...exposure, path: locator, kind: 'tool-description', chain: [...exposure.chain, locator] });
        }
        const servers = parsed.mcpServers ?? parsed.mcp ?? {};
        for (const name of Object.keys(servers)) {
          if (bounded(file, depth)) break;
          entries++;
          const locator = `${label(file)}#mcp/${encodeURIComponent(name)}`;
          unavailable(locator, { ...exposure, path: locator, kind: 'tool-description', chain: [...exposure.chain, locator] }, 'opaque', 'External tool connection declared; descriptions and enabled state require live discovery');
        }
      } catch { /* Non-JSON descriptions are inventoried as files without executing tools. */ }
    }
    // Only instruction surfaces follow imports/references; stored knowledge is data.
    if (['memory-store', 'registry', 'tool-description', 'compound-memory', 'native-memory', 'tool-config'].includes(category)) return;
    const links: Array<{ target: string; kind: Exposure['kind'] }> = [];
    for (const match of content.matchAll(/(?:^|\s)@((?:~\/|\.?\.?\/)?[^\s<>`"']+\.(?:md|mdc|txt|json|ya?ml|toml))/gm)) {
      links.push({ target: match[1], kind: adapter?.context.loadMode === 'native-include' ? 'include' : 'reference' });
    }
    for (const match of content.matchAll(/\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      if (!/^[a-z][a-z\d+.-]*:/i.test(match[1]) && !match[1].startsWith('#')) links.push({ target: match[1].split('#')[0], kind: 'reference' });
    }
    if (adapter?.context.configRegistration && path.basename(file) === path.basename(adapter.context.configRegistration.file)) {
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        const value = parsed[adapter.context.configRegistration.key];
        for (const target of Array.isArray(value) ? value : []) if (typeof target === 'string') links.push({ target, kind: 'include' });
      } catch { finding('unverified-registration', [label(file)], 'Instruction registration could not be resolved statically'); }
    }
    for (const link of links) {
      if (bounded(file, depth)) break;
      const target = link.target.startsWith('~/') ? path.join(homedir(), link.target.slice(2)) : path.resolve(path.dirname(file), link.target);
      if (/[*?{}]/.test(target)) { finding('unresolved-reference', [label(file), link.target], 'Pattern reference requires provider runtime resolution'); incomplete = true; continue; }
      const next = { ...exposure, path: label(target), chain: [...exposure.chain, label(target)], kind: link.kind,
        detail: link.kind === 'include' ? 'Declared native import; live loading unverified' : 'Linked context candidate; loading inferred, not a native import claim' };
      const edges = includeGraph[label(file)] ??= [];
      if (!edges.includes(label(target))) edges.push(label(target));
      if (exposure.chain.includes(label(target))) continue;
      await visit(target, next, depth + 1, 'transitive-context');
    }
  }
  async function scanRoot(file: string, provider: string | null, category: string): Promise<void> {
    roots.add(file);
    await visit(file, rootExposure(file, provider, category === 'memory-store' || category === 'registry' ? 'store' : 'eligible'), 0, category);
  }
  // Registry reads are preflighted through the same byte bound before an
  // existing memory resolver may consult them. Other projects' bodies stay out
  // of workspace scans.
  if (scope !== 'provider') allowedRoots.add(projectMemoryManifestPath());
  const registryMetadata = scope !== 'provider' ? await metadata(projectMemoryManifestPath()) : null;
  if (scope === 'global') {
    allowedRoots.add(projectMemoryHome());
    await scanRoot(projectMemoryHome(), null, 'registry');
    if (registryMetadata?.version === 1 && Array.isArray(registryMetadata.projects)) for (const entry of registryMetadata.projects) {
      if (entry && typeof entry.memoryRoot === 'string' && path.isAbsolute(entry.memoryRoot)) {
        allowedRoots.add(entry.memoryRoot);
        await scanRoot(entry.memoryRoot, null, 'memory-store');
      }
    }
  } else if (scope !== 'provider') {
    for (const name of ['WORKSPACE.md', 'AIWG.md']) await scanRoot(path.join(workspace, name), null, 'instruction');
    await scanRoot(projectMemoryManifestPath(), null, 'registry');
  }
  if (scope !== 'provider' && artifactRoot) {
    for (const name of ['context', 'wiki', 'index', 'AIWG.md']) await scanRoot(path.join(artifactRoot, name), null, name === 'context' ? 'compound-memory' : name === 'AIWG.md' ? 'instruction' : 'memory-store');
    const configPath = storageConfigPath(storeWorkspace);
    try {
      const raw = await metadata(configPath);
      if (metadataStates.get(configPath) === 'unavailable') throw new Error('Storage config was not inspected');
      const config = raw ? validateStorageConfig(raw, configPath) : null;
      for (const subsystem of ['memory', 'kb'] as const) {
        if (config?.backends?.[subsystem] && config.backends[subsystem]?.type !== 'fs') {
          unavailable(`backend:${subsystem}`, rootExposure(`backend:${subsystem}`, null, 'store'), 'opaque', 'External backend connection configured; no network content inspected');
          continue;
        }
        if (subsystem === 'memory' && !config?.roots?.memory && metadataStates.get(projectMemoryManifestPath()) === 'unavailable') {
          // A failed registry read must never turn into an assumed default.
          unavailable(projectMemoryManifestPath(), rootExposure(projectMemoryManifestPath(), null, 'store'), 'inaccessible', 'Memory registry could not be inspected; root resolution skipped');
          continue;
        }
        const root = await resolveSubsystemRootRuntime(subsystem, storeWorkspace, config);
        allowedRoots.add(root);
        await scanRoot(root, null, 'memory-store');
      }
    } catch {
      unavailable(configPath, rootExposure(configPath, null, 'store'), 'inaccessible', 'Storage/root resolution failed; no fallback scan performed');
    }
    await scanRoot(path.join(artifactRoot, 'smiths', 'toolsmith'), null, 'tool-description');
    await scanRoot(path.join(artifactRoot, 'smiths', 'tools'), null, 'tool-description');
  }

  async function providerRoots(adapter: ProviderMemoryAdapter, base: string, nested = false): Promise<void> {
    for (const locator of adapter.memoryRoots()) {
      const global = locator.startsWith('~/') || path.isAbsolute(locator);
      if (scope === 'global' ? !global : global) continue;
      if (nested && (global || !adapter.context.nestedContext || !adapter.context.startupFiles.includes(locator))) continue;
      const expanded = locator.startsWith('~/') ? path.join(homedir(), locator.slice(2)) : path.resolve(base, locator);
      const file = expanded;
      if (scope === 'global') allowedRoots.add(expanded.split(/[*?]/)[0].replace(/\/$/, ''));
      if (/[*?]/.test(file)) {
        roots.add(file);
        const prefix = file.slice(0, file.search(/[*?]/));
        const baseDir = prefix.slice(0, prefix.lastIndexOf(path.sep));
        const segments = path.relative(baseDir, file).split(path.sep);
        async function pattern(directory: string, rest: string[], depth: number): Promise<void> {
          if (bounded(directory, depth)) return;
          if (!rest.length) { await scanRoot(directory, adapter.providerId, file.includes('/memory') ? 'native-memory' : file.includes('/rules/') ? 'rule' : 'instruction'); return; }
          const [part, ...remaining] = rest;
          if (!/[*?]/.test(part)) { await pattern(path.join(directory, part), remaining, depth + 1); return; }
          try {
            const mode = (await fs.stat(directory)).mode;
            if (!(mode & 0o444) || !(mode & 0o111)) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
            for await (const entry of await fs.opendir(directory)) {
              if (bounded(directory, depth)) break;
              entries++;
              const expression = new RegExp('^' + part.split(/([*?])/).map(p => p === '*' ? '.*' : p === '?' ? '.' : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$');
              if ((entry.isDirectory() || remaining.length === 0) && expression.test(entry.name)) await pattern(path.join(directory, entry.name), remaining, depth + 1);
            }
          } catch (error) { unavailable(directory, rootExposure(directory, adapter.providerId), errorStatus(error), 'Native memory pattern root unavailable'); }
        }
        await pattern(baseDir, segments, 0);
        continue;
      }
      if (nested) {
        try { await fs.lstat(file); }
        catch (error) { if (errorStatus(error) === 'absent') continue; }
      }
      const definition = getProviderDefinition(adapter.providerId)!;
      const artifactKind = Object.entries({ ...definition.paths.artifacts, ...definition.paths.contextDiscovery })
        .find(([, value]) => value === locator || (value && path.basename(value) === path.basename(locator)))?.[0];
      const category = artifactKind === 'agents' ? 'role' : artifactKind === 'rules' || artifactKind === 'behaviors' ? 'rule'
        : artifactKind === 'commands' ? 'prompt' : artifactKind === 'skills' || locator.includes('/skills') ? 'skill' : 'instruction';
      await scanRoot(file, adapter.providerId, /(?:^|\/)(?:memories|memory)(?:\/|$)/.test(file) ? 'native-memory' : category);
    }
  }
  for (const adapter of adapters) {
    try { await providerRoots(adapter, workspace); }
    catch { unavailable(`provider:${adapter.providerId}:roots`, rootExposure(`provider:${adapter.providerId}:roots`, adapter.providerId), 'inaccessible', 'Provider root resolution failed; other providers remain independently inventoried'); }
    const configPath = getProviderConfigPath(adapter.providerId as InjectProvider, workspace, { scope: scope === 'global' ? 'user' : 'project' });
    const alternateConfigPath = scope === 'global' ? getProviderConfigPath(adapter.providerId as InjectProvider, path.join(workspace, '__scope_probe__'), { scope: 'user' }) : '';
    if (configPath && (scope === 'global' ? configPath === alternateConfigPath : within(workspace, configPath))) {
      if (scope === 'global') allowedRoots.add(configPath);
      await scanRoot(configPath, adapter.providerId, 'tool-config');
    }
    const file = `provider:${adapter.providerId}:system`;
    unavailable(file, { path: file, provider: adapter.providerId, kind: 'eligible', chain: [file], detail: 'Provider system content has no static inspection surface' }, 'opaque', 'Hidden provider system content; live injection and enabled state unknown');
    const tools = `provider:${adapter.providerId}:tools`;
    unavailable(tools, { path: tools, provider: adapter.providerId, kind: 'tool-description', chain: [tools], detail: 'Provider runtime tool registry is not statically inspectable' }, 'opaque', 'Native tool descriptions and enabled state unknown; static declarations are inventoried separately');
  }
  // Search subtree instructions without treating ordinary repository files as resident memory.
  if (scope !== 'global') {
    async function subtree(directory: string, depth: number): Promise<void> {
      if (bounded(directory, depth)) return;
      try {
        const mode = (await fs.stat(directory)).mode;
        if (!(mode & 0o444) || !(mode & 0o111)) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        for await (const entry of await fs.opendir(directory)) {
          if (bounded(directory, depth)) break;
          entries++;
          if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
          const child = path.join(directory, entry.name);
          for (const adapter of adapters) await providerRoots(adapter, child, true);
          await subtree(child, depth + 1);
        }
      } catch (error) {
        unavailable(directory, rootExposure(directory, null), 'inaccessible', `Subtree discovery failed: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`);
      }
    }
    await subtree(workspace, 0);
  }
  for (const cycle of detectMemoryIncludeCycles(includeGraph)) finding('include-cycle', cycle, 'Transitive context cycle; traversal stopped');
  const records = [...items.values()].flatMap(item => item.record ? [item.record] : []);
  try { indexMemoryAliases(records); }
  catch { finding('alias-collision', records.filter(r => r.aliases.length).map(r => r.sourcePath), 'Owner aliases collide; no canonical alias winner was selected'); }
  const resident = [...items.values()].filter(i => i.record?.placement === 'resident');
  const digests = new Map<string, AuditItem[]>();
  for (const item of resident) if (item.digest) digests.set(item.digest, [...digests.get(item.digest) ?? [], item]);
  for (const group of digests.values()) if (group.length > 1) finding('duplicate-resident-copy', group.map(i => i.sourcePath), 'Distinct record identities contain identical resident bytes');
  for (const adapter of adapters) {
    const candidates = resident.filter(i => i.exposures.some(e => e.provider === adapter.providerId && e.kind === 'eligible'));
    if (adapter.limits.includes('nearest-nonempty-context')) {
      const native = candidates.filter(i => path.basename(i.sourcePath) === 'AGENTS.md' && (i.bytes ?? 0) > 0);
      for (const item of native) {
        const ancestors = native.filter(other => other.id !== item.id && within(path.dirname(path.resolve(workspace, other.sourcePath)), path.resolve(workspace, item.sourcePath)));
        if (ancestors.length) finding('shadow', [item.sourcePath, ...ancestors.map(i => i.sourcePath)], 'Nearest nonempty OMP context candidate; applicability depends on the selected working directory');
      }
    }
    if (adapter.providerId === 'codex') {
      for (const override of candidates.filter(i => path.basename(i.sourcePath) === 'AGENTS.override.md' && (i.bytes ?? 0) > 0)) {
        const base = candidates.find(i => path.dirname(i.sourcePath) === path.dirname(override.sourcePath) && path.basename(i.sourcePath) === 'AGENTS.md');
        if (base) finding('shadow', [override.sourcePath, base.sourcePath], 'Codex override is eligible ahead of AGENTS.md in this directory; runtime loading unverified');
      }
    }
    const byName = new Map<string, AuditItem[]>();
    for (const item of candidates) {
      const name = path.basename(item.sourcePath);
      byName.set(name, [...byName.get(name) ?? [], item]);
    }
    for (const group of byName.values()) {
      if (new Set(group.map(i => i.digest)).size < 2) continue;
      finding('potential-conflict', group.map(i => i.sourcePath), adapter.limits.includes('no-general-precedence')
        ? 'Applicable instruction surfaces differ; no general Copilot precedence is asserted'
        : 'Eligible instruction copies differ; inspect applicability before deciding precedence');
    }
  }
  return MemoryAuditSchema.parse({
    schemaVersion: 'aiwg.memory-audit.v1', at, workspace, scope,
    providers: adapters.map(a => ({ id: a.providerId, support: a.context.support, limits: [...a.limits], diagnostic: a.diagnostic,
      precedence: a.limits.includes('no-general-precedence') ? ['No general precedence; applicable personal, repository and organization instructions combine'] : a.context.precedence })),
    items: [...items.values()].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath)), findings,
    coverage: { mode: 'static', complete: !incomplete, roots: [...roots], limits, limitsHit: [...limitsHit], files, entries,
      exclusions: ['Global roots require --scope global', 'Credential files, network content and hidden system bodies are not read', 'Live activation, injected bytes and external tool descriptions are unknown', 'Linked context is eligible, not proof of provider loading'] },
  });
}

export function formatMemoryAudit(report: MemoryAudit): string {
  return [
    `Memory audit (${report.scope}): ${report.workspace}`,
    `Static inventory: ${report.items.length} items, ${report.findings.length} findings; live context unobserved`,
    `Coverage: ${report.coverage.complete ? 'complete within selected static surfaces' : 'incomplete; inspect inaccessible, opaque and truncated surfaces'}`,
    ...report.items.map(i => `  ${i.observation.status.padEnd(12)} ${i.sourcePath} [${i.category}; ${i.exposures.length} exposure(s)]`),
    ...report.findings.map(f => `  ${f.code}: ${f.paths.join(' -> ')} (${f.detail})`),
    ...(report.coverage.limitsHit.length ? [`Bounds reached: ${report.coverage.limitsHit.join(', ')}`] : []),
  ].join('\n');
}
