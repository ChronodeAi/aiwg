import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { itWithSqlite } from '../../../helpers/sqlite.js';

const repo = resolve('.');
let root: string;
let entry: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sessions-stdout-'));
  entry = join(root, 'cli.mjs');
  // Exercise the source handler without requiring a build. Both the launcher
  // (success) and router (failure) force exit as soon as the handler returns.
  writeFileSync(entry, `
import { sessionsHandler } from ${JSON.stringify(pathToFileURL(resolve(repo, 'src/cli/handlers/sessions.ts')).href)};
const args = process.argv.slice(2);
const result = await sessionsHandler.execute({ args, rawArgs: ['sessions', ...args], cwd: process.cwd(), frameworkRoot: ${JSON.stringify(repo)} });
process.exit(result.exitCode);
`);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function runCli(args: string[]) {
  // Use an OS pipe, as with `aiwg ... | jq`, rather than Node's socket pair.
  return spawnSync('bash', ['-o', 'pipefail', '-c', '"$@" | cat', 'sessions-stdout', process.execPath,
    '--import', pathToFileURL(resolve(repo, 'node_modules/tsx/dist/loader.mjs')).href,
    entry, ...args,
  ], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      CODEX_HOME: '',
      AIWG_CONFIG: join(root, 'config'),
      AIWG_NO_UPDATE_CHECK: '1',
      AIWG_LOG_DISABLE: '1',
    },
  });
}

describe('sessions JSON with piped stdout', () => {
  it('flushes a discovery manifest larger than 64 KiB before successful exit', () => {
    const sourceRoot = join(root, 'codex');
    mkdirSync(sourceRoot);
    const count = 200;
    for (let index = 0; index < count; index += 1) {
      writeFileSync(join(sourceRoot, `session-${index}.jsonl`), JSON.stringify({
        type: 'session_meta', payload: { id: `synthetic-${index}`, cwd: root },
      }) + '\n');
    }
    const manifest = join(root, 'manifest.json');
    const result = runCli([
      'discover', '--workspace', root, '--provider-home', root,
      '--expected-providers', 'codex', '--codex-root', sourceRoot,
      '--manifest', manifest, '--json',
    ]);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const saved = JSON.parse(readFileSync(manifest, 'utf8'));
    expect(Buffer.byteLength(JSON.stringify(saved))).toBeGreaterThan(64 * 1024);
    expect(Buffer.byteLength(result.stdout), result.stderr).toBeGreaterThan(64 * 1024);
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      command: 'sessions.discover', status: 'ok', error: null,
      data: { manifestPersisted: true, manifest: { totals: { sources: count } } },
    });
    expect(output.data.manifest.sources).toHaveLength(count);
    expect(output.data.manifest.manifestId).toBe(saved.manifestId);
  });

  itWithSqlite('flushes a JSON error larger than 64 KiB before nonzero exit', () => {
    const unknownCommand = `unknown-${'x'.repeat(96 * 1024)}`;
    const result = runCli([unknownCommand, '--json']);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(2);
    expect(Buffer.byteLength(result.stdout)).toBeGreaterThan(64 * 1024);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'error', data: null,
      error: { code: 'UNKNOWN_COMMAND', message: expect.stringContaining(unknownCommand) },
    });
  });
});
