/**
 * Offline packaged-CLI session-to-Fortemi journey (#2567 slice).
 *
 * Exercises the real packaged entry point (`node bin/aiwg.mjs`, built by
 * `npm run build:cli`) inside a mkdtemp workspace: import a synthetic Claude
 * web/account export, select via list/search, plan, build with embedded
 * attachment bytes, verify, unpack, and recover the exact attachment set.
 * Negative paths cover a missing attachment, digest drift, and an existing
 * output without --force. No network, no server, no model calls.
 *
 * Output registration has no CLI surface, so the registered analysis output
 * is created through OutputRegistrationCoordinator (same stores the packaged
 * CLI reads when cwd is the workspace root).
 */
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FilesystemDerivedOutputIndex,
  FilesystemOutputRegistrationStore,
  OutputRegistrationCoordinator,
} from '../../../../src/sessions/index.js';
import { describeWithSqlite } from '../../../helpers/sqlite.js';

const REPO_ROOT = process.cwd();
const BIN_PATH = resolve(REPO_ROOT, 'bin/aiwg.mjs');
const ROUTER_PATH = resolve(REPO_ROOT, 'dist/src/cli/router.js');
const FIXTURE = resolve(REPO_ROOT, 'test/fixtures/sessions/claude/web-export.json');

const missingBuild = !existsSync(BIN_PATH) || !existsSync(ROUTER_PATH);
if (missingBuild) {
  console.warn('[skip] packaged sessions-export tests need `npm run build:cli` first');
}

interface CliResult {
  status: number;
  json: Record<string, any>;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): CliResult {
  const result = spawnSync(process.execPath, [BIN_PATH, ...args], {
    cwd,
    timeout: 60_000,
    encoding: 'utf-8',
    env: {
      ...process.env,
      AIWG_LOG_DISABLE: '1',
      NO_UPDATE_NOTIFIER: '1',
      AIWG_NO_UPDATE_CHECK: '1',
      NO_COLOR: '1',
    },
  });
  expect(result.error, `spawn failed: ${String(result.error)}`).toBeUndefined();
  const stdout = result.stdout ?? '';
  return {
    status: result.status ?? 1,
    json: JSON.parse(stdout),
    stdout,
    stderr: result.stderr ?? '',
  };
}

function expectOk(result: CliResult): Record<string, any> {
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.json.status).toBe('ok');
  return result.json.data;
}

function expectCliError(result: CliResult, code: string): string {
  expect(result.status).not.toBe(0);
  expect(result.json.status).toBe('error');
  expect(result.json.error.code).toBe(code);
  return String(result.json.error.message ?? '');
}

