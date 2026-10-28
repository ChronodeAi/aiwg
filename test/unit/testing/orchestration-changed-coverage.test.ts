import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ADAPTER_THRESHOLDS, bucketConfig, classifyChangedFile, listChangedFiles,
  resolveMergeBase, runGate, splitChangedFiles, VALIDATOR_THRESHOLDS,
} from '../../../tools/testing/orchestration-changed-coverage.mjs';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

describe('T-OG-05/06 orchestration changed-code coverage helper', () => {
  it('classifies validators, adapters/recovery and out-of-scope files', () => {
    for (const file of ['src/models/resolver.ts', 'src/config/aiwg-config.ts',
      'src/mission-protocol/codecs.ts', 'src/serve/shared-host-scheduler.ts',
      'src/serve/shared-host-admission-checks.ts']) expect(classifyChangedFile(file)).toBe('validators');
    for (const file of ['tools/ralph-external/session-launcher.mjs',
      'src/serve/fleet-mission-conductor.ts', 'src/mcp/stdio-lifecycle.ts']) {
      expect(classifyChangedFile(file)).toBe('adapters-recovery');
    }
    for (const file of ['test/unit/serve/shared-host-scheduler.test.ts', 'test/fixtures/ralph-stub-cli.mjs',
      'docs/contracts/shared-host-admission.v1.md', 'src/cli/handlers/models.ts',
      'tools/testing/orchestration-changed-coverage.mjs', 'test/conformance/orchestration-v1/packs.json',
      '../outside/repo.ts']) expect(classifyChangedFile(file)).toBeNull();
  });

  it('prefers validators when a file matches both scopes', () => {
    expect(classifyChangedFile('src/serve/shared-host-starvation.ts')).toBe('validators');
  });

  it('splits, dedupes and sorts changed files by bucket', () => {
    expect(splitChangedFiles(['src/mcp/a.ts', 'src/models/b.ts', 'src/models/b.ts', 'README.md'])).toEqual({
      validators: ['src/models/b.ts'],
      'adapters-recovery': ['src/mcp/a.ts'],
      outOfScope: ['README.md'],
    });
  });

  it('resolves the merge base from the environment, refs, or parent commit', () => {
    const calls: string[][] = [];
    const runGit = (args: string[]) => {
      calls.push(args);
      if (args[0] === 'merge-base') return args[2] === 'main' ? ['abc123'] : null;
      return ['parent1'];
    };
    expect(resolveMergeBase(runGit, {})).toBe('abc123');
    expect(resolveMergeBase(runGit, { ORCHESTRATION_COVERAGE_BASE: ' custom ' })).toBe('custom');
    expect(calls.some(args => args[0] === 'merge-base')).toBe(true);
    expect(resolveMergeBase(() => null, {})).toBeNull();
  });

  it('diffs main against its first parent when the merge base is HEAD itself', () => {
    const runGit = (args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ['head1'];
      if (args[0] === 'merge-base') return ['head1'];
      if (args.includes('HEAD^1')) return ['parent1'];
      return null;
    };
    expect(resolveMergeBase(runGit, {})).toBe('parent1');
  });

  it('fails closed in CI when no baseline resolves, and skips locally', () => {
    expect(runGate({ runGit: () => null, env: { CI: 'true' } })).toBe(1);
    expect(runGate({ runGit: () => null, env: {} })).toBe(0);
  });

  it('unions tracked and untracked changes without blanks', () => {
    const runGit = (args: string[]) => {
      if (args[0] === 'diff') return ['src/models/a.ts', '', 'src/models/b.ts'];
      return ['src/models/b.ts', 'tools/ralph-external/new.mjs'];
    };
    expect(listChangedFiles('base', runGit)).toEqual(
      ['src/models/a.ts', 'src/models/b.ts', 'tools/ralph-external/new.mjs']);
  });

  it('selects the reviewed thresholds and report directory per bucket', () => {
    expect(bucketConfig('validators', ['src/models/a.ts'])).toEqual({
      thresholds: VALIDATOR_THRESHOLDS, include: ['src/models/a.ts'],
      reportsDirectory: 'test-results/orchestration-changed-coverage/validators',
    });
    expect(VALIDATOR_THRESHOLDS).toEqual({ statements: 90, branches: 85 });
    expect(ADAPTER_THRESHOLDS).toEqual({ branches: 80 });
    expect(bucketConfig('adapters-recovery', ['src/mcp/a.ts']).thresholds).toBe(ADAPTER_THRESHOLDS);
  });

  it('generates coverage configs excluding test/** even when fixture paths match the source include', () => {
    const dir = mkdtempSync(join(tmpdir(), 'changed-coverage-config-')); directories.push(dir);
    for (const folder of ['tools/testing', 'config', 'node_modules/vitest']) {
      mkdirSync(join(dir, folder), { recursive: true });
    }
    const helper = join(dir, 'tools/testing/orchestration-changed-coverage.mjs');
    copyFileSync(fileURLToPath(new URL('../../../tools/testing/orchestration-changed-coverage.mjs', import.meta.url)), helper);
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    writeFileSync(join(dir, 'config/vitest.config.js'), 'export default { test: {} };');
    // A fake local runner reads the actual generated module; no nested Vitest process.
    writeFileSync(join(dir, 'node_modules/vitest/vitest.mjs'), `
      import { pathToFileURL } from 'node:url';
      const { default: config } = await import(pathToFileURL(process.argv[process.argv.indexOf('--config') + 1]));
      console.log('CONFIG=' + JSON.stringify(config.test.coverage));
      console.log('SUITES=' + JSON.stringify(config.test.include));
    `);
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { runGate } = await import(process.argv[1]);
      process.exitCode = runGate({ base: 'synthetic-base', runGit: () =>
        ['src/config/worker-context.ts', 'tools/ralph-external/lib/worker-context.mjs'] });
    `, pathToFileURL(helper).href], { cwd: dir, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
    expect(result.status, result.stderr).toBe(0);
    const configs = result.stdout.split('\n').filter(line => line.startsWith('CONFIG='))
      .map(line => JSON.parse(line.slice('CONFIG='.length)));
    expect(configs).toHaveLength(2);
    expect(configs.map(config => config.include)).toEqual([
      ['src/config/worker-context.ts'], ['tools/ralph-external/lib/worker-context.mjs'],
    ]);
    for (const config of configs) expect(config.exclude).toEqual(['test/**']);
    const suites = result.stdout.split('\n').filter(line => line.startsWith('SUITES='))
      .map(line => JSON.parse(line.slice('SUITES='.length)));
    for (const include of suites) expect(include).toContain('test/unit/ralph-external/**/*.test.mjs');
  });

  it('lists real working-tree changes from a disposable git repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'changed-coverage-helper-')); directories.push(dir);
    const git = (args: string[]) => {
      const result = spawnSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test',
        '-c', 'init.defaultBranch=main', ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
      if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      return result;
    };
    git(['init', '-q']);
    writeFileSync(join(dir, 'tracked.txt'), 'base\n');
    git(['add', 'tracked.txt']);
    git(['commit', '-qm', 'base']);
    const runGit = (args: string[]) => {
      const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
      if (result.status !== 0) return null;
      return String(result.stdout ?? '').split('\n').map(line => line.trim()).filter(Boolean);
    };
    writeFileSync(join(dir, 'tracked.txt'), 'changed\n');
    writeFileSync(join(dir, 'added.ts'), 'export const added = 1;\n');
    expect(listChangedFiles('HEAD', runGit)).toEqual(['added.ts', 'tracked.txt']);
  });
});
