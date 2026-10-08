#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statfsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
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

/**
 * Parse MemAvailable (kB) from /proc/meminfo text. Returns GiB or undefined
 * when the field is absent/unparsable. Pure: tests feed synthetic fixtures.
 */
function parseMemAvailableGb(meminfoText) {
  if (typeof meminfoText !== 'string') return undefined;
  const match = meminfoText.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
  if (!match) return undefined;
  const gib = Number(match[1]) / 1024 / 1024;
  return Number.isFinite(gib) ? gib : undefined;
}

/**
 * Parse memory pressure from /proc/pressure/memory text. Returns
 * `{ avg10, avg60, avg300 }` from the `some` line, or null when no `some`
 * line parses. Pure: tests feed synthetic fixtures.
 */
function parseMemoryPsi(pressureText) {
  if (typeof pressureText !== 'string') return null;
  for (const line of pressureText.split('\n')) {
    if (!line.startsWith('some')) continue;
    const values = {};
    for (const part of line.split(/\s+/)) {
      const [key, raw] = part.split('=');
      if ((key === 'avg10' || key === 'avg60' || key === 'avg300') && raw !== undefined) {
        const value = Number(raw);
        if (Number.isFinite(value)) values[key] = value;
      }
    }
    if (values.avg10 !== undefined && values.avg60 !== undefined && values.avg300 !== undefined) return values;
    return null;
  }
  return null;
}

/**
 * Parse /proc/loadavg text. Returns `{ load1, load5, load15 }` or null.
 * Pure: tests feed synthetic fixtures.
 */
function parseLoadAverages(loadavgText) {
  if (typeof loadavgText !== 'string') return null;
  const parts = loadavgText.trim().split(/\s+/);
  const loads = parts.slice(0, 3).map(Number);
  if (loads.length !== 3 || loads.some(value => !Number.isFinite(value))) return null;
  return { load1: loads[0], load5: loads[1], load15: loads[2] };
}

/** Count active current-user units with the explicit aiwg-worker- prefix. */
function countWorkerUnits({ spawn = spawnSync } = {}) {
  try {
    const result = spawn('systemctl', ['--user', 'list-units', '--type=service',
      '--state=running,activating', '--no-legend', '--plain', 'aiwg-worker-*'],
    { encoding: 'utf8', timeout: 1000 });
    if (result.error || result.status !== 0) return undefined;
    return String(result.stdout ?? '').split('\n')
      .filter(line => /^aiwg-worker-[^\s]+\.service\s/.test(line.trim())).length;
  } catch { return undefined; }
}

/**
 * Current UID only. Explicit worker units are authoritative when available;
 * otherwise count exact comm names, never shell text or arbitrary argv.
 */
function defaultCountWorkers({
  readDir = readdirSync,
  readText = path => readFileSync(path, 'utf8'),
  uid = process.getuid?.(),
  countWorkerUnits: readUnits = countWorkerUnits,
} = {}) {
  if (process.platform !== 'linux' || uid === undefined) return undefined;
  // Units cover launched workers; process names cover degraded launches and other
  // conductors. Take the larger so no worker class can hide from max_workers.
  let units;
  try {
    const counted = readUnits();
    if (Number.isInteger(counted) && counted >= 0) units = counted;
  } catch { /* Fall back to current-user process names. */ }
  let entries;
  try { entries = readDir('/proc'); } catch { return units; }
  let total = 0;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = readText(`/proc/${entry}/status`);
      const owner = status.match(/^Uid:\s+(\d+)/m);
      if (!owner || Number(owner[1]) !== uid) continue;
      const comm = readText(`/proc/${entry}/comm`).trim();
      if (comm === 'codex' || comm === 'muse-bin') total += 1;
    } catch { /* Processes may exit during the scan. */ }
  }
  return Math.max(units ?? 0, total);
}

/**
 * Sample live host signals. All inputs are injectable so tests use synthetic
 * meminfo/pressure/loadavg fixtures instead of the real /proc:
 * `{ readText, coreCount, countWorkers }`. Non-Linux hosts report
 * `{ supported: false }`; the gate turns that into an explicit diagnostic
 * (MVP qualifies Linux per NFR-OG-008) rather than an implicit pass.
 */
