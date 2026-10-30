// Exercise exact REF resolution through the public lint runner.
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLint } from '@/lint/runner.js';
import type { LintCheck, LintRuleset } from '@/lint/types.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lint-ref-identity-'));
  for (const dir of ['.git', 'target', 'refs']) mkdirSync(join(root, dir));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function lint(text: string, check: Partial<LintCheck> = {}) {
  writeFileSync(join(root, 'target', 'source.md'), text);
  const ruleset: LintRuleset = {
    id: 'refs', name: 'Refs', description: 'Refs', framework: 'research', version: '1',
    rules: [{ id: 'resolve', name: 'Resolve', description: 'Resolve', severity: 'error',
      appliesTo: { glob: '*.md' },
      checks: [{ type: 'reference-resolves', basePath: 'refs', ...check }] }],
  };
  return (await runLint(join(root, 'target'), [ruleset])).diagnostics;
}

it('rejects directories for bare and slugged basePath references', async () => {
  mkdirSync(join(root, 'refs', 'REF-020-paper.md'));
  mkdirSync(join(root, 'refs', 'REF-021.md'));
  expect(await lint('REF-020 REF-021')).toHaveLength(2);
});

it('rejects malformed tokens even when matching files exist', async () => {
  writeFileSync(join(root, 'refs', 'REF-020aa-paper.md'), '# Invalid');
  expect(await lint('REF-020aa', { referencePattern: 'REF-[a-zA-Z0-9]+' })).toHaveLength(1);
});

it('keeps width and suffix spelling exact for basePath references', async () => {
  writeFileSync(join(root, 'refs', 'REF-020-paper.md'), '# Paper');
  expect(await lint('REF-02 REF-2 REF-020a REF-020A REF-020')).toHaveLength(4);
});

it('indexes short and suffixed tokens without aliasing them to the unsuffixed ID', async () => {
  for (const ref of ['REF-02', 'REF-12345', 'REF-020a', 'REF-020A']) {
    writeFileSync(join(root, 'target', `${ref}-paper.md`), '# Paper');
  }
  expect(await lint('REF-02 REF-12345 REF-020a REF-020A')).toHaveLength(0);
  expect(await lint('REF-020 REF-2')).toHaveLength(2);
});

it('requires an exact REF token for a backlink', async () => {
  writeFileSync(join(root, 'target', 'REF-020.md'), 'REF-021');
  writeFileSync(join(root, 'target', 'REF-021.md'), 'REF-0200');
  const diagnostics = await lint('', { type: 'cross-ref-bidirectional' });
  expect(diagnostics.filter(d => d.file === 'REF-020.md')).toHaveLength(1);
});

it('shipped research rules resolve whole short, long and suffixed tokens', async () => {
  const { loadRuleset } = await import('@/lint/loader.js');
  const { resolve } = await import('node:path');
  const shipped = (await loadRuleset(resolve('agentic/code/frameworks/research-complete/lint'), 'research'))!;
  const rules = shipped.rules.filter(r => ['research/citation-resolves', 'research/ref-id-format',
    'research/cross-ref-bidirectional', 'research/orphan-detection'].includes(r.id));
  expect(rules).toHaveLength(4);
  const dir = join(root, 'findings');
  mkdirSync(dir);
  for (const ref of ['REF-02', 'REF-12345', 'REF-020A', 'REF-020a']) {
    writeFileSync(join(dir, `${ref}.md`), `---\nref: ${ref}\n---\nREF-02 REF-12345 REF-020A REF-020a`);
  }
  const result = await runLint(root, [{ ...shipped, rules }]);
  // Short legacy IDs resolve, while the established filename convention still warns.
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({
    ruleId: 'research/ref-id-format', file: 'findings/REF-02.md', severity: 'warn',
  });
});
