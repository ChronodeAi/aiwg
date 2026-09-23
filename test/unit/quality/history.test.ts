/**
 * @source @tools/quality/history.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultGateConfig } from '../../../tools/quality/config.mjs';
import { runHistory } from '../../../tools/quality/history.mjs';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, timeout: 60_000, encoding: 'utf8' });
}

function write(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

function config(overrides: Record<string, number>) {
  const cfg = defaultGateConfig();
  cfg.history = { ...cfg.history, ...overrides };
  return cfg;
}

describe('runHistory (git-backed)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aiwg-history-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'Test User');
    git(dir, 'config', 'user.email', 'test@example.com');
    write(dir, 'pkg/b.py', 'X = 0\n');
    write(dir, 'pkg/a.py', 'from pkg.b import X\n');
    write(dir, 'pkg/c.py', 'Y = 0\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('groups a merged branch into one first-parent unit', () => {
    git(dir, 'checkout', '-q', '-b', 'feature');
    for (let i = 1; i <= 3; i++) {
      write(dir, 'pkg/c.py', `Y = ${i}\n`);
      git(dir, 'commit', '-q', '-am', `c${i}`);
    }
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'merge', '-q', '--no-ff', '-m', 'merge feature', 'feature');
    const result = runHistory(dir, config({ min_commits: 1, min_cochange: 1 }));
    expect(result.units).toBe(2);
    expect(result.hotspots.find((h: { file: string }) => h.file === 'pkg/c.py')?.units).toBe(2);
  }, 60_000);

  it('reports confident co-change pairs with import edges', () => {
    for (let i = 1; i <= 5; i++) {
      write(dir, 'pkg/b.py', `X = ${i}\n`);
      write(dir, 'pkg/a.py', `from pkg.b import X\n# ${i}\n`);
      git(dir, 'commit', '-q', '-am', `ab${i}`);
    }
    write(dir, 'pkg/c.py', 'Y = 9\n');
    git(dir, 'commit', '-q', '-am', 'c');
    const result = runHistory(dir, config({ min_commits: 1, min_cochange: 5, min_confidence: 0.5 }));
    expect(result.lines[0]).toBe('prioritisation only — not defect prediction');
    expect(result.pairs).toEqual([
      expect.objectContaining({ a: 'pkg/a.py', b: 'pkg/b.py', cochange: 6, importEdge: 'yes' }),
    ]);
  }, 60_000);

  it('reports insufficient history below min_commits', () => {
    const result = runHistory(dir, config({ min_commits: 50 }));
    expect(result.insufficient).toBe(true);
    expect(result.lines.join('\n')).toContain('insufficient history (<50 commits)');
  }, 60_000);
});
