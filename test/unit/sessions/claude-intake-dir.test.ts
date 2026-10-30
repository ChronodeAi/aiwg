import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionsHandler } from '../../../src/cli/handlers/sessions.js';
import type { HandlerContext } from '../../../src/cli/handlers/types.js';
import { itWithSqlite } from '../../helpers/sqlite.js';

let root: string;
let intakeDir: string;
let database: string;
let log: ReturnType<typeof vi.spyOn>;

function webExport(conversation: string, message: string, text: string): string {
  return JSON.stringify([
    {
      uuid: conversation,
      name: `intake ${conversation}`,
      created_at: '2026-08-01T09:00:00.000Z',
      chat_messages: [
        {
          uuid: message,
          sender: 'human',
          text,
          created_at: '2026-08-01T09:00:00.000Z',
        },
      ],
    },
  ]);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aiwg-claude-intake-dir-'));
  intakeDir = join(root, 'intake');
  database = join(root, 'catalog.sqlite');
  await mkdir(intakeDir, { recursive: true });
  await writeFile(join(intakeDir, 'export-a.json'), webExport('intake-conv-a', 'intake-msg-a', 'First intake question.'));
  await writeFile(join(intakeDir, 'export-b.json'), webExport('intake-conv-b', 'intake-msg-b', 'Second intake question.'));
  await writeFile(join(intakeDir, 'notes.txt'), 'operator notes are not an export\n');
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function importIntake(extra: string[] = []) {
  const context: HandlerContext = {
    args: [
      'import', '--from-dir', intakeDir, '--provider', 'claude',
      '--source-id', 'claude-admin', '--workspace', join(root, 'workspace'),
      '--db', database, '--json', ...extra,
    ],
    rawArgs: ['sessions', 'import'],
    cwd: root,
    frameworkRoot: process.cwd(),
  };
  const result = await sessionsHandler.execute(context);
  expect(result.exitCode).toBe(0);
  return JSON.parse(String(log.mock.calls.at(-1)?.[0]));
}

describe('Claude intake-directory batch import', () => {
  itWithSqlite('imports two exports, skips the unrecognised file, and reports receipts', async () => {
    const output = await importIntake();
    expect(output).toMatchObject({ status: 'ok', command: 'sessions.import' });
    expect(output.data.summary).toMatchObject({
      total: 3, imported: 2, alreadyImported: 0, skipped: 1, rejected: 0,
      sessionsInserted: 2, eventsInserted: 2,
    });
    const byFile = new Map(output.data.files.map((file: { file: string }) => [file.file, file]));
    expect(byFile.get('export-a.json')).toMatchObject({ status: 'imported', sourceId: 'claude-admin/export-a.json' });
    expect(byFile.get('export-b.json')).toMatchObject({ status: 'imported', sourceId: 'claude-admin/export-b.json' });
    expect(String((byFile.get('export-a.json') as { digest: string }).digest)).toMatch(/^sha256:/);
    expect(byFile.get('notes.txt')).toMatchObject({ status: 'skipped', sourceId: null });
    expect(String((byFile.get('notes.txt') as { reason: string }).reason)).toContain('unrecognised');
  });

  itWithSqlite('reruns import nothing after the first import', async () => {
    await importIntake();
    log.mockClear();
    const output = await importIntake();
    expect(output.data.summary).toMatchObject({
      total: 3, imported: 0, alreadyImported: 2, skipped: 1, rejected: 0,
      sessionsInserted: 0, eventsInserted: 0,
    });
    const byFile = new Map(output.data.files.map((file: { file: string }) => [file.file, file]));
    expect(byFile.get('export-a.json')).toMatchObject({ status: 'already-imported' });
    expect(byFile.get('export-b.json')).toMatchObject({ status: 'already-imported' });
    expect(String((byFile.get('export-a.json') as { reason: string }).reason)).toContain('digest');
  });

  itWithSqlite('lists the imported sessions from the catalog', async () => {
    await importIntake();
    log.mockClear();
    const context: HandlerContext = {
      args: [
        'list', '--workspace', join(root, 'workspace'),
        '--db', database, '--json',
      ],
      rawArgs: ['sessions', 'list'],
      cwd: root,
      frameworkRoot: process.cwd(),
    };
    const result = await sessionsHandler.execute(context);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(output.data.items).toHaveLength(2);
  });
});