describeWithSqlite.skipIf(missingBuild)('packaged sessions export journey (#2567)', () => {
  let root: string;
  let db: string;
  let sessionIds: string[];

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'aiwg-sessions-packaged-'));
    db = resolve(root, 'catalog.sqlite');
    writeFileSync(resolve(root, 'fixture.json'), readFileSync(FIXTURE));
    const imported = runCli([
      'sessions', 'import', 'fixture.json', '--provider', 'claude',
      '--source-id', 'packaged-fixture', '--workspace', 'default', '--db', db, '--json',
    ], root);
    const data = expectOk(imported);
    expect(data.receipts[0]).toMatchObject({ outcome: 'committed' });
    sessionIds = expectOk(runCli(
      ['sessions', 'list', '--workspace', 'default', '--db', db, '--json'],
      root,
    )).items.map((item: any) => item.sessionId);
    expect(sessionIds).toHaveLength(2);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function registerAnalysisOutput(sessionId: string, bytes: Buffer): Promise<void> {
    mkdirSync(resolve(root, 'output/reports'), { recursive: true });
    writeFileSync(resolve(root, 'output/reports/result.md'), bytes);
    const coordinator = new OutputRegistrationCoordinator(
      root,
      new FilesystemOutputRegistrationStore(root),
      new FilesystemDerivedOutputIndex(root),
    );
    const request = {
      outputPath: 'output/reports/result.md',
      mediaType: 'text/markdown',
      contextPack: {
        id: 'context-pack:packaged-1',
        digest: `sha256:${'2'.repeat(64)}`,
        sources: [{ kind: 'session' as const, ref: sessionId, digest: null, span: null }],
      },
      supersedes: [],
      conflictsWith: [],
    };
    const preview = coordinator.preview(request);
    await coordinator.register({ request, operationId: preview.operationId });
  }

  it('imports, selects, builds, verifies, unpacks, and recovers the exact attachment set', async () => {
    const search = expectOk(runCli(
      ['sessions', 'search', 'token', '--workspace', 'default', '--db', db, '--json'],
      root,
    ));
    expect(search.items.length).toBeGreaterThan(0);

    const analysisBytes = Buffer.from('# Packaged analysis\nExact bytes for #2567.\n', 'utf8');
    await registerAnalysisOutput(sessionIds[0], analysisBytes);

    const planData = expectOk(runCli([
      'sessions', 'export', 'plan', '--workspace', 'default', '--db', db,
      '--out', 'selection.json', ...sessionIds, '--json',
    ], root));
    expect(planData.totals).toMatchObject({ sessionCount: 2, eventCount: 3 });
    expect(planData.outputs).toBe(1);

    const buildData = expectOk(runCli([
      'sessions', 'export', 'build', '--db', db, '--plan', 'selection.json',
      '--out', 'export-out', '--include-bytes', '--json',
    ], root));
    expect(buildData).toMatchObject({
      archiveProfile: 'full-v1',
      archiveSchemaVersion: '2.0.0',
      lossless: true,
      losses: [],
      embeddedAttachmentCount: 1,
      embeddedAttachmentBytes: analysisBytes.length,
    });

    const verifyData = expectOk(runCli(
      ['sessions', 'export', 'verify', '--input', 'export-out/evidence.shard', '--json'],
      root,
    ));
    expect(verifyData).toMatchObject({
      valid: true,
      receiptChecked: true,
      receiptMatches: true,
      embeddedAttachmentCount: 1,
    });

    const unpackData = expectOk(runCli([
      'sessions', 'export', 'unpack', '--input', 'export-out/evidence.shard',
      '--out', 'recovered', '--json',
    ], root));
    expect(unpackData).toMatchObject({
      sessionRecordCount: 2,
      eventRecordCount: 3,
      recoveredAttachmentCount: 1,
      recoveredAttachmentBytes: analysisBytes.length,
    });

    const recovered = JSON.parse(readFileSync(resolve(root, 'recovered/index.json'), 'utf8'));
    expect(recovered.source).toEqual({ repo: 'default', privacy: 'private' });
    expect(recovered.items.some((item: any) => item.type === 'aiwg.session-catalog-export-manifest')).toBe(false);
    const outputRecord = recovered.items.find((item: any) => item.type === 'aiwg.session-output');
    expect(outputRecord?.source.repo_relative_path).toBe('output/reports/result.md');

    const attachmentRoot = resolve(root, 'recovered/attachments');
    const recordDirs = readdirSync(attachmentRoot);
    expect(recordDirs).toHaveLength(1);
    const files = readdirSync(resolve(attachmentRoot, recordDirs[0]));
    expect(files).toEqual(['result.md']);
    expect(readFileSync(resolve(attachmentRoot, recordDirs[0], 'result.md'))).toEqual(analysisBytes);
  });

  it('fails the build when a registered attachment is missing', async () => {
    await registerAnalysisOutput(sessionIds[0], Buffer.from('will be deleted\n', 'utf8'));
    expectOk(runCli([
      'sessions', 'export', 'plan', '--workspace', 'default', '--db', db,
      '--out', 'selection.json', ...sessionIds, '--json',
    ], root));
    rmSync(resolve(root, 'output/reports/result.md'));
    const message = expectCliError(runCli([
      'sessions', 'export', 'build', '--db', db, '--plan', 'selection.json',
      '--out', 'export-missing', '--include-bytes', '--json',
    ], root), 'SCHEMA_DRIFT');
    expect(message).toMatch(/registered output is missing since the plan was generated/);
  });

  it('fails the build when registered bytes drift after planning', async () => {
    await registerAnalysisOutput(sessionIds[0], Buffer.from('original bytes\n', 'utf8'));
    expectOk(runCli([
      'sessions', 'export', 'plan', '--workspace', 'default', '--db', db,
      '--out', 'selection.json', ...sessionIds, '--json',
    ], root));
    writeFileSync(resolve(root, 'output/reports/result.md'), 'changed after planning\n');
    expectCliError(runCli([
      'sessions', 'export', 'build', '--db', db, '--plan', 'selection.json',
      '--out', 'export-drifted', '--include-bytes', '--json',
    ], root), 'SCHEMA_DRIFT');
  });

  it('refuses to overwrite an existing shard or recovery without --force', async () => {
    expectOk(runCli([
      'sessions', 'export', 'plan', '--workspace', 'default', '--db', db,
      '--out', 'selection.json', ...sessionIds, '--json',
    ], root));
    const buildArgs = [
      'sessions', 'export', 'build', '--db', db, '--plan', 'selection.json',
      '--out', 'export-out', '--json',
    ];
    expectOk(runCli(buildArgs, root));
    expectCliError(runCli(buildArgs, root), 'OUTPUT_EXISTS');
    expectOk(runCli([...buildArgs, '--force'], root));

    const unpackArgs = [
      'sessions', 'export', 'unpack', '--input', 'export-out/evidence.shard',
      '--out', 'recovered', '--json',
    ];
    expectOk(runCli(unpackArgs, root));
    expectCliError(runCli(unpackArgs, root), 'OUTPUT_EXISTS');
    expectOk(runCli([...unpackArgs, '--force'], root));
  });
});
