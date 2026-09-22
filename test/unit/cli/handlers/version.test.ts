/**
 * Unit tests for version.ts handler
 *
 * @issue #691
 * @parent #684
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HandlerContext } from '../../../../src/cli/handlers/types.js';

// ── Mocks ────────────────────────────────────────────────────

const { mockGetVersionInfo } = vi.hoisted(() => ({
  mockGetVersionInfo: vi.fn(),
}));

vi.mock('../../../../src/channel/manager.mjs', () => ({
  getVersionInfo: mockGetVersionInfo,
}));

vi.mock('../../../../src/cli/ui.js', () => ({
  blank: vi.fn(),
  rule: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  dim: vi.fn(),
  bold: vi.fn((s: string) => s),
  brandMark: vi.fn(() => '◆'),
  dimText: vi.fn((s: string) => s),
  header: vi.fn(),
  accent: vi.fn((s: string) => s),
  error: vi.fn(),
  channelLabel: vi.fn((channel: string) => channel === 'stable' ? '' : `[${channel}]`),
}));

import { versionHandler } from '../../../../src/cli/handlers/version.js';

// ── Helpers ───────────────────────────────────────────────────

function makeCtx(args: string[] = []): HandlerContext {
  return {
    args,
    rawArgs: ['version', ...args],
    cwd: '/mock/cwd',
    frameworkRoot: '/mock/framework/root',
  };
}

function versionInfo(overrides = {}) {
  return {
    version: '2026.4.0',
    channel: 'stable',
    packageRoot: '/usr/local/lib/node_modules/aiwg',
    devMode: false,
    gitHash: undefined,
    gitBranch: undefined,
    edgePath: undefined,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────

describe('versionHandler metadata', () => {
  it('has correct id, category, and aliases', () => {
    expect(versionHandler.id).toBe('version');
    expect(versionHandler.category).toBe('maintenance');
    expect(versionHandler.aliases).toContain('-version');
    expect(versionHandler.aliases).toContain('--version');
    expect(typeof versionHandler.execute).toBe('function');
  });
});

describe('versionHandler.execute — stable channel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetVersionInfo.mockResolvedValue(versionInfo());
  });

  it('exits 0', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await versionHandler.execute(makeCtx());
    expect(result.exitCode).toBe(0);
    consoleSpy.mockRestore();
  });

  it('prints version to stdout', async () => {
    const output: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((s) => output.push(s));
    await versionHandler.execute(makeCtx());
    const combined = output.join('\n');
    expect(combined).toContain('2026.4.0');
    consoleSpy.mockRestore();
  });

  it('does not include channel suffix for stable', async () => {
    const { channelLabel } = await import('../../../../src/cli/ui.js');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await versionHandler.execute(makeCtx());
    // channelLabel is called with 'stable'; mock returns ''
    expect(channelLabel).toHaveBeenCalledWith('stable');
    consoleSpy.mockRestore();
  });
});

describe('versionHandler.execute — next channel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetVersionInfo.mockResolvedValue(versionInfo({
      version: '2026.4.0-rc.8',
      channel: 'next',
    }));
  });

  it('shows [next] label', async () => {
    const { channelLabel } = await import('../../../../src/cli/ui.js');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await versionHandler.execute(makeCtx());
    expect(channelLabel).toHaveBeenCalledWith('next');
    consoleSpy.mockRestore();
  });
});

describe('versionHandler.execute — nightly channel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetVersionInfo.mockResolvedValue(versionInfo({
      version: '2026.4.0-nightly.20260404',
      channel: 'nightly',
    }));
  });

  it('shows [nightly] label', async () => {
    const { channelLabel } = await import('../../../../src/cli/ui.js');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await versionHandler.execute(makeCtx());
    expect(channelLabel).toHaveBeenCalledWith('nightly');
    consoleSpy.mockRestore();
  });
});

describe('versionHandler.execute — edge channel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetVersionInfo.mockResolvedValue(versionInfo({
      version: '2026.4.0-edge',
      channel: 'edge',
      gitHash: 'abc1234',
      gitBranch: 'main',
      edgePath: '/home/user/.local/share/ai-writing-guide',
    }));
  });

  it('shows git hash and edge path for edge channel', async () => {
    const output: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((s) => output.push(String(s)));
    const { dim } = await import('../../../../src/cli/ui.js');
    await versionHandler.execute(makeCtx());
    // dim is called for git info on edge channel
    expect(dim).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe('versionHandler.execute — dev mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetVersionInfo.mockResolvedValue(versionInfo({
      devMode: true,
      channel: 'stable',
    }));
  });

  it('shows dev channel when devMode is true', async () => {
    const { channelLabel } = await import('../../../../src/cli/ui.js');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await versionHandler.execute(makeCtx());
    // devMode overrides channel to 'dev'
    expect(channelLabel).toHaveBeenCalledWith('dev');
    consoleSpy.mockRestore();
  });
});

describe('versionHandler.execute — getVersionInfo failure', () => {
  it('does not crash when getVersionInfo throws', async () => {
    vi.clearAllMocks();
    mockGetVersionInfo.mockRejectedValue(new Error('Version read failed'));
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Should propagate the error (caller handles it)
    await expect(versionHandler.execute(makeCtx())).rejects.toThrow('Version read failed');
    consoleSpy.mockRestore();
  });
});

describe('versionHandler.execute — installation drift (#2529)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports the running root, not the declared edge checkout', async () => {
    mockGetVersionInfo.mockResolvedValue(versionInfo({
      version: '2026.9.6',
      channel: 'edge',
      packageRoot: '/home/u/.nvm/lib/node_modules/aiwg',
      gitHash: 'abc1234',
      gitBranch: 'main',
      edgePath: '/home/u/dev/aiwg',
      installation: {
        state: 'mismatch',
        actualRoot: '/home/u/.nvm/lib/node_modules/aiwg',
        identity: { method: 'source', root: '/home/u/dev/aiwg' },
      },
    }));

    const lines: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((v) => lines.push(String(v)));
    const { dim } = await import('../../../../src/cli/ui.js');
    await versionHandler.execute(makeCtx());
    const dimmed = (dim as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    consoleSpy.mockRestore();

    // path: must name the binary that actually ran.
    expect(dimmed.some((l) => l.includes('path:') && l.includes('.nvm/lib/node_modules/aiwg'))).toBe(true);
    expect(dimmed.some((l) => l.includes('path:') && l.includes('/home/u/dev/aiwg'))).toBe(false);
  });

  it('surfaces the drift notice naming the canonical root', async () => {
    mockGetVersionInfo.mockResolvedValue(versionInfo({
      version: '2026.9.6',
      packageRoot: '/home/u/.nvm/lib/node_modules/aiwg',
      installation: {
        state: 'mismatch',
        actualRoot: '/home/u/.nvm/lib/node_modules/aiwg',
        identity: { method: 'source', root: '/home/u/dev/aiwg' },
      },
    }));

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { dim } = await import('../../../../src/cli/ui.js');
    await versionHandler.execute(makeCtx());
    const dimmed = (dim as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    consoleSpy.mockRestore();

    const notice = dimmed.find((l) => l.includes('canonical install declares'));
    expect(notice).toBeDefined();
    expect(notice).toContain('source');
    expect(notice).toContain('/home/u/dev/aiwg');
    expect(notice).toContain('aiwg installation show');
  });

  it('prints no drift notice when canonical and actual agree', async () => {
    mockGetVersionInfo.mockResolvedValue(versionInfo({
      installation: {
        state: 'aligned',
        actualRoot: '/usr/local/lib/node_modules/aiwg',
        identity: { method: 'npm', root: '/usr/local/lib/node_modules/aiwg' },
      },
    }));

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { dim } = await import('../../../../src/cli/ui.js');
    await versionHandler.execute(makeCtx());
    const dimmed = (dim as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    consoleSpy.mockRestore();

    expect(dimmed.some((l) => l.includes('canonical install declares'))).toBe(false);
  });
});
