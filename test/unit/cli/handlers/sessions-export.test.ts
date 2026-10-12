import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
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
    await sessionsHandler.execute(context([
      'tag', sessionIds[0], 'reviewed-selection', '--workspace', 'default', '--db', db, '--json',
    ]));
    log.mockClear();
    const planPath = resolve(root, 'selection.json');
    const planResult = await sessionsHandler.execute(context([
      'export', 'plan', '--workspace', 'default', '--db', db, '--out', planPath, ...sessionIds, '--json',
    ]));
    expect(planResult.exitCode).toBe(0);
    expect(jsonOutput(log)).toMatchObject({
      status: 'ok', command: 'sessions.export.plan',
      data: { totals: { sessionCount: 2, eventCount: 3, recordCount: 6 } },
    });
    log.mockClear();

    const buildDir = resolve(root, 'export-out');
    const buildResult = await sessionsHandler.execute(context([
      'export', 'build', '--db', db, '--plan', planPath, '--out', buildDir, '--json',
    ]));
    expect(buildResult.exitCode).toBe(0);
    const buildData = jsonOutput(log).data;
    expect(buildData).toMatchObject({
      archiveProfile: 'full-v1', archiveSchemaVersion: '2.0.0', lossless: true, losses: [],
      // recordCount here includes the synthetic export-manifest record (#2564);
      // verify/unpack below exclude it again since it isn't a session/event/output.
      totals: { sessionCount: 2, eventCount: 3, recordCount: 6 },
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
    // Index-level source is recovered via the export-manifest record (#2564),
    // not the placeholder -- confirms the fix actually round-trips.
    expect(recovered.source).toEqual({ repo: 'default', privacy: 'private' });
    expect(recovered.items.some((item: any) => item.type === 'aiwg.session-catalog-export-manifest')).toBe(false);
    expect(recovered.items.find((item: any) => item.id === sessionIds[0]).tags)
      .toContain('catalogTag:reviewed-selection');
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

  it('refuses to overwrite an existing shard and receipt unless --force is explicit', async () => {
    const planPath = resolve(root, 'selection-overwrite.json');
    await sessionsHandler.execute(context([
      'export', 'plan', '--workspace', 'default', '--db', db, '--out', planPath, ...sessionIds, '--json',
    ]));
    const buildDir = resolve(root, 'export-overwrite');
    const command = ['export', 'build', '--db', db, '--plan', planPath, '--out', buildDir, '--json'];
    expect((await sessionsHandler.execute(context(command))).exitCode).toBe(0);
    log.mockClear();
    const refused = await sessionsHandler.execute(context(command));
    expect(refused.exitCode).not.toBe(0);
    expect(jsonOutput(log)).toMatchObject({ status: 'error', error: { code: 'OUTPUT_EXISTS' } });
    log.mockClear();
    expect((await sessionsHandler.execute(context([...command, '--force']))).exitCode).toBe(0);
  });

  it('rejects a plan after selected session tags change', async () => {
    const planPath = resolve(root, 'selection-tag-drift.json');
    await sessionsHandler.execute(context([
      'export', 'plan', '--workspace', 'default', '--db', db, '--out', planPath, sessionIds[0], '--json',
    ]));
    await sessionsHandler.execute(context([
      'tag', sessionIds[0], 'changed-after-plan', '--workspace', 'default', '--db', db, '--json',
    ]));
    log.mockClear();
    const result = await sessionsHandler.execute(context([
      'export', 'build', '--db', db, '--plan', planPath, '--out', resolve(root, 'tag-drift'), '--json',
    ]));
    expect(result.exitCode).not.toBe(0);
    expect(jsonOutput(log)).toMatchObject({ status: 'error', error: { code: 'SCHEMA_DRIFT' } });
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
    expect(outputRecord.tags).toEqual(expect.arrayContaining(['mediaType:text/markdown', 'lineage:registered']));
    expect(outputRecord.provenance_events).toContainEqual(expect.objectContaining({
      activity: 'aiwg.session-output',
      attributes: expect.objectContaining({
        sessionId: sessionIds[0], outputLocator: 'output/reports/result.md', bytesEmbedded: false,
      }),
    }));
  });

  it('rejects changed registered-output bytes and opt-in embedding recovers exact bytes (#2569)', async () => {
    const original = Buffer.from('exact registered analysis bytes\n\0binary-safe', 'utf8');
    mkdirSync(resolve(root, 'output/reports'), { recursive: true });
    const outputPath = resolve(root, 'output/reports/exact.bin');
    writeFileSync(outputPath, original);
    const coordinator = new OutputRegistrationCoordinator(
      root,
      new FilesystemOutputRegistrationStore(root),
      new FilesystemDerivedOutputIndex(root),
    );
    const request = {
      outputPath: 'output/reports/exact.bin', mediaType: 'application/octet-stream',
      contextPack: {
        id: 'context-pack:bytes-test', digest: `sha256:${'3'.repeat(64)}`,
        sources: [{ kind: 'session' as const, ref: sessionIds[0], digest: null, span: null }],
      },
      supersedes: [], conflictsWith: [],
    };
    const preview = coordinator.preview(request);
    await coordinator.register({ request, operationId: preview.operationId });
    const planPath = resolve(root, 'selection-bytes.json');
    await sessionsHandler.execute(context([
      'export', 'plan', '--workspace', 'default', '--db', db, '--out', planPath, sessionIds[0], '--json',
    ], root));

    writeFileSync(outputPath, 'changed after planning');
    log.mockClear();
    const drift = await sessionsHandler.execute(context([
      'export', 'build', '--db', db, '--plan', planPath, '--out', resolve(root, 'drifted-output'), '--json',
    ], root));
    expect(drift.exitCode).not.toBe(0);
    expect(jsonOutput(log)).toMatchObject({ status: 'error', error: { code: 'SCHEMA_DRIFT' } });

    writeFileSync(outputPath, original);
    log.mockClear();
    const buildDir = resolve(root, 'embedded-output');
    const built = await sessionsHandler.execute(context([
      'export', 'build', '--db', db, '--plan', planPath, '--out', buildDir, '--include-bytes', '--json',
    ], root));
    expect(built.exitCode, JSON.stringify(jsonOutput(log))).toBe(0);
    expect(jsonOutput(log).data).toMatchObject({ embeddedAttachmentCount: 1, embeddedAttachmentBytes: original.length });
    log.mockClear();
    const unpackDir = resolve(root, 'embedded-output-unpacked');
    const unpacked = await sessionsHandler.execute(context([
      'export', 'unpack', '--input', resolve(buildDir, 'evidence.shard'), '--out', unpackDir, '--json',
    ], root));
    expect(unpacked.exitCode).toBe(0);
    const attachmentRoot = resolve(unpackDir, 'attachments');
    const recordDirectory = (await import('node:fs')).readdirSync(attachmentRoot)[0];
    const recoveredPath = resolve(attachmentRoot, recordDirectory, 'exact.bin');
    expect(existsSync(recoveredPath)).toBe(true);
    expect(readFileSync(recoveredPath)).toEqual(original);
  });

  it('exports a non-Claude provider (Codex) through the same plan/build pipeline, proving the mapping is provider-agnostic', async () => {
    const codexDb = resolve(root, 'codex-catalog.sqlite');
    const fixture = resolve('test/fixtures/sessions/codex/threads.app-server.jsonl');
    const imported = await sessionsHandler.execute(context([
      'import', fixture, '--provider', 'codex', '--source-id', 'codex-export-fixture',
      '--workspace', 'default', '--db', codexDb, '--json',
    ]));
    expect(imported.exitCode).toBe(0);
    log.mockClear();

    const listed = await sessionsHandler.execute(context(['list', '--workspace', 'default', '--db', codexDb, '--json']));
    const codexSessionIds = jsonOutput(log).data.items.map((item: any) => item.sessionId);
    expect(codexSessionIds.length).toBeGreaterThan(0);
    log.mockClear();

    const planPath = resolve(root, 'codex-selection.json');
    const planResult = await sessionsHandler.execute(context([
      'export', 'plan', '--workspace', 'default', '--db', codexDb, '--out', planPath, ...codexSessionIds, '--json',
    ]));
    expect(planResult.exitCode).toBe(0);
    log.mockClear();

    const buildDir = resolve(root, 'codex-export-out');
    const buildResult = await sessionsHandler.execute(context([
      'export', 'build', '--db', codexDb, '--plan', planPath, '--out', buildDir, '--json',
    ]));
    expect(buildResult.exitCode).toBe(0);
    expect(jsonOutput(log).data).toMatchObject({ archiveProfile: 'full-v1', archiveSchemaVersion: '2.0.0', lossless: true });
    log.mockClear();

    const verifyResult = await sessionsHandler.execute(context([
      'export', 'verify', '--input', resolve(buildDir, 'evidence.shard'), '--json',
    ]));
    expect(verifyResult.exitCode).toBe(0);
    expect(jsonOutput(log).data).toMatchObject({ valid: true, receiptMatches: true });
  });

  it('embeds and exactly recovers locally present session-event attachment bytes (#2569)', async () => {
    const attachmentDb = resolve(root, 'opencode-attachment.sqlite');
    const fixture = resolve('test/fixtures/sessions/opencode/complete.json');
    expect((await sessionsHandler.execute(context([
      'import', fixture, '--provider', 'opencode', '--source-id', 'opencode-attachment-fixture',
      '--workspace', 'default', '--db', attachmentDb, '--json',
    ]))).exitCode).toBe(0);
    log.mockClear();
    await sessionsHandler.execute(context(['list', '--workspace', 'default', '--db', attachmentDb, '--json']));
    const attachmentSessionId = jsonOutput(log).data.items[0].sessionId;
    log.mockClear();
    const planPath = resolve(root, 'opencode-attachment-plan.json');
    const plannedAttachment = await sessionsHandler.execute(context([
      'export', 'plan', '--workspace', 'default', '--db', attachmentDb, '--out', planPath,
      attachmentSessionId, '--json',
    ], root));
    expect(plannedAttachment.exitCode, JSON.stringify(jsonOutput(log))).toBe(0);
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    expect(plan.attachments).toHaveLength(1);
    expect(plan.attachments[0]).toMatchObject({ filename: 'synthetic.txt', byteLength: 9 });
    log.mockClear();
    const buildDir = resolve(root, 'opencode-attachment-export');
    expect((await sessionsHandler.execute(context([
      'export', 'build', '--db', attachmentDb, '--plan', planPath, '--out', buildDir,
      '--include-bytes', '--json',
    ], root))).exitCode).toBe(0);
    const unpackDir = resolve(root, 'opencode-attachment-unpacked');
    expect((await sessionsHandler.execute(context([
      'export', 'unpack', '--input', resolve(buildDir, 'evidence.shard'), '--out', unpackDir, '--json',
    ], root))).exitCode).toBe(0);
    const attachmentRoot = resolve(unpackDir, 'attachments');
    const recordDirectory = (await import('node:fs')).readdirSync(attachmentRoot)[0];
    expect(readFileSync(resolve(attachmentRoot, recordDirectory, 'synthetic.txt'), 'utf8')).toBe('Synthetic');
  });
});
