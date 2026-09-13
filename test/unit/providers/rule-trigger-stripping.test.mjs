/**
 * Rules declare trigger phrases so discovery can reach them by the question an
 * agent asks. That is index-time metadata — no provider matches a *rule* by
 * trigger — so shipping it into deployed rules spends startup context on noise.
 *
 * @issue #2544
 */
import { describe, it, expect } from 'vitest';
import { stripTriggersFromContent } from '../../../tools/agents/providers/base.mjs';

const RULE = `---
enforcement: critical
triggers:
  - "how do I handle a token safely"
  - "where do I put an api key"
---

# Token Security Rules

Body stays.
`;

describe('stripTriggersFromContent (#2544)', () => {
  it('removes the triggers block and keeps the rest of the frontmatter', () => {
    const out = stripTriggersFromContent(RULE);
    expect(out).toContain('enforcement: critical');
    expect(out).not.toContain('triggers:');
    expect(out).not.toContain('api key');
    expect(out).toContain('# Token Security Rules');
    expect(out).toContain('Body stays.');
  });

  it('leaves no blank line before the closing fence', () => {
    expect(stripTriggersFromContent(RULE)).toContain('enforcement: critical\n---\n');
  });

  it('handles the inline list form', () => {
    const out = stripTriggersFromContent('---\nenforcement: high\ntriggers: ["a", "b"]\n---\n\n# Rule\n');
    expect(out).not.toContain('triggers:');
    expect(out).toContain('enforcement: high');
  });

  it('drops frontmatter entirely when triggers were its only key', () => {
    const out = stripTriggersFromContent('---\ntriggers:\n  - "a phrase"\n---\n\n# Rule\n');
    expect(out).toBe('# Rule\n');
  });

  it('returns content unchanged when there are no triggers', () => {
    const unchanged = '---\nenforcement: high\n---\n\n# Rule\n';
    expect(stripTriggersFromContent(unchanged)).toBe(unchanged);
    expect(stripTriggersFromContent('# No frontmatter\n')).toBe('# No frontmatter\n');
  });
});
