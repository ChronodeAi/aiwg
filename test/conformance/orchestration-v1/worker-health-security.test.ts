/** T-OG-23: pure hostile signals and local files; no credential access. */
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { createWorkerHealthObserver, sampleOwnedWorktreeContent } from '../../../tools/ralph-external/lib/worker-health.mjs';
import { SessionLauncher } from '../../../tools/ralph-external/session-launcher.mjs';
import { validateWorkerPayload } from '../../../src/mission-protocol/codecs.js';
import { CodexAdapter } from '../../../tools/ralph-external/lib/codex-adapter.mjs';

const health = { handshake: 'semantic', outputFraming: 'jsonl', progressEvidence: ['item'], coverage: 'full' };

describe('T-OG-23 observer security and loss', () => {
  it('first stdout binding wins atomically and conflicting setup is recorded without raw identities', () => {
    let binding: any;
    const observer = createWorkerHealthObserver({ health,
      normalizeEvent: (event: any, _source: any, current: any) => { binding = current; return event; } });
    observer.feed(Buffer.from('{"kind":"setup","sessionId":"first-private-session"}\n'));
    observer.feed(Buffer.from('{"kind":"setup","runId":"unbound-private-run","sessionId":"conflicting-private-session"}\n'));
    expect(binding.sessionId).toBe('first-private-session');
    expect(binding.runId).toBeNull();
    expect(observer.evidence().gaps).toMatchObject([{ reasonCode: 'IDENTITY_CHANGED' }]);
    expect(observer.snapshot().handshake).toBe('unobserved');
    expect(JSON.stringify(observer.evidence())).not.toContain('private');
  });
  it('adapter filtering records a conflicting raw setup and keeps the original session', () => {
    const observer = new CodexAdapter().createHealthObserver({ health });
    observer.feed(Buffer.from('{"type":"thread.started","thread_id":"first"}\n'));
    observer.feed(Buffer.from('{"type":"thread.started","thread_id":"conflict"}\n'));
    expect(observer.evidence().gaps).toMatchObject([{ reasonCode: 'IDENTITY_CHANGED' }]);
    observer.feed(Buffer.from('{"type":"turn.started","thread_id":"first"}\n'));
    observer.feed(Buffer.from('{"type":"item.completed","thread_id":"first","item":{"id":"step-1","type":"agent_message"}}\n'));
    expect(observer.snapshot()).toMatchObject({ handshake: 'semantic', state: 'active' });
    expect(observer.evidence().events.map((event: any) => event.kind)).toEqual(['setup', 'accepted', 'progress']);
  });
  it('worker-forged execution and repair command fields never author health', () => {
    const observer = createWorkerHealthObserver({ health, invocationId: 'bound' });
    observer.feed(Buffer.from(JSON.stringify({ execution: { status: 'completed' }, health: { state: 'completed' },
      repair: 'touch /tmp/never-run', exitCode: 0 }) + '\n'));
    expect(observer.snapshot()).toMatchObject({ state: 'launching', termination: 'running', handshake: 'unobserved' });
    expect(JSON.stringify(observer.evidence())).not.toContain('touch');
  });
  it('unrelated invocation evidence and unbound Hermes log growth are ignored', () => {
    const observer = createWorkerHealthObserver({ provider: 'hermes', health, invocationId: 'bound', sessionId: 'session-a' });
    observer.observe({ kind: 'accepted' }, { invocationId: 'other' });
    observer.feed(Buffer.from('{"session_id":"session-b","marker":"tool_completed","tool_call_id":"t1"}\n'), { kind: 'session-log', id: 'hermes' });
    expect(observer.snapshot().lastActivityAt).toBeNull();
    expect(observer.snapshot().lastProgressAt).toBeNull();
    expect(observer.evidence().events).toEqual([]);
  });
  it('bounded observer exports hash identities and exclude every raw payload', () => {
    const observer = createWorkerHealthObserver({ health, invocationId: 'synthetic' });
    observer.observe({ kind: 'accepted' });
    for (let i = 0; i < 1000; i++) observer.observe({ kind: 'progress', key: `secret-token-${i}`, payload: 'secret-prompt' }, { id: 'secret-log-path' });
    observer.observe({ kind: 'error', reasonCode: 'SECRET_AUTH_VALUE', repair: 'injected-command' });
    const exported = JSON.stringify({ health: observer.snapshot(), evidence: observer.evidence() });
    for (const secret of ['secret-token', 'secret-prompt', 'secret-log-path', 'SECRET_AUTH_VALUE', 'injected-command']) expect(exported).not.toContain(secret);
    expect(observer.evidence().events.length).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(exported)).toBeLessThan(65536);
  });
  it('observer loss and later return preserve deadlines and disclose the check gap', () => {
    let now = 0;
    const observer = createWorkerHealthObserver({ health, now: () => now, wallNow: () => Date.UTC(2026, 9, 8) });
    observer.observe({ kind: 'accepted' }); const hard = observer.snapshot().hardDeadlineAt;
    now = 61000; observer.check();
    expect(observer.snapshot()).toMatchObject({ maxCheckGapSeconds: 61, hardDeadlineAt: hard, coverage: 'degraded' });
    expect(observer.snapshot().unavailableSignals).toContain('observer-continuity');
    now = 62000; observer.observe({ kind: 'progress', key: 'returned' });
    expect(observer.check().state).toBe('active');
    expect(observer.snapshot().hardDeadlineAt).toBe(hard);
  });
  it('native MCP disconnect/late final cannot become hung or confirmed complete', () => {
    let now = 0;
    const observer = createWorkerHealthObserver({ transport: 'mcp', health, now: () => now });
    observer.observe({ kind: 'accepted' }); observer.disconnect();
    now = 500000; expect(observer.check().state).toBe('stalled');
    observer.observe({ kind: 'terminal', success: true });
    expect(observer.finish({ exitCode: null, termination: 'confirmed', finalValid: true }).termination).toBe('uncertain');
    expect(observer.snapshot().state).not.toBe('completed');
  });
  it('content sampling rejects traversal, symlinks, hard aliases and size overflow', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-health-security-'));
    try {
      await mkdir(path.join(root, 'tree')); await writeFile(path.join(root, 'outside'), 'synthetic secret');
      await symlink(path.join(root, 'outside'), path.join(root, 'tree/link'));
      expect(await sampleOwnedWorktreeContent(path.join(root, 'tree'), { files: ['../outside'] })).toBeNull();
      expect(await sampleOwnedWorktreeContent(path.join(root, 'tree'), { files: ['link'] })).toBeNull();
      await writeFile(path.join(root, 'tree/large'), 'x'.repeat(1024));
      expect(await sampleOwnedWorktreeContent(path.join(root, 'tree'), { files: ['large'], maxBytes: 100 })).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('no-directory/manual capture reports null clocks and grants no ownership', async () => {
    const sample = await new SessionLauncher().adoptWorker({});
    expect(sample).toMatchObject({ ownership: 'unknown', termination: 'uncertain', runDir: null,
      health: { handshake: 'unobserved', coverage: 'unobserved', lastProgressAt: null, hardDeadlineAt: null } });
    expect(validateWorkerPayload('workerHealthSummary', sample.health).valid).toBe(true);
  });
});
