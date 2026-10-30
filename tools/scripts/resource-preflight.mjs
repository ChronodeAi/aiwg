#!/usr/bin/env node
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Installed packages ship dist/src, not src; resolve the runtime like workspace-status.mjs.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runtimeRoot = existsSync(join(packageRoot, 'src')) ? 'src' : 'dist/src';
const [
  { DEFAULT_DISPATCH_HOST_THRESHOLDS: DEFAULT_DISPATCH_THRESHOLDS, resolveDispatchHostThresholds },
  { resolveProjectAiwgDir },
] = await Promise.all([
  import(pathToFileURL(join(packageRoot, runtimeRoot, 'config/dispatch-thresholds-runtime.mjs')).href),
  import(pathToFileURL(join(packageRoot, runtimeRoot, 'config/project-artifacts-runtime.mjs')).href),
]);

const { parseMemAvailableGb, parseMemoryPsi, parseLoadAverages, countWorkerUnits, defaultCountWorkers, readLiveHostResources, evaluateDispatchGate } = await import(pathToFileURL(join(packageRoot, runtimeRoot, 'config/host-resource-runtime.mjs')).href);

const BYTES_PER_GB = 1024 ** 3;

const DEFAULT_AUTO_REQUIREMENTS = {
  min_memory_gb: 8,
  min_free_disk_gb: 5,
  min_cpus: 2,
  min_swap_gb: 0,
};

const REQUIREMENT_LABELS = {
  min_memory_gb: 'memory',
  min_free_disk_gb: 'free disk',
  min_cpus: 'CPU cores',
  min_swap_gb: 'swap',
};

const HOST_KEYS = {
  min_memory_gb: 'memory_gb',
  min_free_disk_gb: 'free_disk_gb',
  min_cpus: 'cpus',
  min_swap_gb: 'swap_gb',
};

function parseArgs(argv) {
  const args = { projectDir: process.cwd(), profile: 'default' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--project') {
      args.projectDir = argv[++i] ?? args.projectDir;
    } else if (arg === '--profile') {
      args.profile = argv[++i] ?? args.profile;
    }
  }
  args.projectDir = resolve(args.projectDir);
  return args;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readProjectConfig(projectDir) {
  const configPath = join(resolveProjectAiwgDir(projectDir), 'aiwg.config');
  try {
    return { config: readJson(configPath), configPath };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { config: null, configPath };
    throw new Error(`Unable to read ${configPath}: ${error.message}`);
  }
}

