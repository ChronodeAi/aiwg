/**
 * `tools/contrib/sync-upstream.mjs` headless conflict handling (#3062).
 *
 * The interactive "Choice [1-4]" conflict-resolution prompt previously had
 * no argument at all — a headless caller resuming a stuck merge/rebase
 * could only see the printed options, never act on them. These tests spawn
 * the real script against a throwaway git repository seeded with a genuine
 * merge conflict, so the "already in progress" path (`checkCleanState`)
 * exercises `handleConflicts()` before any fetch/divergence logic runs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../../../tools/contrib/sync-upstream.mjs');

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, timeout: 20_000, stdio: 'pipe' });
}

function runScript(args: string[], cwd: string) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd,
      timeout: 20_000,
      encoding: 'utf-8',
      // No TTY is attached to a spawned subprocess's stdio by default
      // already; CI=true belt-and-suspenders matches this file's own
      // isInteractiveTerminal() CI-var check.
      env: { ...process.env, CI: 'true' },
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number | null };
    return {
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
      exitCode: e.status ?? 1,
    };
  }
}

/** Seeds a repo with a real merge conflict on `main` vs. `feature`, leaves it checked out on `feature` mid-merge, and writes the `.aiwg/contrib/feature` workspace status the script reads. */
function seedConflictedRepo(root: string): void {
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.name', 'Test User'], root);
  git(['config', 'user.email', 'test@example.com'], root);

  writeFileSync(join(root, 'conflict.txt'), 'base\n');
  git(['add', 'conflict.txt'], root);
  git(['commit', '-q', '-m', 'base'], root);

  git(['checkout', '-q', '-b', 'feature'], root);
  writeFileSync(join(root, 'conflict.txt'), 'feature change\n');
  git(['commit', '-q', '-am', 'feature change'], root);

  git(['checkout', '-q', 'main'], root);
  writeFileSync(join(root, 'conflict.txt'), 'main change\n');
  git(['commit', '-q', '-am', 'main change'], root);

  git(['checkout', '-q', 'feature'], root);
  try {
    git(['merge', 'main'], root);
  } catch {
    // Expected: the merge conflicts. Leaves .git/MERGE_HEAD and an
    // unmerged conflict.txt, which is exactly the fixture under test.
  }
  expect(existsSync(join(root, '.git', 'MERGE_HEAD'))).toBe(true);

  const workspaceDir = join(root, '.aiwg', 'contrib', 'feature');
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(
    join(workspaceDir, 'status.json'),
    JSON.stringify({
      feature: 'feature', status: 'development', pr: null, quality: null,
      created: new Date().toISOString(), updated: new Date().toISOString(),
      branch: 'feature', upstream: 'example/example',
    }),
  );
}

describe('sync-upstream.mjs headless conflict handling (#3062)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiwg-sync-upstream-'));
    seedConflictedRepo(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('--on-conflict with no following value is a usage error naming the flag, and never touches the conflict', () => {
    const result = runScript(['feature', '--on-conflict'], root);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('--on-conflict requires a value');
    expect(existsSync(join(root, '.git', 'MERGE_HEAD'))).toBe(true);
  });

  it('--on-conflict with an out-of-range value is a usage error naming the accepted values', () => {
    const result = runScript(['feature', '--on-conflict', '9'], root);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('--on-conflict must be one of: 1, 2, 3, 4');
    expect(existsSync(join(root, '.git', 'MERGE_HEAD'))).toBe(true);
  });

  it('--on-conflict=3 (equals form) aborts the merge headlessly', () => {
    const result = runScript(['feature', '--on-conflict=3'], root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('merge aborted');
    expect(existsSync(join(root, '.git', 'MERGE_HEAD'))).toBe(false);
  });

  it('a malformed second --on-conflict occurrence is still an error, even though the first was valid', () => {
    const result = runScript(['feature', '--on-conflict', '3', '--on-conflict'], root);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('--on-conflict requires a value');
    // Never reached the first (otherwise valid) occurrence's action.
    expect(existsSync(join(root, '.git', 'MERGE_HEAD'))).toBe(true);
  });

  it('without a terminal and without --on-conflict, prints resolution options and changes nothing', () => {
    const result = runScript(['feature'], root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('Resolution options');
    // The merge is left exactly as found — no git mutation happened.
    expect(existsSync(join(root, '.git', 'MERGE_HEAD'))).toBe(true);
  });

  it('--on-conflict 3 aborts the merge headlessly, without any prompt', () => {
    const result = runScript(['feature', '--on-conflict', '3'], root);
    expect(result.exitCode).not.toBe(0); // main() always exits 1 from this path; the abort itself is the assertion below.
    expect(result.stdout).toContain('merge aborted');
    expect(existsSync(join(root, '.git', 'MERGE_HEAD'))).toBe(false);
  });

  it('--on-conflict 2 shows the diff headlessly and leaves the conflict untouched', () => {
    const result = runScript(['feature', '--on-conflict', '2'], root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('conflict.txt');
    expect(existsSync(join(root, '.git', 'MERGE_HEAD'))).toBe(true);
  });

  it('--on-conflict 1 (open $EDITOR) refuses without a terminal instead of spawning an editor', () => {
    const result = runScript(['feature', '--on-conflict', '1'], root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/requires an interactive terminal/);
    expect(existsSync(join(root, '.git', 'MERGE_HEAD'))).toBe(true);
  });

  it('--on-conflict 4 is a no-op (resolve manually) and leaves the conflict untouched', () => {
    const result = runScript(['feature', '--on-conflict', '4'], root);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(join(root, '.git', 'MERGE_HEAD'))).toBe(true);
  });
});
