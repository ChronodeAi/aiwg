import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Go/no-go review blocker 1B: `resolveExecutable()`'s `which`/`where.exe`
// lookup (reached via `createInstallationIdentity()` for a `method:
// 'source'` identity with no `managerExecutable` override) must pass only
// an allow-listed environment, never the whole parent one — this spies on
// `boundedExecFileSync` to capture the environment at the lookup boundary.
const boundedExecFileSyncSpy = vi.fn();
vi.mock('../../../src/process/bounded-child-process.mjs', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/process/bounded-child-process.mjs')>();
  return {
    ...actual,
    boundedExecFileSync: (...callArgs: Parameters<typeof actual.boundedExecFileSync>) => {
      return boundedExecFileSyncSpy(...callArgs) ?? actual.boundedExecFileSync(...callArgs);
    },
  };
});

// Pin the fast-path filesystem probe without changing the real fixture I/O.
const existsSyncSpy = vi.fn();
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const existsSync = (...args: Parameters<typeof actual.existsSync>) =>
    existsSyncSpy(...args) ?? actual.existsSync(...args);
  return { ...actual, existsSync, default: { ...actual.default, existsSync } };
});

import {
  adoptInstallation,
  assertCanonicalInstallation,
  createInstallationIdentity,
  formatInstallationDiagnostic,
  inspectInstallation,
  installationFile,
  loadInstallationIdentity,
  saveInstallationIdentity,
  switchInstallation,
} from '../../../src/installation/manager.mjs';
import { resolveUserConfigDir } from '../../../src/config/user-config-dir.mjs';

