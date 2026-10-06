import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getFeaturesRoot } from '../../src/features/paths.js';
import { itWithSqlite } from '../helpers/sqlite.js';
import { writeMuseLog } from '../helpers/muse-native.js';

const repo = resolve('.');
const featuresRoot = getFeaturesRoot();
let scratch = '';
let installRoot: string;
let workspace: string;
let manifestPath: string;
let database: string;

// A clean unpack exercises exactly the published file set. Runtime dependencies
// come from the existing installation, avoiding a network-dependent npm install.
describe.skipIf(!existsSync(join(repo, 'dist/src/cli/router.js')))('installed-package Muse public CLI conformance', () => {
  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'aiwg-muse-package-'));
    installRoot = join(scratch, 'node_modules', 'aiwg');
    workspace = join(scratch, 'workspace');
    manifestPath = join(scratch, 'manifest.json');
    database = join(scratch, 'catalog.sqlite');
    await Promise.all([installRoot, workspace, join(scratch, 'empty-provider-home'), join(scratch, 'config')]
      .map((path) => mkdir(path, { recursive: true })));
    const pack = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], {
      cwd: repo, encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, NPM_CONFIG_CACHE: join(scratch, 'npm-cache') },
    });
    expect(pack.error).toBeUndefined();
    expect(pack.status, pack.stderr).toBe(0);
    const packed = JSON.parse(pack.stdout.slice(pack.stdout.indexOf('[')));
    const unpack = spawnSync('tar', ['-xzf', join(scratch, packed[0].filename), '-C', installRoot, '--strip-components=1'], {
      cwd: scratch, encoding: 'utf8', timeout: 30_000,
    });
    expect(unpack.error).toBeUndefined();
    expect(unpack.status, unpack.stderr).toBe(0);
    await symlink(join(repo, 'node_modules'), join(installRoot, 'node_modules'), 'junction');
    expect(existsSync(join(installRoot, 'src'))).toBe(false);
    expect(existsSync(join(installRoot, 'dist/src/sessions/adapters/muse-workspace-scan.js'))).toBe(true);
    for (const [suffix, count] of [['1', 2], ['2', 101]] as const) {
      await writeMuseLog(join(scratch, 'sessions'), `00000000-0000-4000-8000-00000000000${suffix}`, count, workspace);
    }
  }, 120_000);

  afterAll(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); });

  it('discovers both 2-record/101-record sources from the unpacked bin/aiwg.mjs', async () => {
    const output = discover();
    expect(output).toMatchObject({ status: 'ok', data: { manifestPersisted: true } });
    expect(output.data.manifest.providers.find((provider: { provider: string }) => provider.provider === 'muse'))
      .toMatchObject({ status: 'checked', sourceCount: 2, reasonCode: null });
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(manifest.sources).toHaveLength(2);
    expect(output.data.manifest.sources.map((source: { sourceId: string }) => source.sourceId))
      .toEqual(manifest.sources.map((source: { sourceId: string }) => source.sourceId));
  });

  itWithSqlite('imports and replays the longer selected session through the installed public CLI', async () => {
    discover();
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const args = ['import-discovered', '--workspace', workspace, '--manifest', manifestPath, '--db', database, '--confirm', '--json'];
    const output = runCli(args);
    expect(output.data).toMatchObject({ manifestId: manifest.manifestId, receipt: { totals: { discovered: 2, accepted: 2, rejected: 0, eventsAccepted: 103 } } });
    expect(output.data.receipt.run.sources.map((source: { sourceId: string }) => source.sourceId))
      .toEqual(manifest.sources.map((source: { sourceId: string }) => source.sourceId));
    expect(runCli(['list', '--workspace', workspace, '--db', database, '--json']).data.page.total).toBe(2);
    const replay = runCli(args);
    expect(replay.data.receipt.run.sources.every((source: { status: string }) => source.status === 'previously-committed')).toBe(true);
  });
});

function discover() {
  return runCli([
    'discover', '--workspace', workspace, '--provider-home', join(scratch, 'empty-provider-home'),
    '--muse-root', join(scratch, 'sessions'), '--manifest', manifestPath, '--db', database, '--json',
  ]);
}

function runCli(args: string[]) {
  const env = { ...process.env };
  delete env.AIWG_ROOT;
  const result = spawnSync(process.execPath, [join(installRoot, 'bin/aiwg.mjs'), 'sessions', ...args], {
    cwd: workspace, encoding: 'utf8', timeout: 30_000,
    env: {
      ...env,
      AIWG_CONFIG: join(scratch, 'config'), AIWG_FEATURES_HOME: featuresRoot,
      AIWG_LOG_DISABLE: '1', AIWG_NO_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1',
      XDG_CONFIG_HOME: join(scratch, 'xdg-config'), XDG_DATA_HOME: join(scratch, 'xdg-data'),
    },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
