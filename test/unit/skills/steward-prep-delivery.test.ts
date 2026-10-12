import { writeExecutable } from '../../helpers/write-executable.js';
import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const helperPath = path.join(
  repoRoot,
  'agentic/code/addons/aiwg-utils/skills/steward-prep-delivery/find-duplicates.sh',
);

let tempRoot: string;
let fakeBin: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(tmpdir(), 'aiwg-steward-prep-'));
  fakeBin = path.join(tempRoot, 'bin');
  await fs.mkdir(fakeBin, { recursive: true });
  await writeExecutable(
    path.join(fakeBin, 'aiwg'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "${1:-}" != "discover" ]; then exit 2; fi',
      'query="${2:-}"',
      'case "${AIWG_FAKE_MODE:-success}" in',
      '  fail) exit 77 ;;',
      '  sleep) exec sleep 30 ;;',
      'esac',
      'sleep 0.02',
      'printf \'{"results":[{"score":0.91,"type":"skill","name":"candidate-%s","capability":"capability for %s"}]}\\n\' "$query" "$query"',
    ].join('\n'),
  );
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe('steward-prep-delivery duplicate helper', () => {
  it('uses per-invocation discovery temp directories instead of the legacy shared file', async () => {
    const source = await fs.readFile(helperPath, 'utf8');

    expect(source).toContain('mkdir -m 700 -- "${DISCOVER_CANDIDATE}"');
    expect(source).toContain('DISCOVER_JSON');
    expect(source).not.toContain('/tmp/.steward-prep-discover.json');
    expect(source).not.toMatch(/\$\(mktemp/);
    expect(source.indexOf('trap cleanup_discover_tmp EXIT'))
      .toBeLessThan(source.indexOf('mkdir -m 700 -- "${DISCOVER_CANDIDATE}"'));
  });

  it('runs concurrent duplicate checks without parse errors or leaked discovery temp dirs', async () => {
    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      TMPDIR: tempRoot,
      GITEA_OWNER: 'roctinam',
      GITEA_REPO: 'aiwg',
      GITEA_TOKEN_FILE: path.join(tempRoot, 'missing-token'),
    };

    const runs = Array.from({ length: 10 }, (_, index) => {
      const query = `concurrent-query-${index}`;
      return execFileAsync('bash', [helperPath, query], {
        cwd: tempRoot,
        env,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      }).then(({ stdout, stderr }) => ({ query, stdout, stderr }));
    });

    const results = await Promise.all(runs);

    for (const result of results) {
      expect(result.stderr).toBe('');
      expect(result.stdout).not.toContain('parse error');
      expect(result.stdout).toContain(`candidate-${result.query}`);
      expect(result.stdout).toContain('Gitea token not found');
    }

    const tempEntries = await fs.readdir(tempRoot);
    expect(tempEntries.filter((entry) => entry.startsWith('steward-prep-discover.'))).toEqual([]);
  });

  it('cleans the discovery temp dir when local discovery fails', async () => {
    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      TMPDIR: tempRoot,
      AIWG_FAKE_MODE: 'fail',
      GITEA_OWNER: 'roctinam',
      GITEA_REPO: 'aiwg',
      GITEA_TOKEN_FILE: path.join(tempRoot, 'missing-token'),
    };

    const { stdout, stderr } = await execFileAsync('bash', [helperPath, 'failing-query'], {
      cwd: tempRoot,
      env,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });

    expect(stderr).toBe('');
    expect(stdout).toContain('aiwg discover failed');

    const tempEntries = await fs.readdir(tempRoot);
    expect(tempEntries.filter((entry) => entry.startsWith('steward-prep-discover.'))).toEqual([]);
  });

  /** @implements #2107 */
  it('cleans the discovery temp dir on signal exit', async () => {
    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      TMPDIR: tempRoot,
      AIWG_FAKE_MODE: 'sleep',
      GITEA_OWNER: 'roctinam',
      GITEA_REPO: 'aiwg',
      GITEA_TOKEN_FILE: path.join(tempRoot, 'missing-token'),
    };

    const child = spawn('bash', [helperPath, 'sleeping-query'], {
      cwd: tempRoot,
      env,
      stdio: 'ignore',
    });

    try {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const tempEntries = await fs.readdir(tempRoot);
        if (tempEntries.some((entry) => entry.startsWith('steward-prep-discover.'))) break;
        await delay(20);
      }

      const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      child.kill('SIGTERM');
      const exit = await Promise.race([
        exitPromise,
        delay(5_000).then(() => {
          throw new Error('helper did not exit within 5 seconds of SIGTERM');
        }),
      ]);

      expect(exit.code === 143 || exit.signal === 'SIGTERM').toBe(true);

      let leakedEntries: string[] = [];
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const tempEntries = await fs.readdir(tempRoot);
        leakedEntries = tempEntries.filter((entry) => entry.startsWith('steward-prep-discover.'));
        if (leakedEntries.length === 0) break;
        await delay(20);
      }
      expect(leakedEntries).toEqual([]);
    } finally {
      child.kill('SIGKILL');
    }
  });

  /**
   * Regression for the deferred-trap race (#2982): bash defers HUP/INT/TERM
   * traps while a foreground child runs. Under CI load the child that creates
   * the discovery temp dir could finish its work but take seconds to exit,
   * stalling signal handling. The stub creates the real directory, then
   * sleeps before exiting, which is what a scheduler-starved child looks like
   * to the helper.
   * @implements #2107
   */
  it('exits promptly on SIGTERM even when temp-dir creation is slow to exit', async () => {
    const slowSeconds = 5;
    // Stub both temp-dir creators so the test catches the bug whichever one
    // the helper uses.
    for (const command of ['mkdir', 'mktemp']) {
      await writeExecutable(
        path.join(fakeBin, command),
        [
          '#!/usr/bin/env bash',
          'set -euo pipefail',
          `command -p ${command} "$@"`,
          `sleep "\${AIWG_TEST_SLOW_TEMPDIR_SECONDS:-${slowSeconds}}"`,
        ].join('\n'),
      );
    }

    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      TMPDIR: tempRoot,
      GITEA_OWNER: 'roctinam',
      GITEA_REPO: 'aiwg',
      GITEA_TOKEN_FILE: path.join(tempRoot, 'missing-token'),
    };

    const child = spawn('bash', [helperPath, 'slow-mkdir-query'], {
      cwd: tempRoot,
      env,
      stdio: 'ignore',
    });

    try {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const tempEntries = await fs.readdir(tempRoot);
        if (tempEntries.some((entry) => entry.startsWith('steward-prep-discover.'))) break;
        await delay(20);
      }

      const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      child.kill('SIGTERM');

      // The helper must not wait out the child's slow exit. The budget is well
      // under the stub's sleep so a reintroduced deferred-trap bug fails here.
      const exit = await Promise.race([
        exitPromise,
        delay(2_000).then(() => {
          throw new Error('helper did not exit within 2 seconds of SIGTERM (temp-dir stub sleeps 5s)');
        }),
      ]);

      expect(exit.code === 143 || exit.signal === 'SIGTERM').toBe(true);

      let leakedEntries: string[] = [];
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const tempEntries = await fs.readdir(tempRoot);
        leakedEntries = tempEntries.filter((entry) => entry.startsWith('steward-prep-discover.'));
        if (leakedEntries.length === 0) break;
        await delay(20);
      }
      expect(leakedEntries).toEqual([]);
    } finally {
      child.kill('SIGKILL');
    }
  });
});