function readLiveHostResources(readers = {}) {
  const readText = readers.readText ?? (path => readFileSync(path, 'utf8'));
  const coreCount = readers.coreCount ?? (() => os.cpus().length);
  const countWorkers = readers.countWorkers ?? (() => defaultCountWorkers());
  if (process.platform !== 'linux' && readers.readText === undefined) {
    return { supported: false, reason: `live dispatch signals require Linux /proc (this host: ${process.platform})` };
  }
  const readOptional = (path) => {
    try {
      return readText(path);
    } catch {
      return undefined;
    }
  };
  const cores = coreCount();
  const load = parseLoadAverages(readOptional('/proc/loadavg') ?? '');
  const psi = parseMemoryPsi(readOptional('/proc/pressure/memory') ?? '');
  let workers;
  try {
    workers = countWorkers();
  } catch {
    workers = undefined;
  }
  return {
    supported: true,
    availMemGb: parseMemAvailableGb(readOptional('/proc/meminfo') ?? ''),
    load1: load?.load1,
    cores: Number.isFinite(cores) && cores > 0 ? cores : undefined,
    loadRatio: load && cores ? load.load1 / cores : undefined,
    memPsiAvg10: psi?.avg10,
    memPsiAvg60: psi?.avg60,
    memPsiAvg300: psi?.avg300,
    workers,
  };
}

/** Adapt tool option names to the single source-owned config resolver. */
function resolveDispatchThresholds({ buildDispatch, admissionHostResources, overlay } = {}) {
  return resolveDispatchHostThresholds(buildDispatch, admissionHostResources, overlay);
}

/**
 * Evaluate sampled live signals against thresholds. Every breach becomes a
 * BLOCK failure naming its signal. Unknown-but-required signals (threshold
 * configured, signal undetectable) fail closed with reason 'not detectable'.
 */
function evaluateDispatchGate(live, thresholds) {
  const failures = [];
  if (!live || live.supported === false) {
    return {
      ok: false,
      failures: [{ signal: 'platform', reason: live?.reason ?? 'live host signals unavailable' }],
      thresholds,
    };
  }
  const breach = (signal, actual, threshold, reason) => failures.push({ signal, actual, threshold, reason });
  if (live.availMemGb === undefined) breach('avail-mem', undefined, thresholds.min_avail_mem_gb, 'MemAvailable not detectable on this host');
  else if (live.availMemGb < thresholds.min_avail_mem_gb) {
    breach('avail-mem', live.availMemGb, thresholds.min_avail_mem_gb, `available ${live.availMemGb.toFixed(1)}GB < ${thresholds.min_avail_mem_gb}GB`);
  }
  if (live.loadRatio === undefined) breach('load', undefined, thresholds.max_load_ratio, 'load average not detectable on this host');
  else if (live.loadRatio > thresholds.max_load_ratio) {
    breach('load', live.loadRatio, thresholds.max_load_ratio, `load ratio ${live.loadRatio.toFixed(2)} > ${thresholds.max_load_ratio}`);
  }
  if (live.memPsiAvg10 === undefined) breach('mem-psi-avg10', undefined, thresholds.max_mem_psi_avg10, '/proc/pressure/memory not detectable on this host');
  else if (live.memPsiAvg10 > thresholds.max_mem_psi_avg10) {
    breach('mem-psi-avg10', live.memPsiAvg10, thresholds.max_mem_psi_avg10, `memory PSI avg10 ${live.memPsiAvg10} > ${thresholds.max_mem_psi_avg10}`);
  }
  if (live.memPsiAvg60 === undefined) breach('mem-psi-avg60', undefined, thresholds.max_mem_psi_avg60, '/proc/pressure/memory not detectable on this host');
  else if (live.memPsiAvg60 > thresholds.max_mem_psi_avg60) {
    breach('mem-psi-avg60', live.memPsiAvg60, thresholds.max_mem_psi_avg60, `memory PSI avg60 ${live.memPsiAvg60} > ${thresholds.max_mem_psi_avg60}`);
  }
  if (thresholds.max_workers !== undefined) {
    if (live.workers === undefined) breach('workers', undefined, thresholds.max_workers, 'worker count not detectable on this host');
    else if (live.workers >= thresholds.max_workers) {
      breach('workers', live.workers, thresholds.max_workers, `${live.workers} running workers >= ${thresholds.max_workers}`);
    }
  }
  return { ok: failures.length === 0, failures, thresholds };
}

/**
 * Tier 0 consumable dispatch check (FR-OG-107, #2954). `prepareWorkerInvocation`
 * callers and the conductor procedure call this before launch; over threshold
 * means queue, pick another qualified host, or reject with the typed failures —
 * never launch. When `parallelism.worker_dispatch` is off, legacy behaviour is
 * unchanged: `{ enabled: false, ok: true }` with no signal sampling.
 *
 * @param {object} options `{ config, live?, readers?, thresholdOverlay? }`.
 * `live` accepts a pre-sampled `readLiveHostResources()` value (tests and
 * SharedHostScheduler pass their own); otherwise signals are sampled now.
 */
function checkWorkerDispatch({ config, live, readers, thresholdOverlay } = {}) {
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
  const sampled = live ?? readLiveHostResources(readers);
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
    const result = checkWorkerDispatch({ config, live, readers });
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
