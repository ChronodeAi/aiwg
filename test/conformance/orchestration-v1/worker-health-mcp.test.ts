/** T-OG-17: MCP observer semantics; worker-invoke bridge deferred to #2892. */
import { describe, expect, it } from 'vitest';
// @ts-expect-error Shared runtime observer owner.
import { createWorkerHealthObserver } from '../../../tools/ralph-external/lib/worker-health.mjs';

function fixture() {
  let now = 0;
  const observer = createWorkerHealthObserver({ transport: 'mcp', invocationId: 'request-a',
    health: { handshake: 'semantic', outputFraming: 'mcp-progress', progressEvidence: ['completed item'] },
    now: () => now, wallNow: () => Date.UTC(2026, 9, 8) });
  return { observer, set: (time: number) => { now = time; } };
}

describe('T-OG-17 MCP execution observation', () => {
  it.each(['initialize', 'ping', 'tools/list', 'notifications/cancelled'])('MCP-TRANSPORT-%s: transport is not execution evidence', method => {
    const { observer } = fixture();
    const notification = { jsonrpc: '2.0', method, params: { requestId: 'request-a', progress: 1, stopped: true } };
    observer.processStarted({ pid: process.pid, startTicks: '1', executable: process.execPath });
    observer.observe(notification);
    observer.feed(Buffer.from(JSON.stringify(notification) + '\n'));
    expect(observer.snapshot()).toMatchObject({ state: 'launching', handshake: 'unobserved',
      termination: 'running', lastProgressAt: null });
    expect(observer.evidence().events).toEqual([]);
    expect(observer.shouldStop()).toBe(false);
  });

  it('MCP-CANCEL-UNCERTAIN: delivery never establishes progress, terminal evidence or confirmed stop', () => {
    const { observer, set } = fixture();
    observer.observe({ kind: 'accepted' });
    set(1000); observer.observe({ kind: 'progress', key: 'completed-1' });
    const progress = observer.snapshot().lastProgressAt;
    set(2000);
    observer.observe({ method: 'notifications/cancelled', stopped: true });
    observer.feed(Buffer.from('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"stopped":true}}\n'));
    expect(observer.snapshot()).toMatchObject({ state: 'active', termination: 'running', lastProgressAt: progress });
    expect(observer.evidence().events.map((event: any) => event.kind)).toEqual(['accepted', 'progress']);
    expect(observer.shouldStop()).toBe(false);
    observer.disconnect();
    expect(observer.snapshot().termination).toBe('uncertain');
  });
});
