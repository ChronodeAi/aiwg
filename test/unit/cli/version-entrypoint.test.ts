import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { getVersionInfo } from '../../../src/channel/manager.mjs';

const repo = path.resolve(import.meta.dirname, '../../..');
const source = readFileSync(path.join(repo, 'bin/aiwg.mjs'), 'utf8');
const functions = source.slice(source.indexOf('function readPackageVersion('), source.indexOf('const FAST_HELP_TEXT'));
let root: string;
let launcher: string;
let runtime: string;
let config: string;

function write(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'aiwg-version-entry-'));
  launcher = path.join(root, 'launcher');
  runtime = path.join(root, 'runtime');
  config = path.join(root, 'config');
  write(path.join(launcher, 'package.json'), { name: 'aiwg', version: '2026.9.20' });
  write(path.join(runtime, 'package.json'), { name: 'aiwg', version: '2026.10.3' });
  write(path.join(config, 'channel.json'), { channel: 'edge', devMode: true, edgePath: runtime });
  vi.stubEnv('AIWG_CONFIG', config);
  vi.stubEnv('AIWG_CLI_DRY_RUN', '1');
  vi.stubEnv('AIWG_LAUNCHER_ROOT', launcher);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function fastVersion(args: string[]) {
  const lines: string[] = [];
  const handled = runInNewContext(`${functions}\nmaybeHandleFastVersion(args);`, {
    args, path, readFileSync, existsSync, packageRoot: launcher,
    os: { homedir: () => root }, process: { env: { AIWG_CONFIG: config } },
    console: { log: (line: string) => lines.push(line) },
  }, { timeout: 1000 });
  return { handled, output: lines.join('\n') };
}

describe('version launcher entrypoint', () => {
  it.each(['--version', '-version'])('%s labels launcher and effective runtime versions', flag => {
    const result = fastVersion([flag]);
    expect(result.handled).toBe(true);
    expect(result.output).toContain('[dev]');
    expect(result.output).toContain('launcher: 2026.9.20');
    expect(result.output).toContain('runtime: 2026.10.3');
    expect(result.output).toContain(`runtime path: ${runtime}`);
  });

  it('passes launcher identity to the runtime and leaves JSON to the handler', async () => {
    const env: Record<string, string> = {};
    const begin = source.indexOf('const cliArgs = process.argv.slice(2);');
    const end = source.indexOf('const indexRefresh', begin);
    runInNewContext(source.slice(begin, end), {
      process: { argv: ['node', 'aiwg', '--version', '--json'], env }, packageRoot: launcher,
    }, { timeout: 1000 });
    expect(env.AIWG_LAUNCHER_ROOT).toBe(launcher);
    expect(fastVersion(['--version', '--json']).handled).toBe(false);
    expect(await getVersionInfo()).toMatchObject({
      launcherVersion: '2026.9.20', runtimeVersion: '2026.10.3', runtimePath: runtime,
    });
  });

  it('keeps stable output compact when a stale edge path is configured', () => {
    write(path.join(config, 'channel.json'), { channel: 'stable', devMode: false, edgePath: runtime });
    const result = fastVersion(['--version']);
    expect(result.output).toContain('2026.9.20  [stable]');
    expect(result.output).not.toContain('2026.10.3');
    expect(result.output).not.toContain('runtime:');
  });

  it('honors canonical installation mode over legacy dev mode', () => {
    write(path.join(config, 'installation.json'), { runMode: 'normal', channel: 'stable', edgePath: runtime });
    const result = fastVersion(['--version']);
    expect(result.output).toContain('[stable]');
    expect(result.output).not.toContain('runtime:');
  });

  it('reports an unreadable runtime package as unknown', () => {
    rmSync(path.join(runtime, 'package.json'));
    const result = fastVersion(['--version']);
    expect(result.output).toContain('runtime: (unknown)');
    expect(result.output).toContain(runtime);
  });

  it.each([{ args: [] }, { args: ['--json'] }])('legacy version script reports runtime identity with args $args', async ({ args }) => {
    const lines: string[] = [];
    const script = readFileSync(path.join(repo, 'tools/cli/version.mjs'), 'utf8');
    await runInNewContext(`(async () => { ${script.slice(script.indexOf('const args ='))} })()`, {
      getVersionInfo, process: { argv: ['node', 'version.mjs', ...args] },
      console: { log: (line: string) => lines.push(line) },
    }, { timeout: 1000 });
    const output = lines.join('\n');
    if (args.includes('--json')) {
      expect(JSON.parse(output)).toMatchObject({ launcherVersion: '2026.9.20', runtimeVersion: '2026.10.3', runtimePath: runtime });
    } else {
      expect(output).toContain('launcher: 2026.9.20');
      expect(output).toContain('runtime: 2026.10.3');
      expect(output).toContain(`runtime path: ${runtime}`);
    }
  });
});
