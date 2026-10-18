import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionsHandler } from '../../../src/cli/handlers/sessions.js';
import type { HandlerContext } from '../../../src/cli/handlers/types.js';
import { SessionRepository } from '../../../src/sessions/repository.js';
import { readDiscoveryManifest, writeDiscoveryManifest } from '../../../src/sessions/workspace-discovery.js';
import { MUSE_WORKSPACE_SCAN_LIMITS } from '../../../src/sessions/adapters/muse-workspace-scan.js';
import { itWithSqlite } from '../../helpers/sqlite.js';
import { museMetadata, writeMuseLog } from '../../helpers/muse-native.js';

let root: string;
let workspace: string;
let manifestPath: string;
let database: string;
let log: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aiwg-muse-cli-'));
  workspace = join(root, 'workspace');
  manifestPath = join(root, 'manifest.json');
  database = join(root, 'catalog.sqlite');
  await Promise.all([workspace, join(root, 'empty-provider-home')].map((path) => mkdir(path)));
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function execute(args: string[]) {
  const context: HandlerContext = {
    args, rawArgs: ['sessions', ...args], cwd: root, frameworkRoot: process.cwd(),
  };
  const result = await sessionsHandler.execute(context);
  expect(result.exitCode).toBe(0);
  return JSON.parse(String(log.mock.calls.at(-1)?.[0]));
}

async function discover() {
  return execute([
    'discover', '--workspace', workspace, '--provider-home', join(root, 'empty-provider-home'),
    '--muse-root', join(root, 'sessions'), '--manifest', manifestPath, '--db', database, '--json',
  ]);
}

async function reproduction() {
  for (const [suffix, count] of [['1', 2], ['2', 101]] as const) {
    await writeMuseLog(join(root, 'sessions'), `00000000-0000-4000-8000-00000000000${suffix}`, count, workspace);
  }
}

