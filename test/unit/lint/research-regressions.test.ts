/** Regression coverage for research lint issues #3143, #3144, #3145 and #3163. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { main } from '../../../src/lint/cli.js';
import { loadRuleset } from '../../../src/lint/loader.js';
import { runLint } from '../../../src/lint/runner.js';
import type { LintRuleset } from '../../../src/lint/types.js';

let root: string;
let research: LintRuleset;
const originalExitCode = process.exitCode;
const lintDir = resolve('agentic/code/frameworks/research-complete/lint');
const valid = `---
title: Example paper
authors: ["Doe, Jane", "Roe, Rich"]
year: 2026
publication_type: academic-paper
tags: [example]
status: documented
grade_rating: High
documented_date: 2026-10-15
acquisition_method: manual
---
# Example
`;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'aiwg-research-lint-'));
  research = (await loadRuleset(lintDir, 'research-complete'))!;
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function note(layout: string, content: string, name = 'REF-123.md'): string {
  const dir = join(root, layout);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

async function cli(target: string, extra: string[] = []) {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  await main([target, '--ruleset', 'research', '--format', 'json', '--ci', ...extra]);
  return JSON.parse(output.mock.calls.at(-1)![0]);
}

describe('REF identifier format (#3163)', () => {
  it.each(['findings', 'documentation/references'])(
    'warns only for malformed names in %s, from root and direct targets',
    async (layout) => {
      const names = [
        'REF-123', 'REF-1000', 'REF-124-slug',
        'REF-2832-skyjepa-quadrotor-world-model',
        'REF-12', 'REF-ABC-bad', 'REF-125-Bad', 'REF-126-',
      ];
      for (const name of names) note(layout, valid, `${name}.md`);

      for (const target of [root, join(root, layout)]) {
        const result = await runLint(target, [research], { respectGitignore: false });
        const diagnostics = result.diagnostics.filter(d => d.ruleId === 'research/ref-id-format');
        expect(diagnostics).toHaveLength(4);
        expect(diagnostics.every(d => d.severity === 'warn')).toBe(true);
        expect(diagnostics.map(d => d.file.split('/').at(-1)).sort()).toEqual([
          'REF-12.md', 'REF-125-Bad.md', 'REF-126-.md', 'REF-ABC-bad.md',
        ].sort());
      }
    },
  );

  it.each([
    ['REF-123', 'REF-123', false],
    ['REF-123-slug', 'REF-123', false],
    ['REF-2832-slug', 'REF-2832', false],
    ['REF-123', 'REF-124', true],
    ['REF-123-slug', 'REF-124', true],
    ['REF-2832-slug', 'REF-283', true],
    ['REF-2832-slug', 'REF', true],
    ['REF-123-slug', '', false],
  ])('compares %s with ref: %s', async (name, ref, mismatch) => {
    note('documentation/references', valid.replace('---\ntitle:', `---\nref: ${ref}\ntitle:`), `${name}.md`);
    const result = await runLint(root, [research]);
    const diagnostics = result.diagnostics.filter(d => d.ruleId === 'research/ref-id-format');
    expect(diagnostics).toHaveLength(mismatch ? 1 : 0);
    if (mismatch) expect(diagnostics[0].message).toContain("does not match frontmatter field 'ref'");
  });
});

describe('YAML frontmatter (#3143)', () => {
  it('produces identical diagnostics for the reported block and flow lists', async () => {
    const inline = valid.replace('status: documented', 'status: archived')
      .replace('grade_rating: High\n', '').replace('documented_date: 2026-10-15\n', '')
      .replace('acquisition_method: manual\n', '');
    const block = inline.replace('authors: ["Doe, Jane", "Roe, Rich"]', 'authors:\n  - Doe, Jane\n  - Roe, Rich')
      .replace('tags: [example]', 'tags:\n  - example');
    note('inline/findings', inline, 'REF-123-example.md');
    note('block/findings', block, 'REF-123-example.md');
    const flow = await runLint(join(root, 'inline/findings'), [research]);
    const expanded = await runLint(join(root, 'block/findings'), [research]);
    expect(expanded.diagnostics).toEqual(flow.diagnostics);
    expect(expanded.summary.errors).toBe(3);
    expect(flow.summary.errors).toBe(3);
  });

  it('accepts nested maps, multiline strings, false and zero for shared rulesets', async () => {
    note('findings', '---\r\nauthors:\r\n  - name: Jane\r\n    affiliation: Example\r\nmetadata:\r\n  nested: value\r\ntitle: |\r\n  First line\r\n  Second line\r\ncount: 0\r\nenabled: false\r\n---\r\n');
    const shared: LintRuleset = { ...research, id: 'shared', rules: [{
      id: 'shared/yaml', name: 'YAML', description: 'Shared parser', severity: 'error',
      appliesTo: { glob: '**/*.md' }, checks: [
        { type: 'frontmatter-required', fields: ['authors', 'metadata', 'title', 'count', 'enabled'] },
        { type: 'frontmatter-format', field: 'count', pattern: '^0$' },
        { type: 'frontmatter-format', field: 'enabled', pattern: '^false$' },
        { type: 'frontmatter-format', field: 'title', pattern: '^First line\\nSecond line\\n$' },
      ],
    }] };
    expect((await runLint(root, [shared])).diagnostics).toEqual([]);
    shared.rules[0].checks[1].pattern = '^1$';
    shared.rules[0].checks[2].pattern = '^true$';
    expect((await runLint(root, [shared])).diagnostics).toHaveLength(2);
  });

  it.each(['[]', 'null', '~', '', '"   "'])('reports an empty authors value (%s)', async (value) => {
    note('findings', valid.replace('authors: ["Doe, Jane", "Roe, Rich"]', `authors: ${value}`));
    const result = await runLint(root, [research]);
    expect(result.diagnostics.some(d => d.message === 'Missing required frontmatter field: authors')).toBe(true);
  });

  it('handles malformed and non-mapping YAML without crashing', async () => {
    for (const yaml of ['title: [invalid', '- item', 'null']) {
      note('findings', `---\n${yaml}\n---\n`);
      const result = await runLint(root, [research]);
      expect(result.summary.passed).toBe(false);
    }
  });
});

