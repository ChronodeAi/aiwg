/**
 * UAT: Interactive call sites run safely without a terminal (#3062)
 *
 * Spawns the real built CLI (`bin/aiwg.mjs`, requires `npm run build:cli`)
 * with stdin closed and no TTY, once per headless-affected command, and
 * asserts each exits promptly instead of hanging: no real agent/editor/
 * provider binary is invoked by these scenarios (CI-safe, stub lane).
 *
 * `codex-login` has a dedicated CLI-wiring scenario here (`aiwg mcp profile
 * login --api-key-env`, against a stub `codex`); `loginInProfile` itself is
 * covered at the unit level (test/unit/mcp/credentials.test.ts).
 *
 * The `aiwg init --worker-dispatch` scenarios are a related but distinct
 * headless-safety gap under the same rule: the worker-dispatch offer never
 * hangs (it already degrades to a one-line hint without a terminal), but it
 * previously had no argument to answer it directly — see
 * docs/getting-started/worker-dispatch.md#answering-headlessly.
 *
 * Hang-guard design (#3062 review item 14): every scenario below is
 * supervised by `runProcessAsync`, never by a synchronous `spawnSync` with
 * a native `timeout`. A synchronous timeout sends SIGTERM once and then
 * blocks the *calling* thread until the child actually exits — so a CLI
 * that traps SIGTERM (or has a descendant still blocked in its own
 * synchronous child call) hangs this test file's own process too, and
 * Vitest's per-test timeout cannot interrupt a blocked native call either.
 * `runProcessAsync` spawns detached (its own process group), races an
 * independent `setTimeout` against the real `exit` event, and on expiry
 * sends SIGKILL to the whole group (`process.kill(-pid, 'SIGKILL')`), not
 * just the direct child — the only way to reach a descendant the child
 * itself spawned and is blocked on. The dedicated "hang guard fires"
 * scenario below proves this against a fixture built to defeat anything
 * weaker.
 *
 * Run on demand (included in npm run uat):
 *   npm run uat
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { stringify } from 'yaml';

// @ts-ignore
const __dirname_uat = new URL('.', import.meta.url).pathname;
const PROJECT_ROOT = resolve(__dirname_uat, '../..');
const BIN = join(PROJECT_ROOT, 'bin', 'aiwg.mjs');
const FIXTURES = join(__dirname_uat, 'fixtures');

// Generous relative to each test's own assertions — this is the ceiling
// that proves "did not hang", not the expected run time.
const HANG_GUARD_MS = 20_000;
// Vitest's own per-test timeout must exceed HANG_GUARD_MS with headroom,
// or Vitest's timeout could fire first and mask whether our own guard
// would have worked.
const TEST_TIMEOUT_MS = HANG_GUARD_MS + 15_000;

interface ProcResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

/** Grace window after a group kill to settle anyway if `'close'` never arrives (#3062 second review, finding 11). */
const FORCE_SETTLE_GRACE_MS = 5_000;

/**
 * Supervise one child process asynchronously with an independent hard
 * deadline, SIGKILLing its whole process group on expiry *and* on the
 * child's own normal exit, settling only once stdio has actually
 * finished draining. See the module doc comment above for why this must
 * never be a synchronous `spawnSync`.
 *
 * #3062 second review, finding 11 fixed two gaps in the first version:
 *
 *   - It settled on `exit` and never cleaned the remaining group at all —
 *     an isolated probe recorded zero group kills. A descendant can
 *     survive its parent's own ordinary exit exactly as easily as it can
 *     survive the parent being killed, so the whole group is now killed
 *     on *every* exit path, not only the timeout path.
 *   - `exit` fires before stdio is necessarily fully drained; `close`
 *     fires only after it is. Settling now waits for `close`.
 *
 * If the group kill itself fails for a reason other than "already gone"
 * (`ESRCH`), or `'close'` still never arrives afterward, a short grace
 * timer settles independently anyway rather than hanging forever waiting
 * on an event that may never fire.
 */