describe('Muse discovery through the public sessions handler', () => {
  it('selects both sources in the isolated 2-record/101-record reproduction', async () => {
    await reproduction();
    const output = await discover();
    expect(output).toMatchObject({ status: 'ok', data: { manifestPersisted: true } });
    expect(output.data.manifest.providers.find((provider: { provider: string }) => provider.provider === 'muse'))
      .toMatchObject({ status: 'checked', sourceCount: 2, reasonCode: null, remediation: null });
    const manifest = await readDiscoveryManifest(manifestPath);
    expect(manifest.sources).toHaveLength(2);
    expect(output.data.manifest.sources.map((source: { sourceId: string }) => source.sourceId))
      .toEqual(manifest.sources.map((source) => source.sourceId));
    expect(manifest.sources.every((source) => source.authorizedRoot === join(root, 'sessions'))).toBe(true);
  });

  itWithSqlite('imports the longer matching session with the exact selected identities and replays idempotently', async () => {
    await reproduction();
    await discover();
    const manifest = await readDiscoveryManifest(manifestPath);
    const args = ['import-discovered', '--workspace', workspace, '--manifest', manifestPath, '--db', database, '--confirm', '--json'];
    const output = await execute(args);
    expect(output.data).toMatchObject({ manifestId: manifest.manifestId, receipt: { totals: { discovered: 2, accepted: 2, rejected: 0, eventsAccepted: 103 } } });
    expect(output.data.receipt.run.sources.map((source: { sourceId: string }) => source.sourceId))
      .toEqual(manifest.sources.map((source) => source.sourceId));
    const repository = new SessionRepository(database);
    try {
      const sessions = repository.listSessions({ workspaceId: workspace, limit: 20 });
      expect(sessions.total).toBe(2);
      expect(sessions.items.map((session) => session.nativeSessionId).sort()).toEqual([
        '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002',
      ]);
      expect(repository.doctor()).toMatchObject({ sources: 2, sessions: 2, events: 103 });
    } finally {
      repository.close();
    }
    const replay = await execute(args);
    expect(replay.data.receipt.run.sources.every((source: { status: string }) => source.status === 'previously-committed')).toBe(true);
  });

  it('exposes malformed inspection alongside a selected long source in CLI JSON', async () => {
    await reproduction();
    const locator = await writeMuseLog(join(root, 'sessions'), 'malformed', 1);
    await writeFile(locator, '{invalid}\n');
    const output = await discover();
    const report = output.data.manifest.providers.find((provider: { provider: string }) => provider.provider === 'muse');
    expect(report).toMatchObject({ sourceCount: 2, status: 'not-checked', reasonCode: 'MUSE_SOURCE_INSPECTION_INCOMPLETE' });
    expect(report.museSourceInspections).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: 'inconclusive', reasonCode: 'MALFORMED_SOURCE' }),
    ]));
  });

  it('selects tail-attributed sources and persists unattributed limit receipts in CLI JSON', async () => {
    const museRoot = join(root, 'sessions');
    const matched = await writeMuseLog(museRoot, 'tail-matched', MUSE_WORKSPACE_SCAN_LIMITS.maxRecords + 1,
      workspace, MUSE_WORKSPACE_SCAN_LIMITS.maxRecords);
    await writeMuseLog(museRoot, 'unattributed', MUSE_WORKSPACE_SCAN_LIMITS.maxRecords + 1);
    const output = await discover();
    const manifest = await readDiscoveryManifest(manifestPath);
    expect(manifest.sources.map((source) => source.locator)).toEqual([matched]);
    const report = output.data.manifest.providers.find((provider: { provider: string }) => provider.provider === 'muse');
    expect(report).toMatchObject({
      sourceCount: 1, status: 'not-checked', reasonCode: 'MUSE_SOURCE_INSPECTION_INCOMPLETE',
      remediation: expect.stringContaining('unattributed'),
    });
    expect(report.museSourceInspections).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: 'matched', attribution: 'matched', fallback: 'bounded-tail' }),
      expect.objectContaining({
        outcome: 'inconclusive', attribution: 'unattributed', reasonCode: 'RESOURCE_LIMIT_EXCEEDED',
        nativeSessionId: 'unattributed',
        limit: { name: 'maxRecords', value: MUSE_WORKSPACE_SCAN_LIMITS.maxRecords },
        sourceKey: expect.any(String), redactedLocator: expect.any(String),
      }),
    ]));
    expect(manifest.providers.find((provider) => provider.provider === 'muse')!.museSourceInspections)
      .toEqual(report.museSourceInspections);
    expect(JSON.stringify(report)).not.toContain(museRoot);
    const unresolved = manifest.providers.find((provider) => provider.provider === 'muse')!
      .museSourceInspections!.find((inspection) => inspection.attribution === 'unattributed')!;
    unresolved.limit!.value += 1;
    await writeDiscoveryManifest(manifestPath, manifest);
    await expect(readDiscoveryManifest(manifestPath)).rejects.toThrow('identity');
  });

  itWithSqlite('imports a session attributed from tail evidence into the workspace catalog', async () => {
    const count = MUSE_WORKSPACE_SCAN_LIMITS.maxRecords + 1;
    await writeMuseLog(join(root, 'sessions'), 'tail-import', count, workspace, count - 1);
    await discover();
    const output = await execute([
      'import-discovered', '--workspace', workspace, '--manifest', manifestPath,
      '--db', database, '--confirm', '--json',
    ]);
    expect(output.data.receipt.totals).toMatchObject({
      discovered: 1, accepted: 1, rejected: 0, eventsAccepted: count,
    });
    const repository = new SessionRepository(database);
    try {
      expect(repository.listSessions({ workspaceId: workspace, limit: 20 }).items)
        .toEqual([expect.objectContaining({ nativeSessionId: 'tail-import', workspaceId: workspace })]);
    } finally {
      repository.close();
    }
  });

  itWithSqlite.each([false, true])('imports a 5000-record session (retained evidence: %s)', async (retained) => {
    const locator = await writeMuseLog(join(root, 'sessions'), 'long-session', 5000, workspace);
    if (retained) {
      const frame = { retained_frame: 'synthetic-frame', children: [
        { child_index: 0, record_json: JSON.stringify(museMetadata('long-session', 0, workspace)) },
      ] };
      const lines = Array.from({ length: 4999 }, (_, i) => JSON.stringify(museMetadata('long-session', i + 1)));
      await writeFile(locator, [JSON.stringify(frame), ...lines].join('\n') + '\n');
    }
    await discover();
    const manifest = await readDiscoveryManifest(manifestPath);
    const output = await execute(['import-discovered', '--workspace', workspace, '--manifest', manifestPath, '--db', database, '--confirm', '--json']);
    expect(output.data.receipt).toMatchObject({ totals: { discovered: 1, accepted: 1, rejected: 0, eventsAccepted: 5000 }, run: { sources: [expect.objectContaining({ sourceId: manifest.sources[0].sourceId })] } });
  });

  itWithSqlite('validates the full selected history at import and reports a malformed tail', async () => {
    const locator = await writeMuseLog(join(root, 'sessions'), 'matched-prefix', 1, workspace);
    await appendFile(locator, '{invalid}\n');
    await discover();
    const manifest = await readDiscoveryManifest(manifestPath);
    expect(manifest.sources).toHaveLength(1);
    const output = await execute(['import-discovered', '--workspace', workspace, '--manifest', manifestPath, '--db', database, '--confirm', '--json']);
    expect(output.data.receipt).toMatchObject({ totals: { discovered: 1, accepted: 0, rejected: 1 }, run: { sources: [expect.objectContaining({ sourceId: manifest.sources[0].sourceId, errorCode: 'MALFORMED_SOURCE' })] } });
  });
});
