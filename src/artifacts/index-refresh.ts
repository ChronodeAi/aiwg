import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findPackageRoot } from '../cli/find-package-root.js';
import { projectControlPath } from '../config/project-artifacts.js';
import { getUserStateDir } from '../config/user-state.js';
import { collectGraphIndexFiles } from './index-files.js';
import { collectIndexStatus } from './index-status.js';
import { getFortemiCoreSyncStatus, syncFortemiCoreIndex } from './fortemi-core-sync.js';
import { acquireDirectoryLock, DirectoryLockContentionError } from './prebuilt-build-lock.js';
import type { BatchImportReceipt } from '../sessions/batch-import.js';
import {
  BUILTIN_GRAPH_CONFIGS, GRAPH_CONFIGS, INDEX_EXTRACTOR_VERSION, INDEX_VERSION,
  getGraphIndexDir, graphBuildOrder, loadGlobalGraphConfigs, loadUserGraphConfigs,
  resolveGraphBackendType, resolveGraphScanDir,
} from './types.js';

export interface RefreshOptions {
  cwd?: string;
  workspaces?: string[];
  root?: string | string[];
  full?: boolean;
  only?: 'graphs' | 'sessions' | 'caches';
  dryRun?: boolean;
  lockWaitMs?: number;
  signal?: AbortSignal;
}

export interface RefreshJob {
  kind: 'graph' | 'cache' | 'sessions';
  workspace: string;
  graph?: string;
  status: 'planned' | 'ok' | 'skipped' | 'deferred' | 'error';
  wallMs: number;
  reason?: string;
  error?: string;
  sessionImport?: BatchImportReceipt;
}

export interface RefreshReport {
  contractVersion: '1.0.0';
  command: 'index.refresh';
  status: 'ok' | 'partial' | 'skipped' | 'deferred' | 'error';
  mode: 'incremental' | 'full';
  reason?: string;
  messages: string[];
  jobs: RefreshJob[];
  totals: { jobs: number; ok: number; skipped: number; deferred: number; errors: number; wallMs: number };
}

interface Checkpoint {
  runId: string;
  mode: RefreshReport['mode'];
  jobs: string[];
  completed: string[];
}

interface GateResult { ok: boolean; reason?: string }

/** Injectable boundaries for host resource sampling and interruption tests. */
export interface RefreshDependencies {
  gate?: (workspace: string) => Promise<GateResult>;
  sessionsAvailable?: () => Promise<boolean>;
  afterJob?: (job: RefreshJob, completed: number) => void;
}

function readJson<T>(file: string, tolerateMalformed = true): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (tolerateMalformed && error instanceof SyntaxError)) return undefined;
    throw error;
  }
}

