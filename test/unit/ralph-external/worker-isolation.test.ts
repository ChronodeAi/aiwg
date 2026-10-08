import { describe, expect, it, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, readlinkSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as workerIsolation from '../../../tools/ralph-external/lib/worker-isolation.mjs';
import {
  buildWorkerIsolationArgs,
  detectWorkerIsolation,
  launchIsolatedWorker,
  proposeWorkerUnitName,
} from '../../../tools/ralph-external/lib/worker-isolation.mjs';

const ENV = { PATH: '/usr/bin:/bin', HOME: '/home/conductor' };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function tmpWorktree() {
  const root = mkdtempSync(path.join(tmpdir(), 'aiwg-worker-isolation-'));
  roots.push(root);
  return root;
}

describe('worker isolation argument construction (FR-OG-108)', () => {
  it('builds a unit launch with memory ceiling, no swap, env *names* (never values) in argv, and truncating output', () => {
    const argv = buildWorkerIsolationArgs({
      unit: 'aiwg-worker-demo-123',
      memoryMaxGb: 4,
      command: '/usr/bin/codex',
      args: ['exec', '--sandbox', 'workspace-write'],
      cwd: '/tmp/work',
      logFile: '/tmp/work/worker.log',
      env: ENV,
    });
    expect(argv).toEqual([
      'systemd-run', '--user', '--expand-environment=no',
      '--unit=aiwg-worker-demo-123',
      '--setenv=PATH',
      '--setenv=HOME',
      '-p', 'StandardInput=null',
      '-p', 'MemoryMax=4G',
      '-p', 'MemorySwapMax=0',
      '-p', 'StandardOutput=truncate:/tmp/work/worker.log',
      '-p', 'StandardError=truncate:/tmp/work/worker.log',
      '--working-directory=/tmp/work',
      '--', '/usr/bin/codex', 'exec', '--sandbox', 'workspace-write',
    ]);
    // No token carries an environment *value* — `--setenv=NAME` (bare) is
    // the only form emitted; the actual PATH/HOME values are imported by
    // systemd-run from its own invoking process environment, never written
    // into this argv (the fix for the /proc/*/cmdline secret leak).
    for (const token of argv) {
      expect(token).not.toContain(ENV.PATH);
      expect(token).not.toContain(ENV.HOME);
      expect(token).not.toMatch(/^--setenv=.+=/);
    }
  });

  it('unsets every manager-injected environment name that is not on the allowlist, for unit launches only', () => {
    const managerEnvNames = ['PATH', 'HOME', 'LANG', 'XDG_RUNTIME_DIR', 'SSH_AUTH_SOCK'];
    const unitArgv = buildWorkerIsolationArgs({
      unit: 'aiwg-worker-demo-9', memoryMaxGb: 1, command: '/bin/true', env: ENV, managerEnvNames,
    });
    // XDG_RUNTIME_DIR is deliberately NOT unset even though it is neither
    // allowlisted nor a secret: unsetting it was verified (live systemd-run
    // --user) to make the launched unit's own /proc/<pid>/environ EACCES
    // even to the same-UID conductor that started it.
    expect(unitArgv).toContain('UnsetEnvironment=LANG SSH_AUTH_SOCK');
    expect(unitArgv.join(' ')).not.toMatch(/UnsetEnvironment=[^-]*XDG_RUNTIME_DIR/);
    // The same manager-env snapshot against a scope launch has no unset
    // property at all: `--scope` ignores UnsetEnvironment (verified against
    // a live systemd-run --user --scope), so emitting it there would be a
    // no-op guarantee masquerading as a real one.
    const scopeArgv = buildWorkerIsolationArgs({
      unit: 'aiwg-worker-demo-9', memoryMaxGb: 1, command: '/bin/true', env: ENV, managerEnvNames, kind: 'scope',
    });
    expect(scopeArgv.some(token => token.startsWith('UnsetEnvironment='))).toBe(false);
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

  it('attaches separate pipes and passes only environment names in systemd argv', () => {
    let binary: string | undefined;
    let argv: string[] = [];
    let options: any;
    const child = { pid: 4242, once: () => {} };
    const outcome = launchIsolatedWorker({ command: '/qualified/worker', args: ['literal $HOME'], memoryMaxGb: 2,
      gate: passingGate, attached: true, ownedGroup: true, stdin: 'brief-text',
      isolation: { mode: 'systemd-unit', reason: 'synthetic' },
      env: { SYNTHETIC_SECRET: 'never-in-argv' }, envNames: ['SYNTHETIC_SECRET'],
      spawnAsync: ((command: string, args: string[], opts: any) => { binary = command; argv = args; options = opts; return child; }) as never,
    });
    expect(outcome).toMatchObject({ mode: 'systemd-unit', child, launched: true });
    expect(binary).toBe('systemd-run');
    expect(argv).toContain('--wait');
    expect(argv).toContain('--pipe');
    expect(argv).toContain('KillMode=control-group');
    expect(argv).toContain('ExitType=cgroup');
    expect(argv.some(token => token.startsWith('UnsetEnvironment=') && token.includes('NODE_OPTIONS') && token.includes('LD_PRELOAD'))).toBe(true);
    expect(argv).toContain('--setenv=SYNTHETIC_SECRET');
    expect(argv.join(' ')).not.toContain('never-in-argv');
    expect(argv).toContain('--worker-environment');
    expect(argv.slice(-2)).toEqual(['/qualified/worker', 'literal $HOME']);
    expect(options.env.SYNTHETIC_SECRET).toBe('never-in-argv');
    expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(options.detached).toBe(true);
  });

  it.each(['NODE_OPTIONS', 'LD_PRELOAD'])('refuses %s before trusted transport bootstrap', name => {
    const spawnAsync = vi.fn();
    for (const mode of ['systemd-unit', 'degraded']) {
      expect(() => launchIsolatedWorker({ command: '/qualified/worker', memoryMaxGb: 2, gate: passingGate,
        attached: true, runDir: '/private/run', allowDegraded: true,
        isolation: { mode, reason: 'synthetic' }, env: { [name]: 'synthetic-unsafe-bootstrap' }, envNames: [name],
        spawnAsync })).toThrow(/transport bootstrap/);
    }
    expect(spawnAsync).not.toHaveBeenCalled();
  });

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
        if (binary === 'systemctl' && argv.includes('show-environment')) return { status: 0, stdout: 'PATH=/x\nLANG=en_US.UTF-8\n', stderr: '', error: null };
        if (binary === 'systemctl') return { status: 0, stdout: '4242\n', stderr: '', error: null };
        return { status: 0, stdout: '', stderr: '', error: null };
      }) as never,
    });
    expect(outcome).toMatchObject({ launched: true, mode: 'systemd-unit', unit: 'aiwg-worker-demo-9', pid: 4242 });
    const launchCall = calls.find(call => call[0] === 'systemd-run')!;
    expect(launchCall.slice(0, 4)).toEqual(['systemd-run', '--user', '--expand-environment=no', '--unit=aiwg-worker-demo-9']);
    expect(launchCall).toContain('MemoryMax=4G');
    expect(launchCall).toContain('MemorySwapMax=0');
    // LANG was reported by the simulated manager environment and is not
    // allowlisted: it must be explicitly unset, not silently inherited.
    expect(launchCall.join(' ')).toContain('UnsetEnvironment=LANG');
  });

  it('refuses to launch when the manager environment cannot be determined, rather than guessing at isolation', () => {
    const outcome = launchIsolatedWorker({
      name: 'demo', memoryMaxGb: 4, command: '/usr/bin/codex',
      gate: passingGate,
      isolation: { mode: 'systemd-unit', reason: 'fake' },
      spawn: (() => ({ status: 1, stdout: '', stderr: 'manager unreachable', error: null })) as never,
    });
    expect(outcome).toMatchObject({ launched: false, mode: 'systemd-unit' });
    expect(outcome.diagnostic).toContain("unable to determine the user manager's inherited environment");
  });

  it('reports systemd-run failures without claiming a launch', () => {
    const outcome = launchIsolatedWorker({
      name: 'demo', memoryMaxGb: 4, command: '/usr/bin/codex',
      gate: passingGate,
      isolation: { mode: 'systemd-unit', reason: 'fake' },
      spawn: ((binary: string, argv: string[]) => {
        if (binary === 'systemctl' && argv.includes('show-environment')) return { status: 0, stdout: '', stderr: '', error: null };
        return { status: 1, stdout: '', stderr: 'Failed to connect', error: null };
      }) as never,
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

describe('degraded-mode output/fd hygiene (#2888 fix round 2)', () => {
  it('truncates a pre-existing output file instead of appending to it', async () => {
    const root = tmpWorktree();
    const stdoutPath = path.join(root, 'worker.stdout');
    writeFileSync(stdoutPath, 'STALE CONTENT FROM A PRIOR LAUNCH THAT MUST NOT SURVIVE\n');
    const outcome = launchIsolatedWorker({
      command: process.execPath, args: ['-e', 'process.stdout.write("fresh\\n")'],
      gate: { enabled: true, ok: true, failures: [] },
      isolation: { mode: 'degraded', reason: 'truncation test' }, allowDegraded: true,
      stdoutPath,
    }) as { launched: boolean; child: { once: (event: string, cb: () => void) => void } };
    expect(outcome.launched).toBe(true);
    await new Promise<void>(resolve => outcome.child.once('exit', resolve));
    const content = readFileSync(stdoutPath, 'utf8');
    expect(content).toBe('fresh\n');
    expect(content).not.toContain('STALE CONTENT');
  });

  it('does not leak file descriptors across repeated degraded launches', async () => {
    if (process.platform !== 'linux') return;
    const root = tmpWorktree();
    // Count only descriptors pointing at this test's own output files, so
    // concurrent suites sharing the process cannot perturb the measurement.
    const countFds = () => readdirSync('/proc/self/fd').filter(fd => {
      try { return readlinkSync(`/proc/self/fd/${fd}`).startsWith(root); } catch { return false; }
    }).length;
    const launchOnce = async (label: string) => {
      const stdoutPath = path.join(root, `out-${label}.log`);
      const stderrPath = path.join(root, `err-${label}.log`);
      const outcome = launchIsolatedWorker({
        command: process.execPath, args: ['-e', 'process.exit(0)'],
        gate: { enabled: true, ok: true, failures: [] },
        isolation: { mode: 'degraded', reason: 'fd-leak test' }, allowDegraded: true,
        stdoutPath, stderrPath,
      }) as { launched: boolean; child: { once: (event: string, cb: () => void) => void } };
      expect(outcome.launched).toBe(true);
      await new Promise<void>(resolve => outcome.child.once('exit', resolve));
    };
    // Warm up: let any one-time lazy fd allocation (libuv thread pool, etc.,
    // which the rest of the shared vitest process may also be doing) settle
    // before measuring, so the assertion below isolates THIS function's
    // behavior rather than ambient process activity.
    for (let i = 0; i < 3; i++) await launchOnce(`warmup-${i}`);
    const before = countFds();
    const iterations = 20;
    for (let i = 0; i < iterations; i++) await launchOnce(`measured-${i}`);
    const after = countFds();
    // Before the fix: 2 fds (stdout+stderr) per launch stayed open on these
    // output files, so 20 launches would leave ~40 open. After the fix the
    // parent's copies are closed immediately post-spawn.
    expect(after - before).toBe(0);
  });
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

  // Proves the item-1 fix (secret-in-argv + non-exact unit environment)
  // against a real systemd-run --user launch, not a mock.
  it('isolates the unit environment to exactly the allowlisted names, with no secret in /proc/<pid>/environ or in any observed systemd-run argv', async ctx => {
    if (detectWorkerIsolation().mode !== 'systemd-unit') { ctx.skip(); return; }
    const { spawnSync } = await import('node:child_process');
    const unit = `aiwg-worker-env-probe-${process.pid}-${Date.now()}`;
    const secret = `synthetic-env-probe-secret-${process.pid}-${Date.now()}`;
    process.env.AIWG_ENV_PROBE_SECRET = secret;
    const observedArgv: string[][] = [];
    try {
      const outcome = launchIsolatedWorker({
        memoryMaxGb: 64 / 1024, command: '/bin/sleep', args: ['5'],
        envNames: ['PATH', 'HOME'],
        cwd: '/tmp', gate: { enabled: true, ok: true, failures: [] },
        isolation: { mode: 'systemd-unit', reason: 'live probe' }, proposeUnit: () => unit,
        spawn: ((binary: string, argv: string[], opts?: any) => {
          const result = spawnSync(binary, argv, { encoding: 'utf8', ...opts, timeout: opts?.timeout ?? 10000 });
          if (binary === 'systemd-run') observedArgv.push([binary, ...argv]);
          return result;
        }) as never,
      }) as { launched: boolean; mode: string; unit: string; pid?: number };
      expect(outcome).toMatchObject({ launched: true, mode: 'systemd-unit', unit });
      expect(Number.isInteger(outcome.pid) && outcome.pid! > 0).toBe(true);
      // The exact systemd-run argv the conductor issued, captured here rather
      // than merely asserted via buildWorkerIsolationArgs in isolation, is
      // the "visible in /proc/*/cmdline" surface the finding described.
      expect(observedArgv.length).toBe(1);
      for (const token of observedArgv[0]) {
        expect(token).not.toContain(secret);
        expect(token).not.toMatch(/^--setenv=.+=/);
      }
      // This host's /proc/<pid>/environ access for a same-UID systemd --user
      // unit was observed to be transiently EACCES for up to ~1s after the
      // unit starts (kernel.yama.ptrace_scope=1; the unit's cgroup/session
      // registration with logind appears to still be settling), then
      // succeed — not related to this fix's allowlist/UnsetEnvironment
      // logic (reproduced identically with no UnsetEnvironment at all).
      // Poll rather than asserting on the first read.
      let environRaw: string | undefined;
      const readDeadline = Date.now() + 3000;
      while (environRaw === undefined && Date.now() < readDeadline) {
        try { environRaw = readFileSync(`/proc/${outcome.pid}/environ`).toString('latin1'); }
        catch { await new Promise(resolve => setTimeout(resolve, 100)); }
      }
      expect(environRaw).toBeDefined();
      const names = environRaw!.split('\0').filter(Boolean).map(entry => entry.slice(0, entry.indexOf('=')));
      // XDG_RUNTIME_DIR is the one deliberate exception (see
      // buildWorkerIsolationArgs' doc comment): everything else here is
      // either allowlisted or a name systemd itself always injects.
      const systemdInjected = ['XDG_RUNTIME_DIR', 'MANAGERPID', 'MANAGERPIDFDID', 'INVOCATION_ID', 'SYSTEMD_EXEC_PID', 'MEMORY_PRESSURE_WATCH', 'MEMORY_PRESSURE_WRITE', 'JOURNAL_STREAM'];
      for (const name of names) expect(['PATH', 'HOME', ...systemdInjected]).toContain(name);
      expect(environRaw!).not.toContain(secret);
      expect(environRaw!).not.toContain('AIWG_ENV_PROBE_SECRET');
    } finally {
      delete process.env.AIWG_ENV_PROBE_SECRET;
      spawnSync('systemctl', ['--user', 'stop', unit], { timeout: 10000 });
      spawnSync('systemctl', ['--user', 'reset-failed', unit], { timeout: 10000 });
    }
  }, 20000);
});


it('fails status queries explicitly instead of manufacturing a successful outcome', () => {
  expect(() => workerIsolation.getWorkerIsolationStatus('aiwg-worker-test', { spawn: (() => ({ status: 1, stderr: 'manager unavailable' })) as never })).toThrow(/unavailable/);
  expect(() => workerIsolation.getWorkerIsolationStatus('aiwg-worker-test', { spawn: (() => ({ status: 0, stdout: '' })) as never })).toThrow(/missing systemd properties/);
});
