/**
 * Go/no-go review blocker 1: no bootstrap subprocess (today, only the
 * update notifier) may start before `bin/aiwg.mjs` knows whether the
 * invocation is a credential-handling command, and the notifier's own
 * background child must never inherit the whole parent environment
 * regardless of command.
 *
 * `--api-key-stdin`/`--api-key-file` (the other two `mcp profile login`
 * credential sources, #3062/#3069) are not exercised against the notifier
 * here: neither ever assigns the key to a `process.env` variable — the
 * value lives only in a local JS variable from the moment it is read — so
 * there is no plausible path for either to reach a bootstrap child's copied
 * environment regardless of start order. The two commands below
 * (`mcp profile login --api-key-env`, `decision setup jev` without
 * `--token-stdin`) are exactly the two places a *named environment
 * variable* carries the secret, which is the vector this fix closes.
 *
 * Runs the real `bin/aiwg.mjs → router → mcp/cli.mjs` path end to end
 * (isolated `HOME`/`XDG_CONFIG_HOME`/`CODEX_HOME`, a stub `codex` that
 * never touches a real installation) — `AIWG_PACKAGE_MANAGER_EXECUTABLE`
 * short-circuits installation-identity creation's own `which git` lookup
 * so this file's output stays focused on the notifier's own behavior (that
 * lookup's own allow-list is tested separately, in
 * test/unit/installation/manager.test.ts — go/no-go review blocker 1B).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeExecutable } from '../../helpers/write-executable.js';

const BIN = resolve(__dirname, '../../../bin/aiwg.mjs');

let root: string;
let homeDir: string;
let stubBinDir: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'aiwg-notifier-credential-startup-'));
  homeDir = join(root, 'home');
  stubBinDir = join(root, 'bin');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(stubBinDir, { recursive: true });
  // Never a real `codex` — the `mcp profile login` case below must not
  // depend on, or touch, a real Codex installation.
  await writeExecutable(join(stubBinDir, 'codex'), `#!/bin/sh\nexit 0\n`);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// `execFileSync` discards stderr on a *successful* exit — several of the
// invocations below exit 0 (--version, mcp profile list) and the whole
// point is to inspect their stderr trace output, so this uses `spawnSync`
// instead, which always returns both streams regardless of exit code.
function run(args: string[], env: Record<string, string>) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf-8',
    timeout: 20_000,
    env: {
      PATH: `${stubBinDir}:${process.env.PATH ?? ''}`,
      HOME: homeDir,
      XDG_CONFIG_HOME: join(homeDir, '.config'),
      CODEX_HOME: join(homeDir, '.codex'),
      AIWG_TRACE_STARTUP: '1',
      NODE_DEBUG: 'child_process',
      // Short-circuits installation-identity creation's own `which git`
      // lookup (a separate, now also fixed, allow-list case — see
      // test/unit/installation/manager.test.ts) so this file's output
      // stays focused on the notifier's own behavior.
      AIWG_PACKAGE_MANAGER_EXECUTABLE: process.execPath,
      ...env,
    },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

describe('go/no-go review blocker 1: no bootstrap subprocess before a credential-handling command is known', () => {
  it('mcp profile login --api-key-env: the key never reaches the parent\'s own output, and the notifier never starts', () => {
    const result = run(
      ['mcp', 'profile', 'login', 'ci-profile', '--api-key-env', 'AIWG_TEST_NOTIFIER_STARTUP_KEY'],
      { AIWG_TEST_NOTIFIER_STARTUP_KEY: 'sk-test-notifier-startup-secret' },
    );
    expect(result.stdout).not.toContain('sk-test-notifier-startup-secret');
    expect(result.stderr).not.toContain('sk-test-notifier-startup-secret');
    expect(result.stderr).toMatch(/notifier:skip \(credential-handling command\)/);
    expect(result.stderr).not.toContain('notifier:bootstrap-complete');
  });

  it('decision setup jev (no --token-stdin, env fallback): the token never reaches the parent\'s own output, and the notifier never starts', () => {
    const result = run(
      ['decision', 'setup', 'jev'],
      { JEV_API_KEY: 'sk-test-jev-startup-secret' },
    );
    expect(result.stdout).not.toContain('sk-test-jev-startup-secret');
    expect(result.stderr).not.toContain('sk-test-jev-startup-secret');
    expect(result.stderr).toMatch(/notifier:skip \(credential-handling command\)/);
    expect(result.stderr).not.toContain('notifier:bootstrap-complete');
  });

  it('an ordinary (non-credential-handling) command still runs the notifier bootstrap', () => {
    const result = run(['mcp', 'profile', 'list'], {});
    expect(result.stderr).toMatch(/notifier:bootstrap-complete/);
    expect(result.stderr).not.toContain('notifier:skip (credential-handling command)');
  });

  it('aiwg --version stays on the fast path: the notifier still runs (unchanged ordering), and nothing hangs', () => {
    const result = run(['--version'], {});
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('aiwg');
    expect(result.stderr).toMatch(/notifier:bootstrap-complete/);
  });
});
