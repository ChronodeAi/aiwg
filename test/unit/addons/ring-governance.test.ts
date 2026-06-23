import { describe, expect, it } from 'vitest';
import { access, readFile } from 'fs/promises';
import { constants } from 'fs';
import { join } from 'path';

const ADDON_PATH = 'agentic/code/addons/ring-governance';

async function readAddonFile(relativePath: string): Promise<string> {
  return readFile(join(ADDON_PATH, relativePath), 'utf-8');
}

describe('ring-governance addon', () => {
  it('registers judge validation content in the addon manifest', async () => {
    const manifest = JSON.parse(await readAddonFile('manifest.json'));

    expect(manifest.rules).toContain('judge-validation-protocol');
    expect(manifest.templates).toContain('judge-validation-card');
    expect(manifest.configuration.defaults.allowUnvalidatedLLMJudgeVerdicts).toBe(false);
    expect(manifest.configuration.defaults.requireJudgeValidationPackage).toBe(true);
  });

  it('ships the judge-validation rule and template files', async () => {
    await expect(
      access(join(ADDON_PATH, 'rules/judge-validation-protocol.md'), constants.F_OK),
    ).resolves.toBeUndefined();
    await expect(
      access(join(ADDON_PATH, 'templates/judge-validation-card.md'), constants.F_OK),
    ).resolves.toBeUndefined();
  });

  it('requires LLM judges to be validated beyond raw agreement', async () => {
    const rule = await readAddonFile('rules/judge-validation-protocol.md');
    const template = await readAddonFile('templates/judge-validation-card.md');

    for (const content of [rule, template]) {
      expect(content).toContain('Chance-corrected agreement');
      expect(content).toContain('Test-retest');
      expect(content).toContain('Position-bias');
    }
    expect(rule).toContain('Exact-match agreement');
    expect(rule).toContain('not sufficient');
  });
});
