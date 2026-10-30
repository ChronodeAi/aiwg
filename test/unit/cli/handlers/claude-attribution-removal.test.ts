// Remove attribution only when the last Claude deployment releases the settings scope.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { emptyConfig, writeAiwgConfig } from '../../../../src/config/aiwg-config.js';
import { writeUserRegistry } from '../../../../src/config/user-registry.js';
import { removeHandler } from '../../../../src/cli/handlers/subcommands.js';

vi.mock('node:os', async original => {
  const actual = await original<typeof import('node:os')>();
  const homedir = () => process.env.HOME!;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

let root: string;
let home: string;
const initial = { attribution: { commit: '', pr: '', sessionUrl: false },
  aiwg: { attributionKeys: ['pr', 'sessionUrl'] }, operator: true };
const deployment = { version: 'test', source: 'bundled' as const, installedAt: '2026-10-29T00:00:00Z',
  deployedTo: { claude: { agents: 0, commands: 0, skills: 0, rules: 0, entries: {} } } };
const settings = async (dir: string) => JSON.parse(await readFile(path.join(dir, '.claude/settings.json'), 'utf8'));
const remove = (args: string[]) => removeHandler.execute({ cwd: root, args, rawArgs: args, frameworkRoot: root });
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-claude-remove-'));
  home = path.join(root, 'home');
  await mkdir(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('AIWG_USER_REGISTRY_PATH', path.join(home, '.aiwg/installed.json'));
  for (const dir of [root, home]) {
    await mkdir(path.join(dir, '.claude'));
    await writeFile(path.join(dir, '.claude/settings.json'), JSON.stringify(initial));
  }
  const config = emptyConfig(); config.providers = ['claude'];
  config.installed = { first: structuredClone(deployment), second: structuredClone(deployment) };
  await writeAiwgConfig(root, config);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe('Claude attribution remove integration', () => {
  it('preserves defaults until the last project deployment is removed', async () => {
    expect((await remove(['first', '--provider', 'claude'])).exitCode).toBe(0);
    expect(await settings(root)).toEqual(initial);
    expect((await remove(['second', '--provider', 'claude', '--dry-run'])).exitCode).toBe(0);
    expect(await settings(root)).toEqual(initial);
    expect((await remove(['second', '--provider', 'claude'])).exitCode).toBe(0);
    expect(await settings(root)).toEqual({ attribution: { commit: '' }, operator: true });
  });
  it('preserves settings while --keep-registry retains the deployment', async () => {
    expect((await remove(['first', '--provider', 'claude', '--keep-registry'])).exitCode).toBe(0);
    expect(await settings(root)).toEqual(initial);
  });
  it('releases only owned keys at user scope after the last user deployment', async () => {
    await writeUserRegistry({ version: '1', installed: {
      first: structuredClone(deployment), second: structuredClone(deployment),
    } });
    expect((await remove(['first', '--scope', 'user', '--provider', 'claude'])).exitCode).toBe(0);
    expect(await settings(home)).toEqual(initial);
    expect((await remove(['second', '--scope', 'user', '--provider', 'claude', '--dry-run'])).exitCode).toBe(0);
    expect(await settings(home)).toEqual(initial);
    expect((await remove(['second', '--scope', 'user', '--provider', 'claude'])).exitCode).toBe(0);
    expect(await settings(home)).toEqual({ attribution: { commit: '' }, operator: true });
    expect(await settings(root)).toEqual(initial);
  });
});
