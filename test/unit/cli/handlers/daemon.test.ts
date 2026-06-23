/**
 * Unit tests for daemon.ts handler
 * Covers daemon, behavior, and daemon-init commands.
 *
 * @issue #689
 * @parent #684
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HandlerContext } from '../../../../src/cli/handlers/types.js';

// ── Mocks ────────────────────────────────────────────────────

const mockRun = vi.fn().mockResolvedValue({ exitCode: 0 });

vi.mock('../../../../src/cli/handlers/script-runner.js', () => ({
  createScriptRunner: vi.fn(() => ({ run: mockRun })),
}));

vi.mock('../../../../src/channel/manager.mjs', () => ({
  getFrameworkRoot: vi.fn().mockResolvedValue('/mock/framework/root'),
}));

import {
  daemonHandler,
  behaviorHandler,
  daemonInitHandler,
  daemonHandlers,
} from '../../../../src/cli/handlers/daemon.js';

// ── Helpers ───────────────────────────────────────────────────

function makeCtx(args: string[] = []): HandlerContext {
  return {
    args,
    rawArgs: args,
    cwd: '/mock/cwd',
    frameworkRoot: '/mock/framework/root',
  };
}

// ── daemonHandler ─────────────────────────────────────────────

describe('daemonHandler', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRun.mockResolvedValue({ exitCode: 0 }); });

  it('has correct metadata', () => {
    expect(daemonHandler.id).toBe('daemon');
    expect(daemonHandler.category).toBe('daemon');
    expect(daemonHandler.name).toBe('Daemon');
    expect(typeof daemonHandler.execute).toBe('function');
  });

  it('aliases contain id', () => {
    expect(daemonHandler.aliases).toContain('daemon');
  });

  it('delegates to tools/daemon/index.mjs', async () => {
    await daemonHandler.execute(makeCtx(['status']));
    expect(mockRun).toHaveBeenCalledWith('tools/daemon/index.mjs', ['status']);
  });

  it('passes start args', async () => {
    await daemonHandler.execute(makeCtx(['start', '--foreground']));
    expect(mockRun).toHaveBeenCalledWith('tools/daemon/index.mjs', ['start', '--foreground']);
  });

  it('forwards non-zero exit', async () => {
    mockRun.mockResolvedValue({ exitCode: 1 });
    const result = await daemonHandler.execute(makeCtx(['start']));
    expect(result.exitCode).toBe(1);
  });
});

// ── behaviorHandler ───────────────────────────────────────────

describe('behaviorHandler', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRun.mockResolvedValue({ exitCode: 0 }); });

  it('has correct metadata', () => {
    expect(behaviorHandler.id).toBe('behavior');
    expect(behaviorHandler.category).toBe('daemon');
    expect(behaviorHandler.name).toBe('Behavior');
    expect(typeof behaviorHandler.execute).toBe('function');
  });

  it('aliases contain id', () => {
    expect(behaviorHandler.aliases).toContain('behavior');
  });

  it('delegates to tools/daemon/behavior.mjs', async () => {
    await behaviorHandler.execute(makeCtx());
    expect(mockRun).toHaveBeenCalledWith('tools/daemon/behavior.mjs', []);
  });

  it('passes list subcommand args', async () => {
    await behaviorHandler.execute(makeCtx(['list']));
    expect(mockRun).toHaveBeenCalledWith('tools/daemon/behavior.mjs', ['list']);
  });

  it('passes enable <name> args', async () => {
    await behaviorHandler.execute(makeCtx(['enable', 'teach-mode']));
    expect(mockRun).toHaveBeenCalledWith('tools/daemon/behavior.mjs', ['enable', 'teach-mode']);
  });

  it('passes disable <name> args', async () => {
    await behaviorHandler.execute(makeCtx(['disable', 'teach-mode']));
    expect(mockRun).toHaveBeenCalledWith('tools/daemon/behavior.mjs', ['disable', 'teach-mode']);
  });

  it('passes status args', async () => {
    await behaviorHandler.execute(makeCtx(['status']));
    expect(mockRun).toHaveBeenCalledWith('tools/daemon/behavior.mjs', ['status']);
  });

  it('forwards non-zero exit (unknown behavior name)', async () => {
    mockRun.mockResolvedValue({ exitCode: 1 });
    const result = await behaviorHandler.execute(makeCtx(['enable', 'nonexistent']));
    expect(result.exitCode).toBe(1);
  });

  it('exits 0 on success', async () => {
    const result = await behaviorHandler.execute(makeCtx(['list']));
    expect(result.exitCode).toBe(0);
  });
});

// ── daemonInitHandler ─────────────────────────────────────────

describe('daemonInitHandler', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRun.mockResolvedValue({ exitCode: 0 }); });

  it('has correct metadata', () => {
    expect(daemonInitHandler.id).toBe('daemon-init');
    expect(daemonInitHandler.category).toBe('daemon');
    expect(daemonInitHandler.name).toBe('Daemon Init');
    expect(typeof daemonInitHandler.execute).toBe('function');
  });

  it('delegates to tools/daemon/init-profile.mjs', async () => {
    await daemonInitHandler.execute(makeCtx());
    expect(mockRun).toHaveBeenCalledWith('tools/daemon/init-profile.mjs', []);
  });

  it('passes --provider warp flag', async () => {
    await daemonInitHandler.execute(makeCtx(['--provider', 'warp']));
    expect(mockRun).toHaveBeenCalledWith('tools/daemon/init-profile.mjs', ['--provider', 'warp']);
  });

  it('passes --provider claude flag', async () => {
    await daemonInitHandler.execute(makeCtx(['--provider', 'claude']));
    expect(mockRun).toHaveBeenCalledWith('tools/daemon/init-profile.mjs', ['--provider', 'claude']);
  });

  it('forwards non-zero exit (missing agentic root)', async () => {
    mockRun.mockResolvedValue({ exitCode: 1, message: 'Agentic root not found' });
    const result = await daemonInitHandler.execute(makeCtx());
    expect(result.exitCode).toBe(1);
  });

  it('exits 0 on idempotent re-init', async () => {
    const result = await daemonInitHandler.execute(makeCtx());
    expect(result.exitCode).toBe(0);
  });
});

// ── daemonHandlers array ──────────────────────────────────────

describe('daemonHandlers', () => {
  it('exports exactly 3 handlers', () => {
    expect(daemonHandlers).toHaveLength(3);
    const ids = daemonHandlers.map(h => h.id);
    expect(ids).toContain('daemon');
    expect(ids).toContain('behavior');
    expect(ids).toContain('daemon-init');
  });

  it('all handlers have required properties', () => {
    for (const handler of daemonHandlers) {
      expect(handler.id).toBeDefined();
      expect(handler.name).toBeDefined();
      expect(handler.description).toBeDefined();
      expect(handler.category).toBe('daemon');
      expect(Array.isArray(handler.aliases)).toBe(true);
      expect(typeof handler.execute).toBe('function');
    }
  });
});
