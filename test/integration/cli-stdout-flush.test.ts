/**
 * The launcher exits with process.exit() right after a command writes its
 * report. On a pipe whose reader is slow, Node had not finished writing, and
 * the exit dropped everything past the 64 KiB pipe buffer, so large `--json`
 * reports parsed as truncated JSON. The reader here pauses before draining.
 *
 * @source bin/aiwg.mjs
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const BIN = path.join(REPO_ROOT, 'bin', 'aiwg.mjs');
const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function runWithSlowReader(args: string[], pauseMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-stdout-flush-'));
  temporary.push(config);
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, AIWG_CONFIG: config, NO_UPDATE_NOTIFIER: '1', AIWG_NO_UPDATE_CHECK: '1', AIWG_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.pause();
  setTimeout(() => {
    child.stdout.on('data', chunk => out.push(chunk));
    child.stdout.resume();
  }, pauseMs);
  child.stderr.on('data', chunk => err.push(chunk));
  // Resolve only after the child exited AND stdout reached end, so the result
  // holds every byte the child wrote, not whatever arrived before exit.
  const exited = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  const ended = new Promise<void>(resolve => child.stdout.on('end', resolve));
  return Promise.all([exited, ended]).then(([code]) => ({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
}

describe('launcher stdout on a slow pipe', () => {
  it('delivers a large JSON report completely before exiting', { timeout: 120_000 }, async () => {
    const result = await runWithSlowReader(['rules', 'inventory', '--scope', 'catalog', '--json'], 1_500);
    expect(result.code, result.stderr).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBeGreaterThan(64 * 1024);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });
});
