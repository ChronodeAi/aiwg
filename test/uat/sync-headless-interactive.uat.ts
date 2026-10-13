/**
 * UAT: Interactive call sites run safely without a terminal (#3062)
 *
 * Spawns the real built CLI (`bin/aiwg.mjs`, requires `npm run build:cli`)
 * with stdin closed and no TTY, once per headless-affected command, and
 * asserts each exits promptly instead of hanging: no real agent/editor/
 * provider binary is invoked by these scenarios (CI-safe, stub lane).
 *
 * `codex-login` has no scenario here: there is currently no `aiwg` command
 * that reaches `loginInProfile` (see the `codex-login` allow-list entry and
 * src/mcp/adapters/codex-runtime.ts) — it is covered at the unit level
 * (test/unit/mcp/credentials.test.ts) instead.
 *
 * The `aiwg init --worker-dispatch` scenarios are a related but distinct
 * headless-safety gap under the same rule: the worker-dispatch offer never
 * hangs (it already degrades to a one-line hint without a terminal), but it
 * previously had no argument to answer it directly — see
 * docs/getting-started/worker-dispatch.md#answering-headlessly.
 *
 * Run on demand (included in npm run uat):
 *   npm run uat
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stringify } from 'yaml';

// @ts-ignore
const __dirname_uat = new URL('.', import.meta.url).pathname;
const PROJECT_ROOT = resolve(__dirname_uat, '../..');
const BIN = join(PROJECT_ROOT, 'bin', 'aiwg.mjs');

// Generous relative to the test's own 20s assertion — this is the ceiling
// that proves "did not hang", not the expected run time.
const HANG_GUARD_MS = 20_000;

function runHeadless(args: string[], cwd: string, configDir: string) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: HANG_GUARD_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      AIWG_CONFIG: configDir,
      NO_UPDATE_NOTIFIER: '1',
      AIWG_TELEMETRY_DISABLED: '1',
      // Belt-and-suspenders: isInteractive() already treats a non-TTY stdin
      // as non-interactive, but force CI-detection too so this never depends
      // on the host's own terminal state.
      CI: 'true',
    },
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.status, signal: result.signal, timedOut: result.error?.code === 'ETIMEDOUT' };
}

function makeTmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `aiwg-uat-headless-${label}-`));
}

describe('UAT: headless-safe interactive call sites (#3062)', () => {
  let cwd: string;
  let configDir: string;

  beforeEach(() => {
    cwd = makeTmpDir('cwd');
    configDir = makeTmpDir('config');
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  it('editor-launch: `aiwg config edit` refuses instead of spawning $EDITOR', () => {
    const result = runHeadless(['config', 'edit'], cwd, configDir);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/--print-path/);
    expect(result.stderr + result.stdout).toMatch(/aiwg config set/);
  });

  it('editor-launch: `aiwg config edit --print-path` prints the path and exits 0', () => {
    const result = runHeadless(['config', 'edit', '--print-path'], cwd, configDir);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(join(configDir, 'config.yaml'));
  });

  it('harness-launch: `aiwg session` with no --prompt refuses instead of hanging waiting for a terminal', () => {
    const result = runHeadless(['session', '--provider', 'claude', '--no-repair'], cwd, configDir);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/--prompt/);
  });

  it('codex-exec: `aiwg session --profile` with no --prompt refuses before reaching the codex runtime home', () => {
    const result = runHeadless(
      ['session', '--provider', 'codex', '--profile', 'does-not-exist', '--no-repair'],
      cwd,
      configDir,
    );
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/--prompt/);
  });

  it('manifest-script-step: `aiwg setup-run` completes a non-prompting script without hanging', () => {
    const manifestPath = join(cwd, 'setup.manifest.yaml');
    const marker = join(cwd, 'marker');
    const scriptPath = join(cwd, 'scripts', 'install.sh');
    mkdirSync(join(cwd, 'scripts'), { recursive: true });
    writeFileSync(scriptPath, `#!/usr/bin/env sh\nprintf ran > ${marker}\n`, { mode: 0o755 });
    writeFileSync(manifestPath, stringify({
      apiVersion: 'setup.aiwg.io/v1',
      kind: 'SetupManifest',
      metadata: { name: 'uat-headless', description: 'no os configuration required', install_type: 'developer' },
      spec: { platforms: [{ os: 'linux' }], steps: [{ id: 'install', type: 'script', script: 'scripts/install.sh' }] },
    }), 'utf8');

    const result = runHeadless(['setup-run', '--manifest', manifestPath, '--yes'], cwd, configDir);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, 'utf8')).toBe('ran');
  });

  it('manifest-shell-command: `aiwg setup-run` runs a non-prompting verify command without hanging', () => {
    const manifestPath = join(cwd, 'setup.manifest.yaml');
    writeFileSync(manifestPath, stringify({
      apiVersion: 'setup.aiwg.io/v1',
      kind: 'SetupManifest',
      metadata: { name: 'uat-headless-verify', description: 'no os configuration required', install_type: 'developer' },
      spec: { platforms: [{ os: 'linux' }], steps: [{ id: 'check', type: 'verify', commands: ['true'] }] },
    }), 'utf8');

    const result = runHeadless(['setup-run', '--manifest', manifestPath, '--yes'], cwd, configDir);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it('aiwg init --worker-dispatch enable writes only parallelism.worker_dispatch, headless', () => {
    const result = spawnSync(process.execPath, [BIN, 'init', '--non-interactive', '--worker-dispatch', 'enable'], {
      cwd,
      encoding: 'utf8',
      timeout: HANG_GUARD_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AIWG_CONFIG: configDir,
        // Enabling worker_dispatch makes writeAiwgConfig validate
        // worker-model defaults against the bundled config; point it at
        // this checkout instead of a real user-home install.
        AIWG_HOME: PROJECT_ROOT,
        NO_UPDATE_NOTIFIER: '1',
        AIWG_TELEMETRY_DISABLED: '1',
        CI: 'true',
      },
    });
    expect(result.error?.code).not.toBe('ETIMEDOUT');
    expect(result.status).toBe(0);
    const config = JSON.parse(readFileSync(join(cwd, '.aiwg', 'aiwg.config'), 'utf8'));
    expect(config.parallelism.worker_dispatch).toBe(true);
    expect(config.setup?.worker_dispatch_offer).toBeUndefined();
  });

  it('aiwg init --worker-dispatch decline writes only setup.worker_dispatch_offer, headless', () => {
    const result = runHeadless(['init', '--non-interactive', '--worker-dispatch', 'decline'], cwd, configDir);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    const config = JSON.parse(readFileSync(join(cwd, '.aiwg', 'aiwg.config'), 'utf8'));
    expect(config.setup?.worker_dispatch_offer).toBe('declined');
    expect(config.parallelism?.worker_dispatch).not.toBe(true);
  });

  it('manifest step marked interactive: true is refused up front, without running it', () => {
    const manifestPath = join(cwd, 'setup.manifest.yaml');
    const marker = join(cwd, 'marker');
    const scriptPath = join(cwd, 'scripts', 'install.sh');
    mkdirSync(join(cwd, 'scripts'), { recursive: true });
    writeFileSync(scriptPath, `#!/usr/bin/env sh\nprintf ran > ${marker}\n`, { mode: 0o755 });
    writeFileSync(manifestPath, stringify({
      apiVersion: 'setup.aiwg.io/v1',
      kind: 'SetupManifest',
      metadata: { name: 'uat-headless-interactive-step', description: 'no os configuration required', install_type: 'developer' },
      spec: { platforms: [{ os: 'linux' }], steps: [{ id: 'install', type: 'script', script: 'scripts/install.sh', interactive: true }] },
    }), 'utf8');

    const result = runHeadless(['setup-run', '--manifest', manifestPath, '--yes'], cwd, configDir);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(result.stderr + result.stdout).toContain("step 'install'");
  });
});
