import { z } from 'zod';
import { dateTime, number } from '../schema/zod-validation.mjs';
import { guardRulesInlineBudget, resolveRulesInlineBudget } from '../rules/inline-budget.mjs';
import type { MemoryAudit } from './audit.js';

/**
 * Resident context cost and memory utility (#3281).
 *
 * Read-only attribution over a `MemoryAudit` report. This module never reads
 * session telemetry, never contacts a provider and never writes anything:
 * every value that cannot be derived from local static evidence stays
 * `unknown` (null tokens, 'unknown' confidence) rather than a guessed number.
 *
 * Token estimation reuses the repository's existing estimators and adds no
 * tokenizer:
 * - per-file `ceil(UTF-8 bytes / 4)` from `tools/rules/measure-startup-context.mjs` (#2936);
 * - the `UTF-8 bytes / 4` guard report from `src/rules/inline-budget.mjs` (#2938),
 *   embedded untouched via `guardRulesInlineBudget`.
 */

export const TOKEN_ESTIMATOR_2936 = 'sum(ceil(UTF-8 bytes per file / 4)); not a tokenizer';
export const TOKEN_ESTIMATOR_2938 = 'UTF-8 bytes / 4';
export const STARTUP_MEASURE_TOOL = 'startup context measurement (#2936)';
/** Existing persistent ledger an operator may reuse; the cost view never writes to it. */
export const USAGE_LEDGER_NOTE = 'No new persistent telemetry is written. Caller-supplied usage evidence is held in memory only; to persist utility observations reuse the existing memory log via `aiwg memory append-log`.';

export const CostConfidenceSchema = z.enum(['measured', 'inferred', 'unknown']);
export const CostClassSchema = z.enum([
  'instruction', 'role', 'rule', 'skill', 'tool-schema', 'native-memory', 'stored', 'imported', 'other',
]);
export const CostItemLayerSchema = z.enum(['startup', 'per-task', 'overhead', 'stored', 'unknown']);

const LayerCostSchema = z.strictObject({
  bytes: number().nullable(),
  tokens: number().nullable(),
  estimator: z.string().min(1),
  confidence: CostConfidenceSchema,
  basis: z.string().min(1),
});

const UtilitySchema = z.strictObject({
  exposures: number(),
  exposureKinds: z.array(z.string()),
  retrieved: z.boolean().nullable(),
  used: z.boolean().nullable(),
  rejected: z.boolean().nullable(),
  outcome: z.enum(['unknown', 'retrieved-unused', 'used', 'rejected']),
  evidence: z.string().nullable(),
});

export const CostAttributionSchema = z.strictObject({
  id: z.string().min(1),
  sourcePath: z.string().min(1),
  costClass: CostClassSchema,
  bytes: number().nullable(),
  tokens: number().nullable(),
  estimator: z.string().min(1),
  confidence: CostConfidenceSchema,
  layer: CostItemLayerSchema,
  imported: z.boolean(),
  duplicateGroup: z.string().nullable(),
  utility: UtilitySchema,
});

const ClassTotalSchema = z.strictObject({
  items: number(),
  bytes: number().nullable(),
  tokens: number().nullable(),
  estimator: z.string().min(1),
  confidence: CostConfidenceSchema,
});

const DemotionAnchorSchema = z.strictObject({
  kind: z.enum(['indexed-record', 'include-stub', 'discovery-query']),
  locator: z.string().min(1),
  bytes: number(),
  tokens: number(),
  estimator: z.string().min(1),
  confidence: CostConfidenceSchema,
  note: z.string().min(1),
});

const DemotionTargetSchema = z.strictObject({
  id: z.string().min(1),
  sourcePath: z.string().min(1),
  reachable: z.boolean(),
  before: z.strictObject({ bytes: number().nullable(), tokens: number().nullable() }),
  after: z.strictObject({ residentBytes: number(), residentTokens: number(), anchorBytes: number(), anchorTokens: number() }),
  anchors: z.array(DemotionAnchorSchema),
  warnings: z.array(z.string().min(1)),
});

const StartupMeasurementSchema = z.object({
  version: number().optional(),
  token_estimate: z.string().optional(),
  providers: z.record(
    z.string(),
    z.object({ startup: z.object({ bytes: number(), estimated_tokens: number() }).catchall(z.unknown()) }).catchall(z.unknown()),
  ),
}).catchall(z.unknown());

