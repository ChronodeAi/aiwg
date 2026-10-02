import { evidenceProvider } from './evidence.js';
import { pairedProvider } from './paired.js';
import { proportionProvider } from './proportion.js';
import { MetricProviderRegistry } from './registry.js';
import { scalarProvider } from './scalar.js';
import { screeningProvider } from './screening.js';
import type { MetricProvider } from './types.js';

export type { BundleMetricProvider, MetricProvider, ProviderRuntime } from './types.js';
export { MetricProviderRegistry } from './registry.js';
export { evidenceProvider, type EvidenceRecord } from './evidence.js';
export { pairedProvider, type PairedRecord } from './paired.js';
export { proportionProvider, type ProportionRecord } from './proportion.js';
export { scalarProvider, type ScalarRecord } from './scalar.js';
export { screeningProvider, type ScreeningRecord } from './screening.js';

/** Core providers registered for v1alpha1 offline evaluation. */
export function createCoreProviderRegistry(): MetricProviderRegistry {
  const registry = new MetricProviderRegistry();
  const providers: MetricProvider[] = [proportionProvider, pairedProvider, scalarProvider, evidenceProvider, screeningProvider];
  for (const provider of providers) registry.register(provider);
  return registry;
}
