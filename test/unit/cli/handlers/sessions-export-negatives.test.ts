/**
 * Offline session-export negatives (#2567 slice).
 *
 * In-process coverage beside the packaged journey in
 * sessions-export-packaged.test.ts: a generic-interchange source through the
 * real plan/build/verify/unpack pipeline, an interrupted shard write that
 * must leave no partial output at the final paths, and a malformed plan
 * profile refused before anything is written. Synthetic fixtures only,
 * mkdtemp workspaces, no network, no model calls.
 */
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import { sessionsHandler } from '../../../../src/cli/handlers/sessions.js';
import type { HandlerContext } from '../../../../src/cli/handlers/types.js';
import { describeWithSqlite } from '../../../helpers/sqlite.js';

const fsFail = vi.hoisted(() => ({ armed: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: ((path: unknown, data: unknown, options: unknown) => {
      if (fsFail.armed && typeof path === 'string' && path.endsWith('.tmp')) {
        // Torn-write simulation: partial bytes reach the sibling temp path,
        // then the filesystem reports ENOSPC. The atomic temp+rename design
        // must keep this away from the final shard path.
        const partial = ArrayBuffer.isView(data)
          ? (data as Uint8Array).subarray(0, 16)
          : data;
        try {
          (actual.writeFileSync as (...args: unknown[]) => void)(path, partial, options);
        } catch {
          // The injected failure below is what the test observes.
        }
        throw Object.assign(
          new Error(`ENOSPC: no space left on device, write '${path}'`),
          { code: 'ENOSPC' },
        );
      }
      return (actual.writeFileSync as (...args: unknown[]) => void)(path, data, options);
    }) as typeof actual.writeFileSync,
  };
});

function context(args: string[], cwd = process.cwd()): HandlerContext {
  return {
    args, rawArgs: ['sessions', ...args], cwd, frameworkRoot: process.cwd(),
  };
}

function jsonOutput(spy: ReturnType<typeof vi.spyOn>): Record<string, any> {
  return JSON.parse(String(spy.mock.calls.at(-1)?.[0]));
}