export const MemoryCostSchema = z.strictObject({
  schemaVersion: z.literal('aiwg.memory-cost.v1'),
  at: dateTime(),
  workspace: z.string().min(1),
  scope: z.string().min(1),
  estimator: z.string().min(1),
  summary: z.strictObject({
    byClass: z.partialRecord(CostClassSchema, ClassTotalSchema),
    imported: ClassTotalSchema,
    duplicated: ClassTotalSchema,
    layers: z.strictObject({
      startup: LayerCostSchema,
      perTask: LayerCostSchema,
      overhead: LayerCostSchema,
      usageBilling: LayerCostSchema,
      cacheDiscounts: LayerCostSchema,
    }),
  }),
  items: z.array(CostAttributionSchema),
  inlineBudget: z.strictObject({
    estimator: z.string().min(1),
    limit: number(),
    configSource: z.string().min(1),
    providers: z.array(z.strictObject({
      provider: z.string().min(1),
      selected_bytes: number(),
      selected_tokens: number(),
      exceeded: z.boolean(),
      contributors: z.array(z.strictObject({ path: z.string().min(1), bytes: number(), estimated_tokens: number() })),
      scopeNote: z.string().min(1),
    })),
  }),
  startupMeasurement: z.strictObject({
    status: z.enum(['matched', 'unknown']),
    estimator: z.string().min(1),
    providers: z.array(z.strictObject({
      provider: z.string().min(1),
      measuredStartupBytes: number().nullable(),
      measuredStartupTokens: number().nullable(),
      staticResidentBytes: number().nullable(),
      note: z.string().min(1),
    })),
    note: z.string().min(1),
  }),
  telemetry: z.strictObject({
    store: z.string().nullable(),
    writesNewTelemetry: z.boolean(),
    retention: z.string().min(1),
    auditComplete: z.boolean(),
    exclusions: z.array(z.string()),
  }),
  demotionPreview: z.strictObject({
    targets: z.array(DemotionTargetSchema),
    totals: z.strictObject({
      beforeTokens: number().nullable(),
      afterAnchorTokens: number(),
      residentTokensRemoved: number().nullable(),
    }),
  }).nullable(),
});

export type MemoryCost = z.infer<typeof MemoryCostSchema>;
export type CostAttribution = z.infer<typeof CostAttributionSchema>;
export type CostClass = z.infer<typeof CostClassSchema>;

export interface UsageEvidence {
  retrieved?: boolean;
  used?: boolean;
  rejected?: boolean;
  evidence?: string;
}

export interface MemoryCostOptions {
  at?: string;
  /** Caller-supplied utility observations by attribution id. Held in memory; never persisted. */
  usage?: Readonly<Record<string, UsageEvidence>>;
  /** #2938 inline-budget config (`rules.inline_budget_tokens`); resolves the same default otherwise. */
  inlineBudgetConfig?: { rules?: { inline_budget_tokens?: number } };
  env?: Record<string, string | undefined>;
  /** #2936 startup-measurement report object; unknown layers stay unknown when absent. */
  startupMeasurement?: unknown;
  /** Attribution ids or source paths to preview demotion for. */
  demote?: readonly string[];
}

function categoryClass(category: string): CostClass {
  switch (category) {
    case 'instruction':
    case 'prompt':
      return 'instruction';
    case 'role':
      return 'role';
    case 'rule':
      return 'rule';
    case 'skill':
      return 'skill';
    case 'tool-description':
      return 'tool-schema';
    case 'native-memory':
      return 'native-memory';
    case 'memory-store':
    case 'compound-memory':
    case 'registry':
    case 'tool-config':
      return 'stored';
    case 'transitive-context':
      return 'imported';
    default:
      return 'other';
  }
}

function itemLayer(item: MemoryAudit['items'][number]): z.infer<typeof CostItemLayerSchema> {
  if (item.record?.placement === 'resident') return 'startup';
  if (item.record?.placement === 'task-context' || item.category === 'prompt') return 'per-task';
  if (item.category === 'tool-description') return 'overhead';
  if (item.record) return 'stored';
  return 'unknown';
}