function readSwapGb() {
  if (process.platform === 'linux') {
    try {
      const meminfo = readFileSync('/proc/meminfo', 'utf8');
      const match = meminfo.match(/^SwapTotal:\s+(\d+)\s+kB$/m);
      if (match) return Number(match[1]) / 1024 / 1024;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function detectHostResources(projectDir) {
  const disk = statfsSync(projectDir);
  return {
    memory_gb: os.totalmem() / BYTES_PER_GB,
    free_disk_gb: (Number(disk.bavail) * Number(disk.bsize)) / BYTES_PER_GB,
    cpus: os.cpus().length,
    swap_gb: readSwapGb(),
  };
}

function formatValue(value, unit) {
  if (value === undefined || Number.isNaN(value)) return 'unknown';
  if (unit === 'count') return String(Math.floor(value));
  return `${value.toFixed(1)} GB`;
}

function normalizeMode(rawMode) {
  if (rawMode === undefined || rawMode === null) return 'configured';
  if (rawMode === 'configured' || rawMode === 'auto_detect') return rawMode;
  throw new Error(`build.resource_preflight.mode must be "configured" or "auto_detect" (got ${JSON.stringify(rawMode)})`);
}

function normalizeRequirements(preflight) {
  const mode = normalizeMode(preflight.mode);
  const explicit = preflight.requirements ?? {};
  if (typeof explicit !== 'object' || Array.isArray(explicit)) {
    throw new Error('build.resource_preflight.requirements must be an object when provided');
  }

  const base = mode === 'auto_detect' ? DEFAULT_AUTO_REQUIREMENTS : {};
  const requirements = { ...base };
  for (const key of Object.keys(REQUIREMENT_LABELS)) {
    if (explicit[key] === undefined) continue;
    const value = Number(explicit[key]);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`build.resource_preflight.requirements.${key} must be a non-negative number`);
    }
    requirements[key] = value;
  }
  return { mode, requirements };
}

function evaluatePreflight(config, hostResources) {
  const preflight = config?.build?.resource_preflight;
  if (!preflight || preflight.enabled !== true) {
    return { enabled: false, ok: true, failures: [], mode: 'disabled', requirements: {} };
  }

  const { mode, requirements } = normalizeRequirements(preflight);
  const failures = [];
  for (const [requirementKey, expected] of Object.entries(requirements)) {
    if (expected <= 0) continue;
    const hostKey = HOST_KEYS[requirementKey];
    const actual = hostResources[hostKey];
    if (actual === undefined || Number.isNaN(actual)) {
      failures.push({
        resource: REQUIREMENT_LABELS[requirementKey],
        expected,
        actual,
        unit: requirementKey === 'min_cpus' ? 'count' : 'gb',
        reason: 'not detectable on this host',
      });
      continue;
    }
    if (actual < expected) {
      failures.push({
        resource: REQUIREMENT_LABELS[requirementKey],
        expected,
        actual,
        unit: requirementKey === 'min_cpus' ? 'count' : 'gb',
        reason: 'below threshold',
      });
    }
  }

  return {
    enabled: true,
    ok: failures.length === 0,
    failures,
    mode,
    requirements,
  };
}

/** Adapt tool option names to the single source-owned config resolver. */
function resolveDispatchThresholds({ buildDispatch, admissionHostResources, overlay } = {}) {
  return resolveDispatchHostThresholds(buildDispatch, admissionHostResources, overlay);
}

/**
 * Tier 0 consumable dispatch check (FR-OG-107, #2954). `prepareWorkerInvocation`
 * callers and the conductor procedure call this before launch; over threshold
 * means queue, pick another qualified host, or reject with the typed failures —
 * never launch. When `parallelism.worker_dispatch` is off, legacy behaviour is
 * unchanged: `{ enabled: false, ok: true }` with no signal sampling.
 *
 * @param {object} options `{ config, live?, readers?, thresholdOverlay?, paths? }`.
 * `live` accepts a pre-sampled `readLiveHostResources()` value (tests and
 * SharedHostScheduler pass their own); otherwise signals are sampled now.
 * `paths` names the filesystems to sample free disk on (evidence root and
 * worktree); without caller-supplied paths free disk is unknown and the
 * gate fails closed rather than sampling the conductor's process cwd.
 */
function checkWorkerDispatch({ config, live, readers, thresholdOverlay, paths } = {}) {
  if (!config?.parallelism?.worker_dispatch) {
    return { enabled: false, ok: true, failures: [], reason: 'worker_dispatch is off; dispatch gate not consulted (legacy behaviour)' };
  }
  let thresholds;
  try {
    thresholds = resolveDispatchThresholds({
      buildDispatch: config?.build?.resource_preflight?.dispatch,
      admissionHostResources: config?.parallelism?.admission?.hostResources,
      overlay: thresholdOverlay,
    });
  } catch (error) {
    return { enabled: true, ok: false, failures: [{ signal: 'thresholds', reason: error.message }], thresholds: undefined };
  }
  const sampled = live ?? readLiveHostResources(paths !== undefined ? { ...readers, paths } : (readers ?? {}));
  return { enabled: true, ...evaluateDispatchGate(sampled, thresholds), live: sampled };
}

function printResult(result, { profile, configPath }) {
  if (!result.enabled) {
    console.log(`[build-preflight] skipped: build.resource_preflight.enabled is not true (${configPath})`);
    return;
  }

  const checked = Object.keys(result.requirements);
  if (checked.length === 0) {
    console.log(`[build-preflight] ${profile}: enabled in configured mode; no explicit requirements set`);
    return;
  }

  if (result.ok) {
    console.log(`[build-preflight] ${profile}: host resources satisfy ${result.mode} requirements`);
    return;
  }

  console.error(`[build-preflight] ${profile}: host resource preflight failed`);
  for (const failure of result.failures) {
    const unit = failure.unit === 'count' ? 'count' : 'gb';
    console.error(
      `  - ${failure.resource}: actual ${formatValue(failure.actual, unit)}, expected >= ${formatValue(failure.expected, unit)} (${failure.reason})`,
    );
  }
}

function printDispatchResult(result, { configPath }) {
  const live = result.live ?? {};
  const signals = [
    `availGB=${live.availMemGb === undefined ? 'unknown' : live.availMemGb.toFixed(1)}`,
    `load=${live.load1 === undefined ? 'unknown' : live.load1}`,
    `cores=${live.cores ?? 'unknown'}`,
    `memPSI10=${live.memPsiAvg10 ?? 'unknown'}`,
    `memPSI60=${live.memPsiAvg60 ?? 'unknown'}`,
    `workers=${live.workers ?? 'unknown'}`,
    `freeDiskGB=${live.freeDiskGb === undefined ? 'unknown' : live.freeDiskGb.toFixed(1)}`,
  ].join(' ');
  if (!result.enabled) {
    console.log(`[dispatch-preflight] skipped: ${result.reason} (${configPath})`);
    return;
  }
  if (result.ok) {
    console.log(`[dispatch-preflight] OK: host can take another worker or heavy run (${signals})`);
    return;
  }
  console.error('[dispatch-preflight] BLOCK: no launch or heavy run on this host');
  for (const failure of result.failures) {
    console.error(`  - ${failure.signal}: ${failure.reason}`);
  }
  console.error(`  host: ${signals}`);
}

function main({ argv = process.argv.slice(2), env = process.env, readConfig = readProjectConfig, live, readers } = {}) {
  const args = parseArgs(argv);
  if (args.profile === 'dispatch') {
    const { config, configPath } = readConfig(args.projectDir);
    // Sample the project filesystem — the evidence it will hold — never the
    // caller's process cwd.
    const result = checkWorkerDispatch({ config, live, readers, paths: live !== undefined ? undefined : [args.projectDir] });
    printDispatchResult(result, { configPath });
    if (!result.ok) process.exitCode = 1;
    return result;
  }
  if (env.AIWG_BUILD_PREFLIGHT_DONE === '1') return;
  if (env.AIWG_BUILD_PREFLIGHT === '0' || env.AIWG_BUILD_PREFLIGHT === 'false') {
    console.log('[build-preflight] skipped by AIWG_BUILD_PREFLIGHT=0');
    return;
  }
  const { config, configPath } = readConfig(args.projectDir);
  const hostResources = detectHostResources(args.projectDir);
  const result = evaluatePreflight(config, hostResources);
  printResult(result, { profile: args.profile, configPath });
  if (!result.ok) process.exitCode = 1;
  return result;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main();
}

export {
  DEFAULT_AUTO_REQUIREMENTS,
  DEFAULT_DISPATCH_THRESHOLDS,
  checkWorkerDispatch,
  defaultCountWorkers,
  countWorkerUnits,
  main,
  detectHostResources,
  evaluateDispatchGate,
  evaluatePreflight,
  normalizeRequirements,
  parseLoadAverages,
  parseMemAvailableGb,
  parseMemoryPsi,
  readLiveHostResources,
  resolveDispatchThresholds,
};
