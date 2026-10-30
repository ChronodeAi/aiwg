import { emptyConfig, readAiwgConfig, writeAiwgConfig } from '../config/aiwg-config.js';
import type { DecisionConfig } from '../config/decision-config.js';
import { decisionSavingsWeights } from './savings.js';

export const JEV_PRICING_SOURCE = 'https://docs.typesafe.ai/models.md';
export interface TokenPrice { inputPerMillionUsd: number; outputPerMillionUsd: number; cachedInputPerMillionUsd?: number }
export interface DecisionPricing {
  schema: 'aiwg-decision-pricing/v1';
  source: string;
  checkedAt: string;
  currency: 'USD';
  endpointOrigin: 'https://api.typesafe.ai';
  models: Record<string, TokenPrice>;
}
export const BUNDLED_JEV_PRICING: DecisionPricing = {
  schema: 'aiwg-decision-pricing/v1', source: JEV_PRICING_SOURCE,
  checkedAt: '2026-10-18T00:00:00.000Z', currency: 'USD', endpointOrigin: 'https://api.typesafe.ai',
  models: { 'jev-1.13.0': { inputPerMillionUsd: 0.042, outputPerMillionUsd: 0 },
    'jev-1.14.0': { inputPerMillionUsd: 0.042, outputPerMillionUsd: 0 } },
};
const MAX_BYTES = 256 * 1024;
export function validTokenPrice(value: unknown): value is TokenPrice {
  const p = value as TokenPrice | null;
  return !!p && [p.inputPerMillionUsd, p.outputPerMillionUsd, ...(p.cachedInputPerMillionUsd === undefined ? [] : [p.cachedInputPerMillionUsd])]
    .every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1_000_000);
}
function validSnapshot(value: unknown): value is DecisionPricing {
  const p = value as DecisionPricing | null;
  return !!p && p.schema === BUNDLED_JEV_PRICING.schema && p.source === JEV_PRICING_SOURCE && p.currency === 'USD'
    && p.endpointOrigin === BUNDLED_JEV_PRICING.endpointOrigin && Number.isFinite(Date.parse(p.checkedAt))
    && !!p.models && Object.keys(p.models).length > 0 && Object.entries(p.models).every(([id, price]) => /^jev-\d+\.\d+\.\d+$/.test(id) && validTokenPrice(price));
}

/** Parse only the official versioned-model table; never guess output billing or aliases. */
export function parseJevPricing(markdown: string, checkedAt = new Date().toISOString()): DecisionPricing {
  const rows = markdown.split('\n').filter(line => line.trim().startsWith('|')).map(line => line.split('|').slice(1, -1).map(cell => cell.trim()));
  const ids = rows.find(row => row[0] === 'Model ID');
  const prices = rows.find(row => row[0] === 'Price (per Btok / per Mtok)');
  if (!ids || !prices || ids.length !== prices.length || !/Output tokens are free\./i.test(markdown)) throw new Error('Official Jev pricing format changed; keeping the prior snapshot.');
  const models: Record<string, TokenPrice> = {};
  for (let i = 1; i < ids.length; i++) {
    const id = /^`(jev-\d+\.\d+\.\d+)`$/.exec(ids[i])?.[1];
    const price = /^\\?\$([\d.]+)\s*\/\s*\\?\$([\d.]+)$/.exec(prices[i]);
    if (!id || !price || !Number.isFinite(Number(price[1])) || !Number.isFinite(Number(price[2])) || Math.abs(Number(price[1]) / 1000 - Number(price[2])) > 1e-10) throw new Error('Invalid official Jev price table.');
    if (models[id]) throw new Error('Duplicate Jev model in official price table.');
    models[id] = { inputPerMillionUsd: Number(price[2]), outputPerMillionUsd: 0 };
  }
  const snapshot = { ...BUNDLED_JEV_PRICING, models, checkedAt };
  if (!validSnapshot(snapshot)) throw new Error('Invalid Jev pricing snapshot.');
  return snapshot;
}

export interface PricingOptions {
  cwd: string;
  refresh?: boolean;
  dryRun?: boolean;
  offline?: boolean;
  allowSnapshot?: boolean;
  model?: string;
  fetch?: typeof fetch;
  now?: Date;
}

