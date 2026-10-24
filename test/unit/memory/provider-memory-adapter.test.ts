import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  PROVIDER_IDS,
  getProviderDefinition,
  getProviderArtifactPathStrings,
} from '../../../src/providers/provider-definitions.js';
import {
  PROVIDER_MEMORY_ADAPTERS,
  listProviderMemoryAdapters,
  type ProviderMemoryItem,
  type ProviderMemorySize,
} from '../../../src/memory/provider-memory-adapter.js';

function item(provider: string, overrides: Partial<ProviderMemoryItem> = {}): ProviderMemoryItem {
  return {
    visibility: 'static',
    observation: {
      status: 'on-disk',
      evidence: { source: 'synthetic inventory', at: '2026-10-24T12:00:00.000Z', session: null, provider, version: null },
    },
    ...overrides,
  };
}

function runtime(provider: string): ProviderMemoryItem {
  return item(provider, {
    visibility: 'runtime',
    observation: {
      status: 'observed',
      evidence: { source: '/context synthetic diagnostic', at: '2026-10-24T12:00:00.000Z', session: 'synthetic-session', provider, version: 'synthetic-v1' },
    },
  });
}

function adapter(provider: (typeof PROVIDER_IDS)[number]) {
  return PROVIDER_MEMORY_ADAPTERS.get(provider)!;
}

afterEach(() => vi.unstubAllEnvs());

