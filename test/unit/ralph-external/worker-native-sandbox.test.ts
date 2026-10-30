/** Synthetic native sandbox mechanism and transient-unit regression coverage. */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { systemdClientFixture } from '../../fixtures/systemd-client.js';
import * as workerIsolation from '../../../tools/ralph-external/lib/worker-isolation.mjs';
import { resolveWorkerBwrap, workerNativeSandboxProbeHooks } from '../../../tools/ralph-external/lib/worker-native-sandbox.mjs';

const ENV = { PATH: '/usr/bin:/bin', HOME: '/home/conductor' };
const roots: string[] = [];
const bwrap = () => workerNativeSandboxProbeHooks.codex({ executable: () => true });
const probeHooks = { codex: bwrap, muse: bwrap };
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('native sandbox unit preflight', () => {
  it('resolves system bwrap first, falls back to absolute worker PATH, and fails closed when missing', () => {
    const executable = vi.fn(candidate => ['/usr/bin/bwrap', '/worker/bin/bwrap'].includes(candidate));
    expect(resolveWorkerBwrap({ env: { PATH: '/worker/bin' }, executable })).toBe('/usr/bin/bwrap');
    expect(executable).toHaveBeenCalledOnce();
    expect(resolveWorkerBwrap({ env: { PATH: '.:relative:/worker/bin' },
      executable: candidate => candidate === '/worker/bin/bwrap' })).toBe('/worker/bin/bwrap');
    expect(() => resolveWorkerBwrap({ env: { PATH: '.' }, executable: () => false })).toThrow('bwrap is unavailable');
    expect(workerNativeSandboxProbeHooks.codex).toBe(workerNativeSandboxProbeHooks.muse);
  });

  it('gives CLIs without their own hook a generic namespace probe instead of failing them', () => {
    const clients = systemdClientFixture(); roots.push(clients.root); vi.stubEnv('PATH', clients.root);
    const spawn = vi.fn((_binary: string, args: string[]) => args.includes('show-environment')
      ? { status: 0, stdout: '' } : { status: 0, stdout: '' });
    const result = workerIsolation.probeWorkerNativeSandbox({ adapter: { provider: 'hermes' }, spawn });
    expect(result).toMatchObject({ ok: true, mode: 'systemd-unit' });
    expect(['bwrap', 'unshare']).toContain(result.mechanism);
    const probeArgs = spawn.mock.calls.map(call => call[1] as string[]).find(args => !args.includes('show-environment'))!;
    expect(probeArgs.some(arg => /\/(bwrap|unshare)$/.test(arg))).toBe(true);
  });

  it.each(['codex', 'muse'])('reports bwrap success and failure for %s without unsafe remediation', provider => {
    const clients = systemdClientFixture(); roots.push(clients.root); vi.stubEnv('PATH', clients.root);
    let status = 0;
    const spawn = vi.fn((_binary: string, args: string[]) => args.includes('show-environment')
      ? { status: 0, stdout: '' } : { status, stderr: 'bwrap: namespace creation denied' });
    const options = { adapter: { provider }, probeHooks, spawn };
    expect(workerIsolation.probeWorkerNativeSandbox(options)).toMatchObject({ ok: true, mechanism: 'bwrap' });
    status = 1;
    const result = workerIsolation.probeWorkerNativeSandbox(options);
    expect(result).toMatchObject({ ok: false, mechanism: 'bwrap', code: 'OG_NATIVE_SANDBOX_UNAVAILABLE' });
    const message = workerIsolation.nativeSandboxProbeMessage(result);
    expect(message).toContain('bwrap probe failed inside a systemd user unit');
    expect(message).not.toMatch(/AppArmor|native-sandbox|unshare/);
  });

  it('allows another CLI to supply its own mechanism and keeps cache entries distinct', () => {
    const clients = systemdClientFixture(); roots.push(clients.root); vi.stubEnv('PATH', clients.root);
    const spawn = vi.fn(() => ({ status: 0, stdout: '' }));
    const options = { spawn, cache: new Map(), probeHooks: { ...probeHooks,
      other: () => ({ mechanism: 'custom', command: '/synthetic/custom', args: ['--check'] }) } };
    expect(workerIsolation.probeWorkerNativeSandbox(options).mechanism).toBe('bwrap');
    expect(workerIsolation.probeWorkerNativeSandbox({ ...options, adapter: { provider: 'other' } }).mechanism).toBe('custom');
    expect(spawn.mock.calls).toHaveLength(4);
    expect((spawn.mock.calls[3] as any)[1]).toContain('/synthetic/custom');
  });

  it('uses a bounded transient unit with the worker environment wrapper and caches only in memory', () => {
    const clients = systemdClientFixture(); roots.push(clients.root);
    vi.stubEnv('PATH', clients.root);
    const spawn = vi.fn((_binary: string, argv: string[]) => ({ status: 0,
      stdout: argv.includes('show-environment') ? 'LANG=C\n' : '', stderr: '' }));
    const cache = new Map();
    const options = { spawn, cache, probeHooks, cwd: '/synthetic/work', env: ENV, envNames: ['PATH', 'HOME'] };
    expect(workerIsolation.probeWorkerNativeSandbox(options)).toMatchObject({ ok: true, mode: 'systemd-unit' });
    expect(workerIsolation.probeWorkerNativeSandbox(options)).toMatchObject({ ok: true });
    expect(spawn).toHaveBeenCalledTimes(2);
    const [binary, argv, settings] = spawn.mock.calls[1] as any;
    expect(binary).toBe(clients.binary);
    for (const token of ['--user', '--collect', '--wait', '--pipe', '--quiet', '--worker-environment',
      '/usr/bin/bwrap', '--ro-bind', '/', '--unshare-user', '--unshare-net', '--', '/usr/bin/true', 'RuntimeMaxSec=5s', 'TimeoutStopSec=1s']) expect(argv).toContain(token);
    expect(argv).toContain('UnsetEnvironment=LANG XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS SYSTEMD_BUS_ADDRESS');
    expect(settings).toMatchObject({ timeout: 8000, maxBuffer: 4096 });
    expect(argv.join(' ')).not.toContain(ENV.HOME);
  });

  it.each(['uid_map: Operation not permitted', 'loopback: Failed RTM_NEWADDR: Operation not permitted'])
    ('reports bounded namespace probe failure: %s', detail => {
      const clients = systemdClientFixture(); roots.push(clients.root); vi.stubEnv('PATH', clients.root);
      const spawn = vi.fn((_binary: string, argv: string[]) => argv.includes('show-environment')
        ? { status: 0, stdout: '' } : { status: 1, stderr: `${detail}\n${'x'.repeat(2000)}` });
      const result = workerIsolation.probeWorkerNativeSandbox({ spawn, probeHooks, env: {}, envNames: [] });
      expect(result).toMatchObject({ ok: false, code: 'OG_NATIVE_SANDBOX_UNAVAILABLE' });
      expect(result.detail.length).toBeLessThanOrEqual(512);
      expect(result.detail).not.toContain('\n');
      expect(workerIsolation.nativeSandboxFailure(result.detail)).toBe(true);
    });

  it('fails closed on probe timeout', () => {
    const clients = systemdClientFixture(); roots.push(clients.root); vi.stubEnv('PATH', clients.root);
    const result = workerIsolation.probeWorkerNativeSandbox({ probeHooks, env: {}, envNames: [],
      spawn: (_binary: string, argv: string[]) => argv.includes('show-environment') ? { status: 0, stdout: '' }
        : { status: null, error: new Error('spawnSync ETIMEDOUT') } });
    expect(result).toMatchObject({ ok: false, code: 'OG_NATIVE_SANDBOX_UNAVAILABLE', detail: 'spawnSync ETIMEDOUT' });
  });

  it('requires a probe for enforcing Codex and Muse sandboxes on Linux', () => {
    for (const provider of ['codex', 'muse']) expect(workerIsolation.workerNeedsNativeNamespaces({ provider }, { sandbox: 'workspace-write' }, 'linux')).toBe(true);
    expect(workerIsolation.workerNeedsNativeNamespaces({ provider: 'codex' }, { sandbox: 'read-only' }, 'linux')).toBe(true);
    for (const sandbox of ['external', 'none', 'danger-full-access']) {
      expect(workerIsolation.workerNeedsNativeNamespaces({ provider: 'codex' }, { sandbox }, 'linux')).toBe(false);
    }
    expect(workerIsolation.workerNeedsNativeNamespaces({ provider: 'other' }, {}, 'linux')).toBe(false);
    expect(workerIsolation.workerNeedsNativeNamespaces({ provider: 'codex' }, {}, 'darwin')).toBe(false);
  });
});
