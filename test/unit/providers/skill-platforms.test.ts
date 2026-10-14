import { describe, expect, it } from 'vitest';
import { parseSkillPlatforms, skillMatchesProvider } from '../../../tools/agents/providers/base.mjs';

describe('skill platform scalars', () => {
  for (const quote of ['', "'", '"']) {
    for (const format of ['inline', 'block']) {
      it.each(['all', 'codex', 'claude-code'])(
        `matches %s with ${quote || 'plain'} scalars in a ${format} list`, (platform) => {
          const scalar = `${quote}${platform}${quote}`;
          const field = format === 'inline' ? `platforms: [${scalar}]` : `platforms:\n  - ${scalar}`;
          const content = `---\n${field}\n---\nBody.\n`;
          expect(parseSkillPlatforms(content)).toEqual(platform === 'all' ? null : [platform]);
          expect(skillMatchesProvider(content, 'codex')).toBe(platform === 'all' || platform === 'codex');
          expect(skillMatchesProvider(content, 'claude')).toBe(platform === 'all' || platform === 'claude-code');
        },
      );
    }
  }

  it.each(['platforms: ["codex", \'claude-code\']', 'platforms:\n  - "codex"\n  - \'claude-code\''])(
    'preserves multiple quoted restrictions: %s', (field) => {
      const content = `---\n${field}\n---\nBody.\n`;
      expect(parseSkillPlatforms(content)).toEqual(['codex', 'claude-code']);
      expect(skillMatchesProvider(content, 'codex')).toBe(true);
      expect(skillMatchesProvider(content, 'claude')).toBe(true);
      expect(skillMatchesProvider(content, 'hermes')).toBe(false);
    },
  );
});
