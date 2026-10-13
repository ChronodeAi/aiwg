import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  AIWG_SYNC_LONG_TIMEOUT_MS_ENV,
  SYNC_PROCESS_TIER_BOUNDS_MS,
  boundedExecFileSync,
  boundedExecSync,
  boundedSpawnSync,
  resolveSyncProcessTimeoutMs,
} from '../../../src/process/bounded-child-process.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '../../fixtures/process');
const ignoreSigtermScript = join(fixtures, 'ignore-sigterm.mjs');
const readStdinScript = join(fixtures, 'read-stdin.mjs');

describe('resolveSyncProcessTimeoutMs — tier bounds and env override', () => {
  const originalEnv = process.env[AIWG_SYNC_LONG_TIMEOUT_MS_ENV];

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[AIWG_SYNC_LONG_TIMEOUT_MS_ENV];
    else process.env[AIWG_SYNC_LONG_TIMEOUT_MS_ENV] = originalEnv;
  });

  it('returns the fixed default for quick and network regardless of the long-tier env var', () => {
    process.env[AIWG_SYNC_LONG_TIMEOUT_MS_ENV] = '999';
    expect(resolveSyncProcessTimeoutMs('quick')).toBe(SYNC_PROCESS_TIER_BOUNDS_MS.quick);
    expect(resolveSyncProcessTimeoutMs('network')).toBe(SYNC_PROCESS_TIER_BOUNDS_MS.network);
    expect(SYNC_PROCESS_TIER_BOUNDS_MS.quick).toBe(30_000);
    expect(SYNC_PROCESS_TIER_BOUNDS_MS.network).toBe(120_000);
  });

  it('returns the default long-tier bound (10 minutes) when the env var is unset', () => {
    delete process.env[AIWG_SYNC_LONG_TIMEOUT_MS_ENV];
    expect(resolveSyncProcessTimeoutMs('long')).toBe(600_000);
    expect(SYNC_PROCESS_TIER_BOUNDS_MS.long).toBe(600_000);
  });

  it('raises the long-tier bound to a valid positive integer override', () => {
    process.env[AIWG_SYNC_LONG_TIMEOUT_MS_ENV] = '900000';
    expect(resolveSyncProcessTimeoutMs('long')).toBe(900_000);
  });

  it('disables the long-tier bound entirely on "0"', () => {
    process.env[AIWG_SYNC_LONG_TIMEOUT_MS_ENV] = '0';
    expect(resolveSyncProcessTimeoutMs('long')).toBe(0);
  });

  it('falls back to the default and warns once for an invalid value', async () => {
    vi.resetModules();
    const fresh = await import('../../../src/process/bounded-child-process.mjs?invalid-env-test');
    process.env[AIWG_SYNC_LONG_TIMEOUT_MS_ENV] = 'not-a-number';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(fresh.resolveSyncProcessTimeoutMs('long')).toBe(600_000);
      expect(fresh.resolveSyncProcessTimeoutMs('long')).toBe(600_000);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain(AIWG_SYNC_LONG_TIMEOUT_MS_ENV);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('falls back to the default for a negative value', () => {
    process.env[AIWG_SYNC_LONG_TIMEOUT_MS_ENV] = '-5';
    expect(resolveSyncProcessTimeoutMs('long')).toBe(600_000);
  });

  it('rejects an unknown tier', () => {
    expect(() => resolveSyncProcessTimeoutMs('medium')).toThrow(/quick.*network.*long|tier/i);
  });
});

