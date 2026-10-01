import { describe, expect, it } from 'vitest';

import {
  DEFAULT_NPM_PACK_TIMEOUT_MS,
  NPM_PACK_TIMEOUT_ENV,
  resolveNpmPackTimeoutMs,
  runNpmPack,
} from '../../../tools/lint/lib/fortemi-npm-pack.mjs';

describe('lint:fortemi-prebuilt-package npm pack bound (#2802)', () => {
  it('defaults to a five minute timeout', () => {
    expect(DEFAULT_NPM_PACK_TIMEOUT_MS).toBe(300_000);
    expect(resolveNpmPackTimeoutMs({})).toBe(300_000);
    expect(resolveNpmPackTimeoutMs({ [NPM_PACK_TIMEOUT_ENV]: '' })).toBe(300_000);
  });

  it('accepts a positive integer override', () => {
    expect(resolveNpmPackTimeoutMs({ [NPM_PACK_TIMEOUT_ENV]: '1500' })).toBe(1500);
  });

  it.each(['0', '-5', '1.5', 'abc', '10ms', '99999999999999999999'])('rejects invalid override %s', (value) => {
    expect(() => resolveNpmPackTimeoutMs({ [NPM_PACK_TIMEOUT_ENV]: value })).toThrow(NPM_PACK_TIMEOUT_ENV);
  });

  it('passes the timeout to the npm pack spawn', () => {
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const outcome = runNpmPack({
      cwd: '/repo',
      destination: '/tmp/pack',
      timeoutMs: 1234,
      spawn: (command: string, args: string[], options: Record<string, unknown>) => {
        calls.push({ command, args, options });
        return { status: 0, signal: null, stdout: '[]', stderr: '' };
      },
    });
    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('npm');
    expect(calls[0].args).toEqual(['pack', '--json', '--pack-destination', '/tmp/pack']);
    expect(calls[0].options).toMatchObject({ cwd: '/repo', encoding: 'utf8', timeout: 1234 });
  });

  it('reports a non-zero exit as before', () => {
    const outcome = runNpmPack({
      cwd: '/repo',
      destination: '/tmp/pack',
      timeoutMs: 1000,
      spawn: () => ({ status: 2, signal: null, stdout: '', stderr: 'boom' }),
    });
    expect(outcome).toMatchObject({ ok: false, timedOut: false, message: 'npm pack --json exited with status 2' });
  });

  it('names the timeout when the child is killed by a signal', () => {
    const outcome = runNpmPack({
      cwd: '/repo',
      destination: '/tmp/pack',
      timeoutMs: 1000,
      spawn: () => ({ status: null, signal: 'SIGKILL', stdout: '', stderr: '' }),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.timedOut).toBe(true);
    expect(outcome.message).toContain('1000ms');
    expect(outcome.message).toContain(NPM_PACK_TIMEOUT_ENV);
  });

  it('kills a hung child and reports ETIMEDOUT', () => {
    const started = Date.now();
    const outcome = runNpmPack({
      cwd: process.cwd(),
      destination: '/unused',
      timeoutMs: 200,
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 30_000)'],
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(outcome.ok).toBe(false);
    expect(outcome.timedOut).toBe(true);
    expect(outcome.message).toBe(
      `npm pack --json timed out after 200ms; set ${NPM_PACK_TIMEOUT_ENV} to adjust the bound`,
    );
  });
});