function runProcessAsync(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<ProcResult> {
  return new Promise((settle) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let forceSettleTimer: NodeJS.Timeout | undefined;

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    if (options.input !== undefined) {
      child.stdin!.write(options.input);
      child.stdin!.end();
    }

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      settle({ stdout, stderr, exitCode, signal: exitSignal, timedOut });
    };

    const armForceSettle = () => {
      if (settled || forceSettleTimer) return;
      forceSettleTimer = setTimeout(finish, FORCE_SETTLE_GRACE_MS);
    };

    const killWholeGroup = () => {
      try {
        if (process.platform === 'win32' || !child.pid) child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        // ESRCH ("no such process") means the group is already gone —
        // fine. Anything else is a real failure to kill it; settling
        // independently (via armForceSettle, called by every caller of
        // this function) is what prevents that from hanging the test.
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          stderr += `\n[runProcessAsync] group kill failed: ${(error as Error).message}`;
        }
      }
    };

    const deadline = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killWholeGroup();
      armForceSettle();
    }, HANG_GUARD_MS);

    child.on('error', (error) => {
      if (settled) return;
      stderr += `\n${error.message}`;
      finish();
    });

    child.on('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      // Kill any surviving descendant in the same process group even on
      // an ordinary exit — the direct child exiting is not proof a
      // grandchild did too.
      killWholeGroup();
      armForceSettle();
    });

    child.on('close', (code, signal) => {
      if (exitCode === null && code !== null) exitCode = code;
      if (exitSignal === null && signal !== null) exitSignal = signal;
      finish();
    });
  });
}

function runHeadless(args: string[], cwd: string, configDir: string): Promise<ProcResult> {
  return runProcessAsync(process.execPath, [BIN, ...args], {
    cwd,
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
}

function makeTmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `aiwg-uat-headless-${label}-`));
}

/**
 * Write a PATH stub executable named `name` from the body of `fixture`
 * (#3062 second review, finding 11: stub executables must not depend on
 * host tools beyond the Node binary actually running these tests). Each
 * fixture file keeps a `#!/usr/bin/env node` first line only so it is
 * itself a valid, directly-runnable script during development; that line
 * is replaced here with an absolute shebang pointing at
 * `process.execPath` — the exact Node binary already running this test
 * process — so resolving the stub never depends on `env` or on PATH
 * containing a `node` at all, let alone the right version of it.
 */
