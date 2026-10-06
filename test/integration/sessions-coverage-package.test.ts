import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_PROVIDER_IDS } from '../../src/sessions/contracts.js';
import { PROVIDER_IDS } from '../../src/providers/provider-definitions.js';
import { expectedSessionProviders } from '../../src/sessions/coverage-preflight.js';
import { createInstallationIdentity } from '../../src/installation/manager.mjs';

const repository = resolve('.');
let root: string;
let installed: string;
let env: NodeJS.ProcessEnv;

// Exercise the published tarball layout offline. Dependencies are shared read-only;
// the clean dependency installation gate remains session-feature-install-smoke.mjs.
describe.skipIf(!existsSync(join(repository, 'dist/src/cli/router.js')))('packed session coverage CLI', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'sessions-coverage-package-'));
    const home = join(root, 'home');
    installed = join(root, 'node_modules', 'aiwg');
    mkdirSync(home, { recursive: true });
    mkdirSync(installed, { recursive: true });
    env = {
      ...process.env, HOME: home, USERPROFILE: home, AIWG_CONFIG: join(home, '.config/aiwg'),
      XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
      AIWG_LOG_DISABLE: '1', NO_UPDATE_NOTIFIER: '1', AIWG_NO_UPDATE_CHECK: '1', NO_COLOR: '1',
      npm_config_cache: join(root, 'npm-cache'),
    };
    delete env.AIWG_ROOT;
    const packed = run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root]);
    const tarball = join(root, JSON.parse(packed)[0].filename);
    run('tar', ['-xzf', tarball, '--strip-components=1', '-C', installed]);
    symlinkSync(join(repository, 'node_modules'), join(installed, 'node_modules'), 'dir');
  }, 60_000);
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  it('retains advertised providers and names the installed package, independent of SQLite health', () => {
    const expected = expectedSessionProviders([...PROVIDER_IDS, 'future-provider']);
    const result = cli(['sources', '--expected-providers', expected.join(','), '--json']);
    const preflight = result.data.preflight;
    expect(result.status).toBe('ok');
    expect(preflight.expectedProviders).toEqual(expected);
    expect(preflight.ledger.map((entry: { provider: string }) => entry.provider)).toEqual(expected);
    expect(preflight.supportedProviders).toEqual([...SESSION_PROVIDER_IDS].sort());
    expect(preflight.runtime).toMatchObject({
      packageRoot: installed,
      version: JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version,
      executable: join(installed, 'bin/aiwg.mjs'),
    });
    expect(preflight.ledger.find((entry: { provider: string }) => entry.provider === 'future-provider').disposition).toBe('missing-adapter');
    expect(preflight.ledger.find((entry: { provider: string }) => entry.provider === 'muse')).toBeDefined();
    expect(preflight.status).toBe('partial');
    const discovery = cli(['discover', '--workspace', root, '--provider-home', root,
      '--expected-providers', 'muse,future-provider', '--dry-run', '--json']);
    expect(discovery.data.manifest.preflight.ledger.map((entry: { disposition: string }) => entry.disposition))
      .toEqual(['missing-adapter', 'authorization-required']);
  });

  it('diagnoses canonical installation drift without switching or updating it', () => {
    // The packaged launcher fails closed on drift before any session command
    // runs; the preflight's own mismatch handling is unit-tested.
    const canonical = join(root, 'canonical');
    mkdirSync(canonical);
    mkdirSync(env.AIWG_CONFIG!, { recursive: true });
    const identity = createInstallationIdentity({
      actualRoot: canonical, method: 'npm', managerExecutable: process.execPath,
    });
    const file = join(env.AIWG_CONFIG!, 'installation.json');
    const original = JSON.stringify(identity);
    writeFileSync(file, original);
    const result = spawnSync(process.execPath, [join(installed, 'bin/aiwg.mjs'), 'sessions', 'sources',
      '--expected-providers', 'muse', '--json'], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('installation identity drift detected');
    expect(result.stderr).toContain(`actual root ${installed} differs from canonical root ${canonical}`);
    expect(result.stderr).toContain('aiwg installation switch --root');
    expect(readFileSync(file, 'utf8')).toBe(original);
  });
});

function run(command: string, args: string[], cwd = repository): string {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}
function cli(args: string[]): any {
  return JSON.parse(run(process.execPath, [join(installed, 'bin/aiwg.mjs'), 'sessions', ...args], root));
}