describe('CI coverage (#3144)', () => {
  it.each(['empty', 'missing', 'ignored', 'unmatched'])('fails clearly for %s targets and preserves the roster', async (kind) => {
    let target = root;
    if (kind === 'missing') target = join(root, 'nonexistent');
    if (kind === 'ignored') {
      execFileSync('git', ['init', '-q', root], { timeout: 60_000 });
      writeFileSync(join(root, '.gitignore'), 'findings/\n');
      note('findings', valid);
    }
    if (kind === 'unmatched') note('unrelated', '# Unmatched\n', 'note.yaml');
    const result = await cli(target);
    expect(process.exitCode).toBe(1);
    expect(result.summary.passed).toBe(false);
    expect(result.summary.coverageMessage).toMatch(/No files checked|No rules applied/);
    expect(result.summary.inapplicableRules).toHaveLength(research.rules.length);
  });

  it('allows empty coverage only through the explicit opt-out in CI', async () => {
    const result = await cli(root, ['--allow-empty']);
    expect(process.exitCode).toBeUndefined();
    expect(result.summary.passed).toBe(true);
    expect(result.summary.inapplicableRules).toHaveLength(research.rules.length);
    expect((await runLint(root, [research])).summary.passed).toBe(true);
  });

  it('fails CI with no selected rules and keeps violations under --allow-empty', async () => {
    note('findings', '# Missing metadata\n');
    const noRules = await runLint(root, [], { ci: true });
    expect(noRules.summary).toMatchObject({ passed: false, rulesApplied: 0 });
    expect(noRules.summary.coverageMessage).toContain('No rules applied');
    const result = await cli(root, ['--allow-empty']);
    expect(result.summary.passed).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('lints a single file and still applies gitignore', async () => {
    const file = note('findings', valid);
    const good = await cli(file);
    expect(good.summary).toMatchObject({ filesChecked: 1, passed: true, rulesApplied: 11 });
    note('findings', '# No frontmatter\n');
    const bad = await cli(file);
    expect(bad.summary.passed).toBe(false);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    execFileSync('git', ['init', '-q', root], { timeout: 60_000 });
    writeFileSync(join(root, '.gitignore'), 'findings/\n');
    expect((await cli(file)).summary.filesChecked).toBe(0);
    expect((await cli(file, ['--no-gitignore'])).summary.filesChecked).toBe(1);
  });

  it('explains unsupported single-file targets', async () => {
    const file = note('findings', '# Text', 'note.txt');
    const result = await cli(file);
    expect(process.exitCode).toBe(1);
    expect(result.summary.coverageMessage).toContain('Unsupported file type');
  });

  it('documents --allow-empty in CLI help', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['--help']);
    expect(output.mock.calls.flat().join('\n')).toContain('--allow-empty');
    expect(process.exitCode).toBeUndefined();
  });
});