function writeJson(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/** The registry is process-global; reload it per workspace to avoid cross-project leakage. */
function loadWorkspaceGraphs(workspace: string): void {
  for (const name of Object.keys(GRAPH_CONFIGS)) delete GRAPH_CONFIGS[name];
  Object.assign(GRAPH_CONFIGS, structuredClone(BUILTIN_GRAPH_CONFIGS));
  loadUserGraphConfigs(workspace);
  loadGlobalGraphConfigs();
}

function workspacePaths(options: RefreshOptions): Map<string, string[]> {
  const cwd = options.cwd ?? process.cwd();
  const found = new Map<string, string[]>();
  const add = (directory: string) => {
    const canonical = fs.realpathSync(directory);
    if (!fs.statSync(canonical).isDirectory()) throw new Error(`workspace is not a directory: ${directory}`);
    const aliases = found.get(canonical) ?? [canonical];
    if (!aliases.includes(directory)) aliases.push(directory);
    found.set(canonical, aliases);
  };
  for (const workspace of options.workspaces ?? []) add(path.resolve(cwd, workspace));
  const roots = typeof options.root === 'string' ? [options.root] : options.root ?? [];
  if (roots.length) {
    const excluded = new Set(['node_modules', '.git', '.aiwg', '.cache', '.worktrees', 'worktrees', 'aiwg-wt', '.aiwg-worktrees']);
    // Track ancestors rather than all visits so other logical routes retain their aliases.
    const ancestors = new Set<string>();
    const scan = (directory: string, depth: number): void => {
      const canonical = fs.realpathSync(directory);
      if (ancestors.has(canonical)) return;
      ancestors.add(canonical);
      if (fs.existsSync(path.join(directory, '.aiwg')) && fs.statSync(path.join(directory, '.aiwg')).isDirectory()) add(directory);
      if (depth < 4) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          if (excluded.has(entry.name)) continue;
          const child = path.join(directory, entry.name);
          if (entry.isSymbolicLink()) {
            try {
              if (!fs.statSync(child).isDirectory()) continue;
            } catch (error) {
              if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
              throw error;
            }
          } else if (!entry.isDirectory()) continue;
          scan(child, depth + 1);
        }
      }
      ancestors.delete(canonical);
    };
    for (const root of roots) scan(path.resolve(cwd, root), 0);
  }
  if (!roots.length && !options.workspaces?.length) {
    let current = fs.realpathSync(cwd);
    while (!fs.existsSync(path.join(current, '.aiwg')) && !fs.existsSync(path.join(current, '.git'))) {
      const parent = path.dirname(current);
      if (parent === current) { current = cwd; break; }
      current = parent;
    }
    add(current);
    // Keep the physical project boundary when cwd itself links into a subdirectory.
    const canonical = fs.realpathSync(current);
    for (let logical = path.resolve(cwd); ; logical = path.dirname(logical)) {
      if (fs.realpathSync(logical) === canonical) { add(logical); break; }
      if (path.dirname(logical) === logical) break;
    }
  }
  return new Map([...found.keys()].sort().map(workspace => [workspace, found.get(workspace)!.sort()]));
}

export function planIndexRefresh(options: RefreshOptions): RefreshJob[] {
  return planWorkspaceRefresh(options, workspacePaths(options));
}

function planWorkspaceRefresh(options: RefreshOptions, workspaces: Map<string, string[]>): RefreshJob[] {
  const saved = { ...GRAPH_CONFIGS };
  try {
    const jobs: RefreshJob[] = [];
    for (const workspace of workspaces.keys()) {
      loadWorkspaceGraphs(workspace);
      const graphs = collectIndexStatus(workspace).graphs
        .sort((a, b) => graphBuildOrder(a.name, GRAPH_CONFIGS[a.name]) - graphBuildOrder(b.name, GRAPH_CONFIGS[b.name]) || a.name.localeCompare(b.name));
      if (!options.only || options.only === 'graphs') {
        for (const graph of graphs) {
          if (graph.built || graph.defaultBuild || graph.origin === 'registered') {
            jobs.push({ kind: 'graph', workspace, graph: graph.name, status: 'planned', wallMs: 0 });
          }
        }
      }
      if (!options.only || options.only === 'caches') {
        for (const graph of graphs) {
          // Refresh only local, opted-in caches; never create a new cache from a packaged prebuilt.
          if (fs.existsSync(getFortemiCoreSyncStatus(workspace, graph.name).location)) {
            jobs.push({ kind: 'cache', workspace, graph: graph.name, status: 'planned', wallMs: 0 });
          }
        }
      }
      if ((!options.only || options.only === 'sessions') && fs.existsSync(path.join(workspace, '.aiwg/sessions/catalog.sqlite'))) {
        jobs.push({ kind: 'sessions', workspace, status: 'planned', wallMs: 0 });
      }
    }
    return jobs;
  } finally {
    for (const name of Object.keys(GRAPH_CONFIGS)) delete GRAPH_CONFIGS[name];
    Object.assign(GRAPH_CONFIGS, saved);
  }
}

