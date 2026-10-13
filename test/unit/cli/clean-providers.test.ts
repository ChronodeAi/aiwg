/**
 * Unit tests for tools/cli/clean-providers.mjs
 *
 * `npm run clean:providers` used to `rm -rf .claude` wholesale, destroying
 * Claude Desktop/Code-owned state that AIWG never wrote (worktrees/,
 * settings.local.json, settings.json and its backups, launch.json). These
 * tests spawn the real script against a synthetic scratch project — no
 * dependency on this host's installed CLIs or home directory — and assert
 * that user-owned files under `.claude/` survive while the AIWG-managed
 * subpaths (and every other provider target, unchanged) are removed.
 *
 * @implements #2626
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, '../../../tools/cli/clean-providers.mjs');

const scratchRoots: string[] = [];

async function makeScratchProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aiwg-clean-providers-'));
  scratchRoots.push(dir);
  return dir;
}

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function seedClaudeDir(projectDir: string): Promise<void> {
  // AIWG-managed subpaths — expected to be removed.
  await mkdir(join(projectDir, '.claude', 'agents'), { recursive: true });
  await writeFile(join(projectDir, '.claude', 'agents', 'some-agent.md'), 'agent', 'utf-8');
  await mkdir(join(projectDir, '.claude', 'commands'), { recursive: true });
  await writeFile(join(projectDir, '.claude', 'commands', 'some-command.md'), 'cmd', 'utf-8');
  await mkdir(join(projectDir, '.claude', '.aiwg', 'skills', 'some-skill'), { recursive: true });
  await writeFile(join(projectDir, '.claude', '.aiwg', 'skills', 'some-skill', 'SKILL.md'), 'skill', 'utf-8');
  await mkdir(join(projectDir, '.claude', 'rules'), { recursive: true });
  await writeFile(join(projectDir, '.claude', 'rules', 'some-rule.md'), 'rule', 'utf-8');
  await mkdir(join(projectDir, '.claude', 'hooks'), { recursive: true });
  await writeFile(join(projectDir, '.claude', 'hooks', 'some-hook.mjs'), 'hook', 'utf-8');
  await mkdir(join(projectDir, '.claude', 'skills', 'kernel-skill'), { recursive: true });
  await writeFile(join(projectDir, '.claude', 'skills', 'kernel-skill', 'SKILL.md'), 'kernel skill', 'utf-8');

  // Claude Desktop/Code-owned state — expected to survive.
  await writeFile(join(projectDir, '.claude', 'settings.json'), '{"hooks":{}}', 'utf-8');
  await writeFile(
    join(projectDir, '.claude', 'settings.json.bak.2026-01-01T00-00-00-000Z'),
    '{}',
    'utf-8',
  );
  await writeFile(join(projectDir, '.claude', 'settings.local.json'), '{"model":"opus"}', 'utf-8');
  await writeFile(join(projectDir, '.claude', 'launch.json'), '{}', 'utf-8');
  await mkdir(join(projectDir, '.claude', 'worktrees', 'feature-x'), { recursive: true });
  await writeFile(
    join(projectDir, '.claude', 'worktrees', 'feature-x', 'session.json'),
    '{"id":"abc"}',
    'utf-8',
  );
}

async function seedOtherProviderTargets(projectDir: string): Promise<void> {
  await mkdir(join(projectDir, '.codex', 'agents'), { recursive: true });
  await writeFile(join(projectDir, '.codex', 'agents', 'a.md'), 'a', 'utf-8');
  await mkdir(join(projectDir, '.agents', 'skills'), { recursive: true });
  await writeFile(join(projectDir, '.agents', 'skills', 's.md'), 's', 'utf-8');
  await writeFile(join(projectDir, '.hermes.md'), 'hermes context', 'utf-8');
  await writeFile(join(projectDir, 'opencode.json'), '{"instructions":[]}', 'utf-8');
}

async function runCleanProviders(projectDir: string): Promise<{ stdout: string }> {
  const { stdout } = await execFileAsync(process.execPath, [SCRIPT], { cwd: projectDir });
  return { stdout };
}

describe('tools/cli/clean-providers.mjs', () => {
  it('removes only the AIWG-managed subpaths under .claude, preserving Claude Desktop/Code-owned state', async () => {
    const projectDir = await makeScratchProject();
    await seedClaudeDir(projectDir);

    await runCleanProviders(projectDir);

    // AIWG-managed subpaths are gone.
    expect(existsSync(join(projectDir, '.claude', 'agents'))).toBe(false);
    expect(existsSync(join(projectDir, '.claude', 'commands'))).toBe(false);
    expect(existsSync(join(projectDir, '.claude', '.aiwg', 'skills'))).toBe(false);
    expect(existsSync(join(projectDir, '.claude', 'rules'))).toBe(false);
    expect(existsSync(join(projectDir, '.claude', 'hooks'))).toBe(false);
    expect(existsSync(join(projectDir, '.claude', 'skills'))).toBe(false);

    // Claude Desktop/Code-owned state survives untouched.
    expect(existsSync(join(projectDir, '.claude', 'settings.json'))).toBe(true);
    expect(existsSync(join(projectDir, '.claude', 'settings.json.bak.2026-01-01T00-00-00-000Z'))).toBe(true);
    expect(existsSync(join(projectDir, '.claude', 'settings.local.json'))).toBe(true);
    expect(existsSync(join(projectDir, '.claude', 'launch.json'))).toBe(true);
    expect(
      existsSync(join(projectDir, '.claude', 'worktrees', 'feature-x', 'session.json')),
    ).toBe(true);

    await expect(
      readFile(join(projectDir, '.claude', 'settings.local.json'), 'utf-8'),
    ).resolves.toBe('{"model":"opus"}');
  });

  it('keeps the previous whole-directory/whole-file removal for every other provider target', async () => {
    const projectDir = await makeScratchProject();
    await seedOtherProviderTargets(projectDir);

    await runCleanProviders(projectDir);

    expect(existsSync(join(projectDir, '.codex'))).toBe(false);
    expect(existsSync(join(projectDir, '.agents'))).toBe(false);
    expect(existsSync(join(projectDir, '.hermes.md'))).toBe(false);
    expect(existsSync(join(projectDir, 'opencode.json'))).toBe(false);
  });

  it('does not error when no provider directories exist', async () => {
    const projectDir = await makeScratchProject();

    await expect(runCleanProviders(projectDir)).resolves.toMatchObject({
      stdout: expect.stringContaining('Removed provider-deployed state'),
    });
  });

  it('reports the .claude managed subpaths it targeted', async () => {
    const projectDir = await makeScratchProject();
    await seedClaudeDir(projectDir);

    const { stdout } = await runCleanProviders(projectDir);

    expect(stdout).toContain('.claude/agents');
    expect(stdout).toContain('.claude/commands');
    expect(stdout).toContain('.claude/rules');
    expect(stdout).toContain('.claude/hooks');
    expect(stdout).toContain('.claude/skills');
    expect(stdout).not.toContain('.claude/settings');
  });
  it('falls back to the hand-written subpaths when the registry cannot be loaded, matching the registry', async () => {
    const mod = await import('../../../tools/cli/clean-providers.mjs');
    const fallback = mod.resolveScopedProviderManagedPaths(null);
    expect(fallback.every((entry: string) => entry.startsWith('.claude/'))).toBe(true);
    expect(fallback).not.toContain('.claude');
    expect([...fallback].sort()).toEqual([...mod.resolveScopedProviderManagedPaths()].sort());
  });
});
