/**
 * `aiwg config edit` headless safety (#3062).
 *
 * Without a terminal, `aiwg config edit` must refuse instead of spawning
 * $EDITOR/$VISUAL and hanging. `--print-path` is the headless equivalent:
 * it prints the resolved config file path and exits without spawning
 * anything, in any terminal state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import { join } from 'node:path';

const { mockIsInteractive, mockExecFileSync, mockExecSync } = vi.hoisted(() => ({
  mockIsInteractive: vi.fn(),
  mockExecFileSync: vi.fn(),
  mockExecSync: vi.fn(),
}));

vi.mock('../../../src/cli/env.js', () => ({
  isInteractive: mockIsInteractive,
}));

vi.mock('child_process', () => ({
  execFileSync: mockExecFileSync,
  execSync: mockExecSync,
}));

import { main } from '../../../src/config/cli.js';
import { AiwgError } from '../../../src/cli/errors.js';

describe('aiwg config edit — headless safety (#3062)', () => {
  let configDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    configDir = mkdtempSync(join(tmpdir(), 'aiwg-config-edit-'));
  });

  afterEach(() => {
    expect(mockExecSync).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    rmSync(configDir, { recursive: true, force: true });
  });

  it('refuses without a terminal and without --print-path, spawning nothing', async () => {
    mockIsInteractive.mockReturnValue(false);
    let caught: unknown;
    try {
      await main(['edit', '--config-dir', configDir]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AiwgError);
    const aiwgErr = caught as AiwgError;
    expect(aiwgErr.message).toMatch(/interactive terminal/);
    expect(aiwgErr.hint).toMatch(/aiwg config set/);
    expect(aiwgErr.hint).toMatch(/--print-path/);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('prints the resolved config file path with --print-path, without a terminal', async () => {
    mockIsInteractive.mockReturnValue(false);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await main(['edit', '--print-path', '--config-dir', configDir]);
      expect(logSpy).toHaveBeenCalledWith(join(configDir, 'config.yaml'));
    } finally {
      logSpy.mockRestore();
    }
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('prints the resolved config file path with --print-path, even with a terminal', async () => {
    mockIsInteractive.mockReturnValue(true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await main(['edit', '--print-path', '--config-dir', configDir]);
      expect(logSpy).toHaveBeenCalledWith(join(configDir, 'config.yaml'));
    } finally {
      logSpy.mockRestore();
    }
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it.each(['override', 'environment', 'legacy', 'xdg', 'fallback'])(
    'passes a %s config path containing shell metacharacters as one literal editor argument', async source => {
      mockIsInteractive.mockReturnValue(true);
      const home = join(configDir, 'home $(touch SHOULD_NOT_EXIST) `echo fake` "quoted"; &');
      const directory = source === 'xdg' ? join(home, '.config', 'aiwg') : join(home, '.aiwg');
      if (source === 'legacy' || source === 'xdg') mkdirSync(directory, { recursive: true });
      vi.spyOn(os, 'homedir').mockReturnValue(home);
      vi.stubEnv('AIWG_CONFIG', source === 'environment' ? directory : '');
      vi.stubEnv('EDITOR', '"/fake/editor with spaces" --wait');
      await main(['edit', ...(source === 'override' ? ['--config-dir', directory] : [])]);
      expect(mockExecFileSync).toHaveBeenCalledExactlyOnceWith('/fake/editor with spaces', ['--wait', join(directory, 'config.yaml')], { stdio: 'inherit', shell: false });
      expect(existsSync(join(configDir, 'SHOULD_NOT_EXIST'))).toBe(false);
    },
  );

  it('launches $EDITOR when a terminal is attached and --print-path is not given', async () => {
    mockIsInteractive.mockReturnValue(true);
    mockExecFileSync.mockReturnValue(Buffer.from(''));
    await main(['edit', '--config-dir', configDir]);
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockExecFileSync).toHaveBeenCalledWith(expect.any(String), [join(configDir, 'config.yaml')], { stdio: 'inherit', shell: false });
  });

  it('delivers the literal metacharacter path to a real child editor', async () => {
    mockIsInteractive.mockReturnValue(true);
    const editor = join(configDir, 'fake-editor.cjs');
    const output = join(configDir, 'argv.json');
    const directory = join(configDir, 'literal $(echo fake) `echo fake` "quotes"; &');
    writeFileSync(editor, "require('node:fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\n");
    const actual = await vi.importActual<typeof import('child_process')>('child_process');
    mockExecFileSync.mockImplementation(actual.execFileSync);
    vi.stubEnv('EDITOR', `"${process.execPath}" "${editor}" "${output}" --wait`);
    await main(['edit', '--config-dir', directory]);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(['--wait', join(directory, 'config.yaml')]);
  });
});
