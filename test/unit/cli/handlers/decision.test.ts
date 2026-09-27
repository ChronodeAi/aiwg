import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

  it('evaluates through the CLI handler with an operator-selected trusted host policy module', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-cli-'));
    const setup = await decisionHandler.execute({
      args: ['setup', 'synthetic-classification', '--output-dir', dir],
      rawArgs: ['decision', 'setup', 'synthetic-classification', '--output-dir', dir],
      cwd: process.cwd(),
      frameworkRoot: process.cwd(),
    });
    expect(setup.exitCode).toBe(0);
    const modulePath = path.join(dir, 'trusted-host-policies.mjs');
    await writeFile(modulePath, 'export default {};\n');
    const previous = process.env.AIWG_DECISION_ENABLED;
    process.env.AIWG_DECISION_ENABLED = '1';
    try {
      const result = await decisionHandler.execute({
        args: ['evaluate', '--request', path.join(dir, 'dispatcher-request.json'), '--host-policy-module', modulePath],
        rawArgs: ['decision', 'evaluate', '--request', path.join(dir, 'dispatcher-request.json'), '--host-policy-module', modulePath],
        cwd: process.cwd(),
        frameworkRoot: process.cwd(),
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.message ?? '{}')).toMatchObject({ exitCode: 0, result: { kind: 'RulesetResult' } });
    } finally {
      if (previous === undefined) delete process.env.AIWG_DECISION_ENABLED;
      else process.env.AIWG_DECISION_ENABLED = previous;
    }
  });
});
