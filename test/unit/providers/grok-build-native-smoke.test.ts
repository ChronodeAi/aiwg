import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const script = resolve(__dirname, '../../../tools/providers/grok-build-native-smoke.mjs');

describe('Grok Build live smoke gate', () => {
  it('skips without opt-in or a provisioned binary', () => {
    const env = { ...process.env };
    delete env.AIWG_GROK_BUILD_LIVE_SMOKE;
    const off = spawnSync(process.execPath, [script], { env, encoding: 'utf8', timeout: 30_000 });
    expect(off.status).toBe(0);
    expect(JSON.parse(off.stdout)).toMatchObject({ status: 'skipped' });
    const missing = spawnSync(process.execPath, [script], {
      env: { ...env, AIWG_GROK_BUILD_LIVE_SMOKE: '1', AIWG_GROK_BUILD_BIN: '/nonexistent/grok' }, encoding: 'utf8', timeout: 30_000,
    });
    expect(missing.status).toBe(0);
    expect(JSON.parse(missing.stdout)).toMatchObject({ status: 'skipped', reason: 'Grok Build binary unavailable' });
  });

  it('refuses an unpinned binary before execution', () => {
    const result = spawnSync(process.execPath, [script], {
      env: {
        ...process.env, AIWG_GROK_BUILD_LIVE_SMOKE: '1',
        AIWG_GROK_BUILD_BIN: process.execPath, XAI_API_KEY: 'fixture-not-a-secret',
        AIWG_GROK_BUILD_EXPECTED_SHA256: '0'.repeat(64),
      }, encoding: 'utf8', timeout: 30_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SHA-256 mismatch');
    expect(result.stdout).not.toContain('fixture-not-a-secret');
  });

  it.each([
    [{ type: 'end', stopReason: 'end_turn' }, 'passed'],
    [{ type: 'end', stopReason: 'max_tokens' }, 'failed'],
    [{ type: 'tool_call_update', toolCallId: 't1', status: 'failed' }, 'failed'],
    [{ type: 'result' }, 'failed'],
  ])('parses synthetic ACP smoke event %j as %s', (event, status) => {
    const root = mkdtempSync(join(tmpdir(), 'aiwg-grok-smoke-'));
    try {
      // A local executable with synthetic stream output, never a model CLI.
      const binary = join(root, 'fake-grok');
      const body = `#!/usr/bin/env node\nif(process.argv.includes('--version')){console.log('grok 1.0.50 synthetic');}else{console.log(${JSON.stringify(JSON.stringify(event))});}`;
      writeFileSync(binary, body, { mode: 0o700 });
      const result = spawnSync(process.execPath, [script], {
        cwd: root, env: { PATH: process.env.PATH, AIWG_GROK_BUILD_LIVE_SMOKE: '1', AIWG_GROK_BUILD_BIN: binary,
          AIWG_GROK_BUILD_EXPECTED_SHA256: createHash('sha256').update(body).digest('hex'), XAI_API_KEY: 'synthetic' },
        encoding: 'utf8', timeout: 30_000,
      });
      expect(result.status).toBe(status === 'passed' ? 0 : 1);
      expect(JSON.parse(result.stdout)).toMatchObject({ status });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
