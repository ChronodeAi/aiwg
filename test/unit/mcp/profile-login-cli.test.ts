/**
 * `aiwg mcp profile login <name> [--api-key-env <ENV_VAR_NAME> |
 * --api-key-stdin | --api-key-file <path>]` (#3062, #3069, go/no-go review
 * blocker 1C).
 *
 * Wires `loginInProfile()` (src/mcp/adapters/codex-runtime.ts, already
 * covered at the unit level by test/unit/mcp/credentials.test.ts) to the
 * `aiwg mcp profile login` subcommand. These tests exercise the CLI wiring
 * itself — argument parsing, usage/exit-code behavior, and that the key
 * travels on stdin only — via a real subprocess with an isolated HOME/
 * CODEX_HOME and a stub `codex` executable, so nothing here ever touches a
 * real Codex installation or a real credential.
 *
 * `--api-key-stdin`'s "refuses when stdin is a terminal" branch is not
 * covered here: `execFileSync` without an explicit `input` already gives
 * the child a plain pipe for stdin (never a TTY), and there is no
 * dependency-free way to attach a real pseudo-terminal from this test
 * runner. That one branch (a single `process.stdin.isTTY` check) is a
 * disclosed coverage gap, not a behavior left unverified by reasoning —
 * see `handleProfileLogin()`'s own comment.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

function run(args: string[], env: Record<string, string> = {}, input?: string) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, 'profile', 'login', ...args], {
      encoding: 'utf-8',
      ...(input !== undefined ? { input } : {}),
      env: {
        PATH: `${stubBinDir}:${process.env.PATH}`,
        HOME: homeDir,
        CODEX_HOME: join(homeDir, '.codex'),
        ...env,
      },
      // Last, so no earlier spread can shadow it (the sync-timeout gate
      // treats a spread after a `timeout:` key as potentially overriding
      // it and flags the call as unbounded either way).
      timeout: 20_000,
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

  it('without a terminal and without any credential source, refuses naming all three flags, spawning nothing', () => {
    const result = run(['ci-profile']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/interactive terminal, or a key supplied via/);
    expect(result.stderr + result.stdout).toMatch(/--api-key-env/);
    expect(result.stderr + result.stdout).toMatch(/--api-key-stdin/);
    expect(result.stderr + result.stdout).toMatch(/--api-key-file/);
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

  // go/no-go review blocker 1C: --api-key-stdin.
  it('--api-key-stdin with piped input logs in headless: the key travels on stdin only, trimmed', () => {
    const result = run(['ci-profile', '--api-key-stdin'], {}, 'sk-test-stdin-secret\n');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Logged in to profile "ci-profile"');

    const argv = readFileSync(argvLogPath, 'utf-8');
    expect(argv).toContain('login --with-api-key');
    expect(argv).not.toContain('sk-test-stdin-secret');
    expect(result.stdout).not.toContain('sk-test-stdin-secret');
    expect(result.stderr).not.toContain('sk-test-stdin-secret');
    // Trimmed: the piped trailing newline must not reach codex's own stdin.
    expect(readFileSync(stdinLogPath, 'utf-8')).toBe('sk-test-stdin-secret');
  });

  it('--api-key-stdin with empty piped input errors naming empty stdin, spawning nothing', () => {
    const result = run(['ci-profile', '--api-key-stdin'], {}, '');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/--api-key-stdin received no key/);
    expect(existsSync(argvLogPath)).toBe(false);
  });

  it('--api-key-stdin and --api-key-env together is a usage error naming both flags', () => {
    const result = run(['ci-profile', '--api-key-stdin', '--api-key-env', 'SOME_VAR'], {}, 'sk-ignored\n');
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Only one credential source may be given');
    expect(result.stderr).toContain('--api-key-env');
    expect(result.stderr).toContain('--api-key-stdin');
    expect(existsSync(argvLogPath)).toBe(false);
  });

  // go/no-go review blocker 1C: --api-key-file.
  it('--api-key-file with a mode-600 file owned by the current user logs in headless', () => {
    const keyPath = join(root, 'key.txt');
    writeFileSync(keyPath, 'sk-test-file-secret\n', { mode: 0o600 });
    const result = run(['ci-profile', '--api-key-file', keyPath]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Logged in to profile "ci-profile"');

    const argv = readFileSync(argvLogPath, 'utf-8');
    expect(argv).not.toContain('sk-test-file-secret');
    expect(result.stdout).not.toContain('sk-test-file-secret');
    expect(result.stderr).not.toContain('sk-test-file-secret');
    expect(readFileSync(stdinLogPath, 'utf-8')).toBe('sk-test-file-secret');
  });

  it('--api-key-file refuses a group-readable file, naming the required permission, without printing contents', () => {
    const keyPath = join(root, 'loose-key.txt');
    writeFileSync(keyPath, 'sk-test-loose-secret\n', { mode: 0o600 });
    chmodSync(keyPath, 0o644);
    const result = run(['ci-profile', '--api-key-file', keyPath]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/group or other/);
    expect(result.stderr + result.stdout).not.toContain('sk-test-loose-secret');
    expect(existsSync(argvLogPath)).toBe(false);
  });

  it('--api-key-file refuses a symlink, refusing to follow it', () => {
    const realPath = join(root, 'real-key.txt');
    const linkPath = join(root, 'linked-key.txt');
    writeFileSync(realPath, 'sk-test-symlink-secret\n', { mode: 0o600 });
    symlinkSync(realPath, linkPath);
    const result = run(['ci-profile', '--api-key-file', linkPath]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/is a symlink/);
    expect(result.stderr + result.stdout).not.toContain('sk-test-symlink-secret');
    expect(existsSync(argvLogPath)).toBe(false);
  });

  it('--api-key-file naming a missing file errors naming the path, spawning nothing', () => {
    const result = run(['ci-profile', '--api-key-file', join(root, 'does-not-exist.txt')]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/does not exist/);
    expect(existsSync(argvLogPath)).toBe(false);
  });

  it('--api-key-file with an empty (after trim) file errors as empty, spawning nothing', () => {
    const keyPath = join(root, 'empty-key.txt');
    writeFileSync(keyPath, '\n', { mode: 0o600 });
    const result = run(['ci-profile', '--api-key-file', keyPath]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/is empty/);
    expect(existsSync(argvLogPath)).toBe(false);
  });

  it('--api-key-file and --api-key-stdin together is a usage error naming both flags', () => {
    const result = run(['ci-profile', '--api-key-file', join(root, 'does-not-exist.txt'), '--api-key-stdin'], {}, 'sk-ignored\n');
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Only one credential source may be given');
    expect(result.stderr).toContain('--api-key-file');
    expect(result.stderr).toContain('--api-key-stdin');
    expect(existsSync(argvLogPath)).toBe(false);
  });

  it('--api-key-file with no following value is a usage error naming the flag', () => {
    const result = run(['ci-profile', '--api-key-file']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('--api-key-file requires a value');
    expect(existsSync(argvLogPath)).toBe(false);
  });
});
