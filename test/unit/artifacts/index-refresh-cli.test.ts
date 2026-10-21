import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { discoverWorkspaceHistories, writeDiscoveryManifest } from '../../../src/sessions/workspace-discovery.js';
import * as builder from '../../../src/artifacts/index-builder.js';
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
  vi.stubEnv('AIWG_INDEX_WORKERS', '');
  fs.mkdirSync(path.join(root, '.aiwg'));
  fs.writeFileSync(path.join(root, '.aiwg/example.md'), '# Example');
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
    for (const flag of ['--index-workers', '--full', '--workspace', '--root', '--only', '--dry-run', '--json', '--lock-wait-ms', '--max-record-bytes', '--max-source-bytes', '--exclude']) expect(help).toContain(flag);
    expect(help).toContain('1073741824 bytes (1 GiB)');
    expect(help).toContain('AIWG_SESSIONS_IMPORT_MAX_RECORD_BYTES');
    expect(help).toContain('AIWG_SESSIONS_IMPORT_MAX_SOURCE_BYTES');
    expect(help).toContain('AIWG_SESSIONS_IMPORT_EXCLUDE');
  });

  it.each(['0', '2'])('passes --index-workers %s through refresh to graph builds', async value => {
    const build = vi.spyOn(builder, 'buildIndex').mockRejectedValue(new Error('synthetic graph failure'));
    await main(['refresh', '--workspace', root, '--only', 'graphs', '--json', '--index-workers', value]);
    expect(build).toHaveBeenCalledWith(root, expect.objectContaining({workers: Number(value)}));
    expect(JSON.parse(output.mock.calls[0][0]).jobs.some((j: any) => j.error === 'synthetic graph failure')).toBe(true);
  });

  it('honors the environment and lets an explicit serial flag override it', async () => {
    vi.stubEnv('AIWG_INDEX_WORKERS', 'invalid');
    await main(['refresh', '--workspace', root, '--dry-run', '--json']);
    expect(JSON.parse(output.mock.calls[0][0]).messages[0]).toContain('AIWG_INDEX_WORKERS');
    output.mockClear();
    await main(['refresh', '--workspace', root, '--dry-run', '--json', '--index-workers', '0']);
    expect(JSON.parse(output.mock.calls[0][0]).status).toBe('ok');
  });

  it.each(['-1', '1.5', 'invalid', ''])('rejects invalid worker flags: %s', async value => {
    await main(['refresh', '--workspace', root, '--dry-run', '--json', '--index-workers', value]);
    expect(JSON.parse(output.mock.calls[0][0]).status).toBe('error');
    expect(process.exitCode).toBe(1);
  });

  it.each([['0', '3', 0], [undefined, '2', 2], ['2', 'invalid', 2]] as const)(
    'passes build workers from flag %s and env %s', async (flag, env, expected) => {
      vi.stubEnv('AIWG_INDEX_WORKERS', env);
      vi.spyOn(process, 'cwd').mockReturnValue(root);
      const build = vi.spyOn(builder, 'buildIndex').mockResolvedValue();
      await main(['build', '--graph', 'project', ...(flag === undefined ? [] : ['--index-workers', flag])]);
      expect(build).toHaveBeenCalledWith(root, expect.objectContaining({workers:expected}));
    });

  it('continues to later workspaces after a graph fails and emits the complete JSON report', async () => {
    const later = path.join(root, 'later');
    fs.mkdirSync(path.join(later, '.aiwg'), {recursive:true});
    fs.writeFileSync(path.join(later, '.aiwg/requirement.md'), '# Later workspace');
    const original = builder.buildIndex;
    vi.spyOn(builder, 'buildIndex').mockImplementation(async (cwd, options) => {
      if (cwd === root && options?.graph === 'project') throw new Error('synthetic preparation failure');
      await original(cwd, options);
    });
    await main(['refresh', '--workspace', root, '--workspace', later, '--only', 'graphs', '--json', '--index-workers', '0']);
    expect(output).toHaveBeenCalledOnce();
    const report = JSON.parse(output.mock.calls[0][0]);
    expect(report).toMatchObject({status:'partial', totals:{errors:1}});
    expect(report.jobs.find((j: any) => j.workspace === root && j.graph === 'project')).toMatchObject({status:'error', error:'synthetic preparation failure'});
    expect(report.jobs.find((j: any) => j.workspace === later && j.graph === 'project')).toMatchObject({status:'ok'});
    expect(fs.existsSync(path.join(later, '.aiwg/.index/project/metadata.json'))).toBe(true);
  });

  it('includes preparation recovery diagnostics in the graph JSON report', async () => {
    const original = builder.buildIndex;
    vi.spyOn(builder, 'buildIndex').mockImplementation(async (cwd, options) => {
      options?.onDiagnostic?.('synthetic worker exited early; retrying unfinished preparation serially');
      await original(cwd, options);
    });
    await main(['refresh', '--workspace', root, '--only', 'graphs', '--json', '--index-workers', '0']);
    const report = JSON.parse(output.mock.calls[0][0]);
    expect(report.jobs.find((j: any) => j.graph === 'project')).toMatchObject({status:'ok',
      diagnostics:['synthetic worker exited early; retrying unfinished preparation serially']});
    expect(report.totals.errors).toBe(0);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it.each(['-1', '1.5', 'invalid'])('rejects invalid build worker flags: %s', async value => {
    const build = vi.spyOn(builder, 'buildIndex').mockResolvedValue();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await main(['build', '--index-workers', value]);
    expect(build).not.toHaveBeenCalled();
    expect(error.mock.calls[0][0]).toContain('--index-workers');
    expect(process.exitCode).toBe(1);
  });

  it.each(['MAX_RECORD_BYTES', 'MAX_SOURCE_BYTES'])('rejects invalid env %s during refresh planning', async setting => {
    vi.stubEnv(`AIWG_SESSIONS_IMPORT_${setting}`, 'invalid');
    await main(['refresh', '--workspace', root, '--dry-run', '--json']);
    const report = JSON.parse(output.mock.calls[0][0]);
    expect(report.status).toBe('error');
    expect(report.messages[0]).toMatch(/env.*safe integer/);
    expect(process.exitCode).toBe(1);
  });

  itWithSqlite('reports repeated exclusion flags and counts in refresh JSON and text', async () => {
    const providerRoot = path.join(root, 'authorized');
    fs.mkdirSync(providerRoot);
    for (const id of ['first', 'second']) fs.writeFileSync(path.join(providerRoot, `${id}.jsonl`), JSON.stringify({
      type: 'session_meta', payload: { id, cwd: root },
    }) + '\n');
    const manifest = await discoverWorkspaceHistories({ workspace: root, codexRoot: providerRoot, expectedProviders: ['codex'] });
    const manifestPath = path.join(root, '.aiwg/sessions/discovery-manifest.json');
    await writeDiscoveryManifest(manifestPath, manifest);
    new SessionRepository(path.join(root, '.aiwg/sessions/catalog.sqlite')).close();
    for (const id of ['first', 'second']) fs.writeFileSync(path.join(providerRoot, `${id}.jsonl`), 'invalid synthetic data');
    const args = ['refresh', '--workspace', root, '--only', 'sessions', '--exclude', 'first',
      '--exclude', path.join(providerRoot, 'sec?nd.jsonl')];
    await main([...args, '--json']);
    const report = JSON.parse(output.mock.calls[0][0]);
    expect(report).toMatchObject({ status: 'ok', totals: { excluded: 2, errors: 0 } });
    expect(report.jobs[0].sessionImport.totals).toMatchObject({ excluded: 2, rejected: 0 });
    // A fresh catalog makes the same exclusions visible in a text receipt.
    fs.rmSync(path.join(root, '.aiwg/sessions/catalog.sqlite'));
    new SessionRepository(path.join(root, '.aiwg/sessions/catalog.sqlite')).close();
    output.mockClear();
    await main(args);
    const text = output.mock.calls.map(call => call[0]).join('\n');
    expect(text).toContain('Excluded session sources: 2');
    expect(text).toContain('session-id first');
    expect(text).toContain(`path-glob ${path.join(providerRoot, 'sec?nd.jsonl')}`);
    expect(text).not.toContain('session import partial');
    expect(process.exitCode ?? 0).toBe(0);
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
    expect(fs.readdirSync(path.join(root, '.aiwg'))).toEqual(['aiwg.config', 'example.md']);
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
