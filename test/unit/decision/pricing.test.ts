import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decisionPricing, parseJevPricing, JEV_PRICING_SOURCE } from '../../../src/decision/pricing.js';
import { validateDecisionConfig } from '../../../src/config/decision-config.js';
import { decisionSavingsWeights, estimateDecisionSavings } from '../../../src/decision/savings.js';

const document = '| Model ID | `jev-1.13.0` | `jev-1.14.0` |\n| Price (per Btok / per Mtok) | \\$42 / \\$0.042 | \\$42 / \\$0.042 |\nOutput tokens are free.';
const dirs: string[] = [];
async function root() { const dir = await mkdtemp(join(tmpdir(), 'decision-pricing-')); dirs.push(dir); return dir; }
beforeEach(async () => {
  vi.stubEnv('XDG_CONFIG_HOME', await root());
  for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR', 'AIWG_CONFIG']) vi.stubEnv(key, undefined);
});
afterEach(async () => { vi.unstubAllEnvs(); vi.useRealTimers(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('sourced config pricing', () => {
  it('parses only versioned prices with consistent units and explicit free output', () => {
    expect(parseJevPricing(document).models['jev-1.13.0']).toEqual({ inputPerMillionUsd: 0.042, outputPerMillionUsd: 0 });
    for (const invalid of [document.replace('Output tokens are free.', ''), document.replace('0.042', '0.42'),
      document.replace('jev-1.13.0', 'jev-latest'), document.replace('jev-1.13.0', 'jev-1.14.0'),
      document.replace('42 /', 'NaN /')]) expect(() => parseJevPricing(invalid)).toThrow();
    expect(() => parseJevPricing(document, 'invalid-date')).toThrow();
  });

  it('validates split rates, source, strict dates and versioned models', () => {
    expect(validateDecisionConfig({ ask: { cost: { jev_input_per_mtok: 0.042, jev_output_per_mtok: 0,
      source: 'typesafe-docs', checked_at: '2026-10-23', jev_model: 'jev-1.13.0' } } })).toEqual([]);
    for (const cost of [{ jev_input_per_mtok: -1 }, { jev_output_per_mtok: Infinity }, { jev_input_per_mtok: '1' },
      { jev_output_per_mtok: 1000001 }, { source: 'guessed' }, { checked_at: '2026-02-30' },
      { checked_at: 'today' }, { jev_model: 'jev-latest' }, { unknown: 1 }]) {
      expect(validateDecisionConfig({ ask: { cost } }).length).toBeGreaterThan(0);
    }
  });

  it('uses a complete split pair with known usage, otherwise the blended rate', () => {
    const weights = decisionSavingsWeights({ cost: { jev_per_mtok: 2, jev_input_per_mtok: 0.042, jev_output_per_mtok: 0 } });
    const estimate = (usage?: { inputTokens: number | null; outputTokens: number | null }) => estimateDecisionSavings(10, false, 110, weights, usage);
    expect(estimate({ inputTokens: 100, outputTokens: 10 }).cost_weighted_net_usd).toBeCloseTo(-4.2e-6);
    expect(estimate({ inputTokens: 100, outputTokens: null }).estimationMethod.jev_rate_basis).toBe('split');
    expect(estimate().cost_weighted_net_usd).toBe(-220e-6);
    expect(estimate({ inputTokens: null, outputTokens: 10 }).estimationMethod.jev_rate_basis).toBe('blended');
    const partial = decisionSavingsWeights({ cost: { jev_per_mtok: 2, jev_input_per_mtok: 0.042 } });
    expect(estimateDecisionSavings(10, false, 110, partial, { inputTokens: 100, outputTokens: 10 }).cost_weighted_net_usd).toBe(-220e-6);
    const paidOutput = { ...weights, jev_output_per_mtok: 3 };
    expect(estimateDecisionSavings(10, false, 110, paidOutput, { inputTokens: 100, outputTokens: 10 }).cost_weighted_net_usd).toBeCloseTo(-34.2e-6);
  });

  it('stays offline for reads and previews changes without writing', async () => {
    const cwd = await root();
    await mkdir(join(cwd, '.aiwg'));
    const file = join(cwd, '.aiwg/aiwg.config');
    const original = JSON.stringify({ decision: { enabled: true, ask: { passes: 7, cost: { llm_per_mtok: 20, jev_per_mtok: 0.5 } } } });
    await writeFile(file, original);
    const fetch = vi.fn(async () => new Response(document));
    expect((await decisionPricing({ cwd, fetch })).current.jev_per_mtok).toBe(0.5);
    expect(fetch).not.toHaveBeenCalled();
    const preview = await decisionPricing({ cwd, fetch, refresh: true, dryRun: true, model: 'jev-1.13.0', now: new Date('2026-10-23') });
    expect(preview).toMatchObject({ written: false, current: { source: 'typesafe-docs', checked_at: '2026-10-23', jev_input_per_mtok: 0.042, jev_output_per_mtok: 0 } });
    expect(preview).toHaveProperty('diff', expect.arrayContaining([expect.objectContaining({ key: 'decision.ask.cost.jev_input_per_mtok', before: null, after: 0.042 })]));
    expect(fetch).toHaveBeenCalledWith(JEV_PRICING_SOURCE, expect.objectContaining({ redirect: 'error', credentials: 'omit', signal: expect.any(AbortSignal) }));
    expect(await readFile(file, 'utf8')).toBe(original);
    await decisionPricing({ cwd, fetch, refresh: true, model: 'jev-1.13.0' });
    expect(JSON.parse(await readFile(file, 'utf8')).decision).toMatchObject({ enabled: true, ask: { passes: 7, cost: { llm_per_mtok: 20, jev_per_mtok: 0.5, jev_model: 'jev-1.13.0' } } });
    await decisionPricing({ cwd, refresh: true, offline: true }); // reuse selected version
  });

  it('requires consent for snapshots and never stamps them with the current date', async () => {
    const cwd = await root();
    const fetch = vi.fn(async () => { throw new Error('offline'); });
    await expect(decisionPricing({ cwd, fetch, refresh: true, model: 'jev-1.13.0' })).rejects.toThrow(/--allow-snapshot/);
    const fallback = await decisionPricing({ cwd, fetch, refresh: true, dryRun: true, allowSnapshot: true, model: 'jev-1.13.0' });
    expect(fallback).toMatchObject({ snapshotDate: '2026-10-18', current: { source: 'typesafe-snapshot', checked_at: '2026-10-18' }, warning: 'offline' });
    fetch.mockClear();
    expect(await decisionPricing({ cwd, fetch, refresh: true, offline: true, dryRun: true, model: 'jev-1.14.0' })).toMatchObject({ snapshotDate: '2026-10-18' });
    expect(fetch).not.toHaveBeenCalled();
    await expect(decisionPricing({ cwd, offline: true })).rejects.toThrow(/require --refresh/);
  });

  it('rejects changed formats, oversized responses, HTTP failure and unknown model without writes', async () => {
    const cwd = await root();
    for (const response of [() => new Response('changed schema'), () => new Response('x'.repeat(262145)), () => new Response('', { status: 503 })]) {
      await expect(decisionPricing({ cwd, refresh: true, model: 'jev-1.13.0', fetch: async () => response() })).rejects.toThrow(/Config unchanged/);
    }
    await expect(decisionPricing({ cwd, refresh: true, offline: true })).rejects.toThrow(/--model/);
    await expect(decisionPricing({ cwd, refresh: true, offline: true, model: 'jev-9.0.0' })).rejects.toThrow(/No sourced rates/);
    await expect(readFile(join(cwd, '.aiwg/aiwg.config'))).rejects.toThrow();
  });

  it('bounds a stalled body read by a timeout', async () => {
    const cwd = await root();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetch = vi.fn(async () => new Response(new ReadableStream({ start() {} })));
    const promise = decisionPricing({ cwd, fetch, refresh: true, model: 'jev-1.13.0' });
    const assertion = expect(promise).rejects.toThrow(/timed out/);
    // Let config filesystem reads finish before the timer is installed.
    while (!fetch.mock.calls.length) await new Promise(resolve => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(5001);
    await assertion;
  });
});
