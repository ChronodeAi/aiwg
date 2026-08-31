/**
 * Unit tests for the Hermes provider adapter (ADR-006)
 *
 * Covers: registry self-registration and resolution, the honest
 * all-false capability surface (open questions H-1..H-6), the minimal
 * prompt-only headless invocation, and the no-credential-materialization
 * environment contract.
 *
 * @source @tools/ralph-external/lib/hermes-adapter.mjs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// @ts-ignore - ESM import
import { HermesAdapter } from '../../../tools/ralph-external/lib/hermes-adapter.mjs';
// @ts-ignore - ESM import
import {
  ensureProvidersRegistered,
  createProvider,
  listProviders,
  DispatchCapabilityError,
} from '../../../tools/ralph-external/lib/provider-adapter.mjs';

describe('hermes provider registration (ADR-006)', () => {
  it('registers hermes as a first-class provider on import', async () => {
    await ensureProvidersRegistered();
    expect(listProviders()).toContain('hermes');
  });

  it('resolves provider=hermes to a HermesAdapter', async () => {
    await ensureProvidersRegistered();
    const adapter = createProvider('hermes');
    expect(adapter).toBeInstanceOf(HermesAdapter);
    expect(adapter.getName()).toBe('hermes');
  });

  it('declares exactly the seven capability flags, all false', async () => {
    await ensureProvidersRegistered();
    const adapter = createProvider('hermes');
    const caps = adapter.getCapabilities();
    expect(Object.keys(caps).sort()).toEqual([
      'agentMode',
      'budgetControl',
      'maxTurns',
      'mcpConfig',
      'sessionResume',
      'streamJson',
      'systemPrompt',
    ]);
    expect(Object.values(caps).every((v) => v === false)).toBe(true);
  });
});

describe('HermesAdapter capability discipline', () => {
  it('refuses dispatch-blocking capabilities loudly (requireCapability)', () => {
    const adapter = new HermesAdapter();
    expect(() => adapter.requireCapability('sessionResume', 'resume')).toThrow(
      DispatchCapabilityError
    );
    expect(() => adapter.requireCapability('budgetControl', 'budget ceiling')).toThrow(
      DispatchCapabilityError
    );
  });

  it('still reports hasCapability without throwing', () => {
    const adapter = new HermesAdapter();
    expect(adapter.hasCapability('sessionResume')).toBe(false);
  });
});

describe('HermesAdapter.buildSessionArgs', () => {
  const fullOptions = {
    prompt: 'Fix the bug',
    sessionId: 'test-session-123',
    model: 'sonnet',
    budget: 5.0,
    maxTurns: 10,
    verbose: true,
    systemPrompt: 'You are an expert developer',
    mcpConfig: { 'mcp-hound': { url: 'http://localhost:3000' } },
  };

  it('emits the prompt as the final argument and nothing else', () => {
    const adapter = new HermesAdapter();
    const args = adapter.buildSessionArgs(fullOptions as any);
    expect(args).toEqual(['-z', 'Fix the bug']);
    expect(args[args.length - 1]).toBe('Fix the bug');
  });

  it('emits no provider-CLI flags for any requested option', () => {
    const adapter = new HermesAdapter();
    const args = adapter.buildSessionArgs(fullOptions as any);
    expect(args.some((a: string) => a.startsWith('--'))).toBe(false);
  });

  it('routes analysis calls through the same headless one-shot', () => {
    const adapter = new HermesAdapter();
    expect(adapter.buildAnalysisArgs({ prompt: 'Analyze' } as any)).toEqual(['-z', 'Analyze']);
  });

  it('passes model slugs through (routing owned by $HERMES_HOME, H-2)', () => {
    const adapter = new HermesAdapter();
    expect(adapter.mapModel('z-ai/glm-5.3-flash')).toBe('z-ai/glm-5.3-flash');
  });
});

describe('HermesAdapter binary and environment', () => {
  const ENV_KEYS = ['HERMES_BIN', 'HERMES_HOME', 'OPENROUTER_API_KEY'];
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    delete process.env.HERMES_BIN;
    delete process.env.HERMES_HOME;
    delete process.env.OPENROUTER_API_KEY;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('resolves the binary via HERMES_BIN override with plain hermes fallback', () => {
    const adapter = new HermesAdapter();
    expect(adapter.getBinary()).toBe('hermes');
    process.env.HERMES_BIN = '/custom/path/hermes';
    expect(adapter.getBinary()).toBe('/custom/path/hermes');
  });

  it('passes HERMES_HOME through only when set', () => {
    const adapter = new HermesAdapter();
    expect(adapter.getEnvOverrides()).toEqual({});
    process.env.HERMES_HOME = '/tmp/hermes-home-test';
    expect(adapter.getEnvOverrides()).toEqual({ HERMES_HOME: '/tmp/hermes-home-test' });
  });

  it('never materializes credentials into the spawn environment (ADR-006)', () => {
    const adapter = new HermesAdapter();
    process.env.OPENROUTER_API_KEY = 'sk-test-should-never-propagate';
    const overrides = adapter.getEnvOverrides() as Record<string, string>;
    expect(overrides.OPENROUTER_API_KEY).toBeUndefined();
    expect(overrides).toEqual({});
    expect(JSON.stringify(overrides)).not.toContain('sk-test-should-never-propagate');
  });

  it('returns a null transcript path (H-3 unobserved; invariant I3)', () => {
    expect(new HermesAdapter().getTranscriptPath()).toBeNull();
  });
});
