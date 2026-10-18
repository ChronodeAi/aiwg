/**
 * Lint Handler Tests
 *
 * Tests for the lint CLI handler registration and delegation.
 *
 * @source @src/cli/handlers/lint.ts
 * @issue #810
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HandlerContext } from '../../../../src/cli/handlers/types.js';

// Mock the lint CLI module
const mockLintMain = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../../src/lint/cli.js', () => ({
  main: mockLintMain,
}));

// Import handler after mocks
import { lintHandler } from '../../../../src/cli/handlers/lint.js';

const baseContext: HandlerContext = {
  args: [],
  rawArgs: ['aiwg', 'lint'],
  cwd: '/mock/project',
  frameworkRoot: '/mock/framework',
};

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
});

describe('lintHandler', () => {
  it('has correct metadata', () => {
    expect(lintHandler.id).toBe('lint');
    expect(lintHandler.name).toBe('Lint');
    expect(lintHandler.category).toBe('utility');
    expect(lintHandler.aliases).toContain('-lint');
    expect(lintHandler.aliases).toContain('--lint');
  });

  it('delegates to lint CLI main with args', async () => {
    const ctx = { ...baseContext, args: ['.aiwg/research/', '--format', 'json'] };
    const result = await lintHandler.execute(ctx);

    expect(mockLintMain).toHaveBeenCalledWith(['.aiwg/research/', '--format', 'json']);
    expect(result.exitCode).toBe(0);
  });

  it('routes help through the lint CLI so --allow-empty is documented', async () => {
    const result = await lintHandler.help!(baseContext);
    expect(mockLintMain).toHaveBeenCalledWith(['--help']);
    expect(result.exitCode).toBe(0);
  });

  it('delegates --list-rulesets', async () => {
    const ctx = { ...baseContext, args: ['--list-rulesets'] };
    const result = await lintHandler.execute(ctx);

    expect(mockLintMain).toHaveBeenCalledWith(['--list-rulesets']);
    expect(result.exitCode).toBe(0);
  });

  it('returns exitCode 1 when lint CLI throws', async () => {
    mockLintMain.mockRejectedValueOnce(new Error('lint exploded'));
    const ctx = { ...baseContext, args: ['.aiwg/'] };
    const result = await lintHandler.execute(ctx);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('lint exploded');
  });

  it('passes empty args when no arguments given', async () => {
    const result = await lintHandler.execute(baseContext);

    expect(mockLintMain).toHaveBeenCalledWith([]);
    expect(result.exitCode).toBe(0);
  });
});