function makeStubBin(dir: string, name: string, fixture: string): string {
  const stubPath = join(dir, name);
  const body = readFileSync(join(FIXTURES, fixture), 'utf8').replace(/^#!.*\n/, '');
  writeFileSync(stubPath, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  chmodSync(stubPath, 0o755);
  return stubPath;
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

  it('editor-launch: `aiwg config edit` refuses instead of spawning $EDITOR', async () => {
    const result = await runHeadless(['config', 'edit'], cwd, configDir);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/--print-path/);
    expect(result.stderr + result.stdout).toMatch(/aiwg config set/);
  }, TEST_TIMEOUT_MS);

  it('editor-launch: `aiwg config edit --print-path` prints the path and exits 0', async () => {
    const result = await runHeadless(['config', 'edit', '--print-path'], cwd, configDir);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(join(configDir, 'config.yaml'));
  }, TEST_TIMEOUT_MS);

  it('harness-launch: `aiwg session` with no --prompt refuses instead of hanging waiting for a terminal', async () => {
    const result = await runHeadless(['session', '--provider', 'claude', '--no-repair'], cwd, configDir);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/--prompt/);
  }, TEST_TIMEOUT_MS);

  it('codex-exec: `aiwg session --profile` with no --prompt refuses before reaching the codex runtime home', async () => {
    const result = await runHeadless(
      ['session', '--provider', 'codex', '--profile', 'does-not-exist', '--no-repair'],
      cwd,
      configDir,
    );
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/--prompt/);
  }, TEST_TIMEOUT_MS);

  it('harness-launch: an unsupported (non-spawnable) provider given --prompt refuses, naming the provider, without spawning anything', async () => {
    const result = await runHeadless(['session', '--provider', 'factory', '--prompt', 'hi', '--no-repair'], cwd, configDir);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/Factory AI/);
    expect(result.stderr + result.stdout).toMatch(/no CLI binary to spawn/);
  }, TEST_TIMEOUT_MS);

  it('harness-launch: `aiwg session --prompt-file` runs a stub provider headless, prompt on stdin — never argv', async () => {
    const binDir = makeTmpDir('stub-provider-bin');
    const workDir = makeTmpDir('stub-provider-work');
    makeStubBin(binDir, 'claude', 'stub-provider-stdin.mjs');
    const argvLog = join(workDir, 'argv.log');
    const stdinLog = join(workDir, 'stdin.log');
    const promptFile = join(workDir, 'prompt.txt');
    const promptText = 'treat this prompt as confidential: sk-not-a-real-secret';
    writeFileSync(promptFile, `${promptText}\n`);

    try {
      const result = await runProcessAsync(process.execPath, [BIN, 'session', '--provider', 'claude', '--prompt-file', promptFile, '--no-repair'], {
        cwd,
        env: {
          ...process.env,
          AIWG_CONFIG: configDir,
          NO_UPDATE_NOTIFIER: '1',
          AIWG_TELEMETRY_DISABLED: '1',
          CI: 'true',
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
          UAT_ARGV_LOG: argvLog,
          UAT_STDIN_LOG: stdinLog,
        },
      });
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(existsSync(argvLog)).toBe(true);
      const recordedArgv = readFileSync(argvLog, 'utf8');
      // The prompt text never appears on argv — only the stdin-transport
      // flags do (#3062 review item 8).
      expect(recordedArgv).not.toContain(promptText);
      expect(recordedArgv).toContain('--input-format');
      expect(existsSync(stdinLog)).toBe(true);
      expect(readFileSync(stdinLog, 'utf8')).toBe(promptText);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);

  it('manifest-script-step: `aiwg setup-run` completes a non-prompting script without hanging', async () => {
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

    const result = await runHeadless(['setup-run', '--manifest', manifestPath, '--yes'], cwd, configDir);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, 'utf8')).toBe('ran');
  }, TEST_TIMEOUT_MS);

  it('manifest-shell-command: `aiwg setup-run` runs a non-prompting verify command without hanging', async () => {
    const manifestPath = join(cwd, 'setup.manifest.yaml');
    writeFileSync(manifestPath, stringify({
      apiVersion: 'setup.aiwg.io/v1',
      kind: 'SetupManifest',
      metadata: { name: 'uat-headless-verify', description: 'no os configuration required', install_type: 'developer' },
      spec: { platforms: [{ os: 'linux' }], steps: [{ id: 'check', type: 'verify', commands: ['true'] }] },
    }), 'utf8');

    const result = await runHeadless(['setup-run', '--manifest', manifestPath, '--yes'], cwd, configDir);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('manifest step marked interactive: true is refused up front, without running it', async () => {
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

    const result = await runHeadless(['setup-run', '--manifest', manifestPath, '--yes'], cwd, configDir);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(result.stderr + result.stdout).toContain("step 'install'");
  }, TEST_TIMEOUT_MS);

  it('manifest "ask" step with every declared param supplied runs headless, never refusing', async () => {
    const manifestPath = join(cwd, 'setup.manifest.yaml');
    writeFileSync(manifestPath, stringify({
      apiVersion: 'setup.aiwg.io/v1',
      kind: 'SetupManifest',
      metadata: { name: 'uat-headless-ask-step', description: 'no os configuration required', install_type: 'developer' },
      spec: {
        platforms: [{ os: 'linux' }],
        params: [{ name: 'DEPLOY_TARGET', type: 'string' }],
        steps: [{ id: 'confirm-target', type: 'ask', message: 'Which target?', params: ['DEPLOY_TARGET'] }],
      },
    }), 'utf8');

    const result = await runHeadless(['setup-run', '--manifest', manifestPath, '--yes', '--param', 'DEPLOY_TARGET=staging'], cwd, configDir);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('manifest "ask" step with a missing declared param is refused up front, naming it', async () => {
    const manifestPath = join(cwd, 'setup.manifest.yaml');
    writeFileSync(manifestPath, stringify({
      apiVersion: 'setup.aiwg.io/v1',
      kind: 'SetupManifest',
      metadata: { name: 'uat-headless-ask-step-missing', description: 'no os configuration required', install_type: 'developer' },
      spec: {
        platforms: [{ os: 'linux' }],
        params: [{ name: 'DEPLOY_TARGET', type: 'string' }],
        steps: [{ id: 'confirm-target', type: 'ask', message: 'Which target?', params: ['DEPLOY_TARGET'] }],
      },
    }), 'utf8');

    const result = await runHeadless(['setup-run', '--manifest', manifestPath, '--yes'], cwd, configDir);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toContain('DEPLOY_TARGET');
  }, TEST_TIMEOUT_MS);

  it('aiwg init --worker-dispatch enable writes only parallelism.worker_dispatch, headless', async () => {
    const result = await runProcessAsync(process.execPath, [BIN, 'init', '--non-interactive', '--worker-dispatch', 'enable'], {
      cwd,
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
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    const config = JSON.parse(readFileSync(join(cwd, '.aiwg', 'aiwg.config'), 'utf8'));
    expect(config.parallelism.worker_dispatch).toBe(true);
    expect(config.setup?.worker_dispatch_offer).toBeUndefined();
  }, TEST_TIMEOUT_MS);

  it('aiwg init --worker-dispatch decline writes only setup.worker_dispatch_offer, headless', async () => {
    const result = await runHeadless(['init', '--non-interactive', '--worker-dispatch', 'decline'], cwd, configDir);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    const config = JSON.parse(readFileSync(join(cwd, '.aiwg', 'aiwg.config'), 'utf8'));
    expect(config.setup?.worker_dispatch_offer).toBe('declined');
    expect(config.parallelism?.worker_dispatch).not.toBe(true);
  }, TEST_TIMEOUT_MS);

  it('aiwg init --dry-run writes nothing at all, even with --providers/--script', async () => {
    const result = await runHeadless(
      ['init', '--non-interactive', '--dry-run', '--providers', 'codex', '--script', 'lint=npm run lint'],
      cwd,
      configDir,
    );
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(cwd, '.aiwg'))).toBe(false);
  }, TEST_TIMEOUT_MS);

  it('aiwg init headless with --providers/--default-scripts/--script answers every remaining wizard input directly', async () => {
    const result = await runHeadless(
      [
        'init', '--non-interactive',
        '--providers', 'codex,claude',
        '--default-scripts', 'false',
        '--script', 'lint=npm run lint',
      ],
      cwd,
      configDir,
    );
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    const config = JSON.parse(readFileSync(join(cwd, '.aiwg', 'aiwg.config'), 'utf8'));
    expect(config.providers).toEqual(['codex', 'claude']);
    expect(config.scripts).toEqual({ lint: 'npm run lint' });
  }, TEST_TIMEOUT_MS);

  it('aiwg init: a value-taking flag present without a value is a usage error before any write', async () => {
    const result = await runHeadless(['init', '--non-interactive', '--providers'], cwd, configDir);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toContain('--providers');
    expect(existsSync(join(cwd, '.aiwg'))).toBe(false);
  }, TEST_TIMEOUT_MS);

  it('aiwg setup project --yes with every flag supplied runs headless, writing the supplied values, no prompts', async () => {
    const result = await runHeadless(
      [
        'setup', 'project', '--yes',
        '--primary', 'origin',
        '--issue-provider', 'local',
        '--delivery-mode', 'direct',
        '--default-branch', 'main',
        '--providers', 'claude',
      ],
      cwd,
      configDir,
    );
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    const config = JSON.parse(readFileSync(join(cwd, '.aiwg', 'aiwg.config'), 'utf8'));
    expect(config.remotes.primary).toBe('origin');
    expect(config.delivery.mode).toBe('direct');
    expect(config.delivery.default_branch).toBe('main');
  }, TEST_TIMEOUT_MS);

  it('aiwg setup project: a value-taking flag present without a value is a usage error before any write', async () => {
    const result = await runHeadless(['setup', 'project', '--yes', '--primary'], cwd, configDir);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toContain('--primary');
    expect(existsSync(join(cwd, '.aiwg', 'aiwg.config'))).toBe(false);
  }, TEST_TIMEOUT_MS);

  it('mcp profile login: without a terminal and without --api-key-env, refuses naming the argument, spawning nothing', async () => {
    const binDir = makeTmpDir('stub-codex-bin');
    const sentinelLog = join(binDir, 'sentinel.log');
    makeStubBin(binDir, 'codex', 'stub-sentinel.mjs');
    try {
      const result = await runProcessAsync(process.execPath, [BIN, 'mcp', 'profile', 'login', 'uat-ci-profile'], {
        cwd,
        env: {
          ...process.env,
          AIWG_CONFIG: configDir,
          HOME: cwd,
          CODEX_HOME: join(cwd, '.codex'),
          NO_UPDATE_NOTIFIER: '1',
          AIWG_TELEMETRY_DISABLED: '1',
          CI: 'true',
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
          UAT_SENTINEL_LOG: sentinelLog,
        },
      });
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).not.toBe(0);
      // Go/no-go review blocker 1C: three credential sources now, not one.
      expect(result.stderr + result.stdout).toMatch(/interactive terminal, or a key supplied via/);
      expect(result.stderr + result.stdout).toMatch(/--api-key-env/);
      expect(result.stderr + result.stdout).toMatch(/--api-key-stdin/);
      expect(result.stderr + result.stdout).toMatch(/--api-key-file/);
      expect(existsSync(sentinelLog)).toBe(false);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);

  it('mcp profile login --api-key-env logs in headless against a stub codex, key on stdin only', async () => {
    const binDir = makeTmpDir('stub-codex-bin-2');
    const argvLog = join(binDir, 'argv.log');
    const stdinLog = join(binDir, 'stdin.log');
    makeStubBin(binDir, 'codex', 'stub-provider-stdin.mjs');
    try {
      const result = await runProcessAsync(
        process.execPath,
        [BIN, 'mcp', 'profile', 'login', 'uat-ci-profile-2', '--api-key-env', 'UAT_FAKE_CODEX_KEY'],
        {
          cwd,
          env: {
            ...process.env,
            AIWG_CONFIG: configDir,
            HOME: cwd,
            CODEX_HOME: join(cwd, '.codex'),
            NO_UPDATE_NOTIFIER: '1',
            AIWG_TELEMETRY_DISABLED: '1',
            CI: 'true',
            PATH: `${binDir}${delimiter}${process.env.PATH}`,
            UAT_ARGV_LOG: argvLog,
            UAT_STDIN_LOG: stdinLog,
            UAT_FAKE_CODEX_KEY: 'sk-uat-not-a-real-secret',
          },
        },
      );
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('sk-uat-not-a-real-secret');
      expect(existsSync(argvLog)).toBe(true);
      expect(readFileSync(argvLog, 'utf8')).not.toContain('sk-uat-not-a-real-secret');
      expect(existsSync(stdinLog)).toBe(true);
      expect(readFileSync(stdinLog, 'utf8')).toBe('sk-uat-not-a-real-secret');
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);

  it('hang guard: a descendant that ignores SIGTERM and blocks forever is still killed within the deadline', async () => {
    const before = Date.now();
    const result = await runProcessAsync(process.execPath, [join(FIXTURES, 'blocking-descendant.mjs')]);
    const elapsedMs = Date.now() - before;
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGKILL');
    // Killed at (approximately) the deadline, not left to run past it.
    expect(elapsedMs).toBeLessThan(HANG_GUARD_MS + 10_000);
  }, TEST_TIMEOUT_MS);

  // #3062 second review, finding 11: the supervisor used to settle on
  // `exit` and never clean the remaining process group at all — a
  // surviving descendant could leak even when the direct child's own
  // exit was fast and ordinary, not just on the timeout path.
  it('hang guard: kills a surviving descendant even when the direct child exits normally and quickly', async () => {
    const workDir = makeTmpDir('parent-exits-first');
    const pidFile = join(workDir, 'grandchild.pid');
    try {
      const before = Date.now();
      const result = await runProcessAsync(process.execPath, [join(FIXTURES, 'parent-exits-first.mjs')], {
        env: { ...process.env, PARENT_EXITS_FIRST_PID_FILE: pidFile },
      });
      const elapsedMs = Date.now() - before;
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      // Settled quickly — this exercises the "ordinary exit" path, not
      // the hang-guard deadline.
      expect(elapsedMs).toBeLessThan(HANG_GUARD_MS);

      expect(existsSync(pidFile)).toBe(true);
      const grandchildPid = Number(readFileSync(pidFile, 'utf8'));
      // Give the OS a brief moment to finish reaping the already-killed
      // grandchild, then confirm it is actually gone (signal 0 is a pure
      // liveness probe — it never actually signals the process).
      await new Promise((resolve) => setTimeout(resolve, 200));
      let stillAlive = true;
      try {
        process.kill(grandchildPid, 0);
      } catch {
        stillAlive = false;
      }
      expect(stillAlive).toBe(false);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);
});
