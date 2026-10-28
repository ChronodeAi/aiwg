/**
 * `tools/git/pr-base-sync.sh` merge-readiness reporting (#2654).
 *
 * Spawns the real script against throwaway git repositories (os.tmpdir() +
 * mkdtemp, never session scratch) covering the three readiness states:
 * up-to-date, behind, and conflict. The script only reads the repo (no
 * fetch, no rebase, no network), so these tests are hermetic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../../../tools/git/pr-base-sync.sh');

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, timeout: 20_000, stdio: 'pipe' });
}

function revParse(ref: string, cwd: string): string {
  return execFileSync('git', ['rev-parse', ref], { cwd, timeout: 20_000, encoding: 'utf-8' }).trim();
}

function runScript(cwd: string) {
  // Merge stderr into stdout: the script keeps machine-readable key=value
  // lines on stdout and human next-steps on stderr; the test asserts both.
  try {
    const stdout = execFileSync(
      'bash',
      ['-c', 'exec bash "$@" 2>&1', '_', SCRIPT, '--main-ref', 'main', '--repo', cwd],
      {
        timeout: 20_000,
        encoding: 'utf-8',
      }
    );
    return { stdout, stderr: stdout, exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number | null };
    return {
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
      exitCode: e.status ?? 1,
    };
  }
}

function parseReport(stdout: string): Record<string, string> {
  return Object.fromEntries(
    stdout
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      })
  );
}

/** Seeds a repo on `main` with one commit and checks out a `feat` branch. */
function seedRepo(root: string): void {
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.name', 'Test User'], root);
  git(['config', 'user.email', 'test@example.com'], root);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  git(['add', '.'], root);
  git(['commit', '-qm', 'base'], root);
  git(['checkout', '-qb', 'feat'], root);
}

describe('pr-base-sync readiness report', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiwg-pr-base-sync-'));
    seedRepo(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reports up-to-date when main is an ancestor of HEAD', () => {
    writeFileSync(join(root, 'feat.txt'), 'feat\n');
    git(['add', '.'], root);
    git(['commit', '-qm', 'feat'], root);

    const result = runScript(root);

    expect(result.exitCode).toBe(0);
    const report = parseReport(result.stdout);
    expect(report['status']).toBe('up-to-date');
    expect(report['ready']).toBe('true');
    expect(report['head']).toBe(revParse('HEAD', root));
    expect(report['main']).toBe(revParse('main', root));
    expect(report['merge_base']).toBe(revParse('main', root));
  });

  it('reports behind when main has commits the branch lacks', () => {
    writeFileSync(join(root, 'feat.txt'), 'feat\n');
    git(['add', '.'], root);
    git(['commit', '-qm', 'feat'], root);
    git(['checkout', '-q', 'main'], root);
    writeFileSync(join(root, 'main.txt'), 'main\n');
    git(['add', '.'], root);
    git(['commit', '-qm', 'main-work'], root);
    git(['checkout', '-q', 'feat'], root);

    const result = runScript(root);

    expect(result.exitCode).toBe(0);
    const report = parseReport(result.stdout);
    expect(report['status']).toBe('behind');
    expect(report['ready']).toBe('false');
    expect(report['head']).toBe(revParse('HEAD', root));
    expect(report['main']).toBe(revParse('main', root));
    expect(result.stderr).toContain('re-run the required verification');
  });

  it('reports conflict when sync would conflict', () => {
    writeFileSync(join(root, 'shared.txt'), 'line1\nline2\n');
    git(['add', '.'], root);
    git(['commit', '-qm', 'shared'], root);
    writeFileSync(join(root, 'shared.txt'), 'line1\nbranch-change\n');
    git(['add', '.'], root);
    git(['commit', '-qm', 'branch-change'], root);
    git(['checkout', '-q', 'main'], root);
    writeFileSync(join(root, 'shared.txt'), 'line1\nmain-change\n');
    git(['add', '.'], root);
    git(['commit', '-qm', 'main-change'], root);
    git(['checkout', '-q', 'feat'], root);

    const result = runScript(root);

    expect(result.exitCode).toBe(0);
    const report = parseReport(result.stdout);
    expect(report['status']).toBe('conflict');
    expect(report['ready']).toBe('false');
    expect(report['head']).toBe(revParse('HEAD', root));
    expect(report['main']).toBe(revParse('main', root));
    expect(result.stderr).toContain('readiness is blocked');
  });
});
