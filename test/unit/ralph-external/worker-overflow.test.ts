import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, constants, createReadStream, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChildProcessTransport, MAX_MCP_FRAME_BYTES } from '../../../src/mcp/tools/worker-invoke.mjs';
import { stopOverflowWorker } from '../../../tools/ralph-external/lib/worker-overflow.mjs';
import { sampleWorkerGroup, sampleWorkerIdentity } from '../../../tools/ralph-external/process-monitor.mjs';
import { signalOwnedWorker } from '../../../tools/ralph-external/session-launcher.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('MCP overflow stop authority', () => {
  const unit = { mode: 'systemd-unit', unit: 'aiwg-overflow-test.service' };
  // Stop-only cases: the unit SIGKILL is refused so these keep testing the stop path alone.
  const noKill = () => ({ ok: false });

  it('SIGKILLs the unit cgroup before stopping it, so a SIGTERM-ignoring worker cannot outlast the deadline (#3691)', async () => {
    const calls: string[] = [];
    const killUnit = vi.fn(() => { calls.push('kill'); return { ok: true }; });
    // A plain stop times out while the worker ignores SIGTERM.
    const stopUnit = vi.fn(() => { calls.push('stop'); return { ok: false, diagnostic: 'spawnSync /usr/bin/systemctl ETIMEDOUT' }; });
    const unitStatus = vi.fn().mockReturnValueOnce({ active: true }).mockReturnValue({ active: false });
    const result = await stopOverflowWorker(unit, { stopUnit, killUnit, unitStatus });
    expect(calls).toEqual(['kill', 'stop']);
    expect(killUnit).toHaveBeenCalledWith(unit.unit, { timeoutMs: expect.any(Number) });
    expect(result).toEqual({ termination: 'confirmed', delivered: true });
  });

  it('reports a stop failure only when both the unit SIGKILL and the stop fail (#3691)', async () => {
    const result = await stopOverflowWorker(unit, { stopUnit: () => ({ ok: false }), killUnit: () => { throw new Error('bus down'); },
      unitStatus: () => ({ active: true }), deadlineMs: 0 });
    expect(result).toEqual({ termination: 'uncertain', delivered: false, diagnostic: 'OG_WORKER_MCP_STOP_FAILED' });
  });

  it.each([true, false])('requires inactive state after unit stop delivery (ok: %s)', async ok => {
    const stopUnit = vi.fn(() => ({ ok }));
    const unitStatus = vi.fn(() => ({ active: true }));
    const result = await stopOverflowWorker(unit, { stopUnit, killUnit: noKill, unitStatus, deadlineMs: 0 });
    expect(stopUnit).toHaveBeenCalledWith(unit.unit, { timeoutMs: 1 });
    expect(unitStatus).toHaveBeenCalledWith(unit.unit, { timeoutMs: 1 });
    expect(result).toEqual({ termination: 'uncertain', delivered: ok,
      diagnostic: ok ? 'OG_WORKER_MCP_STOP_UNCONFIRMED' : 'OG_WORKER_MCP_STOP_FAILED' });
  });

  it.each([true, false])('waits for inactive unit state and retains stop failures (ok: %s)', async ok => {
    const unitStatus = vi.fn().mockReturnValueOnce({ active: true }).mockReturnValue({ active: false });
    const result = await stopOverflowWorker(unit, { stopUnit: () => ({ ok }), killUnit: noKill, unitStatus });
    expect(result).toEqual({ termination: 'confirmed', delivered: ok, ...(ok ? {} : { diagnostic: 'OG_WORKER_MCP_STOP_FAILED' }) });
    expect(unitStatus).toHaveBeenCalledTimes(2);
  });

  it('cannot prove termination when unit state is unavailable', async () => {
    expect(await stopOverflowWorker(unit, { stopUnit: () => ({ ok: true }), killUnit: noKill,
      unitStatus: () => { throw new Error('manager unavailable'); }, deadlineMs: 0,
    })).toEqual({ termination: 'uncertain', delivered: true, diagnostic: 'OG_WORKER_MCP_STOP_UNCONFIRMED' });
  });

  it.each(['parent', 'birth', 'exited', 'ambiguous'])('refuses group signaling with invalid supervisor ownership (%s)', async failure => {
    const supervisor = { pid: 123, parentPid: process.pid, uid: process.getuid?.(), startTicks: '1' };
    const child = { pid: supervisor.pid, exitCode: failure === 'exited' ? 0 : null, signalCode: null };
    const sample = vi.fn().mockReturnValueOnce(failure === 'parent' ? { ...supervisor, parentPid: 1 } : supervisor)
      .mockReturnValue(failure === 'birth' ? { ...supervisor, startTicks: '2' } : supervisor);
    const worker = { pid: 456, parentPid: supervisor.pid };
    const signal = vi.fn();
    const result = await stopOverflowWorker({ mode: 'degraded', child, transportSupervisor: true }, {
      platform: 'linux', sample, children: () => failure === 'ambiguous' ? [worker, worker] : [worker], signal,
    });
    expect(result.termination).toBe('uncertain');
    expect(result.delivered).toBe(false);
    expect(signal).not.toHaveBeenCalled();
  });

  function supervisedFixture() {
    const supervisor = { pid: 123, parentPid: process.pid, uid: process.getuid?.(), startTicks: '1' };
    const worker = { pid: 456, parentPid: supervisor.pid, uid: process.getuid?.(), pgid: 456,
      sessionId: 456, startTicks: '2', bootId: 'boot', host: 'fixture', executable: '/fixture/node' };
    const child = { pid: supervisor.pid, exitCode: null as number | null, signalCode: null };
    return { supervisor, worker, child, launch: { mode: 'degraded', child, transportSupervisor: true } };
  }

  it('signals the same birth after reparenting, including a retry after supervisor teardown', async () => {
    const { supervisor, worker, child, launch } = supervisedFixture();
    let orphaned = false;
    const sample = vi.fn((pid: number) => pid === supervisor.pid
      ? child.exitCode === null ? supervisor : null : { ...worker, parentPid: orphaned ? 1 : supervisor.pid });
    const group = vi.fn();
    // Reparent after capture but before the launcher's fresh identity check.
    const signal = vi.fn((identity: any, sig: string) => {
      orphaned = true;
      return signalOwnedWorker(identity, sig, { sample, group, supervisor: { pid: process.pid, pgid: 999 } });
    });
    const killPid = vi.fn();
    const options = { platform: 'linux', sample, children: () => [worker], signal, killPid };
    const expected = { termination: 'uncertain', delivered: true, diagnostic: 'OG_WORKER_MCP_STOP_UNCONFIRMED' };
    expect(await stopOverflowWorker(launch, options)).toEqual(expected);
    expect(signal).toHaveBeenCalledWith(worker, 'SIGKILL');
    expect(group).not.toHaveBeenCalled(); // parent mismatch refuses before enumeration
    expect(killPid).toHaveBeenCalledWith(worker.pid, 'SIGKILL');
    child.exitCode = 1;
    expect(await stopOverflowWorker(launch, options)).toEqual(expected);
    expect(killPid).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['startTicks', '3'], ['bootId', 'other-boot'], ['uid', -1], ['sessionId', 999],
    ['pgid', 999], ['host', 'other-host'], ['executable', '/other/node'],
  ])('refuses a reused PID or changed identity (%s) with STOP_FAILED', async (key, value) => {
    const { supervisor, worker, launch } = supervisedFixture();
    let changed = false;
    const sample = (pid: number) => pid === supervisor.pid ? supervisor
      : { ...worker, parentPid: 1, ...(changed ? { [key]: value } : {}) };
    const signal = vi.fn(() => { changed = true; return false; });
    const killPid = vi.fn();
    expect(await stopOverflowWorker(launch, { platform: 'linux', sample, children: () => [worker], signal, killPid }))
      .toEqual({ termination: 'uncertain', delivered: false, diagnostic: 'OG_WORKER_MCP_STOP_FAILED' });
    expect(killPid).not.toHaveBeenCalled();
  });

  it.each(['startTicks', 'bootId', 'uid', 'sessionId'])('requires complete captured birth identity (%s)', async key => {
    const { supervisor, worker, launch } = supervisedFixture();
    const signal = vi.fn(); const killPid = vi.fn();
    expect(await stopOverflowWorker(launch, { platform: 'linux', sample: () => supervisor,
      children: () => [{ ...worker, [key]: undefined }], signal, killPid }))
      .toMatchObject({ termination: 'uncertain', delivered: false });
    expect(signal).not.toHaveBeenCalled(); expect(killPid).not.toHaveBeenCalled();
  });

  it.each([false, true])('retains the original birth after failed delivery and supervisor exit (PID reused: %s)', async reused => {
    const { supervisor, worker, child, launch } = supervisedFixture();
    const sample = (pid: number) => pid === supervisor.pid ? child.exitCode === null ? supervisor : null
      : { ...worker, ...(child.exitCode === null ? {} : { parentPid: 1, startTicks: reused ? '3' : worker.startTicks }) };
    const children = vi.fn(() => [worker]);
    const signal = vi.fn(() => false);
    const killPid = vi.fn().mockImplementationOnce(() => { throw new Error('signal unavailable'); }).mockReturnValue(undefined);
    const options = { platform: 'linux', sample, children, signal, killPid };
    expect(await stopOverflowWorker(launch, options))
      .toEqual({ termination: 'uncertain', delivered: false, diagnostic: 'OG_WORKER_MCP_STOP_FAILED' });
    child.exitCode = 1;
    expect(await stopOverflowWorker(launch, options)).toEqual({ termination: 'uncertain', delivered: !reused,
      diagnostic: reused ? 'OG_WORKER_MCP_STOP_FAILED' : 'OG_WORKER_MCP_STOP_UNCONFIRMED' });
    expect(children).toHaveBeenCalledTimes(1);
    expect(killPid).toHaveBeenCalledTimes(reused ? 1 : 2);
  });

  it.each(['darwin', 'win32'])('attempts direct-child kill on %s without claiming tree termination', async platform => {
    const child = { pid: 54321, kill: vi.fn(() => true) };
    const sample = vi.fn(); const signal = vi.fn();
    expect(await stopOverflowWorker({ mode: 'degraded', child }, { platform, sample, signal }))
      .toEqual({ termination: 'uncertain', delivered: true, diagnostic: 'OG_WORKER_MCP_STOP_UNCONFIRMED' });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(sample).not.toHaveBeenCalled(); expect(signal).not.toHaveBeenCalled();
  });

  it.each(['false', 'throw'])('reports failed direct-child kill (%s)', async failure => {
    const child = { pid: 54321, kill: () => { if (failure === 'throw') throw new Error('failed'); return false; } };
    expect(await stopOverflowWorker({ mode: 'degraded', child }, { platform: 'win32' }))
      .toEqual({ termination: 'uncertain', delivered: false, diagnostic: 'OG_WORKER_MCP_STOP_FAILED' });
  });

  it('checks unit state after the final sleep at the deadline', async () => {
    let time = 0;
    const unitStatus = vi.fn(() => ({ active: time < 10 }));
    const stopUnit = vi.fn(() => ({ ok: true }));
    expect(await stopOverflowWorker(unit, { stopUnit, killUnit: noKill, unitStatus, deadlineMs: 10,
      pollIntervalMs: 25, clock: () => time, sleep: async ms => { time += ms; },
    })).toEqual({ termination: 'confirmed', delivered: true });
    expect(unitStatus.mock.calls).toEqual([[unit.unit, { timeoutMs: 10 }], [unit.unit, { timeoutMs: 1 }]]);
    expect(stopUnit).toHaveBeenCalledWith(unit.unit, { timeoutMs: 10 });
  });

  it('retries a transient status error until the unit becomes inactive', async () => {
    let time = 0;
    const unitStatus = vi.fn().mockImplementationOnce(() => { throw new Error('temporary'); })
      .mockReturnValue({ active: false });
    expect(await stopOverflowWorker(unit, { stopUnit: () => ({ ok: true }), unitStatus,
      clock: () => time, sleep: async ms => { time += ms; },
    })).toEqual({ termination: 'confirmed', delivered: true });
    expect(unitStatus).toHaveBeenCalledTimes(2);
  });

  it.skipIf(process.platform !== 'linux').each([
    { escaped: false, contention: false },
    { escaped: true, contention: false },
    { escaped: false, contention: true },
  ])('overflow stays unconfirmed after group kill (escaped descendant: $escaped, CPU contention: $contention)', async ({ escaped, contention }) => {
    const root = mkdtempSync(path.join(tmpdir(), 'aiwg-worker-overflow-')); roots.push(root);
    const script = path.join(root, 'worker.mjs');
    const pidFile = path.join(root, 'worker.pid');
    const descendantFile = path.join(root, 'descendant.pid');
    const fifo = path.join(root, 'stdout.fifo');
    expect(spawnSync('mkfifo', [fifo], { stdio: 'ignore', timeout: 10000 }).status).toBe(0);
    // The descendant inherits a FIFO writer even when native pipes are prohibited.
    const writer = openSync(fifo, constants.O_RDWR);
    const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
    writeFileSync(script, `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
const output = () => {
  // Keep a CPU-bound worker busy beyond the former five-second read deadline.
  const deadline = Date.now() + ${contention ? 6000 : 0};
  while (Date.now() < deadline) Math.sqrt(Math.random());
  process.stdout.write(Buffer.alloc(12 * 1024 * 1024, 120));
};
${contention ? "process.once('SIGUSR2', output);" : ''}
writeFileSync(process.argv[2], String(process.pid));
spawn(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);', process.argv[3]], { stdio: 'inherit', detached: ${escaped} });
${contention ? '' : 'output();'}
setInterval(() => {}, 1000);
`);
    const child = spawn(process.execPath, [path.resolve('tools/ralph-external/lib/worker-isolation.mjs'),
      '--worker-environment', '[]', '--', process.execPath, script, pidFile, descendantFile],
    { stdio: ['ignore', writer, writer] });
    closeSync(writer);
    const closed = new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject); });
    let workerPid = 0;
    let descendantPid = 0;
    let stdout: ReturnType<typeof createReadStream> | undefined;
    try {
      const deadline = Date.now() + 5000;
      while (!descendantPid && Date.now() < deadline) {
        try { workerPid = Number(readFileSync(pidFile, 'utf8')); descendantPid = Number(readFileSync(descendantFile, 'utf8')); } catch { /* startup */ }
        if (!descendantPid) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(workerPid).toBeGreaterThan(0); expect(descendantPid).toBeGreaterThan(0);
      const groupPids = sampleWorkerGroup(workerPid)?.map((member: any) => member.pid);
      if (escaped) expect(groupPids).not.toContain(descendantPid);
      else expect(groupPids).toContain(descendantPid);
      // Let stream readiness drive reads; one FIFO chunk per timer tick can
      // exhaust a wall-clock deadline before the frame reaches the transport.
      stdout = createReadStream(fifo);
      const transport = new ChildProcessTransport({ stdout, once: child.once.bind(child) }, {
        terminate: () => stopOverflowWorker({ mode: 'degraded', child, transportSupervisor: true }),
      });
      const overflow = new Promise<Error>(resolve => { transport.onerror = resolve; });
      await transport.start();
      if (contention) process.kill(workerPid, 'SIGUSR2');
      const failure = await overflow;
      expect(failure).toMatchObject({ code: 'OG_WORKER_MCP_FRAME_TOO_LARGE' });
      expect(transport._failure).toBe(failure);
      expect(await transport._termination).toEqual({ termination: 'uncertain', delivered: true, diagnostic: 'OG_WORKER_MCP_STOP_UNCONFIRMED' });
      await closed;
      // The wrapper's close does not wait for the killed grandchild: it is
      // reparented to init and can still be exiting (state R) when sampled.
      // Wait for kernel teardown; a leaked member would never leave (#3507).
      const settle = async (done: () => boolean) => {
        const deadline = Date.now() + 5000;
        while (!done() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      };
      await settle(() => sampleWorkerGroup(workerPid)?.length === 0);
      expect(sampleWorkerGroup(workerPid)).toEqual([]);
      if (escaped) {
        expect(sampleWorkerIdentity(descendantPid)).not.toBeNull();
        process.kill(descendantPid, 'SIGKILL');
      }
      await settle(() => sampleWorkerIdentity(descendantPid) === null);
      expect(sampleWorkerIdentity(descendantPid)).toBeNull();
      // Drain bytes already in the pipe; EOF proves every inherited writer closed.
      const eofDeadline = Date.now() + 2000;
      let eof = false;
      while (!eof && Date.now() < eofDeadline) {
        try { eof = readSync(reader, Buffer.alloc(64 * 1024), 0, 64 * 1024, null) === 0; }
        catch (error: any) { if (error.code !== 'EAGAIN') throw error; }
        if (!eof) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(eof).toBe(true);
    } finally {
      stdout?.destroy();
      closeSync(reader);
      for (const pid of [workerPid, descendantPid]) if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ } }
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
  }, 30000);

  // #3691: a worker exactly one byte over the frame cap has fully flushed
  // and idles — unlike a still-writing oversized worker, it cannot die via
  // EPIPE when the transport destroys the pipe, so it survives unless the
  // stop authority itself delivers a signal. When the owned-group signal
  // refuses (unreadable /proc membership scan, non-leader topology), the
  // authority must still stop the re-verified worker PID directly instead
  // of reporting the overflow while leaving the worker running.
  it.skipIf(process.platform !== 'linux')('stops an idle cap-plus-one worker when the group signal refuses', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aiwg-worker-overflow-')); roots.push(root);
    const script = path.join(root, 'worker.mjs');
    const pidFile = path.join(root, 'worker.pid');
    const fifo = path.join(root, 'stdout.fifo');
    expect(spawnSync('mkfifo', [fifo], { stdio: 'ignore', timeout: 10000 }).status).toBe(0);
    // The FIFO lets the worker flush all cap+1 bytes even when native child
    // stdio pipes are prohibited, so it is idle (not mid-write) at overflow.
    const writer = openSync(fifo, constants.O_RDWR);
    const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
    writeFileSync(script, `import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], String(process.pid));
process.on('SIGTERM', () => {});
process.stdout.write(Buffer.alloc(${MAX_MCP_FRAME_BYTES + 1}, 120));
setInterval(() => {}, 1000);
`);
    const child = spawn(process.execPath, [path.resolve('tools/ralph-external/lib/worker-isolation.mjs'),
      '--worker-environment', '[]', '--', process.execPath, script, pidFile],
    { stdio: ['ignore', writer, writer] });
    closeSync(writer);
    const closed = new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject); });
    let workerPid = 0;
    let stdout: ReturnType<typeof createReadStream> | undefined;
    try {
      const deadline = Date.now() + 5000;
      while (!workerPid && Date.now() < deadline) {
        try { workerPid = Number(readFileSync(pidFile, 'utf8')); } catch { /* startup */ }
        if (!workerPid) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(workerPid).toBeGreaterThan(0);
      stdout = createReadStream(fifo);
      const killPid = vi.fn((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
      const transport = new ChildProcessTransport({ stdout, once: child.once.bind(child) }, {
        terminate: () => stopOverflowWorker({ mode: 'degraded', child, transportSupervisor: true },
          { signal: () => false, killPid }),
      });
      const overflow = new Promise<Error>(resolve => { transport.onerror = resolve; });
      await transport.start();
      const failure = await overflow;
      expect(failure).toMatchObject({ code: 'OG_WORKER_MCP_FRAME_TOO_LARGE' });
      expect(await transport._termination).toEqual({ termination: 'uncertain', delivered: true,
        diagnostic: 'OG_WORKER_MCP_STOP_UNCONFIRMED' });
      // The fallback addresses the re-verified worker PID itself.
      expect(killPid).toHaveBeenCalledWith(workerPid, 'SIGKILL');
      // SIGKILL delivery precedes process exit and reaping.
      await vi.waitFor(() => {
        expect(() => process.kill(workerPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
      }, { timeout: 2000, interval: 25 });
      await closed;
    } finally {
      stdout?.destroy();
      closeSync(reader);
      if (workerPid) { try { process.kill(workerPid, 'SIGKILL'); } catch { /* already exited */ } }
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
  }, 30000);
});