/** Static inventory is never live telemetry: on-disk evidence only supports inference. */
function confidenceFor(item: MemoryAudit['items'][number]): z.infer<typeof CostConfidenceSchema> {
  if (item.bytes === null || item.bytes === undefined) return 'unknown';
  if (item.observation.status === 'observed') return 'measured';
  return 'inferred';
}

export function estimateTokens(bytes: number | null): number | null {
  if (bytes === null || bytes === undefined) return null;
  return Math.ceil(bytes / 4);
}

/** Read-only attribution. Never touches a filesystem, session or network. */
export function costMemory(report: MemoryAudit, options: MemoryCostOptions = {}): MemoryCost {
  const at = options.at ?? new Date().toISOString();
  const digestCounts = new Map<string, number>();
  for (const item of report.items) {
    if (item.digest) digestCounts.set(item.digest, (digestCounts.get(item.digest) ?? 0) + 1);
  }
  const usage = options.usage ?? {};

  const items: CostAttribution[] = report.items.map(item => {
    const costClass = categoryClass(item.category);
    const layer = itemLayer(item);
    const confidence = confidenceFor(item);
    const tokens = estimateTokens(item.bytes);
    const imported = costClass === 'imported' || item.exposures.some(e => e.kind === 'include');
    const duplicateGroup = item.digest && (digestCounts.get(item.digest) ?? 0) > 1 ? item.digest : null;
    const evidence = usage[item.id];
    const retrieved = evidence?.retrieved ?? null;
    const used = evidence?.used ?? null;
    const rejected = evidence?.rejected ?? null;
    return {
      id: item.id,
      sourcePath: item.sourcePath,
      costClass,
      bytes: item.bytes,
      tokens,
      estimator: TOKEN_ESTIMATOR_2936,
      confidence,
      layer,
      imported,
      duplicateGroup,
      utility: {
        exposures: item.exposures.length,
        exposureKinds: [...new Set(item.exposures.map(e => e.kind))],
        retrieved,
        used,
        rejected,
        outcome: used === true ? 'used' : rejected === true ? 'rejected' : retrieved === true ? 'retrieved-unused' : 'unknown',
        evidence: evidence?.evidence ?? null,
      },
    };
  });

  const classes = CostClassSchema.options;
  const byClass = Object.fromEntries(classes.map(name => {
    const group = items.filter(i => i.costClass === name);
    const bytes = group.every(i => i.bytes === null) ? null : group.reduce((sum, i) => sum + (i.bytes ?? 0), 0);
    const tokens = group.every(i => i.tokens === null) ? null : group.reduce((sum, i) => sum + (i.tokens ?? 0), 0);
    return [name, {
      items: group.length,
      bytes,
      tokens,
      estimator: TOKEN_ESTIMATOR_2936,
      confidence: group.length === 0 || group.every(i => i.confidence === 'unknown')
        ? 'unknown'
        : group.every(i => i.confidence === 'measured') ? 'measured' : 'inferred',
    }];
  })) as MemoryCost['summary']['byClass'];
  const overlapping = (selected: CostAttribution[]): MemoryCost['summary']['imported'] => ({
    items: selected.length,
    bytes: selected.every(i => i.bytes === null) ? null : selected.reduce((sum, i) => sum + (i.bytes ?? 0), 0),
    tokens: selected.every(i => i.tokens === null) ? null : selected.reduce((sum, i) => sum + (i.tokens ?? 0), 0),
    estimator: TOKEN_ESTIMATOR_2936,
    confidence: selected.length === 0 || selected.every(i => i.confidence === 'unknown') ? 'unknown' : 'inferred',
  });

  const startupGroup = items.filter(i => i.layer === 'startup');
  const perTaskGroup = items.filter(i => i.layer === 'per-task');
  const overheadGroup = items.filter(i => i.layer === 'overhead');
  const layers: MemoryCost['summary']['layers'] = {
    startup: {
      bytes: startupGroup.every(i => i.bytes === null) ? null : startupGroup.reduce((s, i) => s + (i.bytes ?? 0), 0),
      tokens: startupGroup.every(i => i.tokens === null) ? null : startupGroup.reduce((s, i) => s + (i.tokens ?? 0), 0),
      estimator: TOKEN_ESTIMATOR_2936,
      confidence: startupGroup.length === 0 || startupGroup.every(i => i.confidence === 'unknown') ? 'unknown' : 'inferred',
      basis: 'Static resident inventory; live activation and enabled state unverified',
    },
    perTask: {
      bytes: perTaskGroup.every(i => i.bytes === null) ? null : perTaskGroup.reduce((s, i) => s + (i.bytes ?? 0), 0),
      tokens: null,
      estimator: TOKEN_ESTIMATOR_2936,
      confidence: 'unknown',
      basis: 'Eligible per-task surfaces only; injected bytes per task are unobserved statically',
    },
    overhead: {
      bytes: overheadGroup.every(i => i.bytes === null) ? null : overheadGroup.reduce((s, i) => s + (i.bytes ?? 0), 0),
      tokens: null,
      estimator: TOKEN_ESTIMATOR_2936,
      confidence: 'unknown',
      basis: 'Declared tool/context description bytes; repetition per call requires runtime telemetry',
    },
    usageBilling: {
      bytes: null,
      tokens: null,
      estimator: TOKEN_ESTIMATOR_2936,
      confidence: 'unknown',
      basis: 'Actual usage and billing have no local evidence surface',
    },
    cacheDiscounts: {
      bytes: null,
      tokens: null,
      estimator: TOKEN_ESTIMATOR_2936,
      confidence: 'unknown',
      basis: 'Provider cache discounts have no local evidence surface',
    },
  };

  // #2938: reuse the inline-budget guard over static resident rule candidates.
  // Live rule activation (isAlwaysOnRule) is owned by rule-binding; the guard
  // input here is static eligibility, never a live selection claim.
  const env = options.env ?? process.env;
  const limit = resolveRulesInlineBudget(options.inlineBudgetConfig ?? {}, env);
  const inlineBudgetProviders = report.providers.map(p => {
    const candidates = items.filter(i => i.costClass === 'rule'
      && i.layer === 'startup'
      && i.bytes !== null
      && report.items.find(a => a.id === i.id)?.exposures.some(e => e.provider === p.id));
    const guarded = guardRulesInlineBudget({
      provider: p.id,
      files: candidates.map(i => ({ path: i.sourcePath, bytes: i.bytes as number })),
      config: options.inlineBudgetConfig ?? {},
      env,
      reportOnly: true,
    });
    return {
      provider: guarded.report.provider,
      selected_bytes: guarded.report.selected_bytes,
      selected_tokens: guarded.report.selected_tokens,
      exceeded: guarded.report.exceeded,
      contributors: guarded.report.contributors,
      scopeNote: 'Static resident rule candidates; live activation-selected content may differ',
    };
  });

  // #2936: cross-reference a startup-measurement report when supplied; the
  // measured surface and this static inventory are reported side by side.
  let startupMeasurement: MemoryCost['startupMeasurement'];
  if (options.startupMeasurement === undefined) {
    startupMeasurement = {
      status: 'unknown',
      estimator: TOKEN_ESTIMATOR_2936,
      providers: report.providers.map(p => ({
        provider: p.id,
        measuredStartupBytes: null,
        measuredStartupTokens: null,
        staticResidentBytes: startupGroup.some(i => report.items.find(a => a.id === i.id)?.exposures.some(e => e.provider === p.id))
          ? startupGroup.filter(i => report.items.find(a => a.id === i.id)?.exposures.some(e => e.provider === p.id))
            .reduce((s, i) => s + (i.bytes ?? 0), 0)
          : null,
        note: `No ${STARTUP_MEASURE_TOOL} report was supplied with --startup-measurement; measured startup bytes are unknown`,
      })),
      note: `Supply a ${STARTUP_MEASURE_TOOL} report with --startup-measurement to compare measured deployment bytes against this static inventory`,
    };
  } else {
    const parsed = StartupMeasurementSchema.parse(options.startupMeasurement);
    startupMeasurement = {
      status: 'matched',
      estimator: parsed.token_estimate ?? TOKEN_ESTIMATOR_2936,
      providers: report.providers.map(p => {
        const measured = parsed.providers[p.id]?.startup;
        const resident = startupGroup.filter(i => report.items.find(a => a.id === i.id)?.exposures.some(e => e.provider === p.id));
        return {
          provider: p.id,
          measuredStartupBytes: measured?.bytes ?? null,
          measuredStartupTokens: measured?.estimated_tokens ?? null,
          staticResidentBytes: resident.length ? resident.reduce((s, i) => s + (i.bytes ?? 0), 0) : null,
          note: 'Measured deployment surface beside static resident inventory; neither establishes live injection',
        };
      }),
      note: 'Measured surface includes emitted indexes and behavior bodies; static inventory includes linked context candidates',
    };
  }

  const demotionPreview = options.demote?.length
    ? previewDemotion(report, items, options.demote)
    : null;

  return MemoryCostSchema.parse({
    schemaVersion: 'aiwg.memory-cost.v1',
    at,
    workspace: report.workspace,
    scope: report.scope,
    estimator: TOKEN_ESTIMATOR_2936,
    summary: {
      byClass,
      imported: overlapping(items.filter(i => i.imported)),
      duplicated: overlapping(items.filter(i => i.duplicateGroup !== null)),
      layers,
    },
    items: items.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath)),
    inlineBudget: {
      estimator: TOKEN_ESTIMATOR_2938,
      limit,
      configSource: env.AIWG_RULES_INLINE_BUDGET_TOKENS !== undefined
        ? 'AIWG_RULES_INLINE_BUDGET_TOKENS'
        : options.inlineBudgetConfig?.rules?.inline_budget_tokens !== undefined ? 'aiwg.config rules.inline_budget_tokens' : 'default',
      providers: inlineBudgetProviders,
    },
    startupMeasurement,
    telemetry: {
      store: Object.keys(usage).length ? 'caller-supplied usage evidence (in-memory only)' : null,
      writesNewTelemetry: false,
      retention: USAGE_LEDGER_NOTE,
      auditComplete: report.coverage.complete,
      exclusions: report.coverage.exclusions,
    },
    demotionPreview,
  });
}

