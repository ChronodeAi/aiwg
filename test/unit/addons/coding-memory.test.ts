import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ADDON_ROOT = resolve('agentic/code/addons/coding-memory');

function read(path: string): string {
  return readFileSync(resolve(ADDON_ROOT, path), 'utf8');
}

describe('coding-memory addon', () => {
  it('registers one lifecycle behavior, one audit skill, and one evidence rule', () => {
    const manifest = JSON.parse(read('manifest.json')) as {
      id: string;
      behaviors: string[];
      skills: string[];
      rules: string[];
      configuration: { defaults: Record<string, unknown> };
    };

    expect(manifest.id).toBe('coding-memory');
    expect(manifest.behaviors).toEqual(['coding-memory-lifecycle']);
    expect(manifest.skills).toEqual(['coding-memory-audit']);
    expect(manifest.rules).toEqual(['coding-memory-evidence']);
    expect(manifest.configuration.defaults).toMatchObject({
      projectScopeRequired: true,
      captureProfile: 'balanced',
      privacy: 'strict',
      externalProcessing: false,
      contextTokenBudget: 2000,
      maximumRecallResults: 5,
      nativeMemorySync: false,
    });
  });

  it('encodes the complete evidence-gated lifecycle', () => {
    const behavior = read('behaviors/coding-memory-lifecycle/BEHAVIOR.md');

    expect(behavior).toContain(
      'Recall -> Verify -> Explore -> Act -> Test -> Record -> Promote -> Commit -> Close',
    );
    expect(behavior).toContain('2,000 tokens');
    expect(behavior).toContain('at most three candidates');
    expect(behavior).toContain('link the full SHA');
    expect(behavior).toContain('Do not claim commit coverage from configuration alone');
  });

  it('keeps memory advisory, scoped, private, and provenance-gated', () => {
    const rule = read('rules/coding-memory-evidence.md');

    expect(rule).toMatch(/Neither is\s+proof/);
    expect(rule).toContain('Never inject global or other-project records');
    expect(rule).toContain('Do not save recalled content as fresh evidence');
    expect(rule).toContain('Strict projects deny external processing');
    expect(rule).toContain('explicit user acceptance');
  });

  it('routes the audit through provider-neutral premium reasoning metadata', () => {
    const skill = read('skills/coding-memory-audit/SKILL.md');

    expect(skill).toContain('name: coding-memory-audit');
    expect(skill).toContain('modelRole: reasoning');
    expect(skill).toContain('modelTier: premium');
    expect(skill).not.toMatch(/gpt-|claude-sonnet|claude-opus/);
    expect(skill).toContain('memory_project_health(project)');
    expect(skill).toContain('Zero cross-project leakage');
  });
});