const temporary: string[] = [];

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aiwg-${label}-`));
  temporary.push(dir);
  return dir;
}

function packageRoot(name = 'aiwg', source = false): string {
  const root = tempDir('installation-root');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name }));
  if (source) fs.mkdirSync(path.join(root, '.git'));
  return root;
}

afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('canonical installation identity', () => {
  it('permits an explicitly read-only unrecorded inspection without creating identity', () => {
    const configDir = tempDir('config');
    const root = packageRoot('aiwg', true);
    const status = assertCanonicalInstallation({
      configDir,
      actualRoot: root,
      createIfMissing: false,
      allowUnrecorded: true,
    });
    expect(status.state).toBe('unrecorded');
    expect(fs.existsSync(installationFile({ configDir }))).toBe(false);
  });

  it('honors config override and both legacy user-config locations', () => {
    const home = tempDir('home');
    const override = tempDir('override');
    expect(resolveUserConfigDir({ env: { AIWG_CONFIG: override }, homeDir: home })).toBe(override);

    const xdg = path.join(home, '.config', 'aiwg');
    fs.mkdirSync(xdg, { recursive: true });
    expect(resolveUserConfigDir({ env: {}, homeDir: home })).toBe(xdg);
    fs.mkdirSync(path.join(home, '.aiwg'));
    expect(resolveUserConfigDir({ env: {}, homeDir: home })).toBe(path.join(home, '.aiwg'));
  });

  it('migrates legacy channel state without losing update-check or dev fields', () => {
    const configDir = tempDir('config');
    const root = packageRoot('aiwg', true);
    fs.writeFileSync(path.join(configDir, 'channel.json'), JSON.stringify({
      channel: 'edge',
      devMode: true,
      edgePath: root,
      lastUpdateCheck: 1234,
      updateCheckInterval: 9876,
      checkOnStartup: false,
    }));
    const identity = loadInstallationIdentity({ configDir, actualRoot: root });
    expect(identity).toMatchObject({
      schemaVersion: 1,
      channel: 'edge',
      runMode: 'development',
      method: 'source',
      root,
      edgePath: root,
      lastUpdateCheck: 1234,
      updateCheckInterval: 9876,
      checkOnStartup: false,
    });
    expect(fs.existsSync(installationFile({ configDir }))).toBe(true);
  });

  it.each([
    ['aiwg', 'npm'],
    ['@aiwg/cli', 'web'],
  ])('records %s as a provider-neutral %s installation', (name, method) => {
    const configDir = tempDir('config');
    const root = packageRoot(name);
    const identity = createInstallationIdentity({ actualRoot: root });
    saveInstallationIdentity(identity, { configDir });
    expect(loadInstallationIdentity({ configDir, actualRoot: root })).toMatchObject({ method, root });
  });

  it('reports PATH/root inversion rather than silently adopting it', () => {
    const configDir = tempDir('config');
    const nvmRoot = packageRoot();
    const brewRoot = packageRoot();
    const manager = path.join(nvmRoot, 'npm');
    fs.writeFileSync(manager, '');
    fs.chmodSync(manager, 0o755);
    saveInstallationIdentity(createInstallationIdentity({
      actualRoot: nvmRoot,
      managerExecutable: manager,
    }), { configDir });
    const status = inspectInstallation({ configDir, actualRoot: brewRoot });
    expect(status.state).toBe('mismatch');
    expect(status.drift.join(' ')).toContain('differs from canonical root');
  });

  it('names running and registered roots and explicit recovery in drift diagnostics', () => {
    const registered = packageRoot();
    const running = packageRoot();
    const identity = createInstallationIdentity({ actualRoot: registered, managerExecutable: process.execPath });
    const status = inspectInstallation({ actualRoot: running, identity });
    const message = formatInstallationDiagnostic(status);
    expect(message).toContain(`Running installation: npm at ${running}`);
    expect(message).toContain(`Registered installation: npm at ${registered}`);
    expect(message).toContain('aiwg doctor');
    expect(message).toContain('aiwg installation adopt --method npm --yes');
    expect(message).toContain('npm uninstall -g aiwg');
    expect(formatInstallationDiagnostic(status, { readOnlyCommand: 'doctor' })).toContain('`doctor` is read-only and continues');
  });

  it('requires explicit adoption even for a same-version npm copy', () => {
    const configDir = tempDir('config');
    const registered = packageRoot();
    const running = packageRoot();
    for (const root of [registered, running]) {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'aiwg', version: '1.0.0' }));
    }
    saveInstallationIdentity(createInstallationIdentity({ actualRoot: registered, managerExecutable: process.execPath }), { configDir });
    expect(() => assertCanonicalInstallation({ actualRoot: running, configDir })).toThrow('installation identity drift');
    expect(loadInstallationIdentity({ configDir })?.root).toBe(registered);
    expect(adoptInstallation({ actualRoot: running, configDir, managerExecutable: process.execPath }).state).toBe('aligned');
    expect(loadInstallationIdentity({ configDir })?.root).toBe(running);
  });

  it('treats an edge launcher redirect as aligned, not drift (#2505)', () => {
    const configDir = tempDir('config');
    // The framework root: a local clone the operator develops against.
    const clone = packageRoot('aiwg', true);
    // The launcher: a real npm-global package directory whose bin redirects to
    // the clone. This is what `channel: edge` + `edgePath` is for.
    const npmGlobal = packageRoot();
    const git = path.join(clone, 'git');
    fs.writeFileSync(git, '');
    fs.chmodSync(git, 0o755);
    saveInstallationIdentity(createInstallationIdentity({
      actualRoot: clone,
      method: 'source',
      channel: 'edge',
      edgePath: clone,
      managerExecutable: git,
    }), { configDir });

    const status = inspectInstallation({ configDir, actualRoot: npmGlobal });

    // Before #2505 this reported `mismatch` with two drift entries, while
    // `aiwg doctor` — running from the clone — reported aligned for the very
    // same workspace. The steward gates its repair ladder on this state.
    expect(status.state).toBe('aligned');
    expect(status.drift).toEqual([]);
    // Launcher and framework root are reported separately, and only the
    // framework root drives state.
    expect(status.frameworkRoot).toBe(status.canonicalRoot);
    expect(status.launcher).toEqual({ root: status.actualRoot, method: 'npm' });
  });

  it('still reports drift when the launcher redirect is not what the identity declares (#2505)', () => {
    const configDir = tempDir('config');
    const clone = packageRoot('aiwg', true);
    const npmGlobal = packageRoot();
    const unrelated = packageRoot();
    const git = path.join(clone, 'git');
    fs.writeFileSync(git, '');
    fs.chmodSync(git, 0o755);
    // edgePath points somewhere other than the canonical root, so the running
    // executable is not the declared launcher for this framework root.
    saveInstallationIdentity(createInstallationIdentity({
      actualRoot: clone,
      method: 'source',
      channel: 'edge',
      edgePath: unrelated,
      managerExecutable: git,
    }), { configDir });

    const status = inspectInstallation({ configDir, actualRoot: npmGlobal });

    expect(status.state).toBe('mismatch');
    expect(status.drift.join(' ')).toContain('differs from canonical root');
    expect(status.launcher).toBeNull();
    expect(status.frameworkRoot).toBe(status.actualRoot);
  });

  it('reports a stale canonical root and supports explicit recovery', () => {
    const configDir = tempDir('config');
    const oldRoot = packageRoot();
    const newRoot = packageRoot();
    const manager = path.join(newRoot, 'npm');
    fs.writeFileSync(manager, '');
    fs.chmodSync(manager, 0o755);
    const identity = createInstallationIdentity({ actualRoot: oldRoot });
    fs.rmSync(oldRoot, { recursive: true, force: true });
    saveInstallationIdentity(identity, { configDir });
    expect(inspectInstallation({ configDir, actualRoot: newRoot }).state).toBe('stale');
    expect(adoptInstallation({ configDir, actualRoot: newRoot, managerExecutable: manager }).state).toBe('aligned');
    expect(switchInstallation({ configDir, root: newRoot, method: 'npm', managerExecutable: manager }).state).toBe('aligned');
  });

  it('records source/development strategy without an npm fallback', () => {
    const configDir = tempDir('config');
    const root = packageRoot('aiwg', true);
    const git = path.join(root, 'git');
    fs.writeFileSync(git, '');
    fs.chmodSync(git, 0o755);
    const status = adoptInstallation({ configDir, actualRoot: root, method: 'source', managerExecutable: git });
    expect(status.identity).toMatchObject({
      method: 'source',
      runMode: 'development',
      updateStrategy: 'source-git',
    });
  });

  it('reports a manager that exists but cannot be invoked', () => {
    const root = packageRoot();
    const manager = path.join(root, 'npm');
    fs.writeFileSync(manager, '');
    fs.chmodSync(manager, 0o755);
    const identity = createInstallationIdentity({ actualRoot: root, managerExecutable: manager });

    const status = inspectInstallation({
      actualRoot: root,
      identity,
      probeManager: true,
      executeManager: () => { throw new Error('spawn failed'); },
    });

    expect(status.state).toBe('mismatch');
    expect(status.managerProbe).toEqual({ state: 'failed', error: 'spawn failed' });
    expect(status.drift).toContain('recorded manager executable cannot be invoked: spawn failed');
  });

  it('probes a Windows manager path containing literal percent and metacharacters (#3117)', () => {
    const root = packageRoot();
    const manager = path.join(root, 'npm %PATH% & 100%.cmd');
    fs.writeFileSync(manager, '');
    fs.chmodSync(manager, 0o755);
    const identity = createInstallationIdentity({ actualRoot: root, managerExecutable: manager });
    const executeManager = vi.fn();

    const status = inspectInstallation({
      actualRoot: root, identity, probeManager: true, executeManager,
      platform: 'win32', env: { ComSpec: 'cmd.exe' },
    });

    expect(status.managerProbe).toEqual({ state: 'usable' });
    expect(executeManager).toHaveBeenCalledWith(
      'cmd.exe',
      ['/d', '/v:off', '/s', '/c', `"${root.replace(/ /g, '^ ')}${path.sep}npm^ ^%PATH^%^ ^&^ 100^%.cmd ^^^"--version^^^""`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, windowsVerbatimArguments: true },
    );
  });

  // Go/no-go review blocker 1B.
  it("resolving a method: 'source' identity's manager executable looks up `git` with only PATH, never the whole parent environment", () => {
    const root = packageRoot('aiwg', true);
    const git = path.join(root, 'git');
    fs.writeFileSync(git, '');
    const besideNode = path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'git.cmd' : 'git');
    // A system Node may share /usr/bin with git; that fast path skips which.
    existsSyncSpy.mockImplementation(file => file === besideNode ? false : undefined);
    boundedExecFileSyncSpy.mockReturnValue(`${git}\n`);
    const env = {
      PATH: path.join(root, 'lookup-bin'),
      PATHEXT: '.EXE;.CMD',
      SystemRoot: path.join(root, 'windows'),
      AIWG_TEST_INSTALLATION_SECRET: 'sk-test-installation-secret',
    };
    const identity = createInstallationIdentity({ actualRoot: root, method: 'source', env });

    expect(identity.managerExecutable).toBe(fs.realpathSync(git));
    expect(existsSyncSpy).toHaveBeenCalledWith(besideNode);
    expect(boundedExecFileSyncSpy).toHaveBeenCalledTimes(1);
    const [finder, args, profile, options] = boundedExecFileSyncSpy.mock.calls[0];
    expect(finder).toBe(process.platform === 'win32' ? 'where.exe' : 'which');
    expect(args).toEqual(['git']);
    expect(profile).toBe('quick');
    expect(options.env).toEqual({
      PATH: env.PATH,
      ...(process.platform === 'win32' ? { PATHEXT: env.PATHEXT, SystemRoot: env.SystemRoot } : {}),
    });
  });
});
