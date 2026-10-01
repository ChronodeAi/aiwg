import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactDigest } from '../../../src/decision/validate.js';
import type { QualificationIntegrityMetadata } from '../../../src/decision/qualification/release.js';
import { evaluateGates, sealUpstream } from '../../../src/gates/evaluate.js';
import { GateRegistry, type ResolvedBinding } from '../../../src/gates/registry.js';
import type {
  GateBinding, GateHoldoutInputs, GateMetricsDocument, GatePack, Sha256Digest, UpstreamCeiling,
} from '../../../src/gates/types.js';
import { qualifyGateParameter } from '../../../src/gates/types.js';
import { createCoreProviderRegistry, evidenceProvider, pairedProvider, proportionProvider, scalarProvider } from '../../../src/gates/providers/index.js';
import type { MetricProvider } from '../../../src/gates/providers/index.js';

const here = dirname(fileURLToPath(import.meta.url));

export const NOW = '2026-09-03T00:00:00.000Z';
export const REGISTERED_AT = '2026-09-01T00:00:00.000Z';
export const FROZEN_AT = '2026-09-02T00:00:00.000Z';

export function loadPack(): GatePack {
  return JSON.parse(readFileSync(resolve(here, 'fixtures/valid-pack.json'), 'utf8')) as GatePack;
}

export function testRegistry(): { registry: GateRegistry; providers: MetricProvider[] } {
  const core = createCoreProviderRegistry();
  const registry = new GateRegistry(core);
  registry.registerPack(loadPack(), { namespace: 'aiwg', bundle: 'test-gates' });
  const providers = [proportionProvider, pairedProvider, scalarProvider, evidenceProvider];
  return { registry, providers };
}

const PACK_ID = 'aiwg:test-gates/conformance-v1';

/** Qualifies the fixture pack's short parameter names for bindings. */
export function packParam(name: string): string {
  return qualifyGateParameter(PACK_ID, name);
}

/** A binding over the fixture pack. Spec overrides replace top-level spec fields. */
export function makeBinding(overrides?: { metadata?: GateBinding['metadata']; spec?: Partial<GateBinding['spec']> }): GateBinding {
  const pack = loadPack();
  const { providers } = testRegistry();
  const resolvedDigest = artifactDigest(pack);
  return {
    apiVersion: 'gates.aiwg.io/v1alpha1',
    kind: 'GateBinding',
    metadata: overrides?.metadata ?? {
      id: 'test-gates/conformance-run', version: '1.0.0', description: 'Conformance binding over the fixture pack.',
    },
    spec: {
      packs: [{ id: pack.metadata.id, version: pack.metadata.version, digest: artifactDigest(pack), resolvedDigest }],
      parameters: {
        [packParam('falseReadyMaxBps')]: 100,
        [packParam('coverageMinBps')]: 1500,
        [packParam('minTotalN')]: 50,
        [packParam('maxBlockingEvents')]: 0,
        [packParam('maxLatency')]: 500,
      },
      slices: ['a', 'b'],
      references: [{ name: 'always-review', kind: 'always-review' }],
      metricProviders: providers.map(provider => ({
        id: provider.id, version: provider.version, sourceDigest: provider.sourceDigest,
      })),
      ceiling: 'PROMOTE',
      registeredAt: REGISTERED_AT,
      frozenAt: FROZEN_AT,
      holdoutAccessedAt: null,
      ...overrides?.spec,
    },
  };
}

export function resolveTestBinding(binding?: GateBinding): ResolvedBinding {
  const { registry } = testRegistry();
  return registry.resolveBinding(binding ?? makeBinding());
}

export function trustedDigest(binding: GateBinding): Sha256Digest {
  return artifactDigest(binding);
}

/** Trusted holdout inputs mirroring the frozen record for a test binding. */
export function testHoldout(binding: GateBinding, firstAccessedAt?: string | null): GateHoldoutInputs {
  return {
    firstAccessedAt: firstAccessedAt ?? (binding.spec.holdoutAccessedAt as string | null | undefined) ?? null,
    frozenDigest: trustedDigest(binding),
  };
}

