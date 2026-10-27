// Exercise the inherited lane environment through native, provider and child resolvers.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, inject, it, vi } from 'vitest';
import { expandProviderHomePath, resolveProviderPathValue } from '../../../src/providers/provider-definitions.js';
import { resolveMcpConfigPath } from '../../../src/providers/provider-definitions.mjs';
import { resolveMuseXdgSkillsDir } from '../../../src/providers/muse-paths.js';
import { createTemporaryHome } from '../../helpers/temporary-home.mjs';
import setup from '../../helpers/default-home-setup.mjs';

afterEach(() => vi.unstubAllEnvs());

describe('default lane temporary home', () => {
  it('isolates native, provider, XDG and child-process home resolution', () => {
    const home = inject('defaultLaneHome');
    expect(path.dirname(home)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(home)).toMatch(/^aiwg-default-home-/);
    expect(os.homedir()).toBe(home);
    expect(process.env.HOME).toBe(home);
    expect(process.env.USERPROFILE).toBe(home);
    expect(process.env.CODEX_HOME).toBeUndefined();
    expect(expandProviderHomePath('~/.codex/skills')).toBe(path.join(home, '.codex/skills'));
    expect(resolveProviderPathValue('~/.codex/skills', '.')).toBe(path.join(home, '.codex/skills'));
    expect(resolveMcpConfigPath('codex')).toBe(path.join(home, '.codex/config.toml'));
    expect(resolveMuseXdgSkillsDir()).toBe(path.join(home, '.config/muse/skills'));
    for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
      expect(process.env[key]?.startsWith(home + path.sep), key).toBe(true);
    }
    const child = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
      "import os from 'node:os'; process.stdout.write(JSON.stringify({home: os.homedir(), codex: process.env.CODEX_HOME}));",
    ], { encoding: 'utf8', timeout: 30_000 }));
    expect(child).toEqual({ home });
  });

  it('lets tests override HOME and CODEX_HOME and restores the lane defaults', () => {
    const fixture = createTemporaryHome('aiwg-home-override-');
    try {
      vi.stubEnv('HOME', fixture.home);
      vi.stubEnv('CODEX_HOME', fixture.env.CODEX_HOME);
      expect(process.env.HOME).toBe(fixture.home);
      expect(resolveMcpConfigPath('codex')).toBe(path.join(fixture.home, '.codex/config.toml'));
      vi.unstubAllEnvs();
      expect(process.env.HOME).toBe(inject('defaultLaneHome'));
      expect(process.env.CODEX_HOME).toBeUndefined();
    } finally { fixture.cleanup(); }
  });

  it('removes its owned home and restores setup environment on teardown', () => {
    const previous = { ...process.env };
    const originalConfigEnv = { EXISTING_FIXTURE_SETTING: 'preserved' };
    const project = { config: { env: originalConfigEnv }, provide: vi.fn() };
    const teardown = setup(project);
    const home = process.env.HOME!;
    try {
      expect(project.provide).toHaveBeenCalledWith('defaultLaneHome', home);
      expect(project.config.env).toMatchObject({ ...originalConfigEnv, HOME: home });
      expect(existsSync(home)).toBe(true);
    } finally { teardown(); }
    expect(existsSync(home)).toBe(false);
    expect(project.config.env).toBe(originalConfigEnv);
    expect({ ...process.env }).toEqual(previous);
  });
});