describe('research layouts and project paths (#3145)', () => {
  it.each(['findings', 'documentation/references'])('checks defects and valid notes in %s at any target depth', async (layout) => {
    mkdirSync(join(root, '.aiwg'));
    const file = note(layout, '# REF-123 no frontmatter at all\n');
    const dir = join(root, layout);
    for (const target of [root, dir, file]) {
      const result = await runLint(target, [research]);
      expect(result.summary.passed).toBe(false);
      expect(result.summary.rulesApplied).toBe(11);
      expect(result.diagnostics.some(d => d.ruleId === 'research/ref-frontmatter')).toBe(true);
      for (const rule of research.rules) {
        expect(result.ruleCoverage[rule.id]).toHaveLength(1);
        expect(result.ruleCoverage[rule.id][0]).toContain('REF-123.md');
      }
    }
    for (const field of ['pdf_location', 'source_text']) {
      note(layout, valid.replace('---\n# Example', `${field}: sources/paper.txt\n---\n# Example`));
      for (const target of [root, dir, file]) {
        const result = await runLint(target, [research]);
        expect(result.diagnostics.some(d => d.ruleId === 'research/source-file-exists')).toBe(true);
      }
      mkdirSync(join(root, 'sources'), { recursive: true });
      writeFileSync(join(root, 'sources/paper.txt'), 'Source');
      for (const target of [root, dir, file]) {
        expect((await runLint(target, [research], { failOn: 'warn' })).diagnostics).toEqual([]);
      }
      rmSync(join(root, 'sources/paper.txt'));
    }
    note(layout, `${valid}\nThe OpenReview PDF was not retrieved.\n`);
    expect((await runLint(dir, [research])).diagnostics.some(d => d.ruleId === 'research/uncertainty-registered')).toBe(true);
  });

  it('resolves sibling and project-relative references when narrowed to a file or subdirectory', async () => {
    mkdirSync(join(root, '.aiwg'));
    const first = note('documentation/references', `${valid}\nSee REF-124.\n`);
    note('documentation/references', valid, 'REF-124-related.md');
    const nested = note('documentation/references/subdir', 'See REF-124.\n', 'summary.md');
    for (const target of [first, nested]) {
      const result = await runLint(target, [research]);
      expect(result.diagnostics.filter(d => d.ruleId === 'research/citation-resolves')).toEqual([]);
    }
    const custom = { ...research, rules: [research.rules.find(r => r.id === 'research/citation-resolves')!] };
    custom.rules = [{ ...custom.rules[0], checks: [{ type: 'reference-resolves', basePath: 'documentation/references' }] }];
    expect((await runLint(nested, [custom])).diagnostics).toEqual([]);
  });

  it.each(['.git', '.aiwg'])('uses the nearest project marker %s, including worktree git files', async (marker) => {
    mkdirSync(join(root, '.aiwg'));
    const project = join(root, 'nested');
    mkdirSync(project);
    writeFileSync(join(project, marker), 'marker');
    mkdirSync(join(project, 'findings'));
    writeFileSync(join(project, 'findings/REF-123.md'), valid.replace('---\n# Example', 'pdf_location: paper.pdf\n---\n# Example'));
    writeFileSync(join(project, 'paper.pdf'), 'PDF');
    const result = await runLint(join(project, 'findings'), [research]);
    expect(result.diagnostics).toEqual([]);
  });

  it('still resolves source paths written relative to the lint target', async () => {
    mkdirSync(join(root, '.git'));
    const target = join(root, '.aiwg/research');
    mkdirSync(join(target, 'findings'), { recursive: true });
    mkdirSync(join(target, 'pdfs'));
    writeFileSync(join(target, 'findings/REF-123.md'), valid.replace('---\n# Example', 'pdf_location: pdfs/paper.pdf\n---\n# Example'));
    writeFileSync(join(target, 'pdfs/paper.pdf'), 'PDF');
    const result = await runLint(target, [research]);
    expect(result.diagnostics.filter(d => d.ruleId === 'research/source-file-exists')).toEqual([]);
  });
});