function previewDemotion(
  report: MemoryAudit,
  items: CostAttribution[],
  selectors: readonly string[],
): NonNullable<MemoryCost['demotionPreview']> {
  const byId = new Map(items.map(i => [i.id, i]));
  const byPath = new Map(items.map(i => [i.sourcePath, i]));
  const targets = [];
  let beforeTokens: number | null = 0;
  let removed: number | null = 0;
  let anchorTokens = 0;
  for (const selector of selectors) {
    const item = byId.get(selector) ?? byPath.get(selector);
    if (!item) throw new Error(`Demotion preview target is not a costed audit item: ${selector}`);
    const auditItem = report.items.find(a => a.id === item.id)!;
    const warnings: string[] = [];
    if (item.layer !== 'startup') warnings.push('Target is not startup-resident; demotion preview assumes a resident to indexed move');
    if (item.imported) {
      warnings.push('Native `@` imports still consume startup context at load; splitting files is not demotion');
    }
    // Anchors keep the demoted body reachable: the indexed record identity,
    // every static include/reference path, and the discovery query surface.
    // A loaded body linked by import or reference never anchors at zero cost.
    const anchors: Array<z.infer<typeof DemotionAnchorSchema>> = [];
    if (auditItem.record) {
      const locator = `indexed:${auditItem.record.id}`;
      const bytes = Buffer.byteLength(locator, 'utf8');
      anchors.push({
        kind: 'indexed-record',
        locator,
        bytes,
        tokens: Math.max(1, Math.ceil(bytes / 4)),
        estimator: TOKEN_ESTIMATOR_2936,
        confidence: 'inferred',
        note: 'Indexed record identity retained for retrieval after demotion',
      });
    }
    for (const exposure of auditItem.exposures) {
      if (exposure.kind !== 'include' && exposure.kind !== 'reference') continue;
      const locator = `stub:${exposure.path}`;
      const bytes = Buffer.byteLength(locator, 'utf8');
      anchors.push({
        kind: exposure.kind === 'include' ? 'include-stub' : 'discovery-query',
        locator,
        bytes,
        tokens: Math.max(1, Math.ceil(bytes / 4)),
        estimator: TOKEN_ESTIMATOR_2936,
        confidence: 'inferred',
        note: exposure.kind === 'include'
          ? 'Import stub remains loadable on demand; loading it consumes context'
          : 'Discovery anchor for on-demand retrieval; loading it consumes context',
      });
    }
    const reachable = anchors.length > 0;
    if (!reachable) warnings.push('No indexed path or exposure anchor exists; demotion would make this content unreachable');
    const anchorBytes = anchors.reduce((s, a) => s + a.bytes, 0);
    const anchorTokenSum = anchors.reduce((s, a) => s + a.tokens, 0);
    anchorTokens += anchorTokenSum;
    if (item.tokens === null) beforeTokens = null;
    else if (beforeTokens !== null) beforeTokens += item.tokens;
    if (item.layer === 'startup' && item.tokens !== null && removed !== null) removed += item.tokens;
    else if (item.layer === 'startup') removed = null;
    targets.push({
      id: item.id,
      sourcePath: item.sourcePath,
      reachable,
      before: { bytes: item.bytes, tokens: item.tokens },
      after: { residentBytes: 0, residentTokens: 0, anchorBytes, anchorTokens: anchorTokenSum },
      anchors,
      warnings,
    });
  }
  return { targets, totals: { beforeTokens, afterAnchorTokens: anchorTokens, residentTokensRemoved: removed } };
}

