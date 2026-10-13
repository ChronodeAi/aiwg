/** S1 T-OG-15/20/23 synthetic status evidence. No spawn, inference, MC or credentials. */
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, chmod, symlink, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sampleWorkerStatus, classifyWorkerStatus, formatWorkerStatus, watchWorkerStatus,
  createStatusObservationOwner } from '../../../tools/ralph-external/process-monitor.mjs';
import { parseWorkerStatusArgs } from '../../../tools/ralph-external/index.mjs';
import { resolveWorkerEffectiveHealth } from '../../../src/serve/worker-invocation.js';

const roots: string[] = [];
const epoch = Date.UTC(2026, 9, 8);
const identity = { pid: 51717, pgid: 51717, uid: process.getuid!(), parentPid: 5, sessionId: 51717,
  host: 'fixture', bootId: 'fixture-boot', startTicks: '100', executable: '/fixture/node', state: 'S', cpuTicks: 1 };
const health = resolveWorkerEffectiveHealth(undefined, { role: 'coding', effort: 'high', modelKey: 'fixture/model',
  profileRef: 'fixture-profile', wallSeconds: 1800, stepEnforcement: 'unavailable' });
const history = { version: 1, state: 'active', coverage: 'full', handshake: 'semantic',
  lastObservedAt: new Date(epoch + 19000).toISOString(), lastActivityAt: new Date(epoch + 10000).toISOString(),
  lastProgressAt: new Date(epoch + 10000).toISOString(), handshakeAt: new Date(epoch + 1000).toISOString(),
  stalledAt: null, reasonCode: 'PROGRESS', termination: 'running', observerGeneration: 0,
  transitionCount: 2, maxCheckGapSeconds: 0, unavailableSignals: [] };
const records = () => ({ invocation: { invocationId: 'fixture-worker', taskId: 'fixture-task', transport: 'shell', health,
  selected: { member: 'fixture-member' }, argv: ['DO-NOT-EXPORT-secret'], prompt: 'DO-NOT-EXPORT-secret' },
  process: { invocationId: 'fixture-worker', worker: identity, supervisor: identity,
    launchTime: new Date(epoch).toISOString(), monotonicStart: '0' },
  health: { invocationId: 'fixture-worker', origin: 'observer', health: history }, exit: null, scratch: null });
const facts = (elapsed = 20000) => ({ now: epoch + elapsed, monotonicNow: elapsed, bootId: 'fixture-boot', actual: identity,
  counters: { stdoutBytes: 3, stderrBytes: 0 } });
async function root() {
  const result = await mkdtemp(path.join(tmpdir(), '2913-status-')); roots.push(result); return result;
}
async function fixture(parent?: string, name = 'worker') {
  const directory = parent ? path.join(parent, name) : await root();
  if (parent) await mkdir(directory, { mode: 0o700 });
  const data = records();
  for (const [key, file] of [['invocation', 'invocation.json'], ['process', 'process.json'], ['health', 'health.json']] as const) {
    await writeFile(path.join(directory, file), JSON.stringify(data[key]), { mode: 0o600 });
  }
  await writeFile(path.join(directory, 'stdout.events.jsonl'), 'abc', { mode: 0o600 });
  await writeFile(path.join(directory, 'stderr.log'), '', { mode: 0o600 });
  return directory;
}
const options = (runDir: string) => ({ runDir, now: () => epoch + 20000, monotonicNow: () => 20000,
  bootId: 'fixture-boot', sampleIdentity: vi.fn(() => identity) });
afterEach(async () => {
  for (const directory of roots.splice(0)) { await rm(directory, { recursive: true, force: true }); }
});

