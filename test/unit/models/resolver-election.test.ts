// Covers flagship refusal and explicit election through the existing agent resolver.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigLoader } from '../../../src/models/config-loader.js';
import { ModelResolver } from '../../../src/models/resolver.js';
import type { MergedModelConfig } from '../../../src/models/types.js';

async function fixture(): Promise<MergedModelConfig> {
  const config = await new ConfigLoader().load();
  vi.spyOn(ConfigLoader.prototype, 'load').mockResolvedValue(config);
  return config;
}
afterEach(() => vi.restoreAllMocks());

describe('T-OG-01 agent resolver election boundaries', () => {
  it('rejects unelected flagship tiers and resolves elected bindings for Claude and OpenAI', async () => {
    await fixture();
    await expect(new ModelResolver({ tier: 'flagship' }).resolve('architect', 'coding'))
      .rejects.toThrow('user-elected only');
    for (const provider of ['claude', 'openai'] as const) {
      const result = await new ModelResolver({ provider, tier: 'max-quality', election: 'user' })
        .resolve('architect', 'coding');
      expect(result).toMatchObject({ provider, tier: 'flagship', source: 'cli' });
      expect(result.modelId).toBe(provider === 'openai' ? 'gpt-6-astra' : 'claude-fable-5-1');
    }
  });
  it('requires election for a flagship direct override even when the requested tier is standard', async () => {
    const config = await fixture();
    config.agentOverrides.architect = { 'model-override': 'gpt-6-astra' };
    await expect(new ModelResolver({ tier: 'standard' }).resolve('architect', 'coding'))
      .rejects.toThrow('user-elected only');
    await expect(new ModelResolver({ tier: 'standard', flagshipAllowlist: ['architect'] })
      .resolve('architect', 'coding')).resolves.toMatchObject({ modelId: 'gpt-6-astra', source: 'agent' });
  });
  it('rejects unelected flagship IDs hidden behind standard provider bindings', async () => {
    const config = await fixture();
    config.providers.claude.tierOverrides = { standard: { coding: 'claude-fable-5-1' } };
    await expect(new ModelResolver({ provider: 'claude', tier: 'standard' }).resolve('architect', 'coding'))
      .rejects.toThrow('user-elected only');
    await expect(new ModelResolver({ provider: 'claude', tier: 'standard', election: 'user' })
      .resolve('architect', 'coding')).resolves.toMatchObject({ modelId: 'claude-fable-5-1' });
  });
  it('refuses an empty configured model binding', async () => {
    const config = await fixture();
    config.providers.claude.models.coding.default = '';
    await expect(new ModelResolver({ provider: 'claude', tier: 'standard' }).resolve('architect', 'coding'))
      .rejects.toThrow('No supported model binding for claude/standard');
  });
});
