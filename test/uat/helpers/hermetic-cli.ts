/**
 * Shared hermetic child-process helper for the stub UAT lane.
 *
 * Every scenario in this directory that exercises real `aiwg` CLI behavior
 * (as opposed to in-process handler calls) spawns the real built CLI
 * (`bin/aiwg.mjs` -> `dist/src/cli/router.js`, the same entry point
 * `test/integration/cli-startup.test.ts` and `cli-perf.test.ts` use — no
 * tsx fork, no source-via-transform shortcut) as a child process with:
 *
 *   - `HOME` inherited from the real environment, same as the existing UAT
 *     lane (`test/uat/aiwg-config-flow.uat.ts`) and `cli-startup.test.ts`,
 *     per the standing instruction not to override `HOME` beyond existing
 *     precedent — this dev checkout's "installation identity" check reads
 *     real-home state and fails closed against a synthetic one;
 *   - a caller-controlled, explicit `PATH` (never inherited verbatim);
 *   - `AIWG_CONFIG` isolated to a scratch directory so config/package/nudge
 *     resolution never depends on what is actually in the operator's real
 *     `~/.aiwg` (user-config-dir.mjs: an explicit `AIWG_CONFIG` always
 *     wins over home-based resolution);
 *   - every known provider harness-detection env var (CLAUDECODE, CODEX_*,
 *     ...) cleared unless the caller deliberately sets one, so this suite's
 *     own execution context (which may itself be a Claude Code or Codex
 *     session) can never leak into the CLI-under-test's provider detection,
 *   - `CI` cleared unless the caller deliberately sets it,
 *   - a bounded `timeout` and no inherited stdin (`stdio: ['ignore', ...]`).
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// test/uat/helpers/hermetic-cli.ts -> repo root is three levels up.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '../../..');
export const ROUTER_PATH = path.join(REPO_ROOT, 'dist', 'src', 'cli', 'router.js');
export const BIN_PATH = path.join(REPO_ROOT, 'bin', 'aiwg.mjs');

/** True when `npm run build:cli` has not produced `dist/` yet. Suites using
 * this helper should `describe.skipIf(missingBuiltCli())` so the fast
 * unit-test workflow is never forced to build first. */
export function missingBuiltCli(): boolean {
  return !existsSync(ROUTER_PATH);
}

// AIWG's own installation-identity check (src/installation/manager.mjs) can
// shell out to `which git` to resolve the source-install manager executable
// when no identity has been recorded yet under the isolated `AIWG_CONFIG`
// scratch directory this helper always uses. Without a `git` on PATH, that
// resolution fails and every command reports a false "installation identity
// drift" usage error. `git` is baseline host plumbing, not a worker CLI this
// suite is trying to isolate from, so these system directories are always
// present on the constructed PATH, before whatever the caller adds via
// `pathDirs`.
const SYSTEM_PATH_DIRS = ['/usr/bin', '/bin'].filter((dir) => existsSync(dir));

// Some `aiwg` subcommands (e.g. `doctor`) shell out to `node <script>` by
// bare name rather than `process.execPath`, so a `node` executable must also
// resolve on PATH. The real Node install directory (e.g. an nvm shim dir)
// cannot be used for this: on a host with worker CLIs installed as npm
// globals, that same directory can also contain `claude`/`codex`/etc.,
// silently defeating the "construct PATH so detection does not depend on
// what this host has installed" isolation this suite exists to provide.
// Instead, a scratch directory holding *only* a `node` symlink to the
// currently-running binary is created once and reused.
let cachedNodeOnlyDir: string | null = null;
function nodeOnlyPathDir(): string {
  if (cachedNodeOnlyDir) return cachedNodeOnlyDir;
  const dir = mkdtempSync(path.join(tmpdir(), 'aiwg-uat-node-only-'));
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  symlinkSync(process.execPath, path.join(dir, name));
  cachedNodeOnlyDir = dir;
  return dir;
}
SYSTEM_PATH_DIRS.unshift(nodeOnlyPathDir());

let cachedMarkerNames: string[] | null = null;

/**
 * Every provider-detection env var name declared across
 * `src/providers/provider-definitions.ts` (`detection.env`), flattened and
 * deduplicated. Read from the product's own registry rather than
 * hand-maintained here, so a new provider's marker is covered automatically.
 */
