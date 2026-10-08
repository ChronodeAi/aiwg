import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as workerIsolation from '../../../tools/ralph-external/lib/worker-isolation.mjs';
import {
  buildWorkerIsolationArgs,
  detectWorkerIsolation,
  launchIsolatedWorker,
  proposeWorkerUnitName,
} from '../../../tools/ralph-external/lib/worker-isolation.mjs';

const ENV = { PATH: '/usr/bin:/bin', HOME: '/home/conductor' };

describe('worker isolation argument construction (FR-OG-108)', () => {
  it('builds a unit launch with memory ceiling, no swap, and env passthrough', () => {
    expect(buildWorkerIsolationArgs({
      unit: 'aiwg-worker-demo-123',
      memoryMaxGb: 4,
      command: '/usr/bin/codex',
      args: ['exec', '--sandbox', 'workspace-write'],
      cwd: '/tmp/work',
      logFile: '/tmp/work/worker.log',
      env: ENV,
    })).toEqual([
      'systemd-run', '--user', '--expand-environment=no',
      '--unit=aiwg-worker-demo-123',
      '--setenv=PATH=/usr/bin:/bin',
      '--setenv=HOME=/home/conductor',
      '-p', 'StandardInput=null',
      '-p', 'MemoryMax=4G',
      '-p', 'MemorySwapMax=0',
      '-p', 'StandardOutput=file:/tmp/work/worker.log',
      '-p', 'StandardError=file:/tmp/work/worker.log',
      '--working-directory=/tmp/work',
      '--', '/usr/bin/codex', 'exec', '--sandbox', 'workspace-write',
    ]);
  });

  it('builds a scope launch without unit/collect/output bindings', () => {
    expect(buildWorkerIsolationArgs({
      unit: 'aiwg-worker-demo-123',
      memoryMaxGb: 2,
      command: '/bin/true',
      env: {},
      kind: 'scope',
    })).toEqual([
      'systemd-run', '--user', '--expand-environment=no', '--scope',
      '-p', 'StandardInput=null',
      '-p', 'MemoryMax=2G',
      '-p', 'MemorySwapMax=0',
      '--', '/bin/true',
    ]);
  });

  it('rejects unsafe unit names, ceilings, and paths', () => {
    const base = { unit: 'aiwg-worker-ok-1', memoryMaxGb: 1, command: '/bin/true', env: {} };
    expect(() => buildWorkerIsolationArgs({ ...base, unit: 'bad; rm -rf' })).toThrow(/unit-safe/);
    expect(() => buildWorkerIsolationArgs({ ...base, memoryMaxGb: 0 })).toThrow(/positive/);
    expect(() => buildWorkerIsolationArgs({ ...base, command: 'relative/true' })).toThrow(/absolute/);
    expect(() => buildWorkerIsolationArgs({ ...base, args: ['ok', 'bad\0x'] })).toThrow(/NUL-free/);
    expect(() => buildWorkerIsolationArgs({ ...base, kind: 'cgroup' })).toThrow(/kind/);
  });

  it('derives unit-safe names', () => {
    expect(proposeWorkerUnitName('review #1/x', 42)).toBe('aiwg-worker-review--1-x-42');
    expect(proposeWorkerUnitName(';;;', 7)).toBe('aiwg-worker-worker-7');
  });
});

describe('worker isolation detection', () => {
  const okSpawn = (binary: string) => {
    if (binary === 'systemd-run') return { status: 0, stdout: 'systemd 255\n', error: null };
    return { status: 0, stdout: '255\n', error: null };
  };

  it('reports systemd-unit when the user manager is reachable', () => {
    expect(detectWorkerIsolation({ spawn: okSpawn }).mode).toBe('systemd-unit');
  });

  it('reports degraded without a systemd-run binary', () => {
    const missing = detectWorkerIsolation({ spawn: () => { throw new Error('spawn ENOENT'); } });
    expect(missing.mode).toBe('degraded');
    expect(missing.reason).toContain('systemd-run is unavailable');
  });

  it('reports degraded when the user manager is unreachable', () => {
    const noManager = detectWorkerIsolation({
      spawn: (binary: string) => (binary === 'systemd-run'
        ? { status: 0, stdout: 'systemd 255\n', error: null }
        : { status: 1, stdout: '', error: null }),
    });
    expect(noManager.mode).toBe('degraded');
    expect(noManager.reason).toContain('user manager is unreachable');
  });

  it('reports degraded off Linux', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      const result = detectWorkerIsolation({ spawn: okSpawn });
      expect(result.mode).toBe('degraded');
      expect(result.reason).toContain('darwin');
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });
});

