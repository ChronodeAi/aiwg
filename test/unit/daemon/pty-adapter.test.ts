import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const loadModule = async () => {
  const mod = await import('../../../tools/daemon/pty-adapter.mjs');
  return mod;
};

describe('PTYAdapter sandbox transport', () => {
  let sessionId: string;
  let sessionPath: string;
  let oldEndpoint: string | undefined;
  let oldAgentId: string | undefined;

  beforeEach(() => {
    sessionId = `sandbox-session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessionPath = join('.aiwg', 'daemon', 'pty', `${sessionId}.json`);
    oldEndpoint = process.env.AIWG_SANDBOX_ENDPOINT;
    oldAgentId = process.env.AIWG_SANDBOX_AGENT_ID;
  });

  afterEach(() => {
    if (oldEndpoint === undefined) {
      delete process.env.AIWG_SANDBOX_ENDPOINT;
    } else {
      process.env.AIWG_SANDBOX_ENDPOINT = oldEndpoint;
    }
    if (oldAgentId === undefined) {
      delete process.env.AIWG_SANDBOX_AGENT_ID;
    } else {
      process.env.AIWG_SANDBOX_AGENT_ID = oldAgentId;
    }
    rmSync(sessionPath, { force: true });
  });

  it('auto-selects sandbox transport when AIWG_SANDBOX_ENDPOINT is set', async () => {
    process.env.AIWG_SANDBOX_ENDPOINT = 'http://127.0.0.1:8122';
    process.env.AIWG_SANDBOX_AGENT_ID = 'agent-test';

    const { PTYAdapter } = await loadModule();
    const adapter = PTYAdapter.auto({ platform: 'codex', cols: 120, rows: 40 });

    expect((adapter as any)._transport).toBeDefined();
    expect((adapter as any)._transport.httpEndpoint).toBe('http://127.0.0.1:8122');
    expect((adapter as any)._transport.agentId).toBe('agent-test');
  });

  it('lists and resolves sandbox-backed sessions without a local PID', async () => {
    const { PTYAdapter } = await loadModule();
    PTYAdapter._ensureSessionDir();

    writeFileSync(sessionPath, JSON.stringify({
      sessionId,
      platform: 'codex',
      bin: 'codex',
      pid: null,
      cols: 120,
      rows: 40,
      cwd: '/home/agent',
      started_at: new Date().toISOString(),
      transport: 'sandbox',
      httpEndpoint: 'http://127.0.0.1:8122',
      agentId: 'agent-test',
      commandId: 'task-123',
    }, null, 2));

    const sessions = PTYAdapter.list();
    const listed = sessions.find((session: any) => session.sessionId === sessionId);
    expect(listed).toBeDefined();
    expect(listed.transport).toBe('sandbox');

    const session = PTYAdapter.getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session.commandId).toBe('task-123');
    expect(existsSync(sessionPath)).toBe(true);
  });
});
