// Synthetic conductor tool events exercise refusal before any task content is read.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectLocalOnlyPaths, conductorToolDenial, validLocalOnlyPath } from '../../../src/models/conductor-data-policy.mjs';
import { mergeWorkerSelection, WorkerSelectionPolicySchema } from '../../../src/models/worker-selection-policy.js';
import { diagnoseWorkerHealthReadiness } from '../../../src/models/worker-health-readiness.js';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const tool = (command: string, cwd?: string) => ({ tool_name: 'Bash', tool_input: { command }, cwd });

describe('T-OG-01 local-only conductor input policy', () => {
  it.each(['../private', '/private', 'a/../b', './secret', 'a//b', 'a/*', 'a)\nBash(*)', '', '.', '..', 'a/.', 'secret\n', 'secret\r', 'secret\u2028'])('rejects unsafe policy path %j', file => {
    expect(validLocalOnlyPath(file)).toBe(false);
    expect(WorkerSelectionPolicySchema.safeParse({ dataPolicy: { localOnlyPaths: [file] } }).success).toBe(false);
  });
  it('unions inherited protected paths instead of relaxing them', () => {
    const { policy, diagnostics } = mergeWorkerSelection([
      { source: 'user', authority: 'user', digest: 'u', policy: { dataPolicy: { localOnlyPaths: ['private'] } } },
      { source: 'project', authority: 'project', digest: 'p', policy: { dataPolicy: { localOnlyPaths: [] },
        dataClasses: { 'local-only': { allowedProcessing: ['local'], localOnlyPaths: ['eval-work/local.txt'] } } } },
    ]);
    expect(diagnostics).toEqual([]);
    expect(collectLocalOnlyPaths(policy, { groups: { workers: { members: [], maxParallel: 1, dataPolicy: { localOnlyPaths: ['group/input'] } } } }))
      .toEqual(['eval-work/local.txt', 'group/input', 'private']);
  });
  it.each([
    'cat eval-work/local.txt | head -5',
    'ls -la . && cat eval-work/local.txt 2>/dev/null | head -5 && pwd',
    'cat "eval-work/local.txt"',
    'head < eval-work/local.txt',
    'python -c "open(\'eval-work/local.txt\').read()"',
  ])('refuses the explicit shell reference %s', command => {
    expect(conductorToolDenial(tool(command), '/project', ['eval-work/local.txt'])).toMatch(/local-only/);
  });
  it.each([
    'for f in eval-work/*.json eval-work/*.txt .eval-control/policy.md; do echo "=== $f ==="; cat "$f"; done',
    'cat eval-work/*.txt',
    'cat eval-work/loc?l.txt',
    'cat eval-work/[kl]ocal.txt',
    'cat eval-work/[!p]*.txt',
    'cat eval-work/[a-z]*.txt',
    'cat eval-*/local.*',
    'cat **/local.txt',
    'cat eval-work/**/*.txt',
    'cat "eval-work/"*.txt',
    'cat < eval-work/*.txt',
    'grep -r x eval-work',
    'grep -Rn x ./eval-work',
    'grep --recursive -e x eval-work',
    'grep -r -e x -- eval-work',
    'rg x eval-work',
    'rg --glob "*.txt" x eval-work',
    'rg --files eval-work',
    'rg x',
    'grep -r x',
    'find eval-work -type f -exec cat {} \\;',
  ])('refuses glob or ancestor reads: %s', command => {
    const root = mkdtempSync(path.join(tmpdir(), 'aiwg-conductor-glob-')); roots.push(root);
    mkdirSync(path.join(root, 'eval-work'));
    writeFileSync(path.join(root, 'eval-work/local.txt'), 'synthetic local-only input');
    expect(conductorToolDenial(tool(command, root), root, ['eval-work/local.txt'])).toMatch(/local-only/);
  });
  it.each([
    'cat eval-work/public.txt',
    'ls eval-work',
    'cat eval-work/*.json',
    'cat eval-work/**/*.json',
    'cat eval-work/[!l]*.txt',
    'cat eval-work/*.tx',
    'cat eval-work/*/local.txt',
    'cat "eval-work/*.txt"',
    "cat 'eval-work/loc?l.txt'",
    'cat eval-work/\\*.txt',
    'cat eval-work/"*".txt',
    'grep x eval-work',
    'grep -r x public-inputs',
    'rg x public-inputs',
    'rg -e x public-inputs',
    'find public-inputs -exec cat {} \\;',
    'rg x public-inputs; ls eval-work',
  ])('allows commands that cannot read the protected file: %s', command => {
    const root = mkdtempSync(path.join(tmpdir(), 'aiwg-conductor-glob-')); roots.push(root);
    mkdirSync(path.join(root, 'eval-work'));
    writeFileSync(path.join(root, 'eval-work/local.txt'), 'synthetic local-only input');
    expect(conductorToolDenial(tool(command, root), root, ['eval-work/local.txt'])).toBeNull();
  });
  it('resolves glob cwd and symlink ancestors, including protected directory subtrees', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aiwg-conductor-glob-')); roots.push(root);
    mkdirSync(path.join(root, 'eval-work'));
    mkdirSync(path.join(root, 'private-inputs/deep'), { recursive: true });
    writeFileSync(path.join(root, 'eval-work/local.txt'), 'synthetic local-only input');
    writeFileSync(path.join(root, 'private-inputs/deep/input.txt'), 'synthetic nested input');
    symlinkSync(path.join(root, 'eval-work'), path.join(root, 'alias-dir'));
    const paths = ['eval-work/local.txt', 'private-inputs'];
    for (const command of ['cat *.txt', 'cat ../eval-work/*.txt', 'rg x .']) {
      expect(conductorToolDenial(tool(command, path.join(root, 'eval-work')), root, paths)).toBeTruthy();
    }
    for (const command of ['cat alias-dir/*.txt', 'rg x alias-dir', 'cat private-*/*', 'cat private-*/*/*.txt']) {
      expect(conductorToolDenial(tool(command, root), root, paths)).toBeTruthy();
    }
    expect(conductorToolDenial(tool(`cat ${root}/eval-work/*.txt`), root, paths)).toBeTruthy();
    expect(conductorToolDenial(tool('cat private-inputs/*'), root, ['private-inputs'])).toBeTruthy();
  });
  it('normalizes Read paths and nested cwd, blocks subtrees and symlink aliases', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aiwg-conductor-input-')); roots.push(root);
    mkdirSync(path.join(root, 'eval-work'));
    writeFileSync(path.join(root, 'eval-work/local.txt'), 'synthetic local-only input');
    symlinkSync(path.join(root, 'eval-work/local.txt'), path.join(root, 'alias'));
    const paths = ['eval-work/local.txt'];
    expect(conductorToolDenial({ tool_name: 'Read', tool_input: { file_path: './eval-work/../eval-work/local.txt' } }, root, paths)).toBeTruthy();
    expect(conductorToolDenial(tool('cat local.txt', path.join(root, 'eval-work')), root, paths)).toBeTruthy();
    expect(conductorToolDenial(tool('cat alias'), root, paths)).toBeTruthy();
    expect(conductorToolDenial({ tool_name: 'Grep', tool_input: { path: 'private/deep/file' } }, root, ['private'])).toBeTruthy();
    expect(conductorToolDenial(tool('cat public.txt'), root, paths)).toBeNull();
    expect(conductorToolDenial({ tool_name: 'Read', tool_input: { file_path: 'README.md' } }, root, paths)).toBeNull();
  });
  it('doctor lists declarations even when worker dispatch is disabled', () => {
    const f = workerResolutionFixture();
    f.snapshot.config.parallelism!.worker_dispatch = false;
    f.snapshot.models.defaults.workerSelection!.dataPolicy = { localOnlyPaths: ['eval-work/local.txt'] };
    const report = diagnoseWorkerHealthReadiness(f.snapshot, f.request);
    expect(report.findings.find(item => item.code === 'CONDUCTOR_LOCAL_ONLY_PATHS')?.message).toContain('eval-work/local.txt');
  });
});
