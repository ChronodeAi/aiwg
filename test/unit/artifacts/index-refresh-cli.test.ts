import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { main } from '../../../src/artifacts/cli.js';
import { run } from '../../../src/cli/router.js';
import { SessionRepository } from '../../../src/sessions/repository.js';
import { itWithSqlite } from '../../helpers/sqlite.js';

vi.mock('../../../tools/scripts/resource-preflight.mjs', () => ({
  resolveDispatchThresholds: () => ({}),
  readLiveHostResources: () => ({}),
  evaluateDispatchGate: () => ({ ok: true, failures: [] }),
}));

let root: string;
let output: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-refresh-cli-'));
  fs.mkdirSync(path.join(root, '.aiwg'));
  fs.writeFileSync(path.join(root, '.aiwg/aiwg.config'), JSON.stringify({
    command_log: { enabled: true }, skill_usage: { enabled: true },
  }));
  vi.stubEnv('HOME', path.join(root, 'home'));
  vi.stubEnv('XDG_STATE_HOME', path.join(root, 'state'));
  vi.stubEnv('XDG_DATA_HOME', path.join(root, 'data'));
  output = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  process.exitCode = 0;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('index refresh CLI routing', () => {
  itWithSqlite('prints a workspace-specific discovery remedy and reports noManifest counts in JSON', async () => {
    const workspaces = [root, path.join(root, 'other')];
    for (const workspace of workspaces) {
      fs.mkdirSync(path.join(workspace, '.aiwg/sessions'), { recursive: true });
      const repository = new SessionRepository(path.join(workspace, '.aiwg/sessions/catalog.sqlite'));
      repository.close();
    }
    fs.writeFileSync(path.join(root, '.aiwg/aiwg.config'), JSON.stringify({
      sessions: { discovery_manifests: ['missing.json'] },
    }));
    const args = ['refresh', '--only', 'sessions', ...workspaces.flatMap(workspace => ['--workspace', workspace])];
    await main(args);
    const text = output.mock.calls.map(call => call[0]).join('\n');
    for (const workspace of workspaces) {
      expect(text).toContain(`Session refresh skipped for ${workspace}`);
      expect(text).toContain(`aiwg sessions discover --workspace '${workspace}'`);
    }
    output.mockClear();
    await main([...args, '--json']);
    expect(output).toHaveBeenCalledOnce();
    const report = JSON.parse(output.mock.calls[0][0]);
    expect(report).toMatchObject({ status: 'partial', totals: { noManifest: 2, skipped: 2, errors: 0 } });
    expect(report.jobs).toEqual(workspaces.sort().map(workspace => expect.objectContaining({
      kind: 'sessions', workspace, noManifest: 1, reason: 'no authorized discovery manifest',
    })));
    expect(report.messages).toHaveLength(2);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('dispatches refresh through the artifact CLI and exposes the refresh flags in help', async () => {
    await main(['refresh', '--workspace', root, '--dry-run', '--json']);
    expect(output).toHaveBeenCalledOnce();
    expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({ contractVersion: '1.0.0', command: 'index.refresh', status: 'ok' });
    output.mockClear();
    await main(['refresh', '--help']);
    const help = output.mock.calls.map(call => call[0]).join('\n');
    expect(help).toContain('refresh');
    expect(help).toContain('[--root <dir>]...');
    expect(help).toContain('--only graphs|sessions|caches|runtime|models|issues');
    for (const flag of ['--full', '--workspace', '--root', '--only', '--dry-run', '--json', '--lock-wait-ms', '--max-record-bytes', '--max-source-bytes']) expect(help).toContain(flag);
  });

  it('accepts import byte flags for refresh planning', async () => {
    await main(['refresh', '--workspace', root, '--dry-run', '--json',
      '--max-record-bytes', '1024', '--max-source-bytes', '0']);
    expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({ status: 'ok' });
  });

  it.each([
    ['--max-record-bytes', '0'], ['--max-record-bytes', '1.5'],
    ['--max-source-bytes', '-1'], ['--max-source-bytes', 'invalid'],
  ])('rejects invalid refresh byte limit %s %s', async (flag, value) => {
    await main(['refresh', '--workspace', root, '--dry-run', '--json', flag, value]);
    expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({ status: 'error' });
    expect(JSON.parse(output.mock.calls[0][0]).messages[0]).toContain('sessions.import.');
    expect(process.exitCode).toBe(1);
  });

  it('routes without registry initialization, hooks or telemetry even when command logging is enabled', async () => {
    await run(['index', 'refresh', '--dry-run', '--json'], { cwd: root });
    expect(output).toHaveBeenCalledOnce();
    expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({ command: 'index.refresh', status: 'ok' });
    expect(fs.readdirSync(root).sort()).toEqual(['.aiwg']);
    expect(fs.readdirSync(path.join(root, '.aiwg'))).toEqual(['aiwg.config']);
  });

  it('propagates refresh errors to the process exit status', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit ${code}`); });
    await expect(run(['index', 'refresh', '--only', 'invalid', '--json'], { cwd: root })).rejects.toThrow('exit 1');
    expect(exit).toHaveBeenCalledWith(1);
    expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({ status: 'error' });
  });

  it('skips update checks in the launcher before refresh reaches the router', async () => {
    // Exercise the actual bootstrap dispatch without loading dist or an installation.
    const source = fs.readFileSync(path.resolve(import.meta.dirname, '../../../bin/aiwg.mjs'), 'utf8');
    const begin = source.indexOf('const cliArgs = process.argv.slice(2);');
    const end = source.indexOf('if (maybeHandleFastVersion(cliArgs))', begin);
    const notifier = vi.fn();
    const traced: string[] = [];
    await vm.runInNewContext(`(async () => { ${source.slice(begin, end)} })()`, {
      process: { argv: ['node', 'aiwg', 'index', 'refresh', '--dry-run', '--json'] },
      trace: (value: string) => traced.push(value),
      isCredentialHandlingCommand: () => false,
      runUpdateNotifierBootstrap: notifier,
    });
    expect(notifier).not.toHaveBeenCalled();
    expect(traced).toEqual(['notifier:skip (index refresh)']);
  });
});
