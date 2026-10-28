import { afterEach, describe, expect, it } from 'vitest';
import {
  captureProviderPathDescriptors,
  setStagedProviderPath,
  restoreProviderPaths,
  logicalProviderOutputPath,
} from '../../../tools/agents/providers/provider-paths-staging.mjs';
import { paths as grokbotPaths } from '../../../tools/agents/providers/grokbot.mjs';

describe('provider paths staging (#3648)', () => {
  it('reports final project and home paths without remapping similarly prefixed siblings', () => {
    const stage = '/tmp/synthetic-stage/project';
    const target = '/tmp/synthetic-target';
    const mappings = [{ to: '/tmp/synthetic-stage/home', from: '/tmp/synthetic-home' }];
    expect(logicalProviderOutputPath(`${stage}/.claude/rules/rule.md`, stage, target, mappings))
      .toBe(`${target}/.claude/rules/rule.md`);
    expect(logicalProviderOutputPath('/tmp/synthetic-stage/home/.codex/prompts/rule.md', stage, target, mappings))
      .toBe('/tmp/synthetic-home/.codex/prompts/rule.md');
    expect(logicalProviderOutputPath(`${stage}-other/file`, stage, target, mappings)).toBe(`${stage}-other/file`);
  });

  afterEach(() => {
    delete process.env.AIWG_GROKBOT_SKILLS_DIR;
  });

  it('round-trips plain data properties', () => {
    const provider = { name: 'synthetic', paths: { agents: '.agents', skills: '.skills', rules: '' } };
    const descriptors = captureProviderPathDescriptors(provider);
    setStagedProviderPath(provider, 'skills', '/tmp/staged-skills');
    expect(provider.paths.skills).toBe('/tmp/staged-skills');
    restoreProviderPaths(provider, descriptors);
    expect(provider.paths).toEqual({ agents: '.agents', skills: '.skills', rules: '' });
  });

  it('stages and restores a getter-only entry without assigning through the getter', () => {
    let backing = '';
    const provider = {
      name: 'synthetic-getter',
      paths: {
        agents: '',
        get skills() {
          return backing;
        },
      },
    };
    const before = Object.getOwnPropertyDescriptor(provider.paths, 'skills');
    expect(typeof before?.get).toBe('function');
    expect(before?.set).toBeUndefined();
    // The old restore path throws on this shape; the helper must not.
    expect(() => Object.assign(provider.paths, { ...provider.paths })).toThrow();
    const descriptors = captureProviderPathDescriptors(provider);
    backing = '/native/skills-absolute';
    setStagedProviderPath(provider, 'skills', '/tmp/staged-native');
    expect(provider.paths.skills).toBe('/tmp/staged-native');
    restoreProviderPaths(provider, descriptors);
    const after = Object.getOwnPropertyDescriptor(provider.paths, 'skills');
    expect(typeof after?.get).toBe('function');
    expect(after?.set).toBeUndefined();
    expect(provider.paths.skills).toBe('/native/skills-absolute');
  });

  it('drops keys added during staging', () => {
    const provider = { name: 'synthetic', paths: { agents: '.agents' } };
    const descriptors = captureProviderPathDescriptors(provider);
    setStagedProviderPath(provider, 'crossAgentSkills', '/tmp/staged-cross');
    expect(provider.paths.crossAgentSkills).toBe('/tmp/staged-cross');
    restoreProviderPaths(provider, descriptors);
    expect('crossAgentSkills' in provider.paths).toBe(false);
  });

  it('preserves the grokbot getter-only skills accessor across staging', () => {
    const before = Object.getOwnPropertyDescriptor(grokbotPaths, 'skills');
    expect(typeof before?.get).toBe('function');
    expect(before?.set).toBeUndefined();
    const provider = { name: 'grokbot', paths: grokbotPaths };
    const descriptors = captureProviderPathDescriptors(provider);
    // Project scope reads '' (bridge-only); staging must not throw or stick.
    expect(grokbotPaths.skills).toBe('');
    try {
      setStagedProviderPath(provider, 'skills', '/tmp/staged-grokbot');
      expect(grokbotPaths.skills).toBe('/tmp/staged-grokbot');
    } finally {
      restoreProviderPaths(provider, descriptors);
    }
    const after = Object.getOwnPropertyDescriptor(grokbotPaths, 'skills');
    expect(typeof after?.get).toBe('function');
    expect(after?.set).toBeUndefined();
    expect(grokbotPaths.skills).toBe('');
  });
});
