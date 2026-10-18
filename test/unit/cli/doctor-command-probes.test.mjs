import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn(), version: vi.fn(), copies: vi.fn() }));
vi.mock('../../../src/process/bounded-child-process.mjs', async importOriginal => ({
  ...await importOriginal(), boundedExecFileSync: mocks.execFile,
}));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal(), execFileSync: mocks.execFile, execSync: mocks.execFile, spawnSync: mocks.spawn,
}));
vi.mock('../../../src/channel/manager.mjs', async importOriginal => ({
  ...await importOriginal(), getVersionInfo: mocks.version,
  loadConfig: async () => ({}), resolveMcpServerEntrypointPath: root => join(root, 'missing-server.mjs'),
}));
vi.mock('../../../src/installation/manager.mjs', async importOriginal => ({
  ...await importOriginal(), inspectInstallation: () => ({ state: 'aligned', drift: [] }),
  inspectInstallationCopies: mocks.copies,
}));

let root;
let runDoctor;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'aiwg-doctor-probes-'));
  mkdirSync(join(root, '.aiwg'));
  writeFileSync(join(root, '.aiwg', 'aiwg.config'), JSON.stringify({ remotes: { primary: 'origin' } }));
  writeFileSync(join(root, 'aiwg.cmd'), '@ECHO off\n"%_prog%" "%dp0%\\entry.mjs" %*\n');
  writeFileSync(join(root, 'entry.mjs'), '');
  vi.stubEnv('AIWG_ROOT', root);
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
  ({ runDoctor } = await import('../../../tools/cli/doctor.mjs'));
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe('doctor command probe behavior', () => {
  beforeEach(() => {
    mocks.copies.mockReturnValue([]);
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    vi.spyOn(process, 'exit').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'argv', 'get').mockReturnValue([process.execPath, 'doctor.mjs', '--no-budget-check']);
    mocks.execFile.mockImplementation((file, args) => {
      if (file === 'git' && args[0] === 'remote') return 'origin\nupstream\n';
      if (file === 'git' && args[0] === 'rev-list') return '2\n';
      return 'aiwg 1.0.0\n';
    });
    mocks.spawn.mockReturnValue({ status: 0, stdout: '{}', stderr: '' });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each(['linux', 'win32'])('runs both version and PATH probes with working %s launch arguments', async platform => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    vi.stubEnv('PATH', root);
    mocks.version.mockRejectedValue(new Error('version unavailable'));
    await runDoctor();
    const file = platform === 'win32' ? process.execPath : 'aiwg';
    const prefix = platform === 'win32' ? [join(root, 'entry.mjs')] : [];
    expect(mocks.execFile).toHaveBeenCalledWith(file, [...prefix, '-version'], 'quick', {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'],
    });
    expect(mocks.execFile).toHaveBeenCalledWith(file, [...prefix, '--version'], 'quick', { stdio: 'ignore' });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('AIWG Version: aiwg 1.0.0'));
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('aiwg installed but may not be in your PATH'));
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Installation Copies:'));
  });

  it('executes the edge and project Git probes with their tiers and working directories', async () => {
    mocks.version.mockResolvedValue({ version: '1.0.0', channel: 'edge', devMode: true, edgePath: join(root, 'edge') });
    await runDoctor();
    expect(mocks.execFile).toHaveBeenCalledWith('git', ['remote'], 'quick', {
      cwd: join(root, 'edge'), encoding: 'utf-8',
    });
    expect(mocks.execFile).toHaveBeenCalledWith('git', ['fetch', 'upstream', '--dry-run'], 'network', {
      cwd: join(root, 'edge'), stdio: 'pipe',
    });
    expect(mocks.execFile).toHaveBeenCalledWith('git', ['rev-list', 'HEAD..upstream/main', '--count'], 'quick', {
      cwd: join(root, 'edge'), encoding: 'utf-8',
    });
    expect(mocks.execFile).toHaveBeenCalledWith('git', ['remote'], 'quick', {
      cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
  });

  it('reports foreign PATH and inactive nvm copies even when the version probe succeeds', async () => {
    const active = join(root, '.nvm/versions/node/v24/lib/node_modules/aiwg');
    const inactive = join(root, '.nvm/versions/node/v25/lib/node_modules/aiwg');
    mocks.copies.mockReturnValue([
      { root: active, executables: [join(root, 'bin/aiwg')], onPath: true, registered: false },
      { root: inactive, executables: [join(root, 'v25/bin/aiwg')], onPath: false, registered: false },
      { root: 'registered-copy', executables: [], onPath: true, registered: true },
    ]);
    await runDoctor();
    const output = console.log.mock.calls.map(([line]) => String(line)).join('\n');
    expect(output).toContain('Installation Copies:');
    expect(output).toContain(`${active} (on PATH`);
    expect(output).toContain(`${inactive} (other nvm Node version, off PATH`);
    expect(output).toContain('aiwg installation adopt --yes');
    expect(output).toContain('npm uninstall -g aiwg');
    expect(output).not.toContain('registered-copy');
  });

  it.each([
    ['2026.10.3', 'Version skew:', 'warn'],
    ['2026.9.20', 'launcher 2026.9.20;', 'ok'],
    ['(unknown)', 'Could not determine both versions:', 'warn'],
  ])('reports launcher/runtime comparison for runtime %s', async (runtimeVersion, message, status) => {
    mocks.version.mockResolvedValue({
      version: '2026.10.3', channel: 'edge', devMode: false,
      launcherVersion: '2026.9.20', runtimeVersion, runtimePath: join(root, 'edge'),
    });
    await runDoctor();
    const output = console.log.mock.calls.map(([line]) => String(line)).join('\n');
    const symbol = status === 'warn' ? '⚠' : '✓';
    const comparison = output.split('\n').filter(line => line.includes('Launcher/Runtime Versions:')).at(-1);
    expect(comparison).toContain(`${symbol} Launcher/Runtime Versions: ${message}`);
    expect(output).toContain(join(root, 'edge'));
  });
});
