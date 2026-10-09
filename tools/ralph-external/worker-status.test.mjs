/** #2913 fix-pass regressions: synthetic evidence, no spawned worker or signals. */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sampleWorkerStatus, watchWorkerStatus, createStatusObservationOwner } from './process-monitor.mjs';
import { parseWorkerStatusArgs } from './index.mjs';

const root = await mkdtemp(path.join(tmpdir(), '2913-status-regression-'));
after(() => rm(root, { recursive: true, force: true }));
const epoch = Date.UTC(2026, 9, 8);
const identity = { pid: 51717, pgid: 51717, uid: process.getuid(), parentPid: 5, sessionId: 51717,
  host: 'fixture', bootId: 'fixture-boot', startTicks: '100', executable: '/fixture/node', state: 'S', cpuTicks: 1 };
const thresholds = { version: 1, startupSeconds: 60, checkSeconds: 15, quietSeconds: 90, stallSeconds: 300,
  diagnosticGraceSeconds: 60, terminateGraceSeconds: 5, hardTimeoutSeconds: 1800, maxSteps: 100,
  stepEnforcement: 'unavailable', scale: 1, profileRef: 'fixture-profile', runDir: null, origins: {} };
const history = { version: 1, state: 'active', coverage: 'full', handshake: 'semantic',
  lastObservedAt: new Date(epoch + 19000).toISOString(), lastActivityAt: new Date(epoch + 10000).toISOString(),
  lastProgressAt: new Date(epoch + 10000).toISOString(), handshakeAt: new Date(epoch + 1000).toISOString(),
  stalledAt: null, reasonCode: 'PROGRESS', termination: 'running', observerGeneration: 0,
  transitionCount: 2, maxCheckGapSeconds: 0, unavailableSignals: [] };
let sequence = 0;
async function fixture() {
  const directory = path.join(root, `run-${++sequence}`);
  await mkdir(directory, { mode: 0o700 });
  await record(directory, 'invocation.json', { invocationId: 'fixture-worker', transport: 'shell', health: thresholds });
  await record(directory, 'process.json', { invocationId: 'fixture-worker', worker: identity, supervisor: identity,
    launchTime: new Date(epoch).toISOString(), monotonicStart: '0' });
  await record(directory, 'health.json', { invocationId: 'fixture-worker', origin: 'observer', health: history });
  return directory;
}
const record = (directory, name, data) => writeFile(path.join(directory, name), JSON.stringify(data), { mode: 0o600 });
const options = (runDir, elapsed = 20000) => ({ runDir, now: () => epoch + elapsed, monotonicNow: () => elapsed,
  bootId: 'fixture-boot', sampleIdentity: () => identity });

test('WS-R1 observe requires finite watch in the status grammar', () => {
  assert.throws(() => parseWorkerStatusArgs(['--status', '--workers', '--run-dir', '/private', '--observe']), /OBSERVE_REQUIRES_WATCH/);
  assert.equal(parseWorkerStatusArgs(['--status', '--workers', '--run-dir', '/private', '--observe', '--watch',
    '--deadline-seconds', '2']).observe, true);
});

test('WS-R2 quiet threshold 1ms away cannot cause a hot watch loop', async () => {
  const directory = await fixture();
  let clock = 0, count = 0;
  const sleeps = [];
  const result = await watchWorkerStatus({ watch: true, observe: true, deadlineSeconds: 2 }, {
    monotonicNow: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms; }, emit: () => {},
    sample: async () => { count++; return sampleWorkerStatus(options(directory, 99999 + clock)); },
  });
  assert.ok(count <= 3, `watch took ${count} samples`);
  assert.equal(result, 2); // original observer history is stale; watching does not restore coverage
  assert.deepEqual(sleeps, [2000]); // resolved cadence is 15s; only the finite watch shortens it
  assert.equal(clock, 2000);
});

test('WS-R3 check cadence and sample cap bound a watch even if a timer makes no progress', async () => {
  let count = 0;
  const reports = [];
  const result = await watchWorkerStatus({ watch: true, deadlineSeconds: 2 }, {
    monotonicNow: () => 0, sleep: async () => { assert.ok(count <= 3, 'unbounded watch'); }, emit: report => reports.push(report),
    sample: async () => { count++; return { sampledAt: new Date(epoch).toISOString(),
      nextCheckAt: new Date(epoch + 1).toISOString(), complete: true, findings: [],
      workers: [{ terminal: false, thresholds: { checkSeconds: 0.001 } }], exitCode: 0 }; },
  });
  assert.equal(result, 2); assert.equal(count, 3);
  assert.equal(reports.at(-1).complete, false);
  assert.ok(reports.at(-1).findings.some(value => value.includes('WATCH_SAMPLE_LIMIT')));
});

