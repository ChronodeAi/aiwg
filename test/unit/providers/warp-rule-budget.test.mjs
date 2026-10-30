import { describe, expect, it } from 'vitest';
import { warpRuleContent } from '../../../tools/agents/providers/rule-delivery.mjs';
import { guardRulesInlineBudget } from '../../../src/rules/inline-budget.mjs';

describe('Warp aggregate rule budget', () => {
  const managed = '<!-- AIWG:rule-startup:start -->\n## Rule: kernel\nKernel policy.\n<!-- AIWG:rule-startup:end -->';
  for (const heading of ['AIWG Rules', 'On-Demand Rules']) {
    it(`counts the legacy ${heading} section and managed block exactly once`, () => {
      const section = `## ${heading}\nRule policy or fetch obligation.\n`;
      const projected = warpRuleContent(`## Agents\n${'agent '.repeat(5000)}\n${section}## Commands\ncommand\n${managed}`);
      expect(projected).toBe(`${section}\n${managed}`);
      expect(guardRulesInlineBudget({ provider: 'warp', files: [{ path: 'WARP.md', content: projected }], config: { rules: { inline_budget_tokens: 1 } }, env: {} }).passed).toBe(false);
    });
  }
  it('counts a final rule listing without a following heading', () => {
    expect(warpRuleContent('## On-Demand Rules\r\nFetch policy.')).toBe('## On-Demand Rules\r\nFetch policy.');
  });
});
