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

describe('skill platform YAML parsing', () => {
  it.each([
    'platforms:\n  # note\n  - codex',
    'platforms:\n  - codex # note\n  # between entries\n  - claude-code',
    'platforms: [codex, # note\n claude-code]',
  ])('preserves restrictions with comments: %s', (field) => {
    const content = `---\n${field}\n---\nBody.\n`;
    const platforms = field.includes('claude-code') ? ['codex', 'claude-code'] : ['codex'];
    expect(parseSkillPlatforms(content)).toEqual(platforms);
    expect(skillMatchesProvider(content, 'codex')).toBe(true);
    expect(skillMatchesProvider(content, 'claude')).toBe(platforms.includes('claude-code'));
    expect(skillMatchesProvider(content, 'hermes')).toBe(false);
  });

  it.each(['all', 'codex', 'claude-code', 'claude'])(
    'accepts plain and quoted standalone %s and preserves aliases', (platform) => {
      for (const quote of ['', "'", '"']) {
        const content = `---\nplatforms: ${quote}${platform}${quote}\n---\nBody.\n`;
        expect(parseSkillPlatforms(content)).toEqual(platform === 'all' ? null : [platform]);
        expect(skillMatchesProvider(content, 'claude')).toBe(['all', 'claude', 'claude-code'].includes(platform));
        expect(skillMatchesProvider(content, 'codex')).toBe(['all', 'codex'].includes(platform));
      }
    },
  );

  it.each(['Body.\n', '---\nname: example\n---\nBody.\n', '---\n---\nBody.\n', '---\n# note\n---\nBody.\n'])(
    'leaves absent platforms unrestricted: %j', (content) => {
      expect(parseSkillPlatforms(content)).toBeNull();
      expect(skillMatchesProvider(content, 'codex')).toBe(true);
    },
  );

  it.each([
    'platforms: []', 'platforms:', 'platforms: null', 'platforms: true',
    'platforms: 42', 'platforms: {codex: true}', 'platforms: [codex, false]',
    'platforms: [codex, null]', 'platforms: [codex, 42]', 'platforms: ""',
    'platforms: [codex, " "]', 'platforms: [codex',
    'platforms: codex\nplatforms: all', 'name: [broken\nplatforms: all',
    '- codex', 'codex', 'null', 'true', '42',
  ])('fails closed on empty, invalid or malformed restrictions: %s', (field) => {
    const content = `---\n${field}\n---\nBody.\n`;
    expect(parseSkillPlatforms(content)).toEqual([]);
    for (const provider of ['codex', 'claude', 'hermes']) {
      expect(skillMatchesProvider(content, provider)).toBe(false);
    }
  });

  it.each(['---\nplatforms: [codex]', '---\nplatforms: all\n---broken\nBody.'])(
    'fails closed on malformed frontmatter delimiters: %j', (content) => {
      expect(parseSkillPlatforms(content)).toEqual([]);
      expect(skillMatchesProvider(content, 'hermes')).toBe(false);
    },
  );

  it('handles CRLF frontmatter', () => {
    expect(parseSkillPlatforms('---\r\nplatforms: [codex]\r\n---\r\nBody.')).toEqual(['codex']);
  });

  it('treats all as unrestricted only when alone', () => {
    const content = '---\nplatforms: [all, codex]\n---\nBody.';
    expect(parseSkillPlatforms(content)).toEqual(['all', 'codex']);
    expect(skillMatchesProvider(content, 'hermes')).toBe(false);
  });
});