export function cleanIntegrity(overrides?: Partial<QualificationIntegrityMetadata>): QualificationIntegrityMetadata {
  return {
    sample_n: 10, uncertainty: { profile: 'test' }, paired_baseline: { baseline: 'test' },
    integrity_mode: 'fresh', fresh_workspace_required: true, fresh_workspace_verified: true,
    integrity_state: 'verified', trusted_score_source: 'fresh-workspace',
    compromise_labels: [], weak_signal_reason: null,
    release_gate: { decision: 'PROMOTE', reasons: [] }, ...overrides,
  };
}

export function makeUpstream(kind: 'promote' | 'hold' | 'rollback' | 'compromised'): UpstreamCeiling {
  if (kind === 'promote') return sealUpstream(cleanIntegrity());
  if (kind === 'hold') {
    return sealUpstream(cleanIntegrity({ release_gate: { decision: 'HOLD', reasons: ['manual-review'] } }));
  }
  return sealUpstream(cleanIntegrity({
    integrity_state: kind === 'compromised' ? 'compromised' : 'verified',
    compromise_labels: kind === 'compromised' ? ['injected-fixture'] : [],
    release_gate: { decision: 'ROLLBACK', reasons: ['integrity'] },
  }));
}

export function proportionRecords(slices: Record<string, { n: number; events: number }>, metric = 'false-ready') {
  return Object.entries(slices).flatMap(([slice, counts]) => [
    ...Array.from({ length: counts.events }, () => ({ slice, metric, event: true })),
    ...Array.from({ length: counts.n - counts.events }, () => ({ slice, metric, event: false })),
  ]);
}

export function pairedRecords(slices: Record<string, { both: number; candidateOnly: number; baselineOnly: number; neither: number }>) {
  return Object.entries(slices).flatMap(([slice, cells]) => [
    ...Array.from({ length: cells.both }, () => ({ slice, candidate: true, baseline: true })),
    ...Array.from({ length: cells.candidateOnly }, () => ({ slice, candidate: true, baseline: false })),
    ...Array.from({ length: cells.baselineOnly }, () => ({ slice, candidate: false, baseline: true })),
    ...Array.from({ length: cells.neither }, () => ({ slice, candidate: false, baseline: false })),
  ]);
}

export function scalarRecords(slices: Record<string, number[]>) {
  return Object.entries(slices).flatMap(([slice, values]) => values.map(value => ({ slice, value })));
}

/** Metrics in which every fixture gate passes under a PROMOTE upstream: the PROMOTE oracle. */
export function passingMetrics(): GateMetricsDocument {
  const proportion = proportionProvider.compute([
    ...proportionRecords({ a: { n: 1000, events: 0 }, b: { n: 1000, events: 0 } }, 'false-ready'),
    ...proportionRecords({ a: { n: 1000, events: 500 }, b: { n: 1000, events: 500 } }, 'coverage'),
  ]);
  const paired = pairedProvider.compute(pairedRecords({
    a: { both: 450, candidateOnly: 30, baselineOnly: 30, neither: 490 },
    b: { both: 450, candidateOnly: 30, baselineOnly: 30, neither: 490 },
  }));
  const scalar = scalarProvider.compute([
    ...scalarRecords({ a: Array.from({ length: 100 }, () => 0.08), b: Array.from({ length: 100 }, () => 0.12) }),
  ]);
  const evidence = evidenceProvider.compute([{ id: 'review-passed', passed: true }]);
  return {
    providers: {
      [proportionProvider.id]: proportion,
      [pairedProvider.id]: paired,
      [scalarProvider.id]: scalar,
      [evidenceProvider.id]: evidence,
    },
  };
}

export function evaluateFixture(input?: {
  binding?: GateBinding; metrics?: GateMetricsDocument; upstream?: UpstreamCeiling | null; now?: string;
  ceiling?: GateBinding['spec']['ceiling']; holdout?: GateHoldoutInputs;
}): ReturnType<typeof evaluateGates> {
  const binding = input?.binding ?? makeBinding(input?.ceiling === undefined ? undefined : { spec: { ceiling: input.ceiling } });
  const { registry } = testRegistry();
  return evaluateGates({
    binding,
    registry,
    trustedBindingDigest: trustedDigest(binding),
    holdout: input?.holdout ?? testHoldout(binding),
    metrics: input?.metrics ?? passingMetrics(),
    upstream: input?.upstream === undefined ? makeUpstream('promote') : input.upstream,
    now: input?.now ?? NOW,
  });
}