describeWithSqlite('sessions export negatives (#2567)', () => {
  let root: string;
  let db: string;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'aiwg-sessions-export-negatives-'));
    db = resolve(root, 'catalog.sqlite');
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    try {
      fsFail.armed = false;
    } finally {
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  async function importFixture(
    fixtureName: string,
    provider: string,
    sourceId: string,
  ): Promise<string[]> {
    const fixture = resolve(root, basename(fixtureName));
    writeFileSync(fixture, readFileSync(resolve(fixtureName)));
    const imported = await sessionsHandler.execute(context([
      'import', fixture, '--provider', provider, '--source-id', sourceId,
      '--workspace', 'default', '--db', db, '--json',
    ], root));
    expect(imported.exitCode, JSON.stringify(imported)).toBe(0);
    log.mockClear();
    const listed = await sessionsHandler.execute(context(
      ['list', '--workspace', 'default', '--db', db, '--json'], root,
    ));
    expect(listed.exitCode).toBe(0);
    const sessionIds = jsonOutput(log).data.items.map((item: any) => item.sessionId);
    log.mockClear();
    return sessionIds;
  }

  it('exports a generic-interchange session through plan/build/verify/unpack', async () => {
    const sessionIds = await importFixture(
      'test/fixtures/sessions/generic/valid-v1.jsonl', 'generic', 'generic-fixture-v1',
    );
    expect(sessionIds).toHaveLength(1);

    const planPath = resolve(root, 'generic-selection.json');
    const planned = await sessionsHandler.execute(context([
      'export', 'plan', '--workspace', 'default', '--db', db,
      '--out', planPath, ...sessionIds, '--json',
    ], root));
    expect(planned.exitCode).toBe(0);
    expect(jsonOutput(log).data.totals).toMatchObject({ sessionCount: 1, eventCount: 2 });
    log.mockClear();

    const buildDir = resolve(root, 'generic-export');
    const built = await sessionsHandler.execute(context([
      'export', 'build', '--db', db, '--plan', planPath, '--out', buildDir, '--json',
    ], root));
    expect(built.exitCode, JSON.stringify(jsonOutput(log))).toBe(0);
    expect(jsonOutput(log).data).toMatchObject({
      archiveProfile: 'full-v1', archiveSchemaVersion: '2.0.0', lossless: true, losses: [],
    });
    log.mockClear();

    const shardPath = resolve(buildDir, 'evidence.shard');
    const verified = await sessionsHandler.execute(context(
      ['export', 'verify', '--input', shardPath, '--json'], root,
    ));
    expect(verified.exitCode).toBe(0);
    expect(jsonOutput(log)).toMatchObject({
      status: 'ok', data: { valid: true, receiptChecked: true, receiptMatches: true },
    });
    log.mockClear();

    const unpackDir = resolve(root, 'generic-recovered');
    const unpacked = await sessionsHandler.execute(context([
      'export', 'unpack', '--input', shardPath, '--out', unpackDir, '--json',
    ], root));
    expect(unpacked.exitCode).toBe(0);
    expect(jsonOutput(log).data).toMatchObject({ sessionRecordCount: 1, eventRecordCount: 2 });

    const recovered = JSON.parse(readFileSync(resolve(unpackDir, 'index.json'), 'utf8'));
    expect(recovered.items).toHaveLength(3);
    expect(recovered.source).toEqual({ repo: 'default', privacy: 'private' });
    const sessionRecord = recovered.items.find((item: any) => item.type === 'aiwg.session');
    expect(sessionRecord.tags).toContain('provider:generic');
  });

  it('an interrupted shard write leaves no partial shard or receipt and a re-run succeeds', async () => {
    const sessionIds = await importFixture(
      'test/fixtures/sessions/claude/web-export.json', 'claude', 'negatives-fixture',
    );
    expect(sessionIds).toHaveLength(2);

    const planPath = resolve(root, 'selection.json');
    const planned = await sessionsHandler.execute(context([
      'export', 'plan', '--workspace', 'default', '--db', db,
      '--out', planPath, ...sessionIds, '--json',
    ], root));
    expect(planned.exitCode).toBe(0);
    log.mockClear();

    const buildDir = resolve(root, 'interrupted-export');
    const buildArgs = [
      'export', 'build', '--db', db, '--plan', planPath, '--out', buildDir, '--json',
    ];
    fsFail.armed = true;
    const failed = await sessionsHandler.execute(context(buildArgs, root));
    fsFail.armed = false;
    expect(failed.exitCode).not.toBe(0);
    expect(jsonOutput(log).status).toBe('error');
    log.mockClear();

    const shardPath = resolve(buildDir, 'evidence.shard');
    expect(existsSync(shardPath)).toBe(false);
    expect(existsSync(`${shardPath}.receipt.json`)).toBe(false);
    const leftovers = existsSync(buildDir) ? readdirSync(buildDir) : [];
    expect(leftovers.filter(
      (name) => name === 'evidence.shard' || name.endsWith('.receipt.json'),
    )).toEqual([]);

    const retried = await sessionsHandler.execute(context(buildArgs, root));
    expect(retried.exitCode, JSON.stringify(jsonOutput(log))).toBe(0);
    log.mockClear();

    const verified = await sessionsHandler.execute(context(
      ['export', 'verify', '--input', shardPath, '--json'], root,
    ));
    expect(verified.exitCode).toBe(0);
    expect(jsonOutput(log).data).toMatchObject({ valid: true, receiptMatches: true });
  });

  it('refuses a plan with an unsupported profile version before writing any output', async () => {
    const sessionIds = await importFixture(
      'test/fixtures/sessions/claude/web-export.json', 'claude', 'negatives-fixture',
    );
    expect(sessionIds).toHaveLength(2);

    const planPath = resolve(root, 'selection.json');
    const planned = await sessionsHandler.execute(context([
      'export', 'plan', '--workspace', 'default', '--db', db,
      '--out', planPath, ...sessionIds, '--json',
    ], root));
    expect(planned.exitCode).toBe(0);
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    plan.schemaVersion = '0.0.0';
    writeFileSync(planPath, JSON.stringify(plan));
    log.mockClear();

    const buildDir = resolve(root, 'malformed-profile-export');
    const result = await sessionsHandler.execute(context([
      'export', 'build', '--db', db, '--plan', planPath, '--out', buildDir, '--json',
    ], root));
    expect(result.exitCode).not.toBe(0);
    const output = jsonOutput(log);
    expect(output).toMatchObject({ status: 'error', error: { code: 'UNKNOWN_SCHEMA_MAJOR' } });
    expect(String(output.error.message)).toMatch(/0\.0\.0/);
    expect(String(output.error.message)).toMatch(/1\.1\.0/);
    expect(existsSync(buildDir)).toBe(false);
  });
});
