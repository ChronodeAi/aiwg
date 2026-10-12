/**
 * T-OG-02 catalog/freshness (B-OG-03, S1 direct/shared checkpoint).
 *
 * Pure-fixture mapping assertions only: synthetic Codex `debug models` JSON
 * and Muse model-catalog rows normalize consistently, partial/failed refresh
 * preserves prior age, account facts stay separate, lifecycle states are
 * explicit, retirement blocks without rewriting pins, and future-dated
 * evidence is rejected. No paid calls, no live account files: the Muse
 * discoverer reads only the synthetic fixture directory. Managed runtime
 * assertions run in S2+ and are deferred here.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  discoverCodexDebugModels,
  discoverMuseCatalogModels,
  isFutureDated,
  mergeProviderDiscovery,
  normalizeCodexDebugModels,
  normalizeMuseCatalogRows,
  recordAccountInstance,
  retirementGuard,
  type NormalizeDiscoveryOptions,
  type ProviderModelDiscovery,
} from '../../../src/models/model-discovery.js';
import { validateWorkerModelObservation } from '../../../src/models/provider-policy.js';

const here = dirname(fileURLToPath(import.meta.url));
const codexFixture = JSON.parse(readFileSync(
  join(here, '../../fixtures/models/codex-debug-models.json'), 'utf8'));
const museFixture = JSON.parse(readFileSync(
  join(here, '../../fixtures/models/muse-catalog/synth.json'), 'utf8'));
const museFixtureDir = join(here, '../../fixtures/models/muse-catalog');

const NOW = new Date('2026-10-07T12:00:00.000Z');

function codexOptions(overrides: Partial<NormalizeDiscoveryOptions> = {}): NormalizeDiscoveryOptions {
  return {
    cliId: 'codex',
    source: 'codex debug models',
    runtimeVersion: '0.160.0-fixture',
    accountScope: 'local-account',
    observedAt: '2026-10-07T12:00:00.000Z',
    firstObservedAt: '2026-10-01T00:00:00.000Z',
    fetchedAt: '2026-10-07T12:00:00.000Z',
    now: NOW,
    ...overrides,
  };
}

function museOptions(overrides: Partial<NormalizeDiscoveryOptions> = {}): NormalizeDiscoveryOptions {
  return {
    cliId: 'muse',
    source: '/synthetic/muse-catalog/synth.json',
    runtimeVersion: '1.4.3-fixture',
    accountScope: 'local-account',
    observedAt: '2026-10-07T12:00:00.000Z',
    firstObservedAt: '2026-10-01T00:00:00.000Z',
    fetchedAt: '2026-10-07T12:00:00.000Z',
    now: NOW,
    ...overrides,
  };
}

describe('T-OG-02 catalog/freshness', () => {
  it('normalizes Codex debug models with per-field provenance and distinct dates', () => {
    const { models, diagnostics } = normalizeCodexDebugModels(codexFixture, codexOptions());
    expect(diagnostics).toEqual([]);
    expect(models.map(model => model.id).sort()).toEqual([
      'synth-ancient-retired',
      'synth-luna-hidden',
      'synth-old-deprecated',
      'synth-sol',
      'synth-terra',
    ]);
    const sol = models.find(model => model.id === 'synth-sol')!;
    expect(sol.reasoningEfforts).toEqual(['low', 'medium', 'high']);
    expect(sol.hidden).toBe(false);
    expect(sol.worker?.contextTokens).toBe(400000);
    expect(sol.worker?.visibility).toBe('listed');
    expect(sol.worker?.lifecycle).toBe('active');
    // Codex debug rows carry no release facts: explicit unknown, never inferred from slugs.
    expect(sol.worker?.releaseDate).toBeNull();
    expect(sol.worker?.releaseDateKind).toBe('unknown');
    // Distinct dates: first observation, fetch and current observation differ.
    expect(sol.worker?.firstObservedAt).toBe('2026-10-01T00:00:00.000Z');
    expect(sol.worker?.fetchedAt).toBe('2026-10-07T12:00:00.000Z');
    expect(sol.worker?.observedAt).toBe('2026-10-07T12:00:00.000Z');
    expect(sol.worker?.provenance).toHaveLength(1);
    expect(sol.worker?.provenance[0]).toMatchObject({
      source: 'codex debug models#/models/0', kind: 'native', confidence: 'reported',
    });
    expect(sol.worker?.provenance[0]?.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(sol.worker?.provenance[0]?.fields).toContain('/id:slug');
    for (const model of models) {
      expect(validateWorkerModelObservation(model.worker)).toEqual([]);
    }
  });

  it('normalizes Muse catalog rows with defaults, limits, dates and config-scoped data use', () => {
    const { models, diagnostics } = normalizeMuseCatalogRows(museFixture, museOptions());
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain('conflicting release_date');
    expect(models.map(model => model.id).sort()).toEqual([
      'synth-ancient-retired',
      'synth-luna-hidden',
      'synth-old-deprecated',
      'synth-sol',
      'synth-terra',
    ]);
    const terra = models.find(model => model.id === 'synth-terra')!;
    expect(terra.isDefault).toBe(true);
    expect(terra.reasoningEfforts).toEqual(['low', 'medium']);
    expect(terra.worker?.contextTokens).toBe(200000);
    expect(terra.worker?.maxOutputTokens).toBe(16000);
    expect(terra.worker?.releaseDate).toBe('2026-02-01');
    expect(terra.worker?.releaseDateKind).toBe('reported');
    expect(terra.worker?.availability).toBe('accessible');
    // Contributor data-use facts stay config-scoped, never row-derived.
    expect(terra.worker?.dataUse).toEqual({ processing: 'unknown', productImprovement: null, retentionDays: null });
    expect(terra.worker?.provenance[0]?.fields).toContain('/dataUse:unknown(config-scoped)');
    const luna = models.find(model => model.id === 'synth-luna-hidden')!;
    expect(luna.hidden).toBe(true);
    expect(luna.worker?.visibility).toBe('hidden');
    expect(luna.worker?.releaseDate).toBeNull();
    expect(luna.worker?.releaseDateKind).toBe('unknown');
    // Conflicting release dates retain unknown with both sources cited.
    const sol = models.find(model => model.id === 'synth-sol')!;
    expect(sol.worker?.releaseDate).toBeNull();
    expect(sol.worker?.releaseDateKind).toBe('unknown');
    for (const model of models) {
      expect(validateWorkerModelObservation(model.worker)).toEqual([]);
    }
  });

  it('normalizes the shared synthetic model set consistently across both shapes', () => {
    const codex = normalizeCodexDebugModels(codexFixture, codexOptions()).models;
    const muse = normalizeMuseCatalogRows(museFixture, museOptions()).models;
    const summarize = (models: typeof codex) => new Map(models.map(model => [
      model.id,
      {
        efforts: model.reasoningEfforts ?? [],
        context: model.worker?.contextTokens ?? null,
        hidden: model.hidden ?? false,
        lifecycle: model.worker?.lifecycle,
      },
    ]));
    expect(summarize(muse)).toEqual(summarize(codex));
  });

  it('maps hidden/deprecated/retired states explicitly', () => {
    const codex = normalizeCodexDebugModels(codexFixture, codexOptions()).models;
    const deprecated = codex.find(model => model.id === 'synth-old-deprecated')!;
    expect(deprecated.worker?.lifecycle).toBe('deprecated');
    expect(deprecated.worker?.sunsetAt).toBe('2026-12-31T00:00:00.000Z');
    expect(deprecated.worker?.replacementModelId).toBe('synth-terra');
    const retired = codex.find(model => model.id === 'synth-ancient-retired')!;
    expect(retired.worker?.lifecycle).toBe('retired');
    expect(retired.worker?.availability).toBe('unavailable');
    expect(retired.worker?.retiredAt).not.toBeNull();
  });

  it('blocks retired models without rewriting pins', () => {
    const codex = normalizeCodexDebugModels(codexFixture, codexOptions()).models;
    const retired = codex.find(model => model.id === 'synth-ancient-retired')!;
    const guard = retirementGuard('synth-ancient-retired', retired);
    expect(guard.blocked).toBe(true);
    // The pin is preserved verbatim; the suggested replacement is never substituted.
    expect(guard.pin).toBe('synth-ancient-retired');
    expect(guard.reason).toContain('synth-sol');
    const active = codex.find(model => model.id === 'synth-sol')!;
    expect(retirementGuard('synth-sol', active)).toEqual({ blocked: false, pin: 'synth-sol' });
  });

  it('preserves prior age on failed refresh', () => {
    const prior: ProviderModelDiscovery = {
      provider: 'codex', source: 'native', observedAt: '2026-10-01T00:00:00.000Z',
      accountScope: 'local-account',
      models: normalizeCodexDebugModels(codexFixture, codexOptions()).models,
    };
    const failed: ProviderModelDiscovery = {
      provider: 'codex', source: 'native', observedAt: '2026-10-07T12:00:00.000Z',
      accountScope: 'local-account', models: [],
      errorKind: 'timeout', error: 'codex debug models timed out',
    };
    const merged = mergeProviderDiscovery(prior, failed);
    expect(merged.models).toEqual(prior.models);
    expect(merged.observedAt).toBe('2026-10-01T00:00:00.000Z');
    expect(merged.errorKind).toBe('timeout');
  });

  it('preserves prior age on partial refresh and keeps earliest first-observed dates', () => {
    const prior: ProviderModelDiscovery = {
      provider: 'muse', source: 'native', observedAt: '2026-10-01T00:00:00.000Z',
      accountScope: 'local-account',
      models: normalizeMuseCatalogRows(museFixture, museOptions({
        observedAt: '2026-10-01T00:00:00.000Z',
        firstObservedAt: '2026-09-20T00:00:00.000Z',
        fetchedAt: '2026-10-01T00:00:00.000Z',
      })).models,
    };
    const partial: ProviderModelDiscovery = {
      provider: 'muse', source: 'native', observedAt: '2026-10-07T12:00:00.000Z',
      accountScope: 'local-account',
      errorKind: 'invalid-output', error: 'Some catalog rows could not be read',
      models: normalizeMuseCatalogRows(
        { rows: (museFixture.rows as unknown[]).slice(0, 3) },
        museOptions({ firstObservedAt: '2026-10-07T12:00:00.000Z' }),
      ).models,
    };
    const merged = mergeProviderDiscovery(prior, partial);
    // Prior-only rows survive with their original age.
    expect(merged.models.map(model => model.id).sort()).toEqual([
      'synth-ancient-retired',
      'synth-luna-hidden',
      'synth-old-deprecated',
      'synth-sol',
      'synth-terra',
    ]);
    const retained = merged.models.find(model => model.id === 'synth-ancient-retired')!;
    expect(retained.worker?.observedAt).toBe('2026-10-01T00:00:00.000Z');
    // Re-observed rows keep the earliest firstObservedAt, not the refresh date.
    const refreshed = merged.models.find(model => model.id === 'synth-terra')!;
    expect(refreshed.worker?.firstObservedAt).toBe('2026-09-20T00:00:00.000Z');
    expect(refreshed.worker?.observedAt).toBe('2026-10-07T12:00:00.000Z');
  });

  it('keeps account facts separate across instances', () => {
    const first = normalizeMuseCatalogRows(museFixture, museOptions({ accountBinding: 'work' })).models;
    const second = normalizeMuseCatalogRows(museFixture, museOptions({ accountBinding: 'personal' })).models;
    const empty: ProviderModelDiscovery = {
      provider: 'muse', source: 'native', observedAt: NOW.toISOString(),
      accountScope: 'local-account', models: [],
    };
    const catalog: any = { version: '1.0.0', providers: {}, discovery: { source: 'native', fetchedAt: NOW.toISOString(), providers: { muse: empty } } };
    const withFirst = recordAccountInstance(catalog,
      'muse:work', { ...empty, accountBinding: 'work', models: first });
    const withBoth = recordAccountInstance(withFirst,
      'muse:personal', { ...empty, accountBinding: 'personal', models: second });
    expect(Object.keys(withBoth.discovery.instances).sort()).toEqual(['muse:personal', 'muse:work']);
    expect(withBoth.discovery.instances['muse:work'].models).toHaveLength(5);
    expect(withBoth.discovery.instances['muse:personal'].accountBinding).toBe('personal');
    // Provider projection is never merged with account entitlements.
    expect(withBoth.discovery.providers.muse.models).toEqual([]);
    expect(validateWorkerModelObservation(
      withBoth.discovery.instances['muse:work'].models[0].worker)).toEqual([]);
  });

  it('rejects future-dated evidence beyond clock skew', () => {
    expect(isFutureDated('2026-10-07T12:05:00.000Z', NOW)).toBe(false);
    expect(isFutureDated('2026-10-07T12:05:00.001Z', NOW)).toBe(true);
    expect(isFutureDated(null, NOW)).toBe(false);
    expect(isFutureDated('not-a-date', NOW)).toBe(false);
    const { models, diagnostics } = normalizeMuseCatalogRows({
      rows: [{
        model_id: 'synth-future', visibility: 'listed', is_default: false, is_current: true,
        reasoning_effort_variants: [], release_date: '2027-01-01',
      }],
    }, museOptions());
    expect(models).toEqual([]);
    expect(diagnostics.join('; ')).toContain('future-dated');
  });

  it('runs the Codex debug strategy against a fake binary without paid calls', async () => {
    const runner = vi.fn()
      .mockResolvedValueOnce({ stdout: '0.160.0-fixture\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: JSON.stringify(codexFixture), stderr: '', exitCode: 0 });
    const result = await discoverCodexDebugModels('codex', runner, { now: () => NOW });
    expect(result.models.map(model => model.id)).toContain('synth-sol');
    expect(result.accountScope).toBe('local-account');
    expect(result.errorKind).toBeUndefined();
    expect(runner).toHaveBeenNthCalledWith(
      2, 'codex', ['debug', 'models'], expect.objectContaining({ timeoutMs: 10_000 }));
  });

  it('runs the Muse strategy against synthetic fixture copies, never live account files', async () => {
    const result = await discoverMuseCatalogModels({ catalogDir: museFixtureDir, now: () => NOW });
    expect(result.models.map(model => model.id).sort()).toEqual([
      'synth-ancient-retired',
      'synth-luna-hidden',
      'synth-old-deprecated',
      'synth-sol',
      'synth-terra',
    ]);
    // Both release-date claims survive, but conflicting validation evidence
    // cannot certify a complete refresh or renew prior evidence age.
    expect(result.errorKind).toBe('invalid-output');
    expect(result.error).toContain('conflicting release_date');
    expect(result.error).toContain('synth.json#/rows/0');
    const missing = await discoverMuseCatalogModels({
      catalogDir: join(museFixtureDir, 'does-not-exist'), now: () => NOW,
    });
    expect(missing.models).toEqual([]);
    expect(missing.errorKind).toBe('invalid-output');
  });

  it('rejects malformed Muse caches without falling back to invented rows', async () => {
    const broken = await discoverMuseCatalogModels({
      catalogDir: museFixtureDir, now: () => NOW,
    });
    expect(broken.models.length).toBeGreaterThan(0);
    const malformed = normalizeMuseCatalogRows({ rows: 'not-rows' }, museOptions());
    expect(malformed.models).toEqual([]);
    expect(malformed.diagnostics.join('; ')).toContain('.rows[]');
  });

  it('never ships synthetic seeds as defaults', () => {
    const shipped = JSON.parse(readFileSync(
      join(here, '../../../agentic/code/providers/model-catalog.v1.json'), 'utf8'));
    const text = JSON.stringify(shipped);
    expect(text).not.toContain('synth-');
  });
});