test('WS-R3b subsecond resolved cadence still samples at most once per second', async () => {
  let clock = 0, count = 0;
  const sleeps = [];
  await watchWorkerStatus({ watch: true, deadlineSeconds: 2 }, {
    monotonicNow: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms; }, emit: () => {},
    sample: async () => { count++; return { sampledAt: new Date(epoch + clock).toISOString(),
      nextCheckAt: new Date(epoch + clock + 1).toISOString(), complete: true, findings: [],
      workers: [{ terminal: false, thresholds: { checkSeconds: 0.001 } }], exitCode: 0 }; },
  });
  assert.equal(count, 3); assert.deepEqual(sleeps, [1000, 1000]);
});

test('WS-R4 forged scratch cannot hide hung health or upgrade coverage', async () => {
  for (const kind of ['no-lock', 'wrong-owner', 'reused', 'reboot', 'dead', 'live']) {
    const directory = await fixture();
    const observer = { ...identity, pid: 61818, pgid: 61818, sessionId: 61818 };
    if (kind !== 'no-lock') await record(directory, '.status-observer', { owner: 'reserved-owner', observer });
    await record(directory, 'last-observed.json', { invocationId: 'fixture-worker', owner: kind === 'wrong-owner' ? 'forged-owner' : 'reserved-owner',
      health: { ...history, lastObservedAt: new Date(epoch + 399999).toISOString(),
        lastActivityAt: new Date(epoch + 399999).toISOString(), lastProgressAt: new Date(epoch + 399999).toISOString() } });
    const settings = options(directory, 400000);
    settings.sampleIdentity = pid => pid === identity.pid ? identity : kind === 'reused' ? { ...observer, startTicks: '101' }
      : kind === 'reboot' ? { ...observer, bootId: 'new-boot' } : kind === 'dead' ? { ...observer, state: 'Z' } : observer;
    const report = await sampleWorkerStatus(settings);
    assert.equal(report.exitCode, 2, kind);
    assert.equal(report.workers[0].health.state, 'hung', kind);
    assert.equal(report.workers[0].health.reasonCode, 'NO_PROGRESS', kind);
    assert.equal(report.workers[0].health.coverage, 'degraded', kind);
    assert.equal(report.workers[0].ages.progressSeconds, 390, kind);
    if (kind !== 'live') assert.ok(report.findings.some(value => value.includes('OBSERVER_HISTORY_UNTRUSTED')), kind);
  }
});

test('WS-R4b matching live scratch cannot launder progress into watch memory', async () => {
  const directory = await fixture(), memory = new Map();
  await record(directory, '.status-observer', { owner: 'live-owner', observer: identity });
  await record(directory, 'last-observed.json', { invocationId: 'fixture-worker', owner: 'live-owner',
    health: { ...history, lastObservedAt: new Date(epoch + 79999).toISOString(),
      lastActivityAt: new Date(epoch + 79999).toISOString(), lastProgressAt: new Date(epoch + 79999).toISOString() } });
  const first = await sampleWorkerStatus(options(directory, 80000), memory);
  assert.equal(first.workers[0].ages.progressSeconds, 70);
  const next = await sampleWorkerStatus(options(directory, 400000), memory);
  assert.equal(next.workers[0].health.state, 'hung');
  assert.equal(next.workers[0].ages.progressSeconds, 390);
});

test('WS-R5 CPU milliseconds disclose an unavailable conversion', async () => {
  const report = await sampleWorkerStatus(options(await fixture()));
  assert.equal(report.workers[0].counters.cpuTimeMs, null);
  assert.equal(report.workers[0].counters.available.cpu, false);
  assert.ok(report.workers[0].health.unavailableSignals.includes('cpu'));
});

test('WS-R6 busy observation retains the classified row and owner scratch', async () => {
  const directory = await fixture(), first = createStatusObservationOwner(), second = createStatusObservationOwner();
  try {
    assert.equal((await sampleWorkerStatus({ ...options(directory), observation: first })).exitCode, 0);
    const original = await readFile(path.join(directory, 'last-observed.json'), 'utf8');
    const report = await sampleWorkerStatus({ ...options(directory), observation: second });
    assert.equal(report.exitCode, 1); assert.equal(report.complete, false); assert.equal(report.workers.length, 1);
    assert.equal(report.workers[0].invocationId, 'fixture-worker'); assert.equal(report.workers[0].error, null);
    assert.equal(report.workers[0].health.state, 'active'); assert.deepEqual(report.workers[0].thresholds, thresholds);
    assert.ok(report.findings.some(value => value.includes('OBSERVER_BUSY')));
    assert.equal(await readFile(path.join(directory, 'last-observed.json'), 'utf8'), original);
  } finally { await first.close(); await second.close(); }
});

test('WS-R7 private oversized records reach the size bound', async () => {
  const directory = await fixture();
  await writeFile(path.join(directory, 'exit.json'), ' '.repeat(65537), { mode: 0o600 });
  assert.equal((await sampleWorkerStatus(options(directory))).workers[0].error.code, 'RECORD_TOO_LARGE');
});
