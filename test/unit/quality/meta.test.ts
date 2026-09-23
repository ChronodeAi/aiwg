/**
 * @source @tools/quality/meta.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMeta } from '../../../tools/quality/meta.mjs';

const GATE = '.aiwg/quality/gate.json';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, timeout: 60_000, encoding: 'utf8' });
}

function write(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

function gate(p90: number): string {
  return `${JSON.stringify({ version: 1, bands: { function_nloc: { p70: 10, p80: 15, p90 }, function_ccn: { p70: 4, p80: 6, p90: 8 } } }, null, 2)}\n`;
}

function commit(dir: string, message: string): void {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
}

const WORKFLOW = `name: ci
on: pull_request
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: contracts
        run: |
          pip install import-linter
          lint-imports
`;

describe('runMeta (git-backed)', () => {
  let dir: string;
  let base: string;

  const meta = () => runMeta(dir, { baseRef: base, mergeBase: base });
  const codes = () => meta().verdicts.filter((v: { level: string }) => v.level === 'FAIL').map((v: { code: string }) => v.code);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aiwg-meta-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'Test User');
    git(dir, 'config', 'user.email', 'test@example.com');
    write(dir, 'src/a.py', 'def f():\n    return 1\n');
    write(dir, GATE, gate(20));
    write(dir, '.aiwg/architecture/ADR-001-adopt-code-shape.md', '# ADR-001\n');
    write(dir, '.github/workflows/ci.yml', WORKFLOW);
    commit(dir, 'base');
    base = git(dir, 'rev-parse', 'HEAD').trim();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails a band loosened without a trailer', () => {
    write(dir, GATE, gate(40));
    commit(dir, 'raise band');
    expect(codes()).toEqual(expect.arrayContaining(['evaluator-surface-changed', 'band-loosened']));
  }, 60_000);

  it('accepts an evaluator-only commit citing an ADR present at base', () => {
    write(dir, GATE, gate(40));
    commit(dir, 'raise band\n\nEvaluator-Change: ADR-001');
    const result = meta();
    expect(result.verdicts.filter((v: { level: string }) => v.level === 'FAIL')).toEqual([]);
    expect(result.exceptions).toEqual([expect.objectContaining({ adr: 'ADR-001' })]);
  }, 60_000);

  it('fails a trailer citing an ADR absent at base', () => {
    write(dir, GATE, gate(40));
    write(dir, '.aiwg/architecture/ADR-002-new.md', '# ADR-002\n');
    commit(dir, 'raise band\n\nEvaluator-Change: ADR-002');
    expect(codes()).toContain('evaluator-surface-changed');
  }, 60_000);

  it('fails a mixed commit even with a valid trailer', () => {
    write(dir, GATE, gate(40));
    write(dir, 'src/a.py', 'def f():\n    return 2\n');
    commit(dir, 'mixed\n\nEvaluator-Change: ADR-001');
    expect(codes()).toEqual(expect.arrayContaining(['evaluator-surface-changed', 'band-loosened']));
  }, 60_000);

  it('fails when gate.json is deleted', () => {
    git(dir, 'rm', '-q', GATE);
    commit(dir, 'drop gate');
    expect(codes()).toContain('gate-config-removed');
  }, 60_000);

  it('fails continue-on-error on a quality step', () => {
    write(dir, '.github/workflows/ci.yml', WORKFLOW.replace('      - name: contracts\n', '      - name: contracts\n        continue-on-error: true\n'));
    commit(dir, 'soften ci\n\nEvaluator-Change: ADR-001');
    expect(codes()).toEqual(['quality-step-suppressed']);
  }, 60_000);

  it('fails a new suppression without annotation and accepts a valid one', () => {
    write(dir, 'src/a.py', 'import os  # noqa\n\ndef f():\n    return 1\n');
    commit(dir, 'noqa');
    expect(codes()).toEqual(['suppression-unjustified']);

    write(dir, 'src/a.py', '# AIWG-allow:suppression owner="dev" expires="2999-01-01" reason="re-export"\nimport os  # noqa\n\ndef f():\n    return 1\n');
    commit(dir, 'annotate');
    expect(codes()).toEqual([]);
  }, 60_000);

  it('fails an expired suppression annotation', () => {
    write(dir, 'src/a.py', 'import os  # noqa AIWG-allow:suppression owner="dev" expires="2000-01-01" reason="old"\n\ndef f():\n    return 1\n');
    commit(dir, 'expired');
    expect(codes()).toEqual(['suppression-unjustified']);
  }, 60_000);
});
