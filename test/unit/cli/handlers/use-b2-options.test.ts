import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { countPiAgentFiles, useHandler, validateUseOptions } from '../../../../src/cli/handlers/use.js';

describe('use boundary validation', () => {
  it.each(['--bogus', '--dev', '--no-hook', '-z', '--provider=pi'])('names unknown option %s', (flag) => {
    expect(validateUseOptions(['all', flag])).toBe(`Unknown option '${flag}'. See aiwg use --help.`);
  });
  it('validates before framework lookup or bootstrap', async () => {
    const result = await useHandler.execute({ args: ['all', '--bogus'], rawArgs: [], cwd: '/missing', frameworkRoot: '/missing' });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain('--bogus');
  });
  it('preserves supported options and values without interpreting them as bundles', () => {
    expect(validateUseOptions(['all', '--provider', 'pi', '--no-hooks', '--model', 'model/id', '--coding', 'model/id', '--save-user', '--no-context-files', '--copy-all', '-v'])).toBeUndefined();
  });
  it.each(['--quiet', '-q'])('preserves the supported deployer option %s (#3467)', (flag) => {
    expect(validateUseOptions(['sdlc', '--provider', 'claude', flag])).toBeUndefined();
  });
  it.each(['--provider', '--model', '--scope'])('rejects a missing value for %s', (flag) => {
    expect(validateUseOptions(['all', flag, '--dry-run'])).toContain(`Missing value for option '${flag}'`);
  });
  it('only accepts internal continuation capabilities issued by this handler', () => {
    expect(validateUseOptions(['all', '--aiwg-provider-main-prepared', 'forged'])).toContain('Unknown option');
    expect(validateUseOptions(['all', '--aiwg-provider-main-prepared', 'issued'], new Set(['issued']))).toBeUndefined();
  });
});

describe('pi agent file counts', () => {
  it('excludes kernel skill directories and counts actual markdown agent files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-pi-count-'));
    try {
      await mkdir(path.join(dir, 'skills', 'use'), { recursive: true });
      await writeFile(path.join(dir, 'skills/use/SKILL.md'), 'skill');
      await writeFile(path.join(dir, 'skills/.aiwg-manifest.json'), '{}');
      expect(await countPiAgentFiles(dir, 'skills')).toBe(0);
      await writeFile(path.join(dir, 'skills/agent.md'), 'agent');
      expect(await countPiAgentFiles(dir, 'skills')).toBe(1);
      expect(await countPiAgentFiles(dir, path.join(dir, 'skills'))).toBe(1);
      expect(await countPiAgentFiles(dir, null)).toBe(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
