import { describe, expect, it } from 'vitest';
import {
  createCoreProviderRegistry, evidenceProvider, pairedProvider, proportionProvider, scalarProvider, screeningProvider,
} from '../../../src/gates/providers/index.js';
import { MetricProviderRegistry } from '../../../src/gates/providers/registry.js';
import { makeBinding } from './helper.js';

describe('gates metric providers', () => {
  it('registers the core providers exactly once with stable source digests', () => {
    const registry = createCoreProviderRegistry();
    expect(registry.ids()).toEqual(['decision.screening/v1', 'test.evidence/v1', 'test.paired/v1', 'test.proportion/v1', 'test.scalar/v1']);
    for (const provider of [proportionProvider, pairedProvider, scalarProvider, evidenceProvider, screeningProvider]) {
      expect(provider.sourceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    expect(() => registry.register(proportionProvider)).toThrow(/duplicate metric provider/);
    expect(() => registry.get('test.nope/v1')).toThrow(/unknown metric provider/);
    expect(() => new MetricProviderRegistry().register({ id: 'x', version: '1' } as never))
      .toThrow(/requires id, version, sourceDigest/);
  });

  it('pins every binding provider pin to the registered source digest', () => {
    const binding = makeBinding();
    const registry = createCoreProviderRegistry();
    for (const pin of binding.spec.metricProviders) {
      const provider = registry.get(pin.id);
      expect(pin.version).toBe(provider.version);
      expect(pin.sourceDigest).toBe(provider.sourceDigest);
    }
  });

  it('pools proportion and paired observations by summation', () => {
    const proportion = proportionProvider.compute([
      { slice: 'a', metric: 'false-ready', event: true }, { slice: 'a', metric: 'false-ready', event: false },
      { slice: 'b', metric: 'false-ready', event: false },
    ]);
    expect(proportion.metrics['false-ready']!.bySlice).toEqual({ a: { n: 2, events: 1 }, b: { n: 1, events: 0 } });
    const paired = pairedProvider.compute([
      { slice: 'a', candidate: true, baseline: false }, { slice: 'a', candidate: true, baseline: true },
    ]);
    expect(paired.metrics['contrast']!.bySlice.a).toEqual({
      n: 2, paired: { both: 1, candidateOnly: 1, baselineOnly: 0, neither: 0 },
    });
    const scalar = scalarProvider.compute([{ slice: 'a', value: 2 }, { slice: 'a', value: 4 }]);
    expect(scalar.metrics['measurement']!.bySlice.a).toEqual({ n: 2, value: 3 });
    expect(scalar.metrics['delta']!.bySlice.a).toEqual({ n: 2, differences: [2, 4] });
    const evidence = evidenceProvider.compute([{ id: 'review-passed', passed: true, expiresAt: null }]);
    expect(evidence.metrics['attestations']!.pooled).toEqual({
      available: [{ id: 'review-passed', passed: true, expiresAt: null }],
    });
  });

  it('fails closed on undeclared metrics and malformed records', () => {
    expect(() => proportionProvider.compute([{ slice: 'a', metric: 'nope', event: true }])).toThrow();
    expect(() => proportionProvider.compute([{ slice: '', metric: 'false-ready', event: true }])).toThrow();
    expect(() => pairedProvider.compute([{ slice: 'a', candidate: true, baseline: 'yes' as never }])).toThrow();
    expect(() => scalarProvider.compute([{ slice: 'a', value: Number.NaN }])).toThrow();
    expect(() => scalarProvider.compute([{ slice: 'a', value: 1 }, { slice: 'a', value: 1, extra: true } as never])).not.toThrow();
    expect(() => evidenceProvider.compute([
      { id: 'a', passed: true }, { id: 'a', passed: false },
    ])).toThrow();
    expect(() => evidenceProvider.compute('nope' as never)).toThrow();
  });
});
