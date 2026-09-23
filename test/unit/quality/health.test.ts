/**
 * @source @tools/quality/health.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HEALTH = resolve(import.meta.dirname, '../../../tools/quality/health.mjs');

function git(dir: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: dir, timeout: 60_000 });
}

describe('health CLI before bootstrap', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aiwg-health-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'Test User');
    git(dir, 'config', 'user.email', 'test@example.com');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/a.py'), 'def f():\n    return 1\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'base');
    writeFileSync(join(dir, 'src/a.py'), 'import os  # noqa\n\ndef f():\n    return 1\n');
    git(dir, 'commit', '-q', '-am', 'head');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 2 with the bootstrap sequence instead of judging against defaults', () => {
    const result = spawnSync(process.execPath, [HEALTH, '--base', 'HEAD~1', '--meta', '--ci'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('no .aiwg/quality/gate.json. Bootstrap:');
    expect(result.stdout).not.toContain('FAIL');
  }, 60_000);

  it('still runs history-only routing without a gate config', () => {
    const result = spawnSync(process.execPath, [HEALTH, '--base', 'HEAD~1', '--history'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('insufficient history');
  }, 60_000);
});
