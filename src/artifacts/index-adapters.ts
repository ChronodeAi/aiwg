import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getUserStateDir } from '../config/user-state.js';
import { projectAiwgPath, projectControlPath } from '../config/project-artifacts.js';
import { validateIndexConfig, type IndexConfig } from '../config/aiwg-config.js';
import { collectGraphIndexFiles, findArtifactFiles, INDEX_SCRATCH_DIRS, type ArtifactDiscoveryOptions } from './index-files.js';
import { writeIndexFile } from './index-reader.js';
import { GRAPH_CONFIGS, INDEX_VERSION, INDEX_EXTRACTOR_VERSION, getGraphIndexDir,
  resolveGraphBackendType, resolveGraphScanDir } from './types.js';
import { acquireDirectoryLock, DirectoryLockContentionError } from './prebuilt-build-lock.js';
import { resolveFrameworkIndexRoot } from './framework-index-paths.js';
import { resolveProjectLocalSearchRoots } from '../extensions/project-local-paths.js';
import { getFortemiCoreIndexDir } from './fortemi-core-sync.js';
import type { RefreshReport } from './index-refresh.js';

export type FreshnessState = 'fresh' | 'stale' | 'degraded' | 'unsupported' | 'unavailable';
export interface FreshnessPolicy {
  index: string;
  targetStaleAfterMs: number;
  maxRetriesPerDay: number;
  measureConvergence: boolean;
}
export interface ConvergenceReport { converged: boolean; wallMs: number; residualJobs: number }
export interface IndexFreshness {
  name: string;
  status: FreshnessState;
  lastVerifiedDigest: string | null;
  lastVerifiedAt: string | null;
  dirtySince: string | null;
  dirtyAgeMs: number | null;
  pendingWork: number;
  lastError: string | null;
  policy: FreshnessPolicy;
  convergence?: ConvergenceReport;
  reason?: string;
}
interface Verification {
  lastVerifiedDigest: string | null;
  lastVerifiedAt: string | null;
  dirtySince: string | null;
  pendingWork: number;
  lastError: string | null;
  outputDigest?: string;
  convergence?: ConvergenceReport;
}
export interface IndexAdapter {
  name: string;
  group: 'graphs' | 'sessions' | 'caches' | 'runtime' | 'models' | 'issues' | 'datasets';
  identity: string;
  backend: string;
  operation: string;
  graph?: string;
  supported: boolean;
  reason?: string;
  exclusions: readonly string[];
  outputPaths: string[];
  statePath: string;
  roots(cwd: string): string[];
  probe(cwd: string, nowMs?: number): Promise<IndexFreshness>;
  refresh(opts: { cwd: string; full?: boolean; dryRun?: boolean; signal?: AbortSignal }): Promise<RefreshReport>;
  convergence(last: RefreshReport): ConvergenceReport;
}

