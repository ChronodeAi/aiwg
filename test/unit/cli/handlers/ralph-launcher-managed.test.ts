import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  abortLoop, cancelManagedRalph, cleanupCompletedLoop, cleanupRegistry,
  launchExternalRalph, loadLauncherRegistry, resumeLoop, saveLauncherRegistry,
} from '../../../../src/cli/handlers/ralph-launcher.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../../../../src/config/aiwg-config.js', async original => ({
  ...await original<typeof import('../../../../src/config/aiwg-config.js')>(),
  readAiwgConfig: vi.fn(async () => null),
}));

let root: string;
let tools: string;
const binding = { requestId: 'synthetic-request', generation: 1 };
const identity = { pid: 12345, uid: 1000, bootId: 'synthetic-boot', startTicks: '123',
  executable: '/synthetic/node', pgid: 12345, sessionId: 12345 };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ralph-managed-'));
  tools = join(root, 'tools', 'ralph-external');
  mkdirSync(tools, { recursive: true });
  writeFileSync(join(tools, 'index.mjs'), '');
  writeFileSync(join(tools, 'identity.json'), JSON.stringify(identity));
  writeFileSync(join(tools, 'process-monitor.mjs'), `
    import { readFileSync } from 'node:fs';
    export function sampleWorkerIdentity() { return JSON.parse(readFileSync(new URL('./identity.json', import.meta.url), 'utf8')); }
    export function createWorkerIdentityCapture() { let previous; return { observe(current) {
      const stable = previous && current && JSON.stringify(previous) === JSON.stringify(current); previous = current; return stable ? current : null;
    } }; }
  `);
  writeFileSync(join(tools, 'session-launcher.mjs'), `
    import { writeFileSync } from 'node:fs';
    export function signalOwnedWorker(identity, signal) {
      writeFileSync(new URL('./signal.json', import.meta.url), JSON.stringify({ pid: identity.pid, signal }));
      return true;
    }
  `);
  mocks.spawn.mockReturnValue({ pid: 12345, unref: vi.fn() });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  rmSync(root, { recursive: true, force: true });
});

async function launch(managed = true) {
  return launchExternalRalph(root, root, { objective: 'synthetic', completionCriteria: 'synthetic complete',
    loopId: managed ? 'synthetic-loop' : 'synthetic-direct', ...(managed ? { managedAdmission: binding } : {}) });
}

describe('T-OG-06 managed Ralph process fencing', () => {
  it('binds a managed launch to its kernel birth identity without adding direct state', async () => {
    expect(await launch()).toMatchObject({ execution: { pid: 12345, startedAt: 'synthetic-boot:123:1000' } });
    expect(loadLauncherRegistry(root).loops['synthetic-loop']!.managedAdmission).toMatchObject(binding);
    expect(await launch(false)).not.toHaveProperty('execution');
    expect(loadLauncherRegistry(root).loops['synthetic-direct']!).not.toHaveProperty('managedAdmission');
  });

  it('persists the managed guard before the spawn boundary', async () => {
    mocks.spawn.mockImplementation(() => {
      expect(loadLauncherRegistry(root).loops['synthetic-loop']).toMatchObject({ pid: 0, managedAdmission: binding });
      return { pid: 12345, unref: vi.fn() };
    });
    await launch();
  });

  it.each([true, false])('rejects a second launch over a managed identity (managed=%s)', async managed => {
    await launch();
    mocks.spawn.mockClear();
    await expect(launchExternalRalph(root, root, { objective: 'synthetic', completionCriteria: 'synthetic complete',
      loopId: 'synthetic-loop', ...(managed ? { managedAdmission: binding } : {}) })).rejects.toThrow(/cannot be relaunched/);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(loadLauncherRegistry(root).loops['synthetic-loop']!.managedAdmission).toMatchObject(binding);
  });

  it('rejects an exited child before binding any observed replacement identity', async () => {
    mocks.spawn.mockReturnValue({ pid: 12345, unref: vi.fn(), exitCode: 0 });
    await expect(launch()).rejects.toThrow(/identity unavailable/);
    expect(loadLauncherRegistry(root).loops['synthetic-loop']!.managedAdmission).toEqual(binding);
    expect(cleanupCompletedLoop(root, 'synthetic-loop').success).toBe(false);
    mocks.spawn.mockClear();
    await expect(launch()).rejects.toThrow(/cannot be relaunched/);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('bounds unavailable identity capture even while the wall clock is frozen', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(0);
    writeFileSync(join(tools, 'identity.json'), 'null');
    const before = process.hrtime.bigint();
    await expect(launch()).rejects.toThrow(/identity unavailable/);
    expect(Number(process.hrtime.bigint() - before) / 1e6).toBeLessThan(2000);
  });

  it.each(['generation', 'request', 'pid', 'birth'])('rejects a mismatched %s without signalling', async mismatch => {
    const launched = await launch();
    const supplied = { ...binding, execution: { ...launched.execution! } };
    if (mismatch === 'generation') supplied.generation += 1;
    if (mismatch === 'request') supplied.requestId = 'different-request';
    if (mismatch === 'pid') supplied.execution.pid += 1;
    if (mismatch === 'birth') supplied.execution.startedAt = 'different-birth';
    expect(await cancelManagedRalph(root, root, 'synthetic-loop', supplied)).toEqual({ state: 'uncertain', signalled: false });
    expect(existsSync(join(tools, 'signal.json'))).toBe(false);
  });

  it.each(['startTicks', 'bootId', 'uid', 'executable', 'pgid', 'sessionId'])('rejects PID reuse or changed %s before signalling', async field => {
    const launched = await launch();
    writeFileSync(join(tools, 'identity.json'), JSON.stringify({ ...identity, [field]: 'changed' }));
    expect(await cancelManagedRalph(root, root, 'synthetic-loop', { ...binding, execution: launched.execution! }))
      .toEqual({ state: 'uncertain', signalled: false });
    expect(existsSync(join(tools, 'signal.json'))).toBe(false);
  });

  it('signals the current identity and still reports uncertain descendant termination', async () => {
    const launched = await launch();
    expect(await cancelManagedRalph(root, root, 'synthetic-loop', { ...binding, execution: launched.execution! }))
      .toEqual({ state: 'uncertain', signalled: true });
    expect(JSON.parse(readFileSync(join(tools, 'signal.json'), 'utf8'))).toEqual({ pid: 12345, signal: 'SIGTERM' });
  });

  it('rejects unfenced abort and resume and preserves managed artifacts and registry', async () => {
    await launch();
    const artifact = join(root, '.aiwg', 'ralph-external', 'loops', 'synthetic-loop', 'synthetic-artifact');
    writeFileSync(artifact, 'retained');
    expect(abortLoop(root, 'synthetic-loop').success).toBe(false);
    await expect(resumeLoop(root, root, 'synthetic-loop')).rejects.toThrow(/admission reconciliation/);
    expect(cleanupCompletedLoop(root, 'synthetic-loop').success).toBe(false);
    const registry = loadLauncherRegistry(root);
    registry.loops['synthetic-loop']!.status = 'failed';
    registry.loops['synthetic-loop']!.lastUpdate = '2000-01-01T00:00:00Z';
    saveLauncherRegistry(root, registry);
    expect(cleanupRegistry(root)).toBe(0);
    expect(readFileSync(artifact, 'utf8')).toBe('retained');
    expect(loadLauncherRegistry(root).loops['synthetic-loop']).toBeDefined();
  });
});