describe('T-OG-15 strict existing status grammar', () => {
  it('WS01 resolves both status scopes and explicit observation without a launch descriptor', () => {
    expect(parseWorkerStatusArgs(['--status', '--workers', '--run-dir', '/private/run', '--json']))
      .toMatchObject({ runDir: '/private/run', json: true, observe: false, watch: false });
    expect(parseWorkerStatusArgs(['--status', '--workers', '--runs-root', '/private', '--watch', '--observe', '--deadline-seconds', '0.1']))
      .toMatchObject({ runsRoot: '/private', observe: true, deadlineSeconds: 0.1 });
  });
  it.each([
    [], ['--run-dir', '/a', '--runs-root', '/b'], ['--run-dir', '/a', '--watch'],
    ['--run-dir', '/a', '--observe'],
    ['--run-dir', '/a', '--watch', '--deadline-seconds', 'Infinity'], ['--run-dir', '/a', '--watch', '--deadline-seconds', '0'],
    ['--run-dir', '/a', '--launch-worker'], ['--run-dir', '/a', '--run-dir', '/b'], ['--run-dir', '/a', '$(touch /tmp/injected)'],
  ])('WS02 rejects malformed/mixed status options %j without side effects', args => {
    expect(() => parseWorkerStatusArgs(['--status', '--workers', ...args])).toThrow();
  });
});