/** Use the dispatch sampler and evaluator even when worker dispatch is disabled. */
export async function refreshResourceGate(workspace: string, live?: Record<string, unknown>): Promise<GateResult> {
  const packageRoot = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
  if (!packageRoot) throw new Error('cannot locate the resource preflight module');
  const moduleUrl = pathToFileURL(path.join(packageRoot, 'tools/scripts/resource-preflight.mjs')).href;
  const preflight = await import(moduleUrl);
  const config = readJson<{
    build?: { resource_preflight?: { dispatch?: Record<string, number> } };
    parallelism?: { admission?: { hostResources?: Record<string, number> } };
  }>(projectControlPath(workspace, 'aiwg.config'), false);
  const thresholds = preflight.resolveDispatchThresholds({
    buildDispatch: config?.build?.resource_preflight?.dispatch,
    admissionHostResources: config?.parallelism?.admission?.hostResources,
    overlay: { max_load_ratio: 0.8 },
  });
  const result = preflight.evaluateDispatchGate(live ?? preflight.readLiveHostResources({ paths: [workspace] }), thresholds);
  return { ok: result.ok, reason: result.failures.map((failure: { reason: string }) => failure.reason).join('; ') || undefined };
}

async function graphFingerprint(workspace: string, graph: string): Promise<string> {
  const files = await collectGraphIndexFiles(workspace, graph);
  // Source import resolution also depends on the compiler/package configuration.
  if (graph === 'source') {
    for (const file of ['tsconfig.json', 'package.json']) {
      if (fs.existsSync(path.join(workspace, file))) files.push(path.join(workspace, file));
    }
  }
  const stats = [...new Set(files)].sort().map(file => {
    const stat = fs.statSync(file);
    return [file, stat.mtimeMs, stat.ctimeMs, stat.size];
  });
  return createHash('sha256').update(JSON.stringify([
    INDEX_VERSION, INDEX_EXTRACTOR_VERSION, GRAPH_CONFIGS[graph], resolveGraphBackendType(graph), stats,
  ])).digest('hex');
}

async function executeJob(job: RefreshJob, options: RefreshOptions, aliases: string[]): Promise<void> {
  const workspace = job.workspace;
  if (job.kind === 'graph') {
    const graph = job.graph!;
    const config = GRAPH_CONFIGS[graph];
    if (!config.scanDirs.some(dir => fs.existsSync(resolveGraphScanDir(workspace, dir)))) {
      job.status = 'skipped';
      job.reason = 'scan directories missing';
      return;
    }
    const directory = getGraphIndexDir(workspace, graph);
    const markerPath = path.join(directory, 'refresh-state.json');
    const marker = readJson<{ fingerprint: string; builtAt: string }>(markerPath);
    const metadata = readJson<{ builtAt: string }>(path.join(directory, 'metadata.json'));
    const fingerprint = await graphFingerprint(workspace, graph);
    const outputs = ['metadata.json', 'dependencies.json', 'tags.json', 'stats.json'];
    if (resolveGraphBackendType(graph) === 'sqlite') outputs.push('graph.db');
    if (!options.full && marker?.fingerprint === fingerprint && metadata?.builtAt === marker.builtAt
      && outputs.every(file => fs.existsSync(path.join(directory, file)))) {
      job.status = 'skipped';
      job.reason = 'unchanged';
      return;
    }
    const { buildIndex } = await import('./index-builder.js');
    await buildIndex(workspace, { graph, force: Boolean(options.full), explicit: false, quiet: true });
    const built = readJson<{ builtAt: string }>(path.join(directory, 'metadata.json'));
    if (!built) throw new Error(`graph did not produce metadata: ${graph}`);
    writeJson(markerPath, { fingerprint, builtAt: built.builtAt });
  } else if (job.kind === 'cache') {
    const status = getFortemiCoreSyncStatus(workspace, job.graph);
    if (!options.full && status.built && !status.stale && !status.sourceIndexNewer) {
      job.status = 'skipped';
      job.reason = 'unchanged';
      return;
    }
    syncFortemiCoreIndex(workspace, { graph: job.graph });
  } else {
    const { refreshSessionCatalog } = await import('../sessions/refresh.js');
    const result = await refreshSessionCatalog(workspace, Boolean(options.full), options.lockWaitMs ?? 0, options.signal, aliases);
    if (typeof result === 'string') {
      job.status = 'skipped';
      job.reason = result;
      return;
    }
    if (result) {
      job.sessionImport = result;
      if (result.run.status === 'partial') {
        job.reason = `session import partial: ${result.totals.rejected} rejected, ${result.totals.pending} pending`;
      }
    }
  }
  job.status = 'ok';
}

