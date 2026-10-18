import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  afterEach, beforeEach, describe, expect, it, onTestFailed, vi,
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

// Step-timing diagnostics for #2653. The export round-trip intermittently hits
// the suite test timeout on loaded hosts, and the timeout message alone does
// not say which step stalled. Every awaited handler call below runs inside
// `exportStep`, which records wall-clock start/end via performance.now(). The
// report prints only when a test fails or times out, so passing runs stay
// silent. It is bounded: at most 50 steps and 4000 chars on stderr.
interface ExportStepTiming {
  name: string;
  startMs: number;
  endMs?: number;
  outcome?: 'ok' | 'error';
}

const EXPORT_TIMING_MAX_STEPS = 50;
const EXPORT_TIMING_MAX_REPORT_CHARS = 4000;

let exportStepTimings: ExportStepTiming[] = [];
let exportTimingWallStartMs = 0;
let exportTimingCpuStart: NodeJS.CpuUsage | undefined;
let exportTimingTestStarted = false;
let exportTimingReported = false;

function resetExportStepTiming(): void {
  exportStepTimings = [];
  exportTimingWallStartMs = performance.now();
  exportTimingCpuStart = process.cpuUsage();
  exportTimingTestStarted = false;
  exportTimingReported = false;
}

async function exportStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const record: ExportStepTiming = { name, startMs: performance.now() };
  exportStepTimings.push(record);
  try {
    const result = await fn();
    record.endMs = performance.now();
    record.outcome = 'ok';
    return result;
  } catch (error) {
    record.endMs = performance.now();
    record.outcome = 'error';
    throw error;
  }
}

function armExportStepTiming(testName: string): void {
  exportTimingTestStarted = true;
  onTestFailed(() => {
    reportExportStepTiming(testName, 'onTestFailed');
  });
}

function reportExportStepTiming(testName: string, trigger: string): void {
  if (exportTimingReported) return;
  exportTimingReported = true;
  const nowMs = performance.now();
  const lines = [`[sessions-export timing] ${testName} (via ${trigger})`];
  for (const record of exportStepTimings.slice(0, EXPORT_TIMING_MAX_STEPS)) {
    if (record.endMs === undefined) {
      lines.push(`  in-progress: ${record.name} elapsed=${Math.round(nowMs - record.startMs)}ms`);
    } else {
      lines.push(`  done: ${record.name} duration=${Math.round(record.endMs - record.startMs)}ms outcome=${record.outcome ?? 'unknown'}`);
    }
  }
  if (exportStepTimings.length > EXPORT_TIMING_MAX_STEPS) {
    lines.push(`  ... ${exportStepTimings.length - EXPORT_TIMING_MAX_STEPS} further steps omitted`);
  }
  const activeByType = new Map<string, number>();
  for (const resource of process.getActiveResourcesInfo()) {
    activeByType.set(resource, (activeByType.get(resource) ?? 0) + 1);
  }
  const activeSummary = [...activeByType.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([type, count]) => `${type}=${count}`)
    .join(' ');
  lines.push(`  active resources: ${activeSummary || 'none'}`);
  if (exportTimingCpuStart !== undefined) {
    const cpu = process.cpuUsage(exportTimingCpuStart);
    lines.push(
      `  cpu since test start: user=${Math.round(cpu.user / 1000)}ms system=${Math.round(cpu.system / 1000)}ms wall=${Math.round(nowMs - exportTimingWallStartMs)}ms`,
    );
  }
  process.stderr.write(`${lines.join('\n').slice(0, EXPORT_TIMING_MAX_REPORT_CHARS)}\n`);
}