describe('T-OG-20 one/all status snapshots and finite watch', () => {
  it('WS03 reads fresh private runs with no MC/admission state and changes no file', async () => {
    const directory = await fixture();
    const before = await Promise.all((await readdir(directory)).sort().map(async name => ({ name,
      bytes: await readFile(path.join(directory, name), 'utf8'), mtime: (await stat(path.join(directory, name))).mtimeMs })));
    const report = await sampleWorkerStatus(options(directory));
    expect(report).toMatchObject({ version: 1, scope: 'direct-conductor', complete: true, exitCode: 0, observerCoverage: 'full', breakers: [] });
    expect(report.workers[0]).toMatchObject({ remainingSeconds: 1780, thresholds: health, ages: { progressSeconds: 10 },
      counters: { cpuTimeMs: null, exitCode: null }, verification: null });
    expect(report.workers[0].health.unavailableSignals).toContain('cpu');
    expect(JSON.stringify(report)).not.toContain('DO-NOT-EXPORT-secret');
    expect(formatWorkerStatus(report)).toContain('fixture-worker | fixture-member | active | full | 20s | 10s | 1780s');
    expect(formatWorkerStatus(report)).toContain(JSON.stringify(health));
    expect(await readdir(directory)).toHaveLength(before.length);
    for (const file of before) {
      expect(await readFile(path.join(directory, file.name), 'utf8')).toBe(file.bytes);
      expect((await stat(path.join(directory, file.name))).mtimeMs).toBe(file.mtime);
    }
  });
  it('WS04 malformed rows retain readable siblings and return read-error precedence', async () => {
    const directory = await root(); await fixture(directory, 'good'); const bad = await fixture(directory, 'bad');
    await writeFile(path.join(bad, 'process.json'), '{');
    const report = await sampleWorkerStatus({ ...options(directory), runDir: undefined, runsRoot: directory });
    expect(report).toMatchObject({ complete: false, exitCode: 1 });
    expect(report.workers).toHaveLength(2);
    expect(report.workers.some((row: any) => row.invocationId === 'fixture-worker')).toBe(true);
    expect(report.workers.find((row: any) => row.error)?.error.code).toBe('MALFORMED_RECORD');
  });
  it('WS05 explicit empty roots are complete informational snapshots', async () => {
    const directory = await root();
    const report = await sampleWorkerStatus({ ...options(directory), runDir: undefined, runsRoot: directory });
    expect(report).toMatchObject({ complete: true, workers: [], exitCode: 0 });
    expect(report.findings.join()).toContain('no-dir workers require conductor-context sampling');
  });
  it('WS06 hand-created process-only metadata stays degraded with null unknown clocks/exit', async () => {
    const directory = await root();
    await writeFile(path.join(directory, 'process.json'), JSON.stringify({ invocationId: 'manual', origin: 'manual', worker: identity }), { mode: 0o600 });
    const report = await sampleWorkerStatus(options(directory));
    expect(report).toMatchObject({ exitCode: 2, complete: true });
    expect(report.workers[0]).toMatchObject({ thresholds: null, elapsedSeconds: null, remainingSeconds: null,
      health: { coverage: 'unobserved', hardDeadlineAt: null }, counters: { exitCode: null, cpuTimeMs: null } });
  });
  it('WS07 finite watch keeps prior counters in memory, emits deadline expiry and never cancels', async () => {
    let clock = 0; const samples: any[] = []; const memorySeen: any[] = [];
    const sample = vi.fn(async (_: any, memory: any) => {
      memorySeen.push(memory); return { version: 1, sampledAt: new Date(epoch + clock).toISOString(), nextCheckAt: null,
        complete: true, workers: [{ terminal: false }], exitCode: 2 };
    });
    expect(await watchWorkerStatus({ watch: true, deadlineSeconds: 0.2 }, { sample, monotonicNow: () => clock,
      sleep: async (ms: number) => { clock += ms; }, emit: (report: any) => samples.push(report) })).toBe(2);
    expect(sample).toHaveBeenCalledTimes(2); expect(memorySeen[0]).toBe(memorySeen[1]);
    expect(samples[1].watch).toEqual({ remainingSeconds: 0, expired: true });
  });
  it('WS08 watch exits immediately when every selected attempt is terminal', async () => {
    const sleep = vi.fn();
    expect(await watchWorkerStatus({ watch: true, deadlineSeconds: 10 }, { sleep, monotonicNow: () => 0, emit: vi.fn(),
      sample: async () => ({ complete: true, workers: [{ terminal: true }], exitCode: 0 }) })).toBe(0);
    expect(sleep).not.toHaveBeenCalled();
  });
  it('WS08b in-memory watch history preserves byte activity without inventing progress', () => {
    const first = classifyWorkerStatus(records(), facts());
    const next = classifyWorkerStatus(records(), { ...facts(30000), previous: {
      counters: first.counters, health: first.health, cpuTicks: identity.cpuTicks },
      counters: { stdoutBytes: 4, stderrBytes: 0 } });
    const third = classifyWorkerStatus(records(), { ...facts(40000), previous: {
      counters: next.counters, health: next.health, cpuTicks: identity.cpuTicks },
      counters: { stdoutBytes: 4, stderrBytes: 0 } });
    expect(third.ages.activitySeconds).toBe(10); expect(third.ages.progressSeconds).toBe(30);
  });
  it('WS09 observe changes only private owner scratch and competing observers cannot write', async () => {
    const directory = await fixture(); const first = createStatusObservationOwner(), second = createStatusObservationOwner();
    const original = await readFile(path.join(directory, 'health.json'), 'utf8');
    try {
      expect((await sampleWorkerStatus({ ...options(directory), observation: first })).exitCode).toBe(0);
      const before = await readFile(path.join(directory, 'last-observed.json'), 'utf8');
      expect(JSON.parse(before)).toMatchObject({ sequence: 1, invocationId: 'fixture-worker' });
      const busy = await sampleWorkerStatus({ ...options(directory), observation: second });
      expect(busy).toMatchObject({ exitCode: 1, complete: false });
      expect(busy.workers[0]).toMatchObject({ invocationId: 'fixture-worker', error: null,
        health: { state: 'active' }, thresholds: health });
      expect(busy.findings.join()).toContain('OBSERVER_BUSY');
      expect(await readFile(path.join(directory, 'last-observed.json'), 'utf8')).toBe(before);
      expect((await stat(path.join(directory, 'last-observed.json'))).mode & 0o777).toBe(0o600);
      expect(await readFile(path.join(directory, 'health.json'), 'utf8')).toBe(original);
    } finally { await first.close(); await second.close(); }
    expect((await readdir(directory)).filter(name => name.startsWith('.'))).toEqual([]);
  });
});