describe('launchIsolatedWorker gate-then-launch', () => {
  const passingGate = { enabled: true, ok: true, failures: [] };

  it('never spawns when the resource gate blocks', () => {
    let calls = 0;
    const outcome = launchIsolatedWorker({
      name: 'blocked', memoryMaxGb: 1, command: '/bin/true',
      gate: { enabled: true, ok: false, failures: [{ signal: 'mem-psi-avg60', reason: 'hot' }] },
      spawn: (() => { calls += 1; throw new Error('must not spawn'); }) as never,
    });
    expect(outcome).toMatchObject({ launched: false, blocked: true });
    expect(calls).toBe(0);
  });

  it('refuses silent unconfined launch and requires explicit degraded opt-in', () => {
    const degraded = { mode: 'degraded', reason: 'no user manager here' } as const;
    const refused = launchIsolatedWorker({
      name: 'x', memoryMaxGb: 1, command: '/bin/true', gate: passingGate, isolation: degraded,
    });
    expect(refused).toMatchObject({ launched: false, mode: 'degraded' });
    expect(refused.diagnostic).toContain('allowDegraded');

    const calls: string[][] = [];
    const allowed = launchIsolatedWorker({
      name: 'x', memoryMaxGb: 1, command: '/bin/true', args: ['--help'],
      gate: passingGate, isolation: degraded, allowDegraded: true,
      spawnAsync: ((binary: string, argv: string[]) => {
        calls.push([binary, ...argv]);
        return { pid: 4242, once: () => {} };
      }) as never,
    });
    expect(allowed).toMatchObject({ launched: true, mode: 'degraded' });
    expect(allowed.diagnostic).toContain('without resource confinement');
    expect(calls).toEqual([['/bin/true', '--help']]);
  });

  it('launches through systemd-run and reads back the MainPID', () => {
    const calls: string[][] = [];
    const outcome = launchIsolatedWorker({
      name: 'demo', memoryMaxGb: 4, command: '/usr/bin/codex', args: ['exec'],
      cwd: '/tmp/work', logFile: '/tmp/work/worker.log',
      gate: passingGate,
      isolation: { mode: 'systemd-unit', reason: 'fake' },
      proposeUnit: () => 'aiwg-worker-demo-9',
      spawn: ((binary: string, argv: string[]) => {
        calls.push([binary, ...argv]);
        if (binary === 'systemctl') return { status: 0, stdout: '4242\n', stderr: '', error: null };
        return { status: 0, stdout: '', stderr: '', error: null };
      }) as never,
    });
    expect(outcome).toMatchObject({ launched: true, mode: 'systemd-unit', unit: 'aiwg-worker-demo-9', pid: 4242 });
    expect(calls[0].slice(0, 4)).toEqual(['systemd-run', '--user', '--expand-environment=no', '--unit=aiwg-worker-demo-9']);
    expect(calls[0]).toContain('MemoryMax=4G');
    expect(calls[0]).toContain('MemorySwapMax=0');
  });

  it('reports systemd-run failures without claiming a launch', () => {
    const outcome = launchIsolatedWorker({
      name: 'demo', memoryMaxGb: 4, command: '/usr/bin/codex',
      gate: passingGate,
      isolation: { mode: 'systemd-unit', reason: 'fake' },
      spawn: (() => ({ status: 1, stdout: '', stderr: 'Failed to connect', error: null })) as never,
    });
    expect(outcome).toMatchObject({ launched: false, mode: 'systemd-unit' });
    expect(outcome.diagnostic).toContain('systemd-run launch failed');
  });
});


it('preserves literal environment references in prepared argv', () => {
  const args = ['$HOME', '${HOME}', '/home/roctinam', 'literal $PATH'];
  const argv = buildWorkerIsolationArgs({ unit: 'aiwg-worker-literal', memoryMaxGb: 1, command: '/bin/echo', args, env: ENV });
  expect(argv).toContain('--expand-environment=no');
  expect(argv.slice(-args.length)).toEqual(args);
  expect(argv).not.toContain('--collect');
});

