/**
 * Unit tests for the ADR-002 sandbox-gate escalation gate in ExecutorShim.
 *
 * The HITL channel is wired but GATED DEFAULT-OFF (operator decision,
 * 2026-08-30, recorded in the ADR-002 status line):
 *  - default missions (hitlChannel absent → 'none'): a sandbox write-path
 *    gate trip fails the mission LOUD with the named reason
 *    'sandbox_gate_escalation_disabled' and NO mission.hitl_required is
 *    emitted — an escalation attempted into a void ("no approval channel is
 *    available", task 11159769) is prohibited;
 *  - hitlChannel 'bridge': the gate trip escalates through the existing
 *    mission.hitl_required envelope ({hitl_id, prompt, context}) consumed by
 *    executor-ws-client.mjs → executor-registry.ts → dashboard HITL drawer;
 *  - gate trips arriving via supervisor loop:failed (Error instance or
 *    stringified) are recognized and routed through the same gate.
 *
 * @source @tools/ralph-external/executor-shim.mjs
 * @decision @.aiwg/architecture/ADR-002-deliverable-write-path-fail-loud.md
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';

// @ts-ignore - ESM import
import { ExecutorShim } from '../../../tools/ralph-external/executor-shim.mjs';
// @ts-ignore - ESM import
import { DeliverableUnwritableError } from '../../../tools/ralph-external/session-launcher.mjs';

class StubSupervisor extends EventEmitter {
  _running: Map<string, any>;
  _counter: number;

  constructor() {
    super();
    this._running = new Map();
    this._counter = 0;
  }

  submit(config: any) {
    const loopId = config.loopId ?? `loop-${++this._counter}`;
    this._running.set(loopId, { config, taskId: `task-${this._counter}`, pid: null });
    queueMicrotask(() => {
      if (this._running.has(loopId)) {
        this.emit('loop:started', { loopId, taskId: `task-${this._counter}` });
      }
    });
    return { loopId };
  }

  failLoop(loopId: string, error: unknown = 'test error', permanent = false) {
    this._running.delete(loopId);
    this.emit('loop:failed', { loopId, error, permanent });
  }
}

function makeShim() {
  const supervisor: any = new StubSupervisor();
  const shim: any = new ExecutorShim({
    supervisor,
    executorId: 'test-executor-uuid-1234',
    name: 'test-local-executor',
    version: '1.0.0',
    restBase: 'http://127.0.0.1:8200',
    wsBase: 'ws://127.0.0.1:8200',
    aiwgServeUrl: 'http://127.0.0.1:7337',
  });
  return { shim, supervisor };
}

/**
 * A real DeliverableUnwritableError as the launcher's pre-flight gate throws
 * it — carrying both sides of the mismatch (task 11159769 topology).
 */
function makeGateError() {
  return new DeliverableUnwritableError({
    target: '/tmp/mission/deliverable.md',
    sandboxRoot: '/Users/base/deepseek-harness',
    provider: 'dsh',
    detail: 'writability probe failed: EACCES',
  });
}