describe('T-OG-23 ownership, bounds, unknowns and observer gaps', () => {
  it('WS10 PID reuse and reboot cannot create process authority or prolong clocks', () => {
    const data = records(); const reused = classifyWorkerStatus(data, { ...facts(), actual: { ...identity, startTicks: '101' } });
    expect(reused.identity.pid).toBeNull(); expect(reused.nextAction).toBe('RESTORE_OBSERVATION');
    const reboot = classifyWorkerStatus(data, { ...facts(), bootId: 'new-boot' });
    expect(reboot.remainingSeconds).toBeNull(); expect(reboot.health.unavailableSignals).toContain('monotonic-clock');
  });
  it('WS11 forged completion and exit zero cannot hide a live worker', () => {
    const data: any = records(); data.health.health = { ...history, state: 'completed' };
    data.exit = { invocationId: 'fixture-worker', exitCode: 0, termination: 'confirmed', health: { state: 'completed' } };
    const row = classifyWorkerStatus(data, facts());
    expect(row.terminal).toBe(false); expect(row.termination).toBe('uncertain'); expect(row.verification).toBeNull();
    expect(row.health.state).not.toBe('completed');
  });
  it('WS12 remote request health never probes or projects a shared server PID', async () => {
    const directory = await fixture(); const data = records().invocation; data.transport = 'mcp';
    await writeFile(path.join(directory, 'invocation.json'), JSON.stringify(data));
    const settings = options(directory); const report = await sampleWorkerStatus(settings);
    expect(settings.sampleIdentity).not.toHaveBeenCalled(); expect(report.workers[0].identity.pid).toBeNull();
  });
  it('WS13 observer loss reports a gap without resetting semantic progress or hard deadline', () => {
    const row = classifyWorkerStatus(records(), facts(400000));
    expect(row.health).toMatchObject({ state: 'hung', lastProgressAt: history.lastProgressAt, maxCheckGapSeconds: 381 });
    expect(row.remainingSeconds).toBe(1400); expect(row.ages.progressSeconds).toBe(390); expect(row.nextAction).toBe('DIAGNOSE_WORKER');
  });
  it('WS14 future timestamps cannot extend a monotonic progress window', () => {
    const data = records(); data.health.health = { ...history, lastProgressAt: new Date(epoch + 1000000).toISOString() };
    const row = classifyWorkerStatus(data, facts());
    expect(row.ages.progressSeconds).toBeNull(); expect(row.health.coverage).toBe('unobserved');
    expect(row.remainingSeconds).toBe(1780);
  });
  it('WS14b a recorded early completion remains completed when queried after its deadline', () => {
    const data: any = records(); data.health.health = { ...history, state: 'completed', termination: 'confirmed' };
    data.exit = { invocationId: 'fixture-worker', exitCode: 0, termination: 'confirmed',
      endedAt: new Date(epoch + 20000).toISOString(), health: data.health.health };
    const row = classifyWorkerStatus(data, { ...facts(1900000), actual: { ...identity, state: 'Z' } });
    expect(row).toMatchObject({ terminal: true, termination: 'confirmed', remainingSeconds: 0, nextAction: 'NONE',
      health: { state: 'completed', reasonCode: 'OK' }, verification: null });
  });
  it.each(['ancestor', 'leaf', 'record', 'capture', 'traversal'])('WS15 rejects %s paths without following links', async kind => {
    const directory = await root(); const run = await fixture(directory); let selected = run;
    if (kind === 'ancestor' || kind === 'leaf') {
      await symlink(run, path.join(directory, 'link')); selected = path.join(directory, 'link');
      if (kind === 'ancestor') selected += '/nested';
    } else if (kind === 'traversal') selected = `${directory}/worker/../worker`;
    else {
      const filename = kind === 'record' ? 'exit.json' : 'stdout.log';
      if (kind === 'capture') {
        // Use a manual run with no JSONL capture to select the opaque symlink.
        const isolated = await root(); await writeFile(path.join(isolated, 'process.json'), JSON.stringify(records().process), { mode: 0o600 });
        await symlink(path.join(run, 'process.json'), path.join(isolated, 'stdout.log')); selected = isolated;
      } else await symlink(path.join(run, 'process.json'), path.join(run, filename));
    }
    expect((await sampleWorkerStatus(options(selected))).exitCode).toBe(1);
  });
  it('WS16 oversized records and excess files fail boundedly', async () => {
    const directory = await fixture(); await writeFile(path.join(directory, 'exit.json'), ' '.repeat(65537), { mode: 0o600 });
    expect((await sampleWorkerStatus(options(directory))).workers[0].error.code).toBe('RECORD_TOO_LARGE');
    const crowded = await fixture();
    for (let i = 0; i < 33; i++) await writeFile(path.join(crowded, `extra-${i}`), '', { mode: 0o600 });
    expect((await sampleWorkerStatus(options(crowded))).workers[0].error.code).toBe('FILE_LIMIT');
  });
  it('WS17 selections over 256 report incomplete and request narrower scope', async () => {
    const directory = await root();
    for (let i = 0; i < 257; i++) await mkdir(path.join(directory, `worker-${i}`), { mode: 0o700 });
    const report = await sampleWorkerStatus({ ...options(directory), runDir: undefined, runsRoot: directory });
    expect(report.complete).toBe(false); expect(report.workers.length).toBeLessThanOrEqual(256);
    expect(report.findings.join()).toContain('SELECTION_LIMIT');
  });
  it('WS18 permission-bit denial skips under root', async context => {
    if (process.getuid?.() === 0) { context.skip(); return; }
    const directory = await fixture(); await chmod(path.join(directory, 'process.json'), 0o000);
    expect((await sampleWorkerStatus(options(directory))).exitCode).toBe(1);
  });
  it('WS19 staged installed monitor loads with no src/dist or MC state', async () => {
    const installed = await root(); await mkdir(path.join(installed, 'lib'), { mode: 0o700 });
    await cp('tools/ralph-external/process-monitor.mjs', path.join(installed, 'process-monitor.mjs'));
    await cp('tools/ralph-external/lib/worker-health.mjs', path.join(installed, 'lib/worker-health.mjs'));
    const module = await import(pathToFileURL(path.join(installed, 'process-monitor.mjs')).href);
    const directory = await fixture(); const report = await module.sampleWorkerStatus(options(directory));
    expect(report.exitCode).toBe(0); expect(module.formatWorkerStatus(report)).toContain('fixture-worker');
    expect(await readdir(installed)).toEqual(expect.arrayContaining(['process-monitor.mjs', 'lib']));
  });

  it('WS20 the same staged-without-resolver monitor surfaces a diagnostic for getProcessHealth instead of a bare null (#3062 B/C finding 12)', async () => {
    const installed = await root(); await mkdir(path.join(installed, 'lib'), { mode: 0o700 });
    await cp('tools/ralph-external/process-monitor.mjs', path.join(installed, 'process-monitor.mjs'));
    await cp('tools/ralph-external/lib/worker-health.mjs', path.join(installed, 'lib/worker-health.mjs'));
    const module = await import(pathToFileURL(path.join(installed, 'process-monitor.mjs')).href);

    const monitor = new module.ProcessMonitor({ projectRoot: installed });
    monitor.monitoredLoops.set('loop', { pid: process.pid });
    const health = monitor.getProcessHealth('loop');

    expect(health).not.toBeNull();
    expect(health.status).toBe('unavailable');
    expect(health.cpu).toBeNull();
    expect(health.memory).toBeNull();
    expect(health.uptime).toBeNull();
    expect(health.unavailableReason).toContain('bounded-child-process helper unavailable');
  });
});
