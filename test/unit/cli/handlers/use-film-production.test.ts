import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BundleManifestSchema } from '../../../../src/extensions/manifest.js';
import {
  computeAllKernelNames,
  getFrameworksForMode,
} from '../../../../tools/agents/providers/base.mjs';

const state = vi.hoisted(() => ({
  run: vi.fn(async () => ({ exitCode: 0, message: '' })),
}));

vi.mock('../../../../src/cli/handlers/script-runner.js', () => ({
  createScriptRunner: vi.fn(() => ({ run: state.run })),
}));

vi.mock('../../../../src/cli/project-isolation/index.js', () => ({
  maybeWarnProjectIsolation: vi.fn(async () => ({ cancelled: false })),
}));

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const frameworkPath = path.join(repoRoot, 'agentic/code/frameworks/film-production');

describe('film-production framework integration', () => {
  let target: string;

  beforeEach(async () => {
    state.run.mockClear();
    target = await mkdtemp(path.join(os.tmpdir(), 'aiwg-film-production-'));
  });

  afterEach(async () => {
    await rm(target, { recursive: true, force: true });
  });

  it('accepts the bundled manifest through the portable bundle schema', async () => {
    const manifest = JSON.parse(await readFile(path.join(frameworkPath, 'manifest.json'), 'utf8'));
    const parsed = BundleManifestSchema.parse(manifest);

    expect(parsed.id).toBe('film-production');
    expect(parsed.type).toBe('framework');
    expect(['full', 'partial', 'experimental']).toContain(parsed.platforms.codex);
    expect(parsed.frameworkConfig).toBeDefined();
  });

  it('discovers the framework and its kernel quickref from the canonical source', () => {
    const frameworks = getFrameworksForMode(repoRoot, 'film-production');

    expect(frameworks).toHaveLength(1);
    expect(frameworks[0].path).toBe(frameworkPath);
    expect(frameworks[0].components.skills.exists).toBe(true);
    expect(computeAllKernelNames(repoRoot)).toContain('film-production-quickref');
  });

  it('routes a named Codex preview to film mode without writing the target', async () => {
    const { UseHandler } = await import('../../../../src/cli/handlers/use.js');
    const args = [
      'film-production', '--provider', 'codex', '--target', target,
      '--dry-run', '--no-utils', '--no-project-local', '--no-context-files',
    ];
    const result = await new UseHandler().execute({
      args,
      rawArgs: ['use', ...args],
      cwd: target,
      frameworkRoot: repoRoot,
    });

    expect(result.exitCode, result.message).toBe(0);
    expect(state.run).toHaveBeenCalledTimes(1);
    const [script, deployArgs] = state.run.mock.calls[0] as unknown as [string, string[]];
    expect(script).toBe('tools/agents/deploy-agents.mjs');
    expect(deployArgs[deployArgs.indexOf('--mode') + 1]).toBe('film-production');
    expect(deployArgs[deployArgs.indexOf('--provider') + 1]).toBe('codex');
    expect(deployArgs).toContain('--deploy-skills');
    expect(deployArgs).toContain('--deploy-rules');
    expect(deployArgs).toContain('--dry-run');
    expect(await readdir(target)).toEqual([]);
  });
});