function jobKey(job: RefreshJob, aliases: string[]): string {
  return JSON.stringify([job.kind, job.workspace, job.graph ?? null,
    ...(job.kind === 'sessions' && aliases.length > 1 ? [aliases] : [])]);
}

export async function refreshIndexes(
  options: RefreshOptions = {},
  dependencies: RefreshDependencies = {},
): Promise<RefreshReport> {
  const start = Date.now();
  const workspaces = workspacePaths(options);
  const jobs = planWorkspaceRefresh(options, workspaces);
  const report: RefreshReport = {
    contractVersion: '1.0.0', command: 'index.refresh', status: 'ok',
    mode: options.full ? 'full' : 'incremental', jobs, messages: [],
    totals: { jobs: jobs.length, ok: 0, skipped: 0, deferred: 0, errors: 0, wallMs: 0 },
  };
  const finish = () => {
    report.totals = {
      jobs: jobs.length,
      ok: jobs.filter(job => job.status === 'ok').length,
      skipped: jobs.filter(job => job.status === 'skipped').length,
      deferred: jobs.filter(job => job.status === 'deferred').length,
      errors: jobs.filter(job => job.status === 'error').length,
      wallMs: Date.now() - start,
    };
    return report;
  };
  if (options.dryRun) return finish();
  const stateDir = getUserStateDir();
  let release: () => Promise<void>;
  try {
    release = await acquireDirectoryLock(path.join(stateDir, 'index-refresh.lock'), {
      timeoutMs: options.lockWaitMs ?? 0, reclaimDeadOwner: true,
    });
  } catch (error) {
    if (!(error instanceof DirectoryLockContentionError)) throw error;
    report.status = 'skipped';
    report.reason = 'locked';
    for (const job of jobs) { job.status = 'skipped'; job.reason = 'locked'; }
    return finish();
  }
  const saved = { ...GRAPH_CONFIGS };
  try {
    const checkpointPath = path.join(stateDir, 'index-refresh-checkpoint.json');
    const keys = jobs.map(job => jobKey(job, workspaces.get(job.workspace)!));
    const previous = readJson<Checkpoint>(checkpointPath);
    const checkpoint: Checkpoint = previous?.mode === report.mode
      && Array.isArray(previous.completed) && JSON.stringify(previous.jobs) === JSON.stringify(keys)
      ? previous : { runId: randomUUID(), mode: report.mode, jobs: keys, completed: [] };
    writeJson(checkpointPath, checkpoint);
    let sqliteAvailable: boolean | undefined;
    for (const job of jobs) {
      options.signal?.throwIfAborted();
      const aliases = workspaces.get(job.workspace)!;
      const key = jobKey(job, aliases);
      if (checkpoint.completed.includes(key)) {
        job.status = 'skipped'; job.reason = 'checkpoint';
        continue;
      }
      const jobStart = Date.now();
      try {
        const gate = await (dependencies.gate ?? refreshResourceGate)(job.workspace);
        if (!gate.ok) {
          job.status = 'deferred'; job.reason = gate.reason;
          report.status = 'deferred'; report.reason = gate.reason;
          break;
        }
        loadWorkspaceGraphs(job.workspace);
        if (job.kind === 'cache' && jobs.some(other => other.kind === 'graph'
          && other.workspace === job.workspace && other.graph === job.graph && other.status === 'error')) {
          job.status = 'skipped'; job.reason = 'graph failed';
        } else if (job.kind === 'sessions') {
          sqliteAvailable ??= await (dependencies.sessionsAvailable ?? (async () => {
            const { sessionRefreshAvailable } = await import('../sessions/refresh.js');
            return sessionRefreshAvailable();
          }))();
          if (!sqliteAvailable) {
            const message = 'Session refresh skipped: run `aiwg features install sqlite`.';
            if (!report.messages.includes(message)) report.messages.push(message);
            job.status = 'skipped'; job.reason = 'sqlite unavailable';
          } else await executeJob(job, options, aliases);
        } else await executeJob(job, options, aliases);
      } catch (error) {
        job.status = 'error'; job.error = error instanceof Error ? error.message : String(error);
      } finally {
        job.wallMs = Date.now() - jobStart;
      }
      if (job.status !== 'error' && job.reason !== 'graph failed') checkpoint.completed.push(key);
      writeJson(checkpointPath, checkpoint);
      dependencies.afterJob?.(job, checkpoint.completed.length);
    }
    options.signal?.throwIfAborted();
    const deferred = jobs.some(job => job.status === 'deferred');
    if (!deferred) fs.rmSync(checkpointPath, { force: true });
    const errors = jobs.filter(job => job.status === 'error').length;
    if (errors) report.status = errors === jobs.length ? 'error' : 'partial';
    else if (!deferred) {
      if (jobs.some(job => job.sessionImport?.run.status === 'partial'
        || job.reason === 'sqlite unavailable' || job.reason?.startsWith('no authorized'))) report.status = 'partial';
    }
    return finish();
  } finally {
    for (const name of Object.keys(GRAPH_CONFIGS)) delete GRAPH_CONFIGS[name];
    Object.assign(GRAPH_CONFIGS, saved);
    await release();
  }
}

