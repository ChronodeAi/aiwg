import { describe, expect, it } from 'vitest';
import { allHandlers } from '../../../../src/cli/handlers/index.js';
import { decisionHandler } from '../../../../src/cli/handlers/decision.js';
import { getCommandDefinition, getCommandIds, searchCommandsByKeyword } from '../../../../src/extensions/commands/definitions.js';

describe('decisionHandler', () => {
  it('is registered with command metadata', () => {
    expect(decisionHandler.id).toBe('decision');
    expect(decisionHandler.category).toBe('utility');
    expect(allHandlers.filter(handler => handler.id === 'decision')).toHaveLength(1);
    expect(getCommandDefinition('decision')).toMatchObject({
      id: 'decision',
      description: expect.stringMatching(/classification/i),
    });
    expect(getCommandIds()).toContain('decision');
    expect(searchCommandsByKeyword('classification').map(command => command.id)).toContain('decision');
  });

  it('returns machine-readable capabilities', async () => {
    const result = await decisionHandler.execute({
      args: ['capabilities'],
      rawArgs: ['decision', 'capabilities'],
      cwd: process.cwd(),
      frameworkRoot: process.cwd(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.rawOutput).toBe(true);
    expect(JSON.parse(result.message ?? '{}')).toMatchObject({ offlineReady: true, backend: { status: 'not-probed' } });
  });
});
