/**
 * `loginInProfile()`'s `--api-key-env` path never exposes the API key to
 * native child-process diagnostics (#3062 second review, finding 1).
 *
 * The first round fed the key to `boundedSpawnSync` via its `input`
 * option, which places the secret inside the options object
 * `child_process` hands to its native binding — printed verbatim by
 * `NODE_DEBUG=child_process` (and by any other dump of those options).
 * This is an end-to-end probe, not a mocked unit test: it spawns a real
 * Node process running `loginInProfile()` against the real compiled
 * module, with `NODE_DEBUG=child_process` set and a stub `codex` on PATH,
 * and asserts the fake key appears nowhere in that process's own stdout
 * or stderr — only on the stub's stdin.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(__dirname, '../../..');
const DIST_CODEX_RUNTIME = join(REPO_ROOT, 'dist', 'src', 'mcp', 'adapters', 'codex-runtime.js');
const FAKE_KEY = 'sk-fake-not-a-real-secret-credential-safety-probe';

describe('loginInProfile --api-key-env credential safety (#3062 second review, finding 1)', () => {
  let root: string;

  beforeEach(() => {
    if (!existsSync(DIST_CODEX_RUNTIME)) {
      throw new Error('dist/src/mcp/adapters/codex-runtime.js is missing — run `npm run build:cli` before this test.');
    }
    root = mkdtempSync(join(tmpdir(), 'aiwg-codex-login-credsafe-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('never prints the key under NODE_DEBUG=child_process; the stub sees it only on stdin, never env/argv', () => {
    const binDir = join(root, 'bin');
    mkdirSync(binDir, { recursive: true });
    const argvLog = join(root, 'argv.log');
    const envLog = join(root, 'env.log');
    const stdinLog = join(root, 'stdin.log');

    // Absolute-path shebang (this exact Node binary) rather than
    // `#!/usr/bin/env node` — the stub must not depend on PATH resolving
    // `node` to anything in particular (#3062 second review, finding 11's
    // "stubs must not depend on host tools beyond the Node binary running
    // the tests", applied here too).
    writeFileSync(
      join(binDir, 'codex'),
      `#!${process.execPath}\n` +
      `import { writeFileSync } from 'node:fs';\n` +
      `writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));\n` +
      `writeFileSync(${JSON.stringify(envLog)}, JSON.stringify(process.env));\n` +
      `const chunks = [];\n` +
      `process.stdin.on('data', (c) => chunks.push(c));\n` +
      `process.stdin.on('end', () => {\n` +
      `  writeFileSync(${JSON.stringify(stdinLog)}, Buffer.concat(chunks).toString('utf8'));\n` +
      `  process.exit(0);\n` +
      `});\n`,
      { mode: 0o755 },
    );

    const runnerPath = join(root, 'runner.mjs');
    writeFileSync(
      runnerPath,
      `import { loginInProfile } from ${JSON.stringify(pathToFileURL(DIST_CODEX_RUNTIME).href)};\n` +
      `await loginInProfile('cred-safety-probe', { apiKeyEnv: 'AIWG_CREDSAFE_FAKE_KEY' });\n` +
      `console.log('runner: login resolved without throwing');\n`,
    );

    const result = spawnSync(process.execPath, [runnerPath], {
      encoding: 'utf-8',
      timeout: 20_000,
      env: {
        PATH: `${binDir}${delimiter}${process.env.PATH}`,
        HOME: root,
        CODEX_HOME: join(root, '.codex'),
        AIWG_CREDSAFE_FAKE_KEY: FAKE_KEY,
        // The diagnostic surface under test: this is what made the key
        // visible in the first round.
        NODE_DEBUG: 'child_process',
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);

    // The parent (this runner) process's own stdout/stderr — including
    // whatever NODE_DEBUG printed — never contains the fake key.
    expect(result.stdout).not.toContain(FAKE_KEY);
    expect(result.stderr).not.toContain(FAKE_KEY);
    expect(result.stdout).toContain('login resolved without throwing');

    // The stub codex process actually ran and received the key — but
    // only on stdin.
    expect(existsSync(stdinLog)).toBe(true);
    expect(readFileSync(stdinLog, 'utf-8')).toBe(FAKE_KEY);

    expect(existsSync(argvLog)).toBe(true);
    const argv = JSON.parse(readFileSync(argvLog, 'utf-8')) as string[];
    expect(argv.join(' ')).not.toContain(FAKE_KEY);

    expect(existsSync(envLog)).toBe(true);
    const env = JSON.parse(readFileSync(envLog, 'utf-8')) as Record<string, string>;
    // Neither the named variable nor any other variable holding the same
    // value reaches the stub's own environment.
    expect(env.AIWG_CREDSAFE_FAKE_KEY).toBeUndefined();
    expect(Object.values(env)).not.toContain(FAKE_KEY);
  });
});
