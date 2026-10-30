/**
 * Unit tests for daemon.ts handler
 * Covers lifecycle, behavior and daemon-init commands.
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
    expect(daemonHandlers).toContain(daemonHandler);
    const ids = daemonHandlers.map(h => h.id);
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

describe('daemonHandler', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRun.mockResolvedValue({ exitCode: 0 }); });

  it.each([['status'], ['start', '--foreground'], ['chat', 'hello']])('forwards argv %j to the existing daemon entry point', async (...args) => {
    await daemonHandler.execute(makeCtx(args));
    expect(mockRun).toHaveBeenCalledWith('tools/daemon/index.mjs', args, { cwd: '/mock/cwd' });
  });

  it('forces help instead of executing a lifecycle command', async () => {
    await daemonHandler.help!(makeCtx(['start', '--help']));
    expect(mockRun).toHaveBeenCalledWith('tools/daemon/index.mjs', ['--help'], { cwd: '/mock/cwd' });
  });

  it('preserves a daemon failure exit code', async () => {
    mockRun.mockResolvedValue({ exitCode: 1 });
    expect((await daemonHandler.execute(makeCtx(['stop']))).exitCode).toBe(1);
  });
});

describe('handlers barrel', () => {
  it('re-exports daemonHandler alongside the other daemon handlers', async () => {
    const barrel = await import('../../../../src/cli/handlers/index.js');
    const daemon = await import('../../../../src/cli/handlers/daemon.js');
    expect(barrel.daemonHandler).toBe(daemon.daemonHandler);
  });
});