export function formatMemoryCost(report: MemoryCost): string {
  const lines = [
    `Memory cost (${report.scope}): ${report.workspace}`,
    `Estimator: ${report.estimator}; unmeasurable layers stay unknown, never guessed`,
    ...Object.entries(report.summary.byClass)
      .filter(([, total]) => total.items > 0)
      .map(([name, total]) => `  ${name}: ${total.items} item(s), ${total.bytes ?? 'unknown'} bytes, ${total.tokens ?? 'unknown'} tokens (${total.confidence})`),
    `  imported (overlapping): ${report.summary.imported.items} item(s), ${report.summary.imported.tokens ?? 'unknown'} tokens`,
    `  duplicated (overlapping): ${report.summary.duplicated.items} item(s), ${report.summary.duplicated.tokens ?? 'unknown'} tokens`,
    `Layers: startup ${report.summary.layers.startup.tokens ?? 'unknown'} tokens (${report.summary.layers.startup.confidence}); `
      + `per-task ${report.summary.layers.perTask.tokens ?? 'unknown'}; overhead ${report.summary.layers.overhead.tokens ?? 'unknown'}; `
      + `usage/billing ${report.summary.layers.usageBilling.tokens ?? 'unknown'}; cache discounts ${report.summary.layers.cacheDiscounts.tokens ?? 'unknown'}`,
    `Inline budget (#2938, ${report.inlineBudget.estimator}, limit ${report.inlineBudget.limit} via ${report.inlineBudget.configSource}): `
      + report.inlineBudget.providers.map(p => `${p.provider} ${p.selected_tokens} tokens${p.exceeded ? ' EXCEEDED' : ''}`).join('; '),
    `Startup measurement (#2936): ${report.startupMeasurement.status}`
      + (report.startupMeasurement.status === 'matched'
        ? ` (${report.startupMeasurement.providers.map(p => `${p.provider} measured ${p.measuredStartupBytes ?? 'unknown'} bytes vs static ${p.staticResidentBytes ?? 'unknown'} bytes`).join('; ')})`
        : '; supply a measure-startup-context report to compare'),
    `Telemetry: ${report.telemetry.store ?? 'none'}; writes new telemetry: ${report.telemetry.writesNewTelemetry}`,
  ];
  if (report.demotionPreview) {
    lines.push(`Demotion preview: before ${report.demotionPreview.totals.beforeTokens ?? 'unknown'} tokens, `
      + `anchors ${report.demotionPreview.totals.afterAnchorTokens} tokens, `
      + `resident removed ${report.demotionPreview.totals.residentTokensRemoved ?? 'unknown'} tokens`);
    for (const target of report.demotionPreview.targets) {
      lines.push(`  ${target.reachable ? 'reachable' : 'UNREACHABLE'} ${target.sourcePath}: `
        + `${target.before.tokens ?? 'unknown'} -> ${target.after.anchorTokens} anchor token(s) `
        + `[${target.anchors.map(a => a.locator).join(', ') || 'no anchor'}]`
        + (target.warnings.length ? ` (${target.warnings.join('; ')})` : ''));
    }
  }
  return lines.join('\n');
}