export async function harnessMarkerEnvNames(): Promise<string[]> {
  if (cachedMarkerNames) return cachedMarkerNames;
  // @ts-ignore - resolved relative to the repo root, loaded via vitest's TS transform
  const { listProviderDefinitions } = await import(path.join(REPO_ROOT, 'src/providers/provider-definitions.js'));
  const names = new Set<string>();
  for (const definition of listProviderDefinitions()) {
    for (const name of definition.detection?.env ?? []) names.add(name);
  }
  cachedMarkerNames = [...names].sort();
  return cachedMarkerNames;
}

export interface HermeticEnvOptions {
  /** Directories placed on PATH *before* the baseline system directories
   * (`SYSTEM_PATH_DIRS`) — the right place for fake/fixture executables so
   * they are found first. Defaults to none. */
  pathDirs?: string[];
  /** Overrides `AIWG_CONFIG` (read by package/marketplace/nudge paths). Most
   * callers should pass a fresh scratch directory. */
  aiwgConfig?: string;
  /** Extra env entries, applied last (can override anything above,
   * including deliberately re-setting a harness marker or `CI`). */
  extra?: Record<string, string>;
}

/**
 * Build a deliberate environment for one child-process invocation. Starts
 * from a copy of the real `process.env` (so `HOME` and the installation
 * identity it anchors keep working — see the module doc), then overwrites
 * every variable this suite cares about explicitly, and clears every known
 * provider harness-detection marker plus `CI` so the invoking test runner's
 * own session can never leak into the CLI-under-test's provider detection.
 */
export async function buildHermeticEnv(options: HermeticEnvOptions = {}): Promise<Record<string, string>> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  env.PATH = [...(options.pathDirs ?? []), ...SYSTEM_PATH_DIRS].join(path.delimiter);
  // Process plumbing Node itself may need; never a credential or harness marker.
  env.NO_COLOR = '1';
  env.NO_UPDATE_NOTIFIER = '1';
  env.AIWG_NO_UPDATE_CHECK = '1';
  env.AIWG_LOG_DISABLE = '1';
  env.AIWG_PROMPT_TIMEOUT_MS = '5000';
  if (options.aiwgConfig) env.AIWG_CONFIG = options.aiwgConfig;
  else delete env.AIWG_CONFIG;
  // Harness markers and CI are deliberately cleared, not merely left as
  // whatever the real invoking session happened to set.
  const markers = await harnessMarkerEnvNames();
  for (const marker of markers) delete env[marker];
  delete env.CI;
  Object.assign(env, options.extra ?? {});
  return env;
}

export interface RunCliResult {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  error: Error | undefined;
}

export interface RunCliOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Spawn the real built CLI (`bin/aiwg.mjs`) as a bounded child process.
 * Never inherits stdin (`stdio[0]: 'ignore'`); always has an explicit
 * `timeout` so a hang fails the test instead of wedging the suite.
 */
export function runAiwgCli(args: string[], options: RunCliOptions): RunCliResult {
  const result: SpawnSyncReturns<string> = spawnSync(process.execPath, [BIN_PATH, ...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf-8',
    timeout: options.timeoutMs ?? 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
    signal: result.signal,
    error: result.error,
  };
}

/**
 * Hash every regular file under `root` (relative path -> sha256 of its
 * bytes), so a before/after comparison can prove "zero files created or
 * modified" without trusting any single command's own report of what it
 * touched. Skips nothing — including dotfiles and nested `.aiwg/` output —
 * so an unexpected new file shows up as an added key, not a silent miss.
 */
export function hashTree(root: string): Map<string, string> {
  const manifest = new Map<string, string>();
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const relative = path.relative(root, absolute);
        manifest.set(relative, createHash('sha256').update(readFileSync(absolute)).digest('hex'));
      }
    }
  };
  if (existsSync(root)) visit(root);
  return manifest;
}

/** Diff two `hashTree()` manifests: files added, removed, or changed. */
export function diffTrees(before: Map<string, string>, after: Map<string, string>): { added: string[]; removed: string[]; changed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [relative, hash] of after) {
    if (!before.has(relative)) added.push(relative);
    else if (before.get(relative) !== hash) changed.push(relative);
  }
  for (const relative of before.keys()) {
    if (!after.has(relative)) removed.push(relative);
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}
