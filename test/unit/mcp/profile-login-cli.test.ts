/**
 * `aiwg mcp profile login <name> [--api-key-env <ENV_VAR_NAME>]` (#3062, #3069).
 *
 * Wires `loginInProfile()` (src/mcp/adapters/codex-runtime.ts, already
 * covered at the unit level by test/unit/mcp/credentials.test.ts) to the
 * `aiwg mcp profile login` subcommand. These tests exercise the CLI wiring
 * itself — argument parsing, usage/exit-code behavior, and that the key
 * travels on stdin only — via a real subprocess with an isolated HOME/
 * CODEX_HOME and a stub `codex` executable, so nothing here ever touches a
 * real Codex installation or a real credential.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeExecutable } from '../../helpers/write-executable.js';

const CLI = resolve(__dirname, '../../../src/mcp/cli.mjs');

let root: string;
let stubBinDir: string;
let homeDir: string;
let stdinLogPath: string;
let argvLogPath: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'aiwg-profile-login-cli-'));
  stubBinDir = join(root, 'bin');
  homeDir = join(root, 'home');
  mkdirSync(stubBinDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  stdinLogPath = join(root, 'stdin.log');
  argvLogPath = join(root, 'argv.log');

  // Stub `codex`: records its argv and stdin, then exits 0. Never a real
  // Codex binary — the test PATH only contains this stub.
  await writeExecutable(
    join(stubBinDir, 'codex'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${argvLogPath}"
cat >> "${stdinLogPath}"
exit 0
`,
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string> = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, 'profile', 'login', ...args], {
      encoding: 'utf-8',
      timeout: 20_000,
      env: {
        PATH: `${stubBinDir}:${process.env.PATH}`,
        HOME: homeDir,
        CODEX_HOME: join(homeDir, '.codex'),
        ...env,
      },
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number | null };
    return {
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
      exitCode: e.status ?? 1,
    };
  }
}

describe('aiwg mcp profile login (#3062, #3069)', () => {
  it('without a profile name, errors with usage and spawns nothing', () => {
    const result = run([]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Usage: aiwg mcp profile login');
    expect(existsSync(argvLogPath)).toBe(false);
  });

  it('--api-key-env with no following value is a usage error naming the flag, before any name parsing', () => {
    const result = run(['--api-key-env']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('--api-key-env requires a value');
    expect(existsSync(argvLogPath)).toBe(false);
  });

  it('does not mistake --api-key-env\'s own value for a missing profile name', () => {
    const result = run(['--api-key-env', 'SOME_VAR']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Usage: aiwg mcp profile login');
    expect(existsSync(argvLogPath)).toBe(false);
  });

  it('without a terminal and without --api-key-env, refuses naming the argument, spawning nothing', () => {
    const result = run(['ci-profile']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/interactive terminal, or an API key/);
    expect(result.stderr + result.stdout).toMatch(/apiKeyEnv/);
    expect(existsSync(argvLogPath)).toBe(false);
  });

  it('accepts --api-key-env=NAME (equals form)', () => {
    const result = run(['ci-profile', '--api-key-env=AIWG_TEST_PROFILE_LOGIN_KEY'], {
      AIWG_TEST_PROFILE_LOGIN_KEY: 'sk-test-not-a-real-secret-eq',
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(stdinLogPath, 'utf-8')).toBe('sk-test-not-a-real-secret-eq');
  });

  it('--api-key-env= (empty value) is a usage error, not a silently-unset lookup', () => {
    const result = run(['ci-profile', '--api-key-env=']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('--api-key-env requires a value');
    expect(existsSync(argvLogPath)).toBe(false);
  });

  it('a malformed second --api-key-env occurrence is still an error, even though the first was valid', () => {
    const result = run(['ci-profile', '--api-key-env', 'AIWG_TEST_PROFILE_LOGIN_KEY', '--api-key-env'], {
      AIWG_TEST_PROFILE_LOGIN_KEY: 'sk-test-not-a-real-secret',
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('--api-key-env requires a value');
    expect(existsSync(argvLogPath)).toBe(false);
  });

  it('--api-key-env naming an unset variable errors naming the variable, never spawning codex', () => {
    const result = run(['ci-profile', '--api-key-env', 'AIWG_TEST_PROFILE_LOGIN_UNSET']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toContain('AIWG_TEST_PROFILE_LOGIN_UNSET');
    expect(result.stderr + result.stdout).not.toMatch(/\bundefined\b/);
    expect(existsSync(argvLogPath)).toBe(false);
  });

  it('--api-key-env with the variable set logs in headless: the key travels on stdin only, never argv', () => {
    const result = run(['ci-profile', '--api-key-env', 'AIWG_TEST_PROFILE_LOGIN_KEY'], {
      AIWG_TEST_PROFILE_LOGIN_KEY: 'sk-test-not-a-real-secret',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Logged in to profile "ci-profile"');

    expect(existsSync(argvLogPath)).toBe(true);
    const argv = readFileSync(argvLogPath, 'utf-8');
    expect(argv).toContain('login --with-api-key');
    expect(argv).not.toContain('sk-test-not-a-real-secret');
    expect(result.stdout).not.toContain('sk-test-not-a-real-secret');
    expect(result.stderr).not.toContain('sk-test-not-a-real-secret');

    expect(existsSync(stdinLogPath)).toBe(true);
    expect(readFileSync(stdinLogPath, 'utf-8')).toBe('sk-test-not-a-real-secret');
  });
});