it('returns an async child handle without any worker deadline in degraded mode', () => {
  const child = { pid: 1234, once: () => {} };
  let options: any;
  const outcome = launchIsolatedWorker({
    command: '/bin/true', gate: { enabled: true, ok: true }, allowDegraded: true,
    isolation: { mode: 'degraded', reason: 'fake' },
    spawn: (() => { throw new Error('blocking spawn forbidden'); }) as never,
    spawnAsync: ((_binary: string, _args: string[], opts: any) => { options = opts; return child; }) as never,
  });
  expect(outcome).toMatchObject({ launched: true, pid: 1234, child });
  expect(options.timeout).toBeUndefined();
  expect(options.stdio[0]).toBe('ignore');
});

it('refuses missing gates and disabled gates when dispatch is on', () => {
  for (const gate of [undefined, 'disabled', {}, { ok: true }, { config: {} }, { enabled: false, ok: true }]) {
    const result = launchIsolatedWorker({ command: '/bin/true', gate, config: { parallelism: { worker_dispatch: true } },
      spawn: (() => { throw new Error('must not launch'); }) as never });
    expect(result).toMatchObject({ launched: false, blocked: true });
  }
  expect(launchIsolatedWorker({ command: '/bin/true', gate: 'disabled', config: { parallelism: { worker_dispatch: false } },
    isolation: { mode: 'degraded', reason: 'fake' }, allowDegraded: true,
    spawnAsync: (() => ({ pid: 5, once: () => {} })) as never })).toMatchObject({ launched: true, gate: { enabled: false } });
});

it('reports retained systemd OOM result, status and ceiling', () => {
  const status = workerIsolation.getWorkerIsolationStatus('aiwg-worker-test', { spawn: (() => ({
    status: 0, stdout: 'ActiveState=failed\nResult=oom-kill\nExecMainStatus=9\nMemoryMax=67108864\n',
  })) as never });
  expect(status).toEqual({ active: false, result: 'oom-kill', execMainStatus: 9, memoryMax: 67108864 });
});

it('documents serialized heavy verification and checkpointing before heavy steps (NFR-OG-023)', () => {
  const doc = readFileSync(new URL('../../../docs/providers/worker-invocation-packaging.md', import.meta.url), 'utf8');
  expect(doc).toMatch(/serializ[^.]*per host/i);
  expect(doc).toMatch(/checkpoint[^.]*before[^.]*heavy/i);
  expect(doc).toContain('reset-failed');
  expect(doc).toContain('#2888');
});

// This is an actual OOM containment probe; absence of a user manager is a skip.
describe('worker isolation live systemd-run', () => {
  it('kills an over-ceiling allocator while the parent survives', async ctx => {
    if (detectWorkerIsolation().mode !== 'systemd-unit') { ctx.skip(); return; }
    const { spawnSync } = await import('node:child_process');
    const unit = `aiwg-worker-oom-probe-${process.pid}-${Date.now()}`;
    const parentPid = process.pid;
    try {
      const outcome = launchIsolatedWorker({
        memoryMaxGb: 64 / 1024, command: process.execPath,
        args: ['-e', 'const held=Array.from({length:25},()=>Buffer.alloc(8*1024*1024,1)); setInterval(()=>{ if (!held.length) process.exit(1); },1000);'],
        cwd: '/tmp', gate: { enabled: true, ok: true, failures: [] },
        isolation: { mode: 'systemd-unit', reason: 'live probe' }, proposeUnit: () => unit,
      });
      expect(outcome.launched).toBe(true);
      let status;
      const deadline = Date.now() + 20000;
      do {
        status = workerIsolation.getWorkerIsolationStatus(unit);
        if (!status.active && (status.result === 'oom-kill' || status.execMainStatus === 9)) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      expect(status.active).toBe(false);
      expect(status.result === 'oom-kill' || status.execMainStatus === 9).toBe(true);
      expect(status.memoryMax).toBeCloseTo(64 * 1024 * 1024, -3);
      expect(process.pid).toBe(parentPid);
      expect(() => process.kill(parentPid, 0)).not.toThrow();
    } finally {
      spawnSync('systemctl', ['--user', 'stop', unit], { timeout: 10000 });
      spawnSync('systemctl', ['--user', 'reset-failed', unit], { timeout: 10000 });
    }
  }, 30000);
});


it('fails status queries explicitly instead of manufacturing a successful outcome', () => {
  expect(() => workerIsolation.getWorkerIsolationStatus('aiwg-worker-test', { spawn: (() => ({ status: 1, stderr: 'manager unavailable' })) as never })).toThrow(/unavailable/);
  expect(() => workerIsolation.getWorkerIsolationStatus('aiwg-worker-test', { spawn: (() => ({ status: 0, stdout: '' })) as never })).toThrow(/missing systemd properties/);
});