function json<T>(file: string): T | undefined {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
function canonical(root: string): string {
  try { return fs.realpathSync(root); } catch { return path.resolve(root); }
}
function hashFiles(files: string[], context: unknown): string {
  const hash = createHash('sha256').update(JSON.stringify(context));
  for (const file of [...new Set(files)].sort()) {
    hash.update('\0').update(file).update('\0').update(fs.readFileSync(file));
  }
  return hash.digest('hex');
}

/** Same authorized source set as the builder, including links and bundle roots. */
export async function graphIndexDigest(cwd: string, graph?: string,
  observation: { files?: string[]; fileStats?: Map<string, fs.Stats>; selection?: ArtifactDiscoveryOptions['selection'] } = {}): Promise<string> {
  const fileStats = observation.fileStats ?? new Map<string, fs.Stats>();
  const files = observation.files ? [...observation.files]
    : graph === 'source' ? (await import('./source-graph.js')).collectSourceFiles(cwd, true)
      : await collectGraphIndexFiles(cwd, graph, { selection: observation.selection, fileStats });
  const ignoreRoots = graph && GRAPH_CONFIGS[graph]?.shared && graph !== 'framework' ? [] : [cwd];
  if (graph) ignoreRoots.push(...GRAPH_CONFIGS[graph].scanDirs.map(dir => resolveGraphScanDir(cwd, dir)));
  for (const root of ignoreRoots) {
    const ignoreFile = path.join(root, '.gitignore');
    if (fs.existsSync(ignoreFile)) files.push(ignoreFile);
  }
  if (graph === 'source') for (const file of ['tsconfig.json', 'package.json']) {
    if (fs.existsSync(path.join(cwd, file))) files.push(path.join(cwd, file));
  }
  // Supplements affect graph entries even though they are outside scanDirs.
  for (const supplement of (graph ? GRAPH_CONFIGS[graph]?.metadataSupplements : undefined) ?? []) {
    files.push(...findArtifactFiles(resolveGraphScanDir(cwd, supplement.scanDir)));
  }
  const inputs = [...new Set(files)].sort().map(file => {
    const stat = fileStats.get(file) ?? fs.statSync(file);
    return [file, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
  });
  return createHash('sha256').update(JSON.stringify([graph && GRAPH_CONFIGS[graph]?.shared ? null : canonical(cwd), INDEX_VERSION, INDEX_EXTRACTOR_VERSION,
    graph ? GRAPH_CONFIGS[graph] : null, resolveGraphBackendType(graph), inputs])).digest('hex');
}

export function resolveFreshnessPolicy(cwd: string, adapter: Pick<IndexAdapter, 'name' | 'group'>): FreshnessPolicy {
  const config = json<{ index?: IndexConfig }>(projectControlPath(cwd, 'aiwg.config'))?.index;
  const errors = validateIndexConfig(config && { freshness: config.freshness });
  if (errors.length) throw new Error(errors.join('; '));
  const defaults: Record<IndexAdapter['group'], number> = {
    graphs: 3_600_000, sessions: 900_000, caches: 86_400_000, runtime: 21_600_000,
    models: 86_400_000, issues: 300_000, datasets: 86_400_000,
  };
  return { index: adapter.name, targetStaleAfterMs: defaults[adapter.group], maxRetriesPerDay: 3,
    measureConvergence: true, ...config?.freshness?.[adapter.group], ...config?.freshness?.[adapter.name] };
}

/** Registry is bounded by graph registrations and existing owner scopes. No host discovery. */
export function indexAdapterRegistry(cwd: string): IndexAdapter[] {
  const adapters: IndexAdapter[] = [];
  const add = (definition: Omit<IndexAdapter, 'probe' | 'refresh' | 'convergence'>) => {
    const adapter: IndexAdapter = { ...definition,
      probe: (workspace, nowMs) => probeIndexAdapter(adapter, workspace, nowMs),
      refresh: async opts => {
        const { refreshIndexes } = await import('./index-refresh.js');
        return refreshIndexes({ cwd: opts.cwd, only: adapter.name, full: opts.full,
          dryRun: opts.dryRun, signal: opts.signal });
      },
      convergence: last => {
        const jobs = last.jobs.filter(job => definition.group === 'graphs' ? job.kind === 'graph' && job.graph === definition.graph
          : definition.group === 'caches' ? job.kind === 'cache' && job.graph === definition.graph : job.kind === definition.name);
        return { converged: jobs.length > 0 && jobs.every(job => job.freshness?.status === 'fresh'
          && job.freshness.convergence?.converged !== false), wallMs: last.totals.wallMs,
          residualJobs: jobs.filter(job => job.freshness?.status !== 'fresh').length };
      },
    };
    adapters.push(adapter);
  };
  for (const [graph, config] of Object.entries(GRAPH_CONFIGS)) {
    const directory = getGraphIndexDir(cwd, graph);
    const outputs = ['metadata.json', 'dependencies.json', 'tags.json', 'stats.json'];
    if (resolveGraphBackendType(graph) === 'sqlite') outputs.push('graph.db');
    if (graph === 'framework') outputs.push('relations.json');
    add({ name: graph, graph, group: 'graphs', identity: canonical(directory),
      backend: resolveGraphBackendType(graph), operation: 'buildIndex', supported: true,
      exclusions: [...INDEX_SCRATCH_DIRS, 'symlinks', 'gitignored', 'hidden directories'],
      roots: workspace => [...new Set([
        ...config.scanDirs.map(dir => canonical(resolveGraphScanDir(graph === 'framework' ? resolveFrameworkIndexRoot(workspace) : workspace, dir))),
        ...(graph === 'project' ? [canonical(workspace), ...resolveProjectLocalSearchRoots(workspace).map(root => canonical(root.rootPath))] : []),
      ])],
      outputPaths: outputs.map(file => path.join(directory, file)), statePath: path.join(directory, 'freshness.json') });
    if (graph === 'framework') {
      const owner = adapters[adapters.length - 1];
      add({ ...owner, name: 'relationships', operation: 'buildIndex(framework):relations',
        reason: 'Relationship projection shares the framework snapshot and owner lock' });
    }
    const cacheDirectory = getFortemiCoreIndexDir(cwd, graph);
    if (fs.existsSync(cacheDirectory)) add({ name: `caches:${graph}`, graph, group: 'caches',
      identity: canonical(cacheDirectory), backend: 'fortemi-core', operation: 'syncFortemiCoreIndex',
      supported: true, exclusions: ['remote mutation'], roots: () => [canonical(directory)],
      outputPaths: ['manifest.json', 'aiwg-fortemi-index-v2.json'].map(file => path.join(cacheDirectory, file)),
      statePath: path.join(cacheDirectory, 'freshness.json') });
  }
  const scopes = [
    { name: 'sessions', directory: path.join(cwd, '.aiwg/sessions'), backend: 'sqlite',
      operation: 'refreshSessionCatalog', outputs: ['catalog.sqlite'] },
    { name: 'runtime', directory: projectAiwgPath(cwd, 'smiths/toolsmith'), backend: 'json',
      operation: 'RuntimeDiscovery', outputs: ['runtime.json', 'runtime-info.md'] },
    { name: 'issues', directory: projectAiwgPath(cwd, 'issues'), backend: 'json',
      operation: 'LocalIssueProviderCore.rebuildIssueIndex', outputs: ['index/issues.index.json'] },
  ] as const;
  for (const scope of scopes) {
    // Absent opt-in scopes are visible as unavailable; planning still respects opt-in.
    add({ name: scope.name, group: scope.name, identity: canonical(scope.directory), backend: scope.backend,
      operation: scope.operation, supported: true, exclusions: ['undeclared provider roots', 'auth and token files'],
      roots: workspace => {
        if (scope.name !== 'sessions') return [canonical(scope.directory)];
        let config: { sessions?: { discovery_manifests?: string[] } } | undefined;
        try { config = json(projectControlPath(workspace, 'aiwg.config')); } catch { return []; }
        const manifests = [path.join(workspace, '.aiwg/sessions/discovery-manifest.json'),
          ...(config?.sessions?.discovery_manifests ?? []).map(file => path.resolve(workspace, file))];
        return [...new Set(manifests.flatMap(file => {
          try {
            const manifest = json<{ authorizedRoots?: Record<string, string[]> }>(file);
            return Object.values(manifest?.authorizedRoots ?? {}).flat().map(canonical);
          } catch { return []; }
        }))];
      }, outputPaths: scope.outputs.map(file => path.join(scope.directory, file)),
      statePath: path.join(scope.directory, '.index', 'freshness.json') });
  }
  for (const name of ['models', 'datasets'] as const) add({ name, group: name,
    identity: `${name}:${canonical(cwd)}`, backend: 'remote', operation: name === 'models'
      ? 'resolveDynamicModelCatalog' : 'dataset owner', supported: false,
    reason: `${name} has no local deterministic freshness probe; use its owning operation`,
    roots: () => [], outputPaths: [], exclusions: ['remote-only owners'],
    statePath: projectAiwgPath(cwd, '.index', `${name}-freshness.json`) });
  return adapters;
}

export function selectIndexAdapters(adapters: IndexAdapter[], only = 'all'): IndexAdapter[] {
  if (only === 'all') return adapters;
  const selected = adapters.filter(adapter => adapter.name === only || adapter.group === only);
  if (!selected.length && !['sessions', 'issues', 'caches'].includes(only)) throw new Error(`Unknown index: ${only}`);
  return selected;
}

async function adapterDigest(adapter: IndexAdapter, cwd: string): Promise<string> {
  if (adapter.group === 'graphs') return graphIndexDigest(adapter.graph === 'framework' ? resolveFrameworkIndexRoot(cwd) : cwd, adapter.graph);
  if (adapter.group === 'caches') return hashFiles(
    ['metadata.json', 'dependencies.json'].map(file => path.join(getGraphIndexDir(cwd, adapter.graph!), file)), adapter.identity);
  if (adapter.group === 'issues') return hashFiles(
    ['items', 'events', 'comments'].flatMap(dir => findArtifactFiles(projectAiwgPath(cwd, 'issues', dir), ['.md', '.json', '.jsonl'])), adapter.identity);
  if (adapter.group === 'sessions') {
    const { readDiscoveryManifest, discoverWorkspaceHistories } = await import('../sessions/workspace-discovery.js');
    const config = json<{ sessions?: { discovery_manifests?: string[]; import?: { exclude?: string[] } } }>(projectControlPath(cwd, 'aiwg.config'));
    const manifests = [path.join(cwd, '.aiwg/sessions/discovery-manifest.json'),
      ...(config?.sessions?.discovery_manifests ?? []).map(file => path.resolve(cwd, file))];
    const inputs: string[] = [];
    for (const file of [...new Set(manifests)]) if (fs.existsSync(file)) {
      const previous = await readDiscoveryManifest(file);
      if (previous.workspaceId !== canonical(cwd)) throw new Error('discovery manifest workspace mismatch');
      const authorizedRoots = previous.authorizedRoots ?? {};
      if (!previous.authorizedRoots) for (const source of previous.sources) {
        const roots = authorizedRoots[source.provider] ??= [];
        if (!roots.includes(source.authorizedRoot)) roots.push(source.authorizedRoot);
      }
      const current = await discoverWorkspaceHistories({ workspace: cwd,
        refreshFrom: { ...previous, authorizedRoots }, knownSources: previous.sources,
        exclude: config?.sessions?.import?.exclude });
      inputs.push(current.manifestId);
    }
    if (!inputs.length) throw new Error('no authorized discovery manifest');
    return createHash('sha256').update(JSON.stringify([adapter.identity, inputs])).digest('hex');
  }
  // RuntimeDiscovery owns environmental discovery; its input receipt bounds this probe.
  const runtime = json<{ inputFingerprint?: string }>(adapter.outputPaths[0]);
  if (!runtime?.inputFingerprint) throw new Error('runtime input fingerprint unavailable');
  return hashFiles([projectControlPath(cwd, 'aiwg.config')].filter(file => fs.existsSync(file)), runtime.inputFingerprint);
}

function outputDigest(adapter: IndexAdapter): string | undefined {
  if (!adapter.outputPaths.every(file => fs.existsSync(file))) return undefined;
  // The owner may renew stats on an unchanged build. Snapshot identity follows primary output.
  const stat = fs.statSync(adapter.outputPaths[0], { bigint: true });
  // Rename changes ctime during publication; inode, mtime and size survive it.
  return createHash('sha256').update(JSON.stringify([adapter.identity, String(stat.dev), String(stat.ino),
    String(stat.size), String(stat.mtimeNs)])).digest('hex');
}

/** Synchronous persisted view for existing reader callers; CLI/daemon also probe inputs. */
export function indexFreshnessSnapshot(adapter: IndexAdapter, cwd: string, nowMs = Date.now(), digest?: string): IndexFreshness {
  const fallback: FreshnessPolicy = { index: adapter.name, targetStaleAfterMs: 3_600_000,
    maxRetriesPerDay: 3, measureConvergence: true };
  let policy = fallback;
  try {
    policy = resolveFreshnessPolicy(cwd, adapter);
    if (!adapter.supported) return { name: adapter.name, status: 'unsupported', policy,
      lastVerifiedDigest: null, lastVerifiedAt: null, dirtySince: null, dirtyAgeMs: null,
      pendingWork: 0, lastError: null, reason: adapter.reason };
    const state = json<Verification>(adapter.statePath);
    const outputs = outputDigest(adapter);
    const age = state?.lastVerifiedAt ? Math.max(0, nowMs - Date.parse(state.lastVerifiedAt)) : Infinity;
    const changed = !state || !outputs || outputs !== state.outputDigest || (digest !== undefined && state.lastVerifiedDigest !== digest);
    const dirtySince = state?.dirtySince ?? (changed ? new Date(nowMs).toISOString()
      : age > policy.targetStaleAfterMs ? new Date(Date.parse(state!.lastVerifiedAt!) + policy.targetStaleAfterMs).toISOString() : null);
    return { name: adapter.name, policy,
      status: !outputs ? 'unavailable' : state?.lastError ? 'degraded'
        : changed || state?.pendingWork || age > policy.targetStaleAfterMs ? 'stale' : 'fresh',
      lastVerifiedDigest: state?.lastVerifiedDigest ?? null, lastVerifiedAt: state?.lastVerifiedAt ?? null,
      dirtySince, dirtyAgeMs: dirtySince ? Math.max(0, nowMs - Date.parse(dirtySince)) : null,
      pendingWork: changed ? Math.max(1, state?.pendingWork ?? 0) : state?.pendingWork ?? 0,
      lastError: state?.lastError ?? null, convergence: policy.measureConvergence && state?.convergence
        ? { ...state.convergence, converged: state.convergence.residualJobs === 0
          && state.convergence.wallMs <= policy.targetStaleAfterMs } : undefined };
  } catch (error) {
    return { name: adapter.name, status: 'degraded', policy, lastVerifiedDigest: null, lastVerifiedAt: null,
      dirtySince: null, dirtyAgeMs: null, pendingWork: 1, lastError: String(error) };
  }
}

export async function probeIndexAdapter(adapter: IndexAdapter, cwd: string, nowMs = Date.now()): Promise<IndexFreshness> {
  const persisted = indexFreshnessSnapshot(adapter, cwd, nowMs);
  if (!adapter.supported || persisted.status === 'unavailable') return persisted;
  try {
    if (adapter.group === 'sessions') {
      const { sessionRefreshAvailable } = await import('../sessions/refresh.js');
      if (!sessionRefreshAvailable()) return { ...persisted, status: 'unavailable', pendingWork: 1,
        reason: 'sqlite unavailable' };
    }
    if (adapter.group === 'caches') {
      const { getFortemiCoreSyncStatus } = await import('./fortemi-core-sync.js');
      const cache = getFortemiCoreSyncStatus(cwd, adapter.graph);
      if (cache.stale && !cache.sourceIndexNewer) return { ...persisted, status: 'degraded',
        pendingWork: 1, lastError: cache.reason };
    }
    const digest = await adapterDigest(adapter, cwd);
    let snapshot = indexFreshnessSnapshot(adapter, cwd, nowMs, digest);
    // Preserve the first measured dirty observation without racing a publisher.
    // Probe never builds or creates an absent index.
    if (fs.existsSync(adapter.statePath)
      && snapshot.status === 'stale' && snapshot.lastVerifiedDigest !== digest) {
      let release: (() => Promise<void>) | undefined;
      try {
        release = await acquireDirectoryLock(adapter.group === 'graphs'
          ? `${path.dirname(adapter.statePath)}.build.lock` : path.join(getUserStateDir(), 'index-refresh.lock'), { timeoutMs: 0 });
        const state = json<Verification>(adapter.statePath);
        if (state && !state.dirtySince && state.lastVerifiedDigest !== digest) {
          writeIndexFile(cwd, path.basename(adapter.statePath), { ...state,
            dirtySince: new Date(nowMs).toISOString(), pendingWork: 1 }, path.dirname(adapter.statePath));
        }
        snapshot = indexFreshnessSnapshot(adapter, cwd, nowMs, digest);
      } catch (error) { if (!(error instanceof DirectoryLockContentionError)) throw error; }
      finally { await release?.(); }
    }
    return snapshot;
  }
  catch (error) { return { ...indexFreshnessSnapshot(adapter, cwd, nowMs), status: 'degraded',
    pendingWork: 1, lastError: error instanceof Error ? error.message : String(error) }; }
}

export async function indexAdapterDigest(adapter: IndexAdapter, cwd: string): Promise<string | undefined> {
  if (!adapter.supported) return undefined;
  return adapterDigest(adapter, cwd);
}

/** Call under the existing owner lock; failure never advances verification. */
export function recordIndexVerification(adapter: IndexAdapter, cwd: string, opts: {
  before?: string; after?: string; error?: string; pendingWork?: number; wallMs: number; nowMs?: number;
}, publicationDir?: string): IndexFreshness {
  const now = opts.nowMs ?? Date.now();
  let prior: Verification | undefined;
  try { prior = json<Verification>(adapter.statePath); } catch { /* Replace corrupt receipt, never the snapshot. */ }
  const complete = !opts.error && !!opts.before && opts.before === opts.after && !opts.pendingWork;
  const policy = resolveFreshnessPolicy(cwd, adapter);
  const state: Verification = { lastVerifiedDigest: complete ? opts.after! : prior?.lastVerifiedDigest ?? null,
    lastVerifiedAt: complete ? new Date(now).toISOString() : prior?.lastVerifiedAt ?? null,
    dirtySince: complete ? null : prior?.dirtySince ?? new Date(now).toISOString(),
    pendingWork: complete ? 0 : Math.max(1, opts.pendingWork ?? 0), lastError: opts.error ?? null,
    outputDigest: complete ? outputDigest(publicationDir ? { ...adapter, outputPaths: adapter.outputPaths.map(file =>
      fs.existsSync(path.join(publicationDir, path.basename(file))) ? path.join(publicationDir, path.basename(file)) : file) } : adapter) : prior?.outputDigest,
    ...(policy.measureConvergence ? { convergence: { converged: complete && opts.wallMs <= policy.targetStaleAfterMs,
      wallMs: opts.wallMs, residualJobs: complete ? 0 : Math.max(1, opts.pendingWork ?? 0) } } : {}) };
  writeIndexFile(cwd, path.basename(adapter.statePath), state, publicationDir ?? path.dirname(adapter.statePath));
  return indexFreshnessSnapshot(adapter, cwd, now, opts.after);
}
