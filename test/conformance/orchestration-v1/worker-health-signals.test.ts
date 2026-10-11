/** T-OG-20: synthetic run-bound signals; no model or credentials. */
import { describe, expect, it } from 'vitest';
import { createWorkerHealthObserver, classifyWorkerHealthFailure } from '../../../tools/ralph-external/lib/worker-health.mjs';
import { qualifyWorkerCpuTickRate, sampleWorkerCpuTime } from '../../../tools/ralph-external/process-monitor.mjs';

const profile = { health: { handshake: 'semantic', outputFraming: 'jsonl', progressEvidence: ['completed-item'], coverage: 'full' } };
const identity = { pid: 123, pgid: 123, uid: 1000, parentPid: 1, sessionId: 123, host: 'fixture', bootId: 'fixture-boot',
  startTicks: '100', executable: '/fixture/worker', cpuTicks: 10 };

describe('T-OG-20 health source attribution and startup diagnosis', () => {
  it.each([
    ['Reading additional input from stdin', 'STDIN_WAIT'], ['trust this workspace', 'TRUST'],
    ['authentication expired HTTP 401', 'AUTH'], ['model_not_found', 'MODEL'], ['EPERM', 'SANDBOX'],
    ['EROFS read-only file system', 'SANDBOX'], ['ENOENT', 'NOT_FOUND'], ['429 Retry-After: 30', 'RATE_LIMIT'],
    ['ECONNRESET', 'NETWORK'], ['ENOSPC', 'RESOURCE'],
  ])('%s is a suspected %s diagnosis, never stop proof', (text, code) => {
    const observer = createWorkerHealthObserver({ profile, invocationId: 'synthetic-startup' });
    observer.feed(Buffer.from(`${text}\n`), { kind: 'stderr' });
    expect(observer.snapshot()).toMatchObject({ state: 'failed-to-start', reasonCode: code, termination: 'running', confidence: 'suspected' });
    expect(observer.snapshot().lastProgressAt).toBeNull();
    expect(classifyWorkerHealthFailure(text, { source: { kind: 'stdout' } })).toBeNull();
  });

  it('verified exec is process-only only for the explicit degraded profile', () => {
    const semantic = createWorkerHealthObserver({ profile });
    semantic.processStarted(identity);
    expect(semantic.snapshot().handshake).toBe('unobserved');
    const degraded = createWorkerHealthObserver({ health: { handshake: 'process-only', outputFraming: 'plain' } });
    degraded.processStarted(identity);
    expect(degraded.snapshot()).toMatchObject({ handshake: 'process-only', state: 'started', coverage: 'degraded' });
  });

  it('setup, heartbeat, observation and activity have independent clocks', () => {
    let now = 0;
    const observer = createWorkerHealthObserver({ profile, now: () => now, wallNow: () => Date.UTC(2026, 9, 8) });
    observer.observe({ kind: 'setup' });
    expect(observer.snapshot().handshakeAt).toBeNull();
    now = 1000; observer.observe({ kind: 'accepted' });
    now = 2000; observer.observe({ kind: 'progress', key: 'useful' });
    const progress = observer.snapshot().lastProgressAt;
    now = 3000; observer.observe({ kind: 'heartbeat' });
    expect(observer.evidence().lastWorkerHeartbeatAt).not.toBe(progress);
    expect(observer.snapshot().lastProgressAt).toBe(progress);
    now = 4000; observer.sampleActivity({ running: true, cpu: 100 }); observer.check();
    expect(observer.snapshot().lastObservedAt).not.toBe(progress);
    expect(observer.snapshot().lastProgressAt).toBe(progress);
  });

  it('CPU ticks use a qualified rate and identity-bound deltas; reuse is unavailable', () => {
    expect(qualifyWorkerCpuTickRate(() => Buffer.from('250\n'))).toBe(250);
    expect(qualifyWorkerCpuTickRate(() => { throw new Error('synthetic EPERM'); })).toBeNull();
    expect(sampleWorkerCpuTime(identity, { ...identity, cpuTicks: 15 }, 250, identity)).toEqual({ cpuTimeMs: 60, deltaMs: 20 });
    expect(sampleWorkerCpuTime(identity, { ...identity, startTicks: '200' }, 250, identity)).toEqual({ cpuTimeMs: null, deltaMs: null });
    expect(sampleWorkerCpuTime(identity, identity, null)).toEqual({ cpuTimeMs: null, deltaMs: null });
  });

  it('source rotation/truncation and malformed UTF-8 disclose a watcher gap', () => {
    const observer = createWorkerHealthObserver({ profile, normalizeEvent: () => null });
    observer.feed(Buffer.from('{"type":"unknown"}\n'), { id: 'stream', generation: 0, offset: 0 });
    observer.feed(Buffer.from('{"type":"unknown"}\n'), { id: 'stream', generation: 1, offset: 0 });
    observer.feed(Buffer.from([0xff, 10]), { id: 'stream', generation: 1, offset: 0 });
    expect(observer.snapshot().unavailableSignals).toContain('observer-continuity');
    expect(observer.evidence().gaps.map((item: any) => item.reasonCode)).toContain('MALFORMED_FRAME');
    expect(observer.evidence().observerGeneration).toBeGreaterThan(0);
  });

  it('spawn failure keeps exit unknown and never fabricates success', () => {
    const observer = createWorkerHealthObserver({ profile });
    observer.observe({ kind: 'error', reasonCode: 'NOT_FOUND' });
    expect(observer.finish({ exitCode: null, termination: 'confirmed', errorCode: 'NOT_FOUND' })).toMatchObject({ state: 'failed', reasonCode: 'NOT_FOUND' });
  });
});