export async function runIndexRefresh(args: string[], cwd = process.cwd(), signal?: AbortSignal): Promise<RefreshReport> {
  const options: RefreshOptions = { cwd, signal, workspaces: [], root: [] };
  let json = args.includes('--json');
  try {
    for (let i = 0; i < args.length; i++) {
      const flag = args[i];
      if (flag === '--full') options.full = true;
      else if (flag === '--dry-run') options.dryRun = true;
      else if (flag === '--json') json = true;
      else if (['--workspace', '--root', '--only', '--lock-wait-ms'].includes(flag)) {
        const value = args[++i];
        if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
        if (flag === '--workspace') options.workspaces!.push(value);
        else if (flag === '--root') (options.root as string[]).push(value);
        else if (flag === '--only') {
          if (value !== 'graphs' && value !== 'sessions' && value !== 'caches') throw new Error('--only must be graphs, sessions, or caches');
          options.only = value;
        } else {
          if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('--lock-wait-ms must be a non-negative integer');
          options.lockWaitMs = Number(value);
        }
      } else throw new Error(`unknown refresh option: ${flag}`);
    }
    const report = await refreshIndexes(options);
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`Index refresh: ${report.status} (${report.mode})${report.reason ? `: ${report.reason}` : ''}`);
      for (const job of report.jobs) console.log(`  ${job.status}: ${job.kind} ${job.workspace}${job.graph ? ` [${job.graph}]` : ''}${job.error || job.reason ? `: ${job.error ?? job.reason}` : ''}`);
      for (const message of report.messages) console.log(message);
    }
    if (report.totals.errors) process.exitCode = 1;
    return report;
  } catch (error) {
    const report: RefreshReport = {
      contractVersion: '1.0.0', command: 'index.refresh', status: 'error', mode: options.full ? 'full' : 'incremental',
      jobs: [], messages: [error instanceof Error ? error.message : String(error)],
      totals: { jobs: 0, ok: 0, skipped: 0, deferred: 0, errors: 1, wallMs: 0 },
    };
    console.log(json ? JSON.stringify(report, null, 2) : `Index refresh: error: ${report.messages[0]}`);
    process.exitCode = 1;
    return report;
  }
}