describe('provider memory adapter contracts', () => {
  it('enumerates every provider, including the explicit unsupported generic entry', () => {
    expect(listProviderMemoryAdapters().map(entry => entry.providerId)).toEqual(PROVIDER_IDS);
    expect(adapter('generic').memoryRoots()).toEqual([]);
    expect(adapter('generic').supports).toEqual({ read: false, write: false, estimate: false, liveLoadVisibility: false });
    expect(adapter('generic').diagnostic).toContain('indexed AIWG baseline');
  });

  it.each(PROVIDER_IDS)('fails enumeration if the %s adapter is missing', provider => {
    const registry = new Map(PROVIDER_MEMORY_ADAPTERS);
    registry.delete(provider);
    expect(() => listProviderMemoryAdapters(registry)).toThrow(`Missing memory adapter contract for ${provider}`);
  });

  it('rejects an adapter registered under a different provider id', () => {
    const registry = new Map(PROVIDER_MEMORY_ADAPTERS);
    registry.set('codex', adapter('claude'));
    expect(() => listProviderMemoryAdapters(registry)).toThrow('codex');
  });

  it.each(PROVIDER_IDS.filter(provider => provider !== 'generic'))('derives %s roots and context ceilings from existing definitions', provider => {
    const definition = getProviderDefinition(provider)!;
    const roots = adapter(provider).memoryRoots();
    for (const root of [
      ...Object.values(definition.paths.artifacts), ...Object.values(definition.paths.contextDiscovery),
      definition.paths.kernelSkills, ...definition.context.startupFiles,
    ].filter(Boolean)) expect(roots).toContain(root);
    expect(adapter(provider).context).toEqual(definition.context);
    expect(new Set(roots).size).toBe(roots.length);
  });

  it('uses deployment resolvers for configured external roots without inventing an unconfigured Grok Bot home', () => {
    vi.stubEnv('AIWG_GROKBOT_SKILLS_DIR', '');
    expect(adapter('grokbot').memoryRoots().join('\n')).not.toContain('AIWG_GROKBOT_SKILLS_DIR');
    expect(adapter('grokbot').memoryRoots().join('\n')).not.toContain('grokbot-skills');
    expect(adapter('grokbot').memoryRoots().join('\n')).not.toContain('.claude');
    vi.stubEnv('AIWG_GROKBOT_SKILLS_DIR', '/synthetic/external/grok-skills');
    expect(adapter('grokbot').memoryRoots()).toContain(getProviderArtifactPathStrings('grokbot')!.skills);
    vi.stubEnv('XDG_CONFIG_HOME', '/synthetic/external/xdg');
    expect(adapter('muse').memoryRoots()).toContain('/synthetic/external/xdg/muse/skills');
    vi.stubEnv('GROK_HOME', '/synthetic/external/grok');
    expect(adapter('grok-build').memoryRoots()).toContain('/synthetic/external/grok/skills');
  });

  it('encodes the provider-specific limits without creating precedence for Copilot', () => {
    expect(adapter('claude').limits).toContain('imports-consume-startup-context');
    expect(adapter('codex').context.maxContextBytes).toBe(32 * 1024);
    expect(adapter('copilot').limits).toEqual(expect.arrayContaining(['no-general-precedence', 'surface-and-enabled-state-required', 'scope-limited-imports']));
    expect(adapter('hermes').limits).toEqual(expect.arrayContaining(['write-is-not-reload-proof', 'distinct-native-memory-stores', 'external-connections-only']));
    expect(adapter('hermes').sessionEffect('retire')).toBe('next-session');
    expect(adapter('openclaw').limits).toEqual(expect.arrayContaining(['durable-and-injected-sizes-separate', 'no-verified-project-startup']));
    expect(adapter('omp').limits).toEqual(expect.arrayContaining(['nearest-nonempty-context', 'depth-ordered-include-deduplication']));
    expect(adapter('opencode').context.configRegistration).toEqual({ file: 'opencode.json', key: 'instructions' });
    expect(adapter('opencode').limits).toContain('configuration-registration-mutation');
    expect(adapter('cursor').context.nestedContext).toBe(false);
    expect(adapter('cursor').limits).toContain('always-apply-except-globs');
  });

  it.each(PROVIDER_IDS)('%s never claims a file edit changes the running session', provider => {
    expect(['next-session', 'unknown']).toContain(adapter(provider).sessionEffect('promote'));
    expect(adapter(provider).limits).toEqual(expect.arrayContaining([
      'canonical-edit-and-regenerate', 'immutable-running-session', 'opaque-system-content',
      'explicit-scope-selection', 'authority-review-required',
    ]));
  });

  it('keeps static context separate from live observed context and requires session/provider/version evidence', () => {
    const claude = adapter('claude');
    expect(claude.disposition({ ...runtime('claude'), visibility: 'static' })).toBe('inferred');
    expect(claude.disposition(runtime('claude'))).toBe('observed');
    expect(claude.disposition(runtime('codex'))).toBe('inferred');
    expect(claude.disposition({ ...runtime('claude'), observation: {
      ...runtime('claude').observation,
      evidence: { ...runtime('claude').observation.evidence, session: null },
    } })).toBe('inferred');
    expect(adapter('codex').disposition(runtime('codex'))).toBe('inferred');
    expect(claude.disposition({ ...runtime('claude'), visibility: 'hidden' })).toBe('opaque');
  });

  it.each(PROVIDER_IDS)('%s preserves unknown size telemetry and confines measured confidence to supported surfaces', provider => {
    const entry = adapter(provider);
    const supported = getProviderDefinition(provider)!.context.support === 'supported';
    const size: ProviderMemorySize = { ...item(provider), kind: 'durable', bytes: 512 };
    expect(entry.estimate({ ...size, observation: { ...size.observation, status: 'unknown' } })).toEqual({ bytes: null, confidence: 'unknown', kind: 'durable' });
    expect(entry.estimate({ ...size, bytes: null })).toEqual({ bytes: null, confidence: 'unknown', kind: 'durable' });
    expect(entry.estimate(size)).toEqual(supported
      ? { bytes: 512, confidence: 'measured', kind: 'durable' }
      : { bytes: null, confidence: 'unknown', kind: 'durable' });
    expect(entry.estimate({ ...size, kind: 'injected' })).toEqual({ bytes: null, confidence: 'unknown', kind: 'injected' });
    expect(entry.estimate({ ...size, ...runtime(provider), kind: 'injected' })).toEqual(supported && entry.supports.liveLoadVisibility
      ? { bytes: 512, confidence: 'measured', kind: 'injected' }
      : { bytes: null, confidence: 'unknown', kind: 'injected' });
    expect(entry.estimate({ ...size, visibility: 'hidden' })).toEqual({ bytes: null, confidence: 'unknown', kind: 'durable' });
  });

  it('keeps truncated injection separate from durable fixture bytes without measuring degraded OpenClaw', () => {
    const fixture = JSON.parse(readFileSync(new URL('../../fixtures/memory-maintenance/truncation.json', import.meta.url), 'utf8')) as {
      durableText: string; injectedText: string; provider: 'openclaw'; status: 'on-disk'; sessionEffect: 'unknown';
    };
    const entry = adapter(fixture.provider);
    const durableBytes = Buffer.byteLength(fixture.durableText);
    const injectedBytes = Buffer.byteLength(fixture.injectedText);
    expect(durableBytes).toBeGreaterThan(injectedBytes);
    expect(entry.limits).toContain('durable-and-injected-sizes-separate');
    expect(entry.disposition(item(fixture.provider))).toBe(fixture.status);
    expect(entry.sessionEffect('demote')).toBe(fixture.sessionEffect);
    expect(entry.estimate({ ...item(fixture.provider), kind: 'durable', bytes: durableBytes })).toEqual({
      bytes: null, confidence: 'unknown', kind: 'durable',
    });
    // Even supplied runtime diagnostic evidence cannot qualify a degraded adapter.
    expect(entry.disposition(runtime(fixture.provider))).toBe('observed');
    expect(entry.estimate({ ...runtime(fixture.provider), kind: 'injected', bytes: injectedBytes })).toEqual({
      bytes: null, confidence: 'unknown', kind: 'injected',
    });
  });

  it('never substitutes missing or invalid sizes with zero, and keeps estimates inferred', () => {
    const entry = adapter('claude');
    for (const bytes of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(entry.estimate({ ...item('claude'), kind: 'durable', bytes }).confidence).toBe('unknown');
    }
    expect(entry.estimate({ ...item('claude'), kind: 'durable', bytes: 0 })).toEqual({ bytes: 0, confidence: 'measured', kind: 'durable' });
    expect(entry.estimate({ ...item('claude'), observation: { ...item('claude').observation, status: 'inferred' }, kind: 'durable', bytes: 200 }).confidence).toBe('inferred');
    for (const status of ['absent', 'inaccessible', 'opaque'] as const) {
      expect(entry.estimate({ ...item('claude'), observation: { ...item('claude').observation, status }, kind: 'durable', bytes: 200 }).confidence).toBe('unknown');
    }
  });
});