/** Explicit public-document fetch only; no credentials, redirects, cache or model calls. */
async function fetchPricing(fetcher: typeof fetch, now: Date): Promise<DecisionPricing> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const operation = async () => {
    const response = await fetcher(JEV_PRICING_SOURCE, {
      redirect: 'error', credentials: 'omit', signal: controller.signal, headers: { Accept: 'text/markdown' },
    });
    if (!response.ok || !response.body) throw new Error(`Jev pricing refresh failed (${response.status}).`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_BYTES) throw new Error('Jev pricing document exceeds limit.');
        chunks.push(chunk.value);
      }
    } finally { void reader.cancel().catch(() => {}); }
    return parseJevPricing(Buffer.concat(chunks).toString('utf8'), now.toISOString());
  };
  try {
    // Bound the entire body read, including injected fetchers which ignore abort.
    return await Promise.race([operation(), new Promise<never>((_, reject) => {
      timeout = setTimeout(() => { controller.abort(); reject(new Error('Jev pricing refresh timed out.')); }, 5000);
    })]);
  } finally { clearTimeout(timeout); }
}

/** The existing project config is the only persisted pricing system. */
export async function decisionPricing(options: PricingOptions) {
  if (!options.refresh && (options.offline || options.allowSnapshot || options.dryRun || options.model)) {
    throw new Error('--offline, --allow-snapshot, --dry-run and --model require --refresh');
  }
  const config = (await readAiwgConfig(options.cwd)) ?? emptyConfig();
  const before = config.decision?.ask?.cost ?? {};
  if (!options.refresh) {
    const weights = decisionSavingsWeights(config.decision?.ask);
    return { refreshed: false, written: false, current: { llm_per_mtok: weights.llm_per_mtok, jev_per_mtok: weights.jev_per_mtok,
      ...before, source: before.source ?? 'manual', checked_at: before.checked_at ?? null, jev_model: before.jev_model ?? null }, sourceUrl: JEV_PRICING_SOURCE };
  }
  // Validate selection before starting any network operation.
  const model = options.model ?? before.jev_model;
  if (!model || !/^jev-\d+\.\d+\.\d+$/.test(model)) throw new Error('Refresh requires --model jev-X.Y.Z or a configured jev_model. Config unchanged.');
  let snapshot: DecisionPricing;
  let warning: string | null = null;
  let source: NonNullable<NonNullable<DecisionConfig['ask']>['cost']>['source'] = 'typesafe-docs';
  if (options.offline) {
    snapshot = structuredClone(BUNDLED_JEV_PRICING);
    source = 'typesafe-snapshot';
  } else {
    try { snapshot = await fetchPricing(options.fetch ?? fetch, options.now ?? new Date()); }
    catch (error) {
      if (!options.allowSnapshot) throw new Error(`${error instanceof Error ? error.message : String(error)} Config unchanged; use --allow-snapshot to permit the dated bundled snapshot.`);
      snapshot = structuredClone(BUNDLED_JEV_PRICING);
      source = 'typesafe-snapshot';
      warning = error instanceof Error ? error.message : String(error);
    }
  }
  // Require an explicit or previously selected version rather than guessing latest.
  const price = snapshot.models[model];
  if (!price) throw new Error(`No sourced rates for ${model}. Config unchanged.`);
  const after = { ...before, jev_input_per_mtok: price.inputPerMillionUsd, jev_output_per_mtok: price.outputPerMillionUsd,
    source, checked_at: snapshot.checkedAt.slice(0, 10), jev_model: model };
  const diff = Object.entries(after).filter(([key, value]) => before[key as keyof typeof before] !== value)
    .map(([key, value]) => ({ key: `decision.ask.cost.${key}`, before: before[key as keyof typeof before] ?? null, after: value }));
  if (!options.dryRun) {
    config.decision = { ...config.decision, ask: { ...config.decision?.ask, cost: after } };
    await writeAiwgConfig(options.cwd, config);
  }
  return { refreshed: true, written: !options.dryRun, dryRun: !!options.dryRun, current: after, diff,
    sourceUrl: snapshot.source, warning, snapshotDate: source === 'typesafe-snapshot' ? after.checked_at : null };
}

/** API-equivalent cost from complete billable usage. Missing cache billing stays unknown. */
export function tokenCost(usage: { inputTokens: number | null; outputTokens: number | null; cachedInputTokens?: number | null } | null,
  price: TokenPrice): number | null {
  if (!validTokenPrice(price) || !usage || usage.inputTokens === null
    || (price.outputPerMillionUsd > 0 && usage.outputTokens === null)) return null;
  if (![usage.inputTokens, usage.outputTokens ?? 0].every(n => Number.isSafeInteger(n) && n >= 0)) return null;
  const cached = price.cachedInputPerMillionUsd === undefined ? 0 : usage.cachedInputTokens;
  if (cached == null || !Number.isSafeInteger(cached) || cached < 0 || cached > usage.inputTokens) return null;
  return ((usage.inputTokens - cached) * price.inputPerMillionUsd
    + cached * (price.cachedInputPerMillionUsd ?? price.inputPerMillionUsd)
    + (usage.outputTokens ?? 0) * price.outputPerMillionUsd) / 1_000_000;
}
