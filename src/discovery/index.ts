import { constants } from 'node:fs';
import { access, lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { projectMemoryManifestPath } from '../memory/project-registry.js';
import { knownWorkerCliExecutables } from '../models/worker-dispatch-offer.js';
import { loadProviderModelCapabilities } from '../models/provider-policy.js';
import { listProviderDefinitions } from '../providers/provider-definitions.js';
import type { DiscoveryDiagnosticCode, DiscoveryInventory, DiscoveryOptions, ProjectInventoryEntry } from './types.js';
export type * from './types.js';
export * from './plan-types.js';
export * from './interview.js';
export { migrateSetupPlan, readSetupPlan, writeSetupPlan, remainingPlanActions,
  unansweredPlanChoices, revalidateSetupPlan } from './plan-store.js';

export const DISCOVERY_EXCLUSIONS = [
  'node_modules', '.git', '.hg', '.svn', '.cache', '.npm', '.pnpm-store', '.yarn',
  'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.turbo', '.parcel-cache',
  'target', 'vendor', '__pycache__', '.venv', 'venv', '.tox', '.gradle', '.idea',
  // Provider payloads and AIWG artifacts are inspected by known paths, never walked.
  '.aiwg', '.claude', '.codex', '.agents', '.factory', '.opencode',
] as const;

class StopDiscovery extends Error {}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function bound(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
  return result;
}

/**
 * Read-only inventory. Workspace and registry roots are inspected shallowly.
 * Only `roots` opts in to walking; no parent discovery, home traversal, network,
 * child processes, credential reads, registry writes, or tool execution occurs.
 * Nested symlinks (even in-root links) are conservatively refused. Explicit root
 * aliases are canonicalized. Deadlines bound waiting for I/O; in-flight kernel
 * metadata operations cannot be cancelled. This is not a sandbox against a
 * concurrently hostile filesystem replacing ancestors during inspection.
 */
export async function discoverInventory(options: DiscoveryOptions = {}): Promise<DiscoveryInventory> {
  const limits = {
    maxDepth: bound(options.maxDepth, 4, 'maxDepth'),
    maxEntries: bound(options.maxEntries, 20_000, 'maxEntries'),
    timeBudgetMs: bound(options.timeBudgetMs, 2_000, 'timeBudgetMs'),
    maxFileBytes: bound(options.maxFileBytes, 256 * 1024, 'maxFileBytes'),
  };
  const now = options.now ?? (() => performance.now());
  const started = now();
  const result: DiscoveryInventory = {
    projects: [], tools: [], diagnostics: [], limits,
    stats: { entriesInspected: 0, elapsedMs: 0, truncated: false },
  };
  const report = (code: DiscoveryDiagnosticCode, path: string, message: string) => {
    result.diagnostics.push({ code, path, message });
    if (['depth-limit', 'entry-limit', 'time-limit', 'file-limit'].includes(code)) result.stats.truncated = true;
  };
  const check = (path: string) => {
    if (now() - started >= limits.timeBudgetMs) {
      report('time-limit', path, 'Discovery time budget exhausted');
      throw new StopDiscovery();
    }
  };
  // Every filesystem operation shares the same deadline and conservative entry budget.
  const io = async <T>(path: string, operation: () => Promise<T>): Promise<T> => {
    check(path);
    if (result.stats.entriesInspected >= limits.maxEntries) {
      report('entry-limit', path, 'Discovery entry budget exhausted');
      throw new StopDiscovery();
    }
    result.stats.entriesInspected++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const remaining = Math.max(1, limits.timeBudgetMs - (now() - started));
      const value = await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            report('time-limit', path, 'Discovery time budget exhausted during I/O');
            reject(new StopDiscovery());
          }, remaining);
        }),
      ]);
      check(path);
      return value;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const failure = (path: string, error: unknown) => {
    if (error instanceof StopDiscovery) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') report('inaccessible', path, `Cannot inspect path (${code ?? 'I/O error'})`);
  };
  // Check each component before access, so a provider directory symlink cannot
  // turn a known relative config path into a read outside the selected root.
  const statCache = new Map<string, Awaited<ReturnType<typeof lstat>> | null>();
  const safeStat = async (root: string, path: string) => {
    if (!within(root, path)) {
      report('outside-root', path, 'Path is outside the discovery root');
      return null;
    }
    let current = root;
    const components = relative(root, path).split(sep).filter(Boolean);
    try {
      const cachedStat = async (target: string) => {
        if (statCache.has(target)) return statCache.get(target)!;
        try {
          const value = await io(target, () => lstat(target));
          statCache.set(target, value);
          return value;
        } catch (error) {
          failure(target, error);
          statCache.set(target, null);
          return null;
        }
      };
      let info = await cachedStat(root);
      if (!info) return null;
      for (const component of components) {
        current = join(current, component);
        info = await cachedStat(current);
        if (!info) return null;
        if (info.isSymbolicLink()) {
          report('symlink-skipped', current, 'Nested symlinks are not followed');
          return null;
        }
      }
      return info;
    } catch (error) {
      failure(current, error);
      return null;
    }
  };
  const readText = async (root: string, path: string): Promise<string | null> => {
    const info = await safeStat(root, path);
    if (!info?.isFile()) return null;
    if (info.size > limits.maxFileBytes) {
      report('file-limit', path, 'Metadata exceeds maxFileBytes');
      return null;
    }
    try {
      // Closing lives inside the timed operation, so a late open/read still closes.
      const content = await io(path, async () => {
        const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const buffer = Buffer.alloc(limits.maxFileBytes + 1);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          return bytesRead > limits.maxFileBytes ? null : buffer.toString('utf8', 0, bytesRead);
        } finally { await file.close(); }
      });
      if (content === null) report('file-limit', path, 'Metadata grew beyond maxFileBytes');
      return content;
    } catch (error) { failure(path, error); return null; }
  };
  const readJson = async (root: string, path: string): Promise<Record<string, unknown> | null> => {
    const text = await readText(root, path);
    if (text === null) return null;
    try {
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value as Record<string, unknown>;
    } catch { report('invalid-metadata', path, 'Expected a JSON object'); return null; }
  };
  const exclusions = new Set<string>([...DISCOVERY_EXCLUSIONS, ...options.excludeNames ?? []]);
  const definitions = listProviderDefinitions().filter(d => d.id !== 'generic');
  for (const definition of definitions) {
    for (const path of Object.values(definition.paths.artifacts)) {
      const directory = path?.split('/')[0];
      if (directory?.startsWith('.') && directory !== '..') exclusions.add(directory);
    }
  }
  const projects = new Map<string, ProjectInventoryEntry>();
  const inspected = new Set<string>();
  const inspect = async (root: string, boundary: string, source: ProjectInventoryEntry['sources'][number], seed: boolean) => {
    const existing = projects.get(root);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      return;
    }
    if (inspected.has(root)) return;
    inspected.add(root);
    const gitDiagnosticStart = result.diagnostics.length;
    const git = await safeStat(boundary, join(root, '.git'));
    let vcs: ProjectInventoryEntry['vcs'] = git?.isDirectory() ? 'git'
      : git || result.diagnostics.length > gitDiagnosticStart ? 'unknown' : 'none';
    if (git?.isFile()) {
      const marker = await readText(boundary, join(root, '.git'));
      if (marker && /^gitdir:[ \t]*\S[^\r\n]*\r?\n?$/.test(marker)) vcs = 'worktree';
      else report('invalid-metadata', join(root, '.git'), 'Unrecognized Git marker; VCS is unknown');
    }
    const manifestPath = join(root, 'package.json');
    const manifestInfo = await safeStat(boundary, manifestPath);
    const manifest = manifestInfo?.isFile() ? await readJson(boundary, manifestPath) : null;
    const aiwg = await safeStat(boundary, join(root, '.aiwg'));
    const config = await safeStat(boundary, join(root, '.aiwg', 'aiwg.config'));
    const aiwgConfig = config?.isFile() ? await readJson(boundary, join(root, '.aiwg', 'aiwg.config')) : null;
    const context = await safeStat(boundary, join(root, 'AIWG.md'));
    const markers: string[] = [];
    for (const marker of ['pnpm-workspace.yaml', 'lerna.json', 'Cargo.toml', 'pyproject.toml', 'go.mod', 'CMakeLists.txt']) {
      if ((await safeStat(boundary, join(root, marker)))?.isFile()) markers.push(marker);
    }
    if (!seed && !git && !manifestInfo && !aiwg && !markers.length) return;
    const rawWorkspaces = manifest?.workspaces;
    const workspaces = Array.isArray(rawWorkspaces) ? rawWorkspaces
      : rawWorkspaces && typeof rawWorkspaces === 'object' ? (rawWorkspaces as Record<string, unknown>).packages : undefined;
    const patterns = Array.isArray(workspaces) ? workspaces.filter((p): p is string => typeof p === 'string') : [];
    const entry: ProjectInventoryEntry = {
      root, sources: [source], vcs, layout: 'project',
      packageManifest: manifestInfo?.isFile() ? manifestPath : null,
      workspacePatterns: patterns, packageRoots: [],
      aiwg: { directory: !!aiwg?.isDirectory(), configFile: config?.isFile() ? join(root, '.aiwg', 'aiwg.config') : null,
        contextFile: context?.isFile() ? join(root, 'AIWG.md') : null },
      providerFiles: [],
    };
    if (patterns.length || markers.includes('pnpm-workspace.yaml') || markers.includes('lerna.json')) entry.layout = 'monorepo';
    if (rawWorkspaces !== undefined && (!Array.isArray(workspaces) || patterns.length !== workspaces.length)) {
      entry.layout = 'ambiguous';
      report('ambiguous', root, 'Malformed workspace declaration; root/package choice requires confirmation');
    }
    projects.set(root, entry);
    if (Array.isArray(aiwgConfig?.providers)) {
      const capabilities = loadProviderModelCapabilities();
      for (const provider of aiwgConfig.providers) {
        if (typeof provider !== 'string') continue;
        const capability = capabilities.providers[provider as keyof typeof capabilities.providers];
        const invocation = (capability?.workerAdapter ?? capability?.workerHealthAdapter)?.invocation;
        if (invocation?.kind !== 'process') continue;
        const tool = result.tools.find(t => t.executable === invocation.executable);
        if (tool && !options.toolEvidence?.[tool.executable]?.configured) {
          tool.configured = 'yes';
          tool.evidence.push(`Provider selected in ${entry.aiwg.configFile}`);
        }
      }
    }
    for (const definition of definitions) {
      const paths = new Map<string, 'config' | 'context' | 'artifacts'>();
      for (const path of Object.values(definition.paths.artifacts)) if (path) paths.set(path, 'artifacts');
      if (definition.paths.kernelSkills) paths.set(definition.paths.kernelSkills, 'artifacts');
      for (const path of definition.context.startupFiles) paths.set(path, 'context');
      if (definition.paths.configFile) paths.set(definition.paths.configFile, 'config');
      for (const [path, kind] of paths) {
        // Home/user paths in the registry are never expanded or inspected here.
        if (path.startsWith('~') || isAbsolute(path)) continue;
        const target = resolve(root, path);
        const info = await safeStat(root, target);
        if (info && (kind === 'artifacts' ? info.isDirectory() : info.isFile())) {
          entry.providerFiles.push({ provider: definition.id, path: target, kind });
        }
      }
    }
  };
  const canonicalRoot = async (path: string): Promise<string | null> => {
    try {
      const canonical = await io(path, () => realpath(resolve(path)));
      if (!(await io(canonical, () => lstat(canonical))).isDirectory()) {
        report('inaccessible', path, 'Discovery root is not a directory');
        return null;
      }
      return canonical;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') report('inaccessible', path, 'Discovery root does not exist');
      failure(path, error); return null;
    }
  };
  const walkedDepth = new Map<string, number>();
  const walk = async (root: string, boundary: string, depth: number): Promise<void> => {
    const remaining = limits.maxDepth - depth;
    if ((walkedDepth.get(root) ?? -1) >= remaining) return;
    walkedDepth.set(root, remaining);
    await inspect(root, boundary, 'selected', depth === 0);
    if (depth >= limits.maxDepth) {
      report('depth-limit', root, 'No children inspected at maximum depth');
      return;
    }
    try {
      // Open/read incrementally: never materialize an unbounded readdir result.
      let directory: Awaited<ReturnType<typeof opendir>> | undefined;
      let abandoned = false;
      try {
        directory = await io(root, async () => {
          const handle = await opendir(root, { bufferSize: 1 });
          if (abandoned) await handle.close();
          else directory = handle;
          return handle;
        });
        while (true) {
          const child = await io(root, async () => {
            try { return await directory!.read(); }
            finally { if (abandoned) void directory!.close().catch(() => {}); }
          });
          if (!child) break;
          const path = join(root, child.name);
          if (exclusions.has(child.name)) { report('excluded', path, 'Excluded directory or metadata name'); continue; }
          if (child.isSymbolicLink()) { report('symlink-skipped', path, 'Nested symlinks are not followed'); continue; }
          if (child.isDirectory() && (await safeStat(boundary, path))?.isDirectory()) await walk(path, boundary, depth + 1);
        }
      } finally {
        abandoned = true;
        // Cleanup is not subject to the exhausted budget.
        if (directory) void directory.close().catch(() => {});
      }
    } catch (error) { failure(root, error); }
  };

  try {
    // Initialize every tool as unknown, including if an earlier scan hits a limit.
    result.tools = knownWorkerCliExecutables().map(executable => ({
      executable, path: null, installed: 'unknown', configured: 'unknown',
      authenticated: 'unknown', qualified: 'unknown', version: null,
      ...options.toolEvidence?.[executable],
      evidence: [...options.toolEvidence?.[executable]?.evidence ?? []],
    }));
    const workspace = await canonicalRoot(options.workspaceRoot ?? process.cwd());
    if (workspace) await inspect(workspace, workspace, 'workspace', true);
    let seeds = options.registrySeeds || [];
    if (options.registrySeeds === undefined) {
      const path = projectMemoryManifestPath();
      // Read only the registry manifest, never its memory roots, indices or home tree.
      const registry = await readJson(resolve(path, '..'), path);
      if (registry) {
        if (registry.version === 1 && Array.isArray(registry.projects)) {
          seeds = registry.projects.flatMap((entry: unknown) => {
            if (entry && typeof entry === 'object' && Array.isArray((entry as Record<string, unknown>).workspaceRoots)) {
              return ((entry as Record<string, unknown>).workspaceRoots as unknown[]).filter((r): r is string => typeof r === 'string');
            }
            report('invalid-metadata', path, 'Invalid registry project entry');
            return [];
          });
        } else report('invalid-metadata', path, 'Expected project memory manifest version 1');
      }
    }
    for (const seed of seeds) {
      const root = await canonicalRoot(seed === '~' ? homedir() : seed.startsWith('~/') ? join(homedir(), seed.slice(2)) : seed);
      if (root) await inspect(root, root, 'registry', true);
    }
    for (const selected of options.roots ?? []) {
      const root = await canonicalRoot(selected);
      if (!root) continue;
      if (exclusions.has(basename(root))) { report('excluded', root, 'Selected root matches a mandatory or caller exclusion'); continue; }
      // Even explicitly selecting home is unsafe for an installer scan. Select its project folders.
      if (root === resolve(homedir()) || root === resolve(sep)) {
        report('home-scan-refused', root, 'Select individual project directories instead of a home/filesystem root');
        continue;
      }
      await walk(root, root, 0);
    }
    for (const tool of result.tools) {
      let found = false;
      let uncertain = false;
      for (const dir of (options.pathEnv ?? process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
        // Direct PATH checks only; executable symlinks are legitimate package-manager shims.
        for (const name of process.platform === 'win32' ? [`${tool.executable}.exe`, `${tool.executable}.cmd`, `${tool.executable}.bat`, tool.executable] : [tool.executable]) {
          const target = resolve(dir, name);
          try {
            let info;
            try { info = await io(target, () => stat(target)); }
            catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              if (code !== 'ENOENT' && code !== 'ENOTDIR') uncertain = true;
              throw error;
            }
            if (!info.isFile()) continue;
            await io(target, () => access(target, constants.X_OK));
            tool.path = target;
            tool.installed = 'yes';
            tool.evidence.push(`Executable on PATH: ${target}`);
            found = true;
            break;
          } catch (error) { failure(target, error); }
        }
        if (found) break;
      }
      if (!found) tool.installed = uncertain ? 'unknown' : 'no';
    }
  } catch (error) { if (!(error instanceof StopDiscovery)) throw error; }

  result.projects = [...projects.values()].sort((a, b) => a.root.localeCompare(b.root));
  try {
    if (!result.diagnostics.some(d => d.code === 'time-limit')) for (const project of result.projects) {
      const children: ProjectInventoryEntry[] = [];
      for (const candidate of result.projects) {
        check(project.root);
        if (candidate.root !== project.root && within(project.root, candidate.root) && candidate.packageManifest) children.push(candidate);
      }
      project.packageRoots = children.map(p => p.root);
      if (children.length && project.layout !== 'monorepo') {
        project.layout = 'ambiguous';
        report('ambiguous', project.root, 'Nested packages without an unambiguous workspace declaration; confirm root or package');
      }
      if (project.layout === 'monorepo') {
        report('ambiguous', project.root, 'Workspace root and package roots require caller selection; packageRoots lists observed candidates only');
        for (const child of children) if (child.layout === 'project') child.layout = 'package';
      }
    }
  } catch (error) { if (!(error instanceof StopDiscovery)) throw error; }
  result.stats.elapsedMs = Math.max(0, now() - started);
  return result;
}
