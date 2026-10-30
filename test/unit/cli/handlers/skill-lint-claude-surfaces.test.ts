// Exercise Claude per-surface projection through the public lint handler.
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lintSkillFile, skillLintHandler } from '../../../../src/cli/handlers/skill-lint.js';
import { projectClaudeSkillSurfaces } from '../../../../src/skills/claude-surface-projection.js';

const fixture = path.resolve('test/fixtures/agent-skills/claude-native/SKILL.md');
afterEach(() => vi.restoreAllMocks());

describe('skill-lint Claude surfaces', () => {
  it('accepts native effort and reports filesystem and shell projection separately', async () => {
    const result = await lintSkillFile(fixture);
    expect(result.conformance.state).toBe('warning'); // portable allowed-tools advisory
    expect(result.dimensions.schema.score).toBe(100);
    expect(result.projections.map((p) => [p.surface, p.status, p.shellInterpolation])).toEqual([
      ['cli', 'native', 'native'],
      ['desktop-code', 'native', 'native'],
      ['cowork', 'unsupported', 'degraded'],
      ['cloud', 'unsupported', 'unsupported'],
    ]);
    expect(result.projections[2].reasons.join(' ')).toMatch(/policy notice/);
    expect(result.projections[3].reasons.join(' ')).toMatch(/claude.ai account/);
  });

  it('omits shell claims for skills without shell interpolation', () => {
    const projections = projectClaudeSkillSurfaces('Read a document.');
    expect(projections.every((p) => p.shellInterpolation === undefined)).toBe(true);
    expect(projections.map((p) => p.status)).toEqual(['native', 'native', 'unsupported', 'unsupported']);
  });

  it.each([false, true])('renders per-surface status (json=%s)', async (json) => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const args = [fixture, ...(json ? ['--json'] : [])];
    await skillLintHandler.execute({ args, rawArgs: args, cwd: process.cwd(), frameworkRoot: process.cwd() });
    const rendered = output.mock.calls.map(([value]) => String(value)).join('\n');
    if (json) {
      const report = JSON.parse(rendered);
      expect(report.files[0].projections).toHaveLength(4);
      expect(report.files[0].projections[2]).toMatchObject({ surface: 'cowork', status: 'unsupported', shellInterpolation: 'degraded' });
    } else {
      for (const surface of ['cli', 'desktop-code', 'cowork', 'cloud']) expect(rendered).toContain(`claude/${surface}:`);
      expect(rendered).toContain('shell: degraded');
    }
  });

  it('keeps strict lint invalid for Claude native fields', async () => {
    const result = await lintSkillFile(fixture, 'standard', 'strict');
    expect(result.passes).toBe(false);
    expect(result.dimensions.schema.score).toBe(0);
    expect(result.conformance.diagnostics).toContainEqual(expect.objectContaining({
      code: 'AS_FIELD_EXTENSION', yamlPath: '$.context', severity: 'error',
    }));
  });
});
