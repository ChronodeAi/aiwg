import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import { sessionsHandler } from '../../../../src/cli/handlers/sessions.js';
import type { HandlerContext } from '../../../../src/cli/handlers/types.js';
import {
  FilesystemDerivedOutputIndex,
  FilesystemOutputRegistrationStore,
  OutputRegistrationCoordinator,
} from '../../../../src/sessions/index.js';
import { describeWithSqlite } from '../../../helpers/sqlite.js';

function context(args: string[], cwd = process.cwd()): HandlerContext {
  return {
    args, rawArgs: ['sessions', ...args], cwd, frameworkRoot: process.cwd(),
  };
}

function jsonOutput(spy: ReturnType<typeof vi.spyOn>): Record<string, any> {
  return JSON.parse(String(spy.mock.calls.at(-1)?.[0]));
}

describeWithSqlite('sessions export CLI (#2564)', () => {
  let root: string;
  let db: string;
  let log: ReturnType<typeof vi.spyOn>;
  let sessionIds: string[];

  beforeEach(async () => {
    root = mkdtempSync(resolve(tmpdir(), 'aiwg-sessions-export-cli-'));
    db = resolve(root, 'catalog.sqlite');
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const fixture = resolve(root, 'web-export.json');
    writeFileSync(fixture, readFileSync(resolve('test/fixtures/sessions/claude/web-export.json')));
    await sessionsHandler.execute(context([
      'import', fixture, '--provider', 'claude', '--source-id', 'cli-export-fixture',
      '--workspace', 'default', '--db', db, '--json',
    ]));
    log.mockClear();
    const listed = await sessionsHandler.execute(context(['list', '--workspace', 'default', '--db', db, '--json']));
    expect(listed.exitCode).toBe(0);
    sessionIds = jsonOutput(log).data.items.map((item: any) => item.sessionId);
    expect(sessionIds).toHaveLength(2);
    log.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('runs plan -> build -> verify -> unpack and recovers the exact session/event count', async () => {
    const planPath = resolve(root, 'selection.json');
    const planResult = await sessionsHandler.execute(context([
      'export', 'plan', '--workspace', 'default', '--db', db, '--out', planPath, ...sessionIds, '--json',
    ]));
    expect(planResult.exitCode).toBe(0);
    expect(jsonOutput(log)).toMatchObject({
      status: 'ok', command: 'sessions.export.plan',
      data: { totals: { sessionCount: 2, eventCount: 3, recordCount: 5 } },
    });
    log.mockClear();

    const buildDir = resolve(root, 'export-out');
    const buildResult = await sessionsHandler.execute(context([
      'export', 'build', '--db', db, '--plan', planPath, '--out', buildDir, '--json',
    ]));
    expect(buildResult.exitCode).toBe(0);
    const buildData = jsonOutput(log).data;
    expect(buildData).toMatchObject({
      archiveProfile: 'full-v1', archiveSchemaVersion: '2.0.0',
      totals: { sessionCount: 2, eventCount: 3, recordCount: 5 },
    });
    log.mockClear();

    const shardPath = resolve(buildDir, 'evidence.shard');
    const verifyResult = await sessionsHandler.execute(context(['export', 'verify', '--input', shardPath, '--json']));
    expect(verifyResult.exitCode).toBe(0);
    expect(jsonOutput(log)).toMatchObject({
      status: 'ok',
      data: { valid: true, itemCount: 5, receiptChecked: true, receiptMatches: true },
    });
    log.mockClear();

    const unpackDir = resolve(root, 'unpacked');
    const unpackResult = await sessionsHandler.execute(context([
      'export', 'unpack', '--input', shardPath, '--out', unpackDir, '--json',
    ]));
    expect(unpackResult.exitCode).toBe(0);
    expect(jsonOutput(log)).toMatchObject({
      status: 'ok',
      data: { itemCount: 5, sessionRecordCount: 2, eventRecordCount: 3 },
    });
    const recovered = JSON.parse(readFileSync(resolve(unpackDir, 'index.json'), 'utf8'));
    expect(recovered.items).toHaveLength(5);
  });

  it('rejects a build whose plan is stale because the plan file was tampered with', async () => {
    const planPath = resolve(root, 'selection.json');
    await sessionsHandler.execute(context([
      'export', 'plan', '--workspace', 'default', '--db', db, '--out', planPath, ...sessionIds, '--json',
    ]));
    log.mockClear();
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    plan.sessions[0].sourceDigest = `sha256:${'0'.repeat(64)}`;
    writeFileSync(planPath, JSON.stringify(plan));

    const buildDir = resolve(root, 'export-out-stale');
    const result = await sessionsHandler.execute(context([
      'export', 'build', '--db', db, '--plan', planPath, '--out', buildDir, '--json',
    ]));
    expect(result.exitCode).not.toBe(0);
    expect(jsonOutput(log)).toMatchObject({
      status: 'error', error: { code: 'SCHEMA_DRIFT' },
    });
  });

  it('rejects an export plan with no session ids', async () => {
    const planPath = resolve(root, 'empty-selection.json');
    const result = await sessionsHandler.execute(context([
      'export', 'plan', '--workspace', 'default', '--db', db, '--out', planPath, '--json',
    ]));
    expect(result.exitCode).not.toBe(0);
    expect(jsonOutput(log)).toMatchObject({ status: 'error', error: { code: 'INVALID_ARGUMENT' } });
  });

  it('verify fails closed on a corrupted shard file', async () => {
    const badShard = resolve(root, 'corrupt.shard');
    writeFileSync(badShard, 'not a real shard archive');
    const result = await sessionsHandler.execute(context(['export', 'verify', '--input', badShard, '--json']));
    expect(result.exitCode).not.toBe(0);
    expect(jsonOutput(log)).toMatchObject({ status: 'error', error: { code: 'MALFORMED_SOURCE' } });
  });

  it('carries a registered output through plan -> build -> unpack as a session-output record (#2566)', async () => {
    mkdirSync(resolve(root, 'output/reports'), { recursive: true });
    writeFileSync(resolve(root, 'output/reports/result.md'), '# Derived analysis\n');
    const coordinator = new OutputRegistrationCoordinator(
      root,
      new FilesystemOutputRegistrationStore(root),
      new FilesystemDerivedOutputIndex(root),
    );
    const request = {
      outputPath: 'output/reports/result.md',
      mediaType: 'text/markdown',
      contextPack: {
        id: 'context-pack:cli-test-1',
        digest: `sha256:${'2'.repeat(64)}`,
        sources: [{ kind: 'session' as const, ref: sessionIds[0], digest: null, span: null }],
      },
      supersedes: [], conflictsWith: [],
    };
    const preview = coordinator.preview(request);
    await coordinator.register({ request, operationId: preview.operationId });

    const planPath = resolve(root, 'selection-with-output.json');
    const planResult = await sessionsHandler.execute(context([
      'export', 'plan', '--workspace', 'default', '--db', db, '--out', planPath, ...sessionIds, '--json',
    ], root));
    expect(planResult.exitCode).toBe(0);
    expect(jsonOutput(log)).toMatchObject({ status: 'ok', data: { outputs: 1 } });
    log.mockClear();

    const buildDir = resolve(root, 'export-out-with-output');
    const buildResult = await sessionsHandler.execute(context([
      'export', 'build', '--db', db, '--plan', planPath, '--out', buildDir, '--json',
    ], root));
    expect(buildResult.exitCode).toBe(0);
    expect(jsonOutput(log).data.totals).toMatchObject({ outputCount: 1 });
    log.mockClear();

    const unpackDir = resolve(root, 'unpacked-with-output');
    await sessionsHandler.execute(context([
      'export', 'unpack', '--input', resolve(buildDir, 'evidence.shard'), '--out', unpackDir, '--json',
    ], root));
    const recovered = JSON.parse(readFileSync(resolve(unpackDir, 'index.json'), 'utf8'));
    const outputRecord = recovered.items.find((item: any) => item.type === 'aiwg.session-output');
    expect(outputRecord).toBeDefined();
    expect(outputRecord.source.repo_relative_path).toBe('output/reports/result.md');
    expect(outputRecord.compatibility).toMatchObject({
      sessionId: sessionIds[0], outputLocator: 'output/reports/result.md', bytesEmbedded: false,
    });
  });
});
