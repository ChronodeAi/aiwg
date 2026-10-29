// Merge rules for Claude attribution defaults (#3750 review follow-ups).
import { describe, expect, it } from 'vitest';
import { mergeClaudeAttribution } from '../../../src/extensions/claude-attribution.js';

describe('mergeClaudeAttribution', () => {
  it('keeps an operator sessionUrl: true and warns, like commit and pr', () => {
    const settings: Record<string, unknown> = { attribution: { sessionUrl: true } };
    const warnings: string[] = [];
    mergeClaudeAttribution(settings, warnings);
    expect(settings.attribution).toEqual({ sessionUrl: true, commit: '', pr: '' });
    expect(warnings).toEqual([expect.stringContaining('Preserved operator attribution.sessionUrl')]);
  });

  it('is silent when operator values already match the defaults', () => {
    const settings: Record<string, unknown> = { attribution: { commit: '', pr: '', sessionUrl: false } };
    const warnings: string[] = [];
    mergeClaudeAttribution(settings, warnings);
    expect(warnings).toEqual([]);
  });

  it('leaves a non-object aiwg setting untouched instead of replacing it', () => {
    const settings: Record<string, unknown> = { aiwg: 'operator-value' };
    const warnings: string[] = [];
    mergeClaudeAttribution(settings, warnings);
    expect(settings).toEqual({ aiwg: 'operator-value' });
    expect(warnings).toEqual([expect.stringContaining('non-object "aiwg"')]);
  });
});
