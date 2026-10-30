import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { startExecutorServer } from '../../../tools/ralph-external/executor-shim.mjs';

const state = vi.hoisted(() => ({ fetch: null as any, server: null as any, upgrade: vi.fn() }));
vi.mock('@hono/node-server', () => ({
  serve: (options: any) => { state.fetch = options.fetch; return state.server; },
  getNodeListener: (fetch: any) => fetch,
}));
vi.mock('ws', () => ({ WebSocketServer: class { handleUpgrade = state.upgrade; } }));

let shim: any;
beforeEach(async () => {
  state.server = new EventEmitter();
  state.server.close = vi.fn();
  state.upgrade.mockClear();
  shim = { executorId: 'executor', dispatch: vi.fn(() => ({ mission_id: 'mission' })),
    getMission: vi.fn(), submitHitlResponse: vi.fn(), pauseMission: vi.fn(), resumeMission: vi.fn(), abortMission: vi.fn() };
  await startExecutorServer(shim, { port: 8200, bind: '127.0.0.1', token: 'executor-secret' });
});

describe('executor REST token authentication', () => {
  it.each([
    ['POST', '/api/v1/sessions/session/dispatch'],
    ['GET', '/api/v1/missions/mission'],
    ['POST', '/api/v1/missions/mission/hitl_response'],
    ['POST', '/api/v1/missions/mission/pause'],
    ['POST', '/api/v1/missions/mission/resume'],
    ['POST', '/api/v1/missions/mission/abort'],
  ])('rejects missing and wrong tokens on %s %s', async (method, path) => {
    for (const authorization of ['', 'Bearer wrong', `Bearer ${'x'.repeat(1000)}`]) {
      const response = await state.fetch(new Request(`http://localhost${path}`, { method, headers: { authorization } }));
      expect(response.status).toBe(401);
    }
    for (const operation of ['dispatch', 'getMission', 'submitHitlResponse', 'pauseMission', 'resumeMission', 'abortMission']) {
      expect(shim[operation]).not.toHaveBeenCalled();
    }
  });

  it('accepts dispatch with the current token', async () => {
    const response = await state.fetch(new Request('http://localhost/api/v1/sessions/session/dispatch', {
      method: 'POST', headers: { authorization: 'Bearer executor-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ mission_id: 'mission', objective: 'test', completion: 'done' }),
    }));
    expect(response.status).toBe(202);
    expect(shim.dispatch).toHaveBeenCalledOnce();
  });
});

describe('executor WebSocket token authentication', () => {
  it.each(['', 'wrong', 'x'.repeat(1000), 'executor-secret'])('authenticates the upgrade token %j', token => {
    const socket = { destroy: vi.fn() };
    state.server.emit('upgrade', { url: `/ws/executors/executor?token=${token}`, headers: { host: 'localhost' } }, socket, Buffer.alloc(0));
    if (token === 'executor-secret') {
      expect(state.upgrade).toHaveBeenCalledOnce();
      expect(socket.destroy).not.toHaveBeenCalled();
    } else {
      expect(state.upgrade).not.toHaveBeenCalled();
      expect(socket.destroy).toHaveBeenCalledOnce();
    }
  });
});