describeWithSqlite('sessions export CLI (#2564)', () => {
  let root: string;
  let db: string;
  let log: ReturnType<typeof vi.spyOn>;
  let sessionIds: string[];

  beforeEach(async () => {
    resetExportStepTiming();
    root = mkdtempSync(resolve(tmpdir(), 'aiwg-sessions-export-cli-'));
    db = resolve(root, 'catalog.sqlite');
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const fixture = resolve(root, 'web-export.json');
    writeFileSync(fixture, readFileSync(resolve('test/fixtures/sessions/claude/web-export.json')));
    await exportStep('import', () => sessionsHandler.execute(context([
      'import', fixture, '--provider', 'claude', '--source-id', 'cli-export-fixture',
      '--workspace', 'default', '--db', db, '--json',
    ])));
    log.mockClear();
    const listed = await exportStep('list', () => sessionsHandler.execute(context(['list', '--workspace', 'default', '--db', db, '--json'])));
    expect(listed.exitCode).toBe(0);
    sessionIds = jsonOutput(log).data.items.map((item: any) => item.sessionId);
    expect(sessionIds).toHaveLength(2);
    log.mockClear();
  });

  afterEach((context) => {
    try {
      // Backstop for failures before the test body arms its own reporter
      // (e.g. a setup step stalls and the run times out in beforeEach).
      if (!exportTimingTestStarted && context.task.result?.state === 'fail') {
        reportExportStepTiming(context.task.name, 'afterEach');
      }
    } finally {
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs plan -> build -> verify -> unpack and recovers the exact session/event count', async () => {
    armExportStepTiming('runs plan -> build -> verify -> unpack and recovers the exact session/event count');
    await exportStep('tag', () => sessionsHandler.execute(context([
      'tag', sessionIds[0], 'reviewed-selection', '--workspace', 'default', '--db', db, '--json',
    ])));
    log.mockClear();
    const planPath = resolve(root, 'selection.json');
    const planResult = await exportStep('export plan', () => sessionsHandler.execute(context([
      'export', 'plan', '--workspace', 'default', '--db', db, '--out', planPath, ...sessionIds, '--json',
    ])));
    expect(planResult.exitCode).toBe(0);
    expect(jsonOutput(log)).toMatchObject({
      status: 'ok', command: 'sessions.export.plan',
      data: { totals: { sessionCount: 2, eventCount: 3, recordCount: 6 } },
    });
    log.mockClear();

    const buildDir = resolve(root, 'export-out');
    const buildResult = await exportStep('export build', () => sessionsHandler.execute(context([
      'export', 'build', '--db', db, '--plan', planPath, '--out', buildDir, '--json',
    ])));
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
    const verifyResult = await exportStep('export verify', () => sessionsHandler.execute(context(['export', 'verify', '--input', shardPath, '--json'])));
    expect(verifyResult.exitCode).toBe(0);
    expect(jsonOutput(log)).toMatchObject({
      status: 'ok',
      data: { valid: true, itemCount: 5, receiptChecked: true, receiptMatches: true },
    });
    log.mockClear();

    const unpackDir = resolve(root, 'unpacked');
    const unpackResult = await exportStep('export unpack', () => sessionsHandler.execute(context([
      'export', 'unpack', '--input', shardPath, '--out', unpackDir, '--json',
    ])));
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
    armExportStepTiming('rejects a build whose plan is stale because the plan file was tampered with');
    const planPath = resolve(root, 'selection.json');
    await exportStep('export plan', () => sessionsHandler.execute(context([
      'export', 'plan', '--workspace', 'default', '--db', db, '--out', planPath, ...sessionIds, '--json',
    ])));
    log.mockClear();
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    plan.sessions[0].sourceDigest = `sha256:${'0'.repeat(64)}`;
    writeFileSync(planPath, JSON.stringify(plan));

    const buildDir = resolve(root, 'export-out-stale');
    const result = await exportStep('export build', () => sessionsHandler.execute(context([
      'export', 'build', '--db', db, '--plan', planPath, '--out', buildDir, '--json',
    ])));
    expect(result.exitCode).not.toBe(0);
    expect(jsonOutput(log)).toMatchObject({
      status: 'error', error: { code: 'SCHEMA_DRIFT' },
    });
  });

  it('refuses to overwrite an existing shard and receipt unless --force is explicit', async () => {
    armExportStepTiming('refuses to overwrite an existing shard and receipt unless --force is explicit');
    const planPath = resolve(root, 'selection-overwrite.json');
    await exportStep('export plan', () => sessionsHandler.execute(context([
      'export', 'plan', '--workspace', 'default', '--db', db, '--out', planPath, ...sessionIds, '--json',
    ])));
    const buildDir = resolve(root, 'export-overwrite');
    const command = ['export', 'build', '--db', db, '--plan', planPath, '--out', buildDir, '--json'];
    expect((await exportStep('export build', () => sessionsHandler.execute(context(command)))).exitCode).toBe(0);
    log.mockClear();
    const refused = await exportStep('export build (existing output)', () => sessionsHandler.execute(context(command)));
    expect(refused.exitCode).not.toBe(0);
    expect(jsonOutput(log)).toMatchObject({ status: 'error', error: { code: 'OUTPUT_EXISTS' } });
    log.mockClear();
    expect((await exportStep('export build (force)', () => sessionsHandler.execute(context([...command, '--force'])))).exitCode).toBe(0);
  });

  it('rejects a plan after selected session tags change', async () => {
    armExportStepTiming('rejects a plan after selected session tags change');
    const planPath = resolve(root, 'selection-tag-drift.json');
    await exportStep('export plan', () => sessionsHandler.execute(context([
      'export', 'plan', '--workspace', 'default', '--db', db, '--out', planPath, sessionIds[0], '--json',
    ])));
    await exportStep('tag', () => sessionsHandler.execute(context([
      'tag', sessionIds[0], 'changed-after-plan', '--workspace', 'default', '--db', db, '--json',
    ])));
    log.mockClear();
    const result = await exportStep('export build', () => sessionsHandler.execute(context([
      'export', 'build', '--db', db, '--plan', planPath, '--out', resolve(root, 'tag-drift'), '--json',
    ])));
    expect(result.exitCode).not.toBe(0);
    expect(jsonOutput(log)).toMatchObject({ status: 'error', error: { code: 'SCHEMA_DRIFT' } });
  });

  it('rejects an export plan with no session ids', async () => {
    armExportStepTiming('rejects an export plan with no session ids');
    const planPath = resolve(root, 'empty-selection.json');
    const result = await exportStep('export plan', () => sessionsHandler.execute(context([
      'export', 'plan', '--workspace', 'default', '--db', db, '--out', planPath, '--json',
    ])));
    expect(result.exitCode).not.toBe(0);
    expect(jsonOutput(log)).toMatchObject({ status: 'error', error: { code: 'INVALID_ARGUMENT' } });
  });

  it('verify fails closed on a corrupted shard file', async () => {
    armExportStepTiming('verify fails closed on a corrupted shard file');
    const badShard = resolve(root, 'corrupt.shard');
    writeFileSync(badShard, 'not a real shard archive');
    const result = await exportStep('export verify', () => sessionsHandler.execute(context(['export', 'verify', '--input', badShard, '--json'])));
    expect(result.exitCode).not.toBe(0);
    expect(jsonOutput(log)).toMatchObject({ status: 'error', error: { code: 'MALFORMED_SOURCE' } });
  });

  it('carries a registered output through plan -> build -> unpack as a session-output record (#2566)', async () => {
    armExportStepTiming('carries a registered output through plan -> build -> unpack as a session-output record (#2566)');
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
    await exportStep('output register', () => coordinator.register({ request, operationId: preview.operationId }));

    const planPath = resolve(root, 'selection-with-output.json');
    const planResult = await exportStep('export plan', () => sessionsHandler.execute(context([
      'export', 'plan', '--workspace', 'default', '--db', db, '--out', planPath, ...sessionIds, '--json',
    ], root)));
    expect(planResult.exitCode).toBe(0);
    expect(jsonOutput(log)).toMatchObject({ status: 'ok', data: { outputs: 1 } });
    log.mockClear();

    const buildDir = resolve(root, 'export-out-with-output');
    const buildResult = await exportStep('export build', () => sessionsHandler.execute(context([
      'export', 'build', '--db', db, '--plan', planPath, '--out', buildDir, '--json',
    ], root)));
    expect(buildResult.exitCode).toBe(0);
    expect(jsonOutput(log).data.totals).toMatchObject({ outputCount: 1 });
    log.mockClear();

    const unpackDir = resolve(root, 'unpacked-with-output');
    await exportStep('export unpack', () => sessionsHandler.execute(context([
      'export', 'unpack', '--input', resolve(buildDir, 'evidence.shard'), '--out', unpackDir, '--json',
    ], root)));
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
    armExportStepTiming('rejects changed registered-output bytes and opt-in embedding recovers exact bytes (#2569)');
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
    await exportStep('output register', () => coordinator.register({ request, operationId: preview.operationId }));
    const planPath = resolve(root, 'selection-bytes.json');
    await exportStep('export plan', () => sessionsHandler.execute(context([
      'export', 'plan', '--workspace', 'default', '--db', db, '--out', planPath, sessionIds[0], '--json',
    ], root)));

    writeFileSync(outputPath, 'changed after planning');
    log.mockClear();
    const drift = await exportStep('export build (drifted bytes)', () => sessionsHandler.execute(context([
      'export', 'build', '--db', db, '--plan', planPath, '--out', resolve(root, 'drifted-output'), '--json',
    ], root)));
    expect(drift.exitCode).not.toBe(0);
    expect(jsonOutput(log)).toMatchObject({ status: 'error', error: { code: 'SCHEMA_DRIFT' } });

    writeFileSync(outputPath, original);
    log.mockClear();
    const buildDir = resolve(root, 'embedded-output');
    const built = await exportStep('export build (include-bytes)', () => sessionsHandler.execute(context([
      'export', 'build', '--db', db, '--plan', planPath, '--out', buildDir, '--include-bytes', '--json',
    ], root)));
    expect(built.exitCode, JSON.stringify(jsonOutput(log))).toBe(0);
    expect(jsonOutput(log).data).toMatchObject({ embeddedAttachmentCount: 1, embeddedAttachmentBytes: original.length });
    log.mockClear();
    const unpackDir = resolve(root, 'embedded-output-unpacked');
    const unpacked = await exportStep('export unpack', () => sessionsHandler.execute(context([
      'export', 'unpack', '--input', resolve(buildDir, 'evidence.shard'), '--out', unpackDir, '--json',
    ], root)));
    expect(unpacked.exitCode).toBe(0);
    const attachmentRoot = resolve(unpackDir, 'attachments');
    const recordDirectory = (await import('node:fs')).readdirSync(attachmentRoot)[0];
    const recoveredPath = resolve(attachmentRoot, recordDirectory, 'exact.bin');
    expect(existsSync(recoveredPath)).toBe(true);
    expect(readFileSync(recoveredPath)).toEqual(original);
  });

  it('exports a non-Claude provider (Codex) through the same plan/build pipeline, proving the mapping is provider-agnostic', async () => {
    armExportStepTiming('exports a non-Claude provider (Codex) through the same plan/build pipeline, proving the mapping is provider-agnostic');
    const codexDb = resolve(root, 'codex-catalog.sqlite');
    const fixture = resolve('test/fixtures/sessions/codex/threads.app-server.jsonl');
    const imported = await exportStep('import (codex)', () => sessionsHandler.execute(context([
      'import', fixture, '--provider', 'codex', '--source-id', 'codex-export-fixture',
      '--workspace', 'default', '--db', codexDb, '--json',
    ])));
    expect(imported.exitCode).toBe(0);
    log.mockClear();

    const listed = await exportStep('list (codex)', () => sessionsHandler.execute(context(['list', '--workspace', 'default', '--db', codexDb, '--json'])));
    const codexSessionIds = jsonOutput(log).data.items.map((item: any) => item.sessionId);
    expect(codexSessionIds.length).toBeGreaterThan(0);
    log.mockClear();

    const planPath = resolve(root, 'codex-selection.json');
    const planResult = await exportStep('export plan (codex)', () => sessionsHandler.execute(context([
      'export', 'plan', '--workspace', 'default', '--db', codexDb, '--out', planPath, ...codexSessionIds, '--json',
    ])));
    expect(planResult.exitCode).toBe(0);
    log.mockClear();

    const buildDir = resolve(root, 'codex-export-out');
    const buildResult = await exportStep('export build (codex)', () => sessionsHandler.execute(context([
      'export', 'build', '--db', codexDb, '--plan', planPath, '--out', buildDir, '--json',
    ])));
    expect(buildResult.exitCode).toBe(0);
    expect(jsonOutput(log).data).toMatchObject({ archiveProfile: 'full-v1', archiveSchemaVersion: '2.0.0', lossless: true });
    log.mockClear();

    const verifyResult = await exportStep('export verify (codex)', () => sessionsHandler.execute(context([
      'export', 'verify', '--input', resolve(buildDir, 'evidence.shard'), '--json',
    ])));
    expect(verifyResult.exitCode).toBe(0);
    expect(jsonOutput(log).data).toMatchObject({ valid: true, receiptMatches: true });
  });

  it('omits provider-native attachment payloads removed by import policy', async () => {
    armExportStepTiming('omits provider-native attachment payloads removed by import policy');
    const attachmentDb = resolve(root, 'opencode-attachment.sqlite');
    const fixture = resolve('test/fixtures/sessions/opencode/complete.json');
    expect((await exportStep('import (opencode)', () => sessionsHandler.execute(context([
      'import', fixture, '--provider', 'opencode', '--source-id', 'opencode-attachment-fixture',
      '--workspace', 'default', '--db', attachmentDb, '--json',
    ])))).exitCode).toBe(0);
    log.mockClear();
    await exportStep('list (opencode)', () => sessionsHandler.execute(context(['list', '--workspace', 'default', '--db', attachmentDb, '--json'])));
    const attachmentSessionId = jsonOutput(log).data.items[0].sessionId;
    log.mockClear();
    const planPath = resolve(root, 'opencode-attachment-plan.json');
    const plannedAttachment = await exportStep('export plan (opencode)', () => sessionsHandler.execute(context([
      'export', 'plan', '--workspace', 'default', '--db', attachmentDb, '--out', planPath,
      attachmentSessionId, '--json',
    ], root)));
    expect(plannedAttachment.exitCode, JSON.stringify(jsonOutput(log))).toBe(0);
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    expect(plan.attachments).toHaveLength(0);
    log.mockClear();
    const buildDir = resolve(root, 'opencode-attachment-export');
    expect((await exportStep('export build (opencode)', () => sessionsHandler.execute(context([
      'export', 'build', '--db', attachmentDb, '--plan', planPath, '--out', buildDir,
      '--include-bytes', '--json',
    ], root)))).exitCode).toBe(0);
    const unpackDir = resolve(root, 'opencode-attachment-unpacked');
    expect((await exportStep('export unpack (opencode)', () => sessionsHandler.execute(context([
      'export', 'unpack', '--input', resolve(buildDir, 'evidence.shard'), '--out', unpackDir, '--json',
    ], root)))).exitCode).toBe(0);
    expect(existsSync(resolve(unpackDir, 'attachments'))).toBe(false);
  });
});
