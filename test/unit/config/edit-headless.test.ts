/**
 * `aiwg config edit` headless safety (#3062).
 *
 * Without a terminal, `aiwg config edit` must refuse instead of spawning
 * $EDITOR/$VISUAL and hanging. `--print-path` is the headless equivalent:
 * it prints the resolved config file path and exits without spawning
 * anything, in any terminal state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { mockIsInteractive, mockExecSync } = vi.hoisted(() => ({
  mockIsInteractive: vi.fn(),
  mockExecSync: vi.fn(),
}));

vi.mock('../../../src/cli/env.js', () => ({
  isInteractive: mockIsInteractive,
}));

vi.mock('child_process', () => ({
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
    expect(mockExecSync).not.toHaveBeenCalled();
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
    expect(mockExecSync).not.toHaveBeenCalled();
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
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('launches $EDITOR when a terminal is attached and --print-path is not given', async () => {
    mockIsInteractive.mockReturnValue(true);
    mockExecSync.mockReturnValue(Buffer.from(''));
    await main(['edit', '--config-dir', configDir]);
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    const [command, options] = mockExecSync.mock.calls[0]!;
    expect(String(command)).toContain(join(configDir, 'config.yaml'));
    expect(options).toMatchObject({ stdio: 'inherit' });
  });
});