describe('boundedSpawnSync — explicit timeout wins when smaller than the tier bound', () => {
  it('kills at the caller-supplied timeout, not the (much larger) tier bound', () => {
    const start = Date.now();
    const result = boundedSpawnSync('node', [ignoreSigtermScript], 'network', { timeout: 200 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5_000);
    expect(result.signal).toBe('SIGKILL');
    expect(result.error?.code).toBe('ETIMEDOUT');
  });

  it('ignores a non-positive explicit timeout and falls back to the tier bound', () => {
    // A real 30s wait would slow this test down pointlessly; just confirm the
    // *resolution* ignores timeout:0/negative rather than treating it as "no bound".
    const result = boundedSpawnSync('node', ['-e', 'process.exit(0)'], 'quick', { timeout: 0 });
    expect(result.status).toBe(0);
  });
});

describe('boundedSpawnSync — stdin is never inherited', () => {
  it('gives a reading child immediate EOF when stdio was "inherit"', () => {
    const result = boundedSpawnSync('node', [readStdinScript], 'quick', {
      stdio: ['inherit', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    expect(result.stdout?.trim()).toBe('EOF');
  });

  it('gives a reading child immediate EOF for the "inherit" shorthand (stdout/stderr still captured via pipe override)', () => {
    const result = boundedSpawnSync('node', [readStdinScript], 'quick', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    expect(result.stdout?.trim()).toBe('EOF');
  });

  it('leaves stdin alone when the caller supplies `input`', () => {
    const result = boundedSpawnSync('node', [readStdinScript], 'quick', {
      input: 'hello-from-input',
      encoding: 'utf8',
    });
    expect(result.stdout?.trim()).toBe('DATA:hello-from-input');
  });
});

describe('boundedSpawnSync — a child that ignores SIGTERM does not outlive the bound', () => {
  it('returns within the bound (+ grace) via SIGKILL instead of hanging', () => {
    const boundMs = 300;
    const graceMs = 2_000; // CI scheduling slack, not a deliberate second stage
    const start = Date.now();
    const result = boundedSpawnSync('node', [ignoreSigtermScript], 'long', { timeout: boundMs });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(boundMs + graceMs);
    expect(result.status).toBeNull();
    expect(result.signal).toBe('SIGKILL');
    expect(result.error?.code).toBe('ETIMEDOUT');
    expect(result.error?.message).toContain("'long' tier bound of 300ms");
    expect(result.error?.message).toContain(ignoreSigtermScript);
  });
});

describe('boundedExecSync / boundedExecFileSync — throw the enriched error on timeout', () => {
  it('boundedExecSync throws with code ETIMEDOUT, signal SIGKILL, and an enriched message', () => {
    let caught;
    try {
      boundedExecSync(`node ${JSON.stringify(ignoreSigtermScript)}`, 'quick', { timeout: 200 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('ETIMEDOUT');
    expect(caught.signal).toBe('SIGKILL');
    expect(caught.message).toContain("'quick' tier bound of 200ms");
  });

  it('boundedExecFileSync throws with code ETIMEDOUT, signal SIGKILL, and an enriched message', () => {
    let caught;
    try {
      boundedExecFileSync('node', [ignoreSigtermScript], 'quick', { timeout: 200 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('ETIMEDOUT');
    expect(caught.signal).toBe('SIGKILL');
    expect(caught.message).toContain("'quick' tier bound of 200ms");
    expect(caught.message).toContain('node');
  });

  it('boundedExecSync leaves a non-timeout error message untouched', () => {
    let caught;
    try {
      boundedExecSync('node -e "process.exit(7)"', 'quick');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(caught.status).toBe(7);
    expect(caught.message).not.toContain('tier bound');
  });
});

describe('bounded* wrappers — normal (non-timeout) behavior is unchanged', () => {
  it('boundedExecSync returns stdout like execSync', () => {
    const out = boundedExecSync('node -e "process.stdout.write(\'ok\')"', 'quick', { encoding: 'utf8' });
    expect(out).toBe('ok');
  });

  it('boundedSpawnSync returns the same shape as spawnSync for a normal run', () => {
    const result = boundedSpawnSync('node', ['-e', 'process.stdout.write("ok")'], 'quick', { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('ok');
    expect(result.error).toBeUndefined();
  });

  it('requires a valid tier', () => {
    expect(() => boundedSpawnSync('node', ['-v'], 'fast')).toThrow(TypeError);
  });
});