describe('ExecutorShim ADR-002 sandbox-gate escalation gate', () => {
  it('default missions gate escalation OFF: gate trip fails loud, no hitl_required', async () => {
    const { shim, supervisor } = makeShim();
    shim.dispatch('s', { mission_id: 'm-gate1', objective: 'x', completion: 'y' });
    await new Promise((r) => supervisor.once('loop:started', r));

    const events: any[] = [];
    shim.on('event', (e: any) => events.push(e));

    const result = shim.handleSandboxGateTrip('m-gate1', makeGateError());

    expect(result.routed).toBe(false);
    expect(result.failedLoud).toBe(true);
    expect(result.channel).toBe('none');

    // NO phantom HITL request — the channel was never wired for this mission.
    expect(events.find((e) => e.event === 'mission.hitl_required')).toBeUndefined();

    const failed = events.find((e) => e.event === 'mission.failed');
    expect(failed).toBeDefined();
    expect(failed.data.reason).toBe('sandbox_gate_escalation_disabled');
    expect(failed.data.error).toContain('unwritable under provider sandbox root');
    expect(failed.data.error).toContain('/tmp/mission/deliverable.md');
    expect(failed.data.error).toContain('/Users/base/deepseek-harness');

    const mission = shim._missions.get('m-gate1');
    expect(mission.state).toBe('failed');
    expect(mission.pendingHitl).toBeNull();
    expect(mission.error).toBe('sandbox_gate_escalation_disabled');
  });

  it("hitlChannel 'bridge': gate trip emits mission.hitl_required with the gate envelope", async () => {
    const { shim, supervisor } = makeShim();
    shim.dispatch('s', {
      mission_id: 'm-gate2',
      objective: 'x',
      completion: 'y',
      metadata: { hitlChannel: 'bridge' },
    });
    await new Promise((r) => supervisor.once('loop:started', r));

    const events: any[] = [];
    shim.on('event', (e: any) => events.push(e));

    const result = shim.handleSandboxGateTrip('m-gate2', makeGateError());

    expect(result.routed).toBe(true);
    expect(result.channel).toBe('bridge');
    expect(result.hitlId).toBe('hitl-m-gate2-sandbox-gate');

    const hitl = events.find((e) => e.event === 'mission.hitl_required');
    expect(hitl).toBeDefined();
    expect(hitl.mission_id).toBe('m-gate2');
    expect(hitl.data.hitl_id).toBe('hitl-m-gate2-sandbox-gate');
    expect(hitl.data.prompt).toContain('unwritable under provider sandbox root');
    // Schema conformance: context is a string ($defs/data_mission_hitl_required),
    // and additionalProperties:false → exactly these three keys.
    expect(typeof hitl.data.context).toBe('string');
    expect(Object.keys(hitl.data).sort()).toEqual(['context', 'hitl_id', 'prompt']);
    expect(hitl.data.context).toContain('kind=sandbox_gate_trip');
    expect(hitl.data.context).toContain('target=/tmp/mission/deliverable.md');
    expect(hitl.data.context).toContain('sandbox_root=/Users/base/deepseek-harness');
    expect(hitl.data.context).toContain('provider=dsh');

    const mission = shim._missions.get('m-gate2');
    expect(mission.state).toBe('hitl-required');
    expect(mission.pendingHitl).toEqual({ hitl_id: 'hitl-m-gate2-sandbox-gate' });
    // The trip is escalated, not failed.
    expect(events.find((e) => e.event === 'mission.failed')).toBeUndefined();
  });

  it('routes gate trips arriving via supervisor loop:failed (Error instance)', async () => {
    const { shim, supervisor } = makeShim();
    shim.dispatch('s', {
      mission_id: 'm-gate3',
      objective: 'x',
      completion: 'y',
      metadata: { hitlChannel: 'bridge' },
    });
    await new Promise((r) => supervisor.once('loop:started', r));

    const events: any[] = [];
    shim.on('event', (e: any) => events.push(e));

    supervisor.failLoop('m-gate3', makeGateError(), false);

    const hitl = events.find((e) => e.event === 'mission.hitl_required');
    expect(hitl).toBeDefined();
    expect(hitl.data.prompt).toContain('unwritable under provider sandbox root');
    expect(shim._missions.get('m-gate3').state).toBe('hitl-required');
    expect(events.find((e) => e.event === 'mission.failed')).toBeUndefined();
  });

  it('stringified gate errors via loop:failed are still recognized (default-off → fail loud)', async () => {
    const { shim, supervisor } = makeShim();
    shim.dispatch('s', { mission_id: 'm-gate4', objective: 'x', completion: 'y' });
    await new Promise((r) => supervisor.once('loop:started', r));

    const events: any[] = [];
    shim.on('event', (e: any) => events.push(e));

    // Supervisors may deliver the error stringified — recognition must hold.
    supervisor.failLoop('m-gate4', makeGateError().message, false);

    expect(events.find((e) => e.event === 'mission.hitl_required')).toBeUndefined();
    const failed = events.find((e) => e.event === 'mission.failed');
    expect(failed).toBeDefined();
    expect(failed.data.reason).toBe('sandbox_gate_escalation_disabled');
    expect(shim._missions.get('m-gate4').state).toBe('failed');
  });

  it('treats unknown hitlChannel values as none (no accidental escalation)', async () => {
    const { shim, supervisor } = makeShim();
    shim.dispatch('s', {
      mission_id: 'm-gate5',
      objective: 'x',
      completion: 'y',
      metadata: { hitlChannel: 'danger-full-access' },
    });
    await new Promise((r) => supervisor.once('loop:started', r));

    const events: any[] = [];
    shim.on('event', (e: any) => events.push(e));

    const result = shim.handleSandboxGateTrip('m-gate5', makeGateError());
    expect(result.routed).toBe(false);
    expect(result.failedLoud).toBe(true);
    expect(events.find((e) => e.event === 'mission.hitl_required')).toBeUndefined();
  });

  it('gate trip for an unknown mission is a no-op', () => {
    const { shim } = makeShim();
    expect(() => shim.handleSandboxGateTrip('nope', makeGateError())).not.toThrow();
    expect(shim.handleSandboxGateTrip('nope', makeGateError()).routed).toBe(false);
  });

  it('synthesizes the fail-loud message when the gate error carries none', async () => {
    const { shim } = makeShim();
    shim.dispatch('s', { mission_id: 'm-gate6', objective: 'x', completion: 'y' });

    const events: any[] = [];
    shim.on('event', (e: any) => events.push(e));

    shim.handleSandboxGateTrip('m-gate6', { target: '/a/b.md', sandboxRoot: '/c' });

    const failed = events.find((e) => e.event === 'mission.failed');
    expect(failed).toBeDefined();
    expect(failed.data.error).toContain('/a/b.md');
    expect(failed.data.error).toContain('/c');
  });
});
