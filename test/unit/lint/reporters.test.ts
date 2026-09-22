/**
 * Lint Reporters Tests
 *
 * Tests for output formatting: full, summary, JSON.
 *
 * @source @src/lint/reporters.ts
 * @issue #810
 */

import { describe, it, expect } from 'vitest';
import { formatResult, formatRulesetList, formatRuleList } from '../../../src/lint/reporters.js';
import type { LintResult, LintRuleset } from '../../../src/lint/types.js';

function makeResult(overrides: Partial<LintResult> = {}): LintResult {
  return {
    target: '/tmp/test',
    rulesets: ['test'],
    diagnostics: [],
    summary: {
      filesChecked: 5,
      errors: 0,
      warnings: 0,
      infos: 0,
      passed: true,
      rulesSelected: 3,
      rulesApplied: 3,
      inapplicableRules: [],
    },
    timestamp: '2026-04-12T00:00:00Z',
    ...overrides,
  };
}

describe('formatResult', () => {
  describe('json format', () => {
    it('produces valid JSON', () => {
      const result = makeResult();
      const output = formatResult(result, 'json');
      const parsed = JSON.parse(output);
      expect(parsed.target).toBe('/tmp/test');
      expect(parsed.summary.passed).toBe(true);
    });

    it('includes all diagnostics in JSON', () => {
      const result = makeResult({
        diagnostics: [
          {
            ruleId: 'test/rule',
            ruleName: 'Test Rule',
            severity: 'error',
            file: 'test.md',
            message: 'Missing field',
          },
        ],
        summary: { filesChecked: 1, errors: 1, warnings: 0, infos: 0, passed: false, rulesSelected: 3, rulesApplied: 3, inapplicableRules: [] },
      });
      const parsed = JSON.parse(formatResult(result, 'json'));
      expect(parsed.diagnostics).toHaveLength(1);
      expect(parsed.diagnostics[0].message).toBe('Missing field');
    });
  });

  describe('summary format', () => {
    it('produces a concise one-line summary', () => {
      const result = makeResult({
        summary: { filesChecked: 10, errors: 2, warnings: 3, infos: 1, passed: false, rulesSelected: 3, rulesApplied: 3, inapplicableRules: [] },
      });
      const output = formatResult(result, 'summary');
      expect(output).toContain('10 files');
      expect(output).toContain('2 errors');
      expect(output).toContain('3 warnings');
      expect(output).toContain('1 info');
      expect(output).toContain('FAIL');
    });

    it('shows PASS when result is passed', () => {
      const result = makeResult();
      const output = formatResult(result, 'summary');
      expect(output).toContain('PASS');
    });
  });

  describe('full format', () => {
    it('includes target and rulesets header', () => {
      const result = makeResult({ rulesets: ['research'] });
      const output = formatResult(result, 'full');
      expect(output).toContain('Target: /tmp/test');
      expect(output).toContain('research');
    });

    it('shows "No issues found" when clean', () => {
      const result = makeResult();
      const output = formatResult(result, 'full');
      expect(output).toContain('No issues found');
    });

    it('groups diagnostics by file', () => {
      const result = makeResult({
        diagnostics: [
          { ruleId: 'r1', ruleName: 'R1', severity: 'error', file: 'a.md', message: 'Error in A' },
          { ruleId: 'r2', ruleName: 'R2', severity: 'warn', file: 'b.md', message: 'Warn in B' },
          { ruleId: 'r3', ruleName: 'R3', severity: 'error', file: 'a.md', message: 'Another error in A' },
        ],
        summary: { filesChecked: 2, errors: 2, warnings: 1, infos: 0, passed: false, rulesSelected: 3, rulesApplied: 3, inapplicableRules: [] },
      });
      const output = formatResult(result, 'full');
      expect(output).toContain('a.md');
      expect(output).toContain('b.md');
      expect(output).toContain('Error in A');
      expect(output).toContain('Warn in B');
    });
  });
});

describe('formatRulesetList', () => {
  it('lists rulesets with metadata', () => {
    const rulesets: LintRuleset[] = [{
      id: 'research',
      name: 'Research Corpus Lint Rules',
      description: 'Validate research corpus',
      framework: 'research-complete',
      version: '1.0.0',
      rules: [
        { id: 'r1', name: 'R1', description: '', severity: 'error', appliesTo: { glob: '*' }, checks: [] },
        { id: 'r2', name: 'R2', description: '', severity: 'warn', appliesTo: { glob: '*' }, checks: [] },
      ],
    }];

    const output = formatRulesetList(rulesets);
    expect(output).toContain('research');
    expect(output).toContain('research-complete');
    expect(output).toContain('2 rule(s)');
  });

  it('shows helpful message when no rulesets found', () => {
    const output = formatRulesetList([]);
    expect(output).toContain('No lint rulesets found');
  });
});

describe('formatRuleList', () => {
  it('lists rules with severity icons', () => {
    const ruleset: LintRuleset = {
      id: 'test',
      name: 'Test',
      description: '',
      framework: 'test-framework',
      version: '1.0.0',
      rules: [
        { id: 'test/err', name: 'Error Rule', description: 'An error', severity: 'error', appliesTo: { glob: '*.md' }, checks: [] },
        { id: 'test/warn', name: 'Warn Rule', description: 'A warning', severity: 'warn', appliesTo: { glob: '*.md' }, checks: [] },
        { id: 'test/info', name: 'Info Rule', description: 'An info', severity: 'info', appliesTo: { glob: '*.md' }, checks: [] },
      ],
    };

    const output = formatRuleList(ruleset);
    expect(output).toContain('test/err');
    expect(output).toContain('test/warn');
    expect(output).toContain('test/info');
    expect(output).toContain('[error]');
    expect(output).toContain('[warn]');
    expect(output).toContain('[info]');
  });
});

describe('rule applicability reporting (#2555)', () => {
  it('names how many rules applied in both full and summary output', () => {
    const result = makeResult({ summary: { filesChecked: 5, errors: 0, warnings: 0, infos: 0, passed: true, rulesSelected: 11, rulesApplied: 4, inapplicableRules: ['a', 'b'] } });
    expect(formatResult(result, 'full')).toContain('Rules applied: 4 of 11');
    expect(formatResult(result, 'summary')).toContain('Rules applied: 4 of 11');
    expect(formatResult(result, 'full')).toContain('2 rule(s) matched no file here: a, b');
  });

  it('says a no-rule-applies run is not a clean result instead of showing only PASS', () => {
    const result = makeResult({ summary: { filesChecked: 2542, errors: 0, warnings: 0, infos: 0, passed: true, rulesSelected: 11, rulesApplied: 0, inapplicableRules: ['r1'] } });
    const full = formatResult(result, 'full');
    expect(full).toContain('No rule applies to this target');
    expect(full).toContain('0 of 11 selected rules matched any file here');
    expect(full).toContain('Lint a parent directory');
    expect(formatResult(result, 'summary')).toContain('this is not a clean result');
  });
});
