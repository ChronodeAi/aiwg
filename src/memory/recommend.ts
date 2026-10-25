import { z } from 'zod';
import { integer, dateTime, number } from '../schema/zod-validation.mjs';
import type { MemoryAudit } from './audit.js';
import { costMemory, CostConfidenceSchema, type MemoryCostOptions } from './cost.js';
import { sha256 } from './context-pack.js';
import { MemoryDigestSchema, MemoryRecordSchema } from './maintenance-record.js';

const Text = z.string().min(1);
const DateTime = dateTime();
/** Local starting points for workload evaluation, not research-established thresholds. */
export const RecommendationThresholdsSchema = z.strictObject({
  minimumAgeDays: integer().nonnegative().default(30),
  reviewAgeDays: integer().nonnegative().default(90),
  demoteMinimumTokens: integer().nonnegative().default(512),
  taskPackCharacters: integer().min(256).max(65536).default(8000),
});
const ItemEvidenceSchema = z.strictObject({
  source: Text,
  criticality: z.enum(['ordinary', 'critical']).optional(),
  ownerPinned: z.boolean().optional(),
  rareObligation: z.boolean().optional(),
  provenance: z.enum(['verified', 'uncertain', 'conflicting']).optional(),
  createdAt: DateTime.optional(), reviewedAt: DateTime.optional(),
  history: z.enum(['known', 'unknown']).optional(),
  obsolete: z.boolean().optional(),
  supersededBy: Text.optional(), conflictsWith: z.array(Text).optional(),
  categoryCorrection: Text.optional(), summaryStale: z.boolean().optional(),
  residentProposal: z.strictObject({
    owner: Text.optional(), rationale: Text.optional(), budgetTokens: integer().positive().optional(),
    reviewDate: DateTime.optional(), boundedPackEvaluated: z.boolean().optional(),
  }).optional(),
});
export const RecommendationInputsSchema = z.strictObject({
  thresholds: RecommendationThresholdsSchema.prefault({}),
  items: z.record(z.string(), ItemEvidenceSchema).prefault({}),
});
const CandidateSchema = z.strictObject({
  id: Text,
  kind: z.enum(['merge', 'recategorize', 'conflict', 'supersede', 'demote', 'promote', 'retire']),
  target: MemoryRecordSchema,
  sourceDigest: MemoryDigestSchema.nullable(),
  related: z.array(Text),
  relatedTargets: z.array(z.strictObject({ record: MemoryRecordSchema, sourceDigest: MemoryDigestSchema.nullable() })),
  status: z.enum(['advisory', 'blocked', 'rejected', 'conflict']),
  advisoryRank: integer().positive(),
  rationale: Text,
  evidence: z.array(z.strictObject({ source: Text, detail: Text })).min(1),
  uncertainty: z.array(Text).min(1),
  blockedReasons: z.array(Text), protectedItemExceptions: z.array(Text),
  expectedSavings: z.strictObject({
    residentTokens: number().nullable(), estimator: Text, confidence: CostConfidenceSchema, basis: Text,
  }),
  retrievalImpact: z.strictObject({
    detail: Text, requiresVerification: z.literal(true),
    proposedPlacement: z.enum(['indexed', 'task-context', 'resident']).nullable(),
    category: Text.nullable(),
    taskPack: z.strictObject({ builder: z.literal('buildWorkspaceContextPack'), totalCharacters: integer().positive() }),
  }),
  residentJustification: z.strictObject({
    owner: Text.optional(), rationale: Text.optional(), budgetTokens: integer().positive().optional(),
    reviewDate: DateTime.optional(), boundedPackEvaluated: z.boolean().optional(),
  }).nullable(),
});
export const MemoryRecommendationsSchema = z.strictObject({
  schemaVersion: z.literal('aiwg.memory-recommendations.v1'),
  at: DateTime, workspace: Text, scope: Text,
  advisoryOnly: z.literal(true), defaultPlacement: z.literal('indexed'),
  thresholds: RecommendationThresholdsSchema,
  coverage: z.strictObject({ complete: z.boolean(), limitsHit: z.array(Text), exclusions: z.array(Text) }),
  candidates: z.array(CandidateSchema),
  notes: z.array(Text),
});
export type MemoryRecommendations = z.infer<typeof MemoryRecommendationsSchema>;
export type MemoryRecommendation = MemoryRecommendations['candidates'][number];
export type RecommendationInputs = z.input<typeof RecommendationInputsSchema>;

/** Pure policy over audit + cost evidence. No file, provider or telemetry writes. */
export function recommendMemory(audit: MemoryAudit, input: RecommendationInputs = {}, costOptions: MemoryCostOptions = {}): MemoryRecommendations {
  const config = RecommendationInputsSchema.parse(input);
  const at = costOptions.at ?? audit.at;
  const now = Date.parse(DateTime.parse(at));
  const cost = costMemory(audit, { ...costOptions, at,
    demote: audit.items.filter(i => i.record?.placement === 'resident').map(i => i.id) });
  const costs = new Map(cost.items.map(i => [i.id, i]));
  const items = new Map(audit.items.map(i => [i.id, i]));
  for (const id of Object.keys(config.items)) if (!items.has(id)) throw new Error(`Recommendation evidence target is outside the audit inventory: ${id}`);
  const candidates: MemoryRecommendation[] = [];
  const age = (date: string | undefined): number | null => date ? (now - Date.parse(date)) / 86400000 : null;
  const metadata = (id: string) => config.items[id];
  const protections = (id: string): string[] => {
    const record = items.get(id)?.record;
    const info = metadata(id);
    return [
      ...(record?.authority.protection === 'pinned' || info?.ownerPinned ? ['Owner pin protects this item'] : []),
      ...(info?.rareObligation ? ['Rare obligation must remain available'] : []),
      ...(info?.criticality === 'critical' ? ['Critical rule requires explicit owner disposition'] : []),
    ];
  };
  const conflicts = new Set<string>();
  for (const finding of audit.findings) if (/conflict|collision/.test(finding.code)) {
    for (const item of audit.items) if (finding.paths.includes(item.sourcePath) || item.exposures.some(e => finding.paths.includes(e.path))) conflicts.add(item.id);
  }
  for (const [id, info] of Object.entries(config.items)) {
    if (info.provenance === 'conflicting' || info.conflictsWith?.length) {
      conflicts.add(id);
      for (const related of info.conflictsWith ?? []) if (items.has(related)) conflicts.add(related);
    }
  }
  function add(id: string, kind: MemoryRecommendation['kind'], rationale: string, related: string[] = [], reasons: string[] = [], placement: 'indexed' | 'task-context' | 'resident' | null = null): void {
    const item = items.get(id)!;
    if (!item.record) return;
    const info = metadata(id);
    const attribution = costs.get(id)!;
    const exceptions = [...new Set([id, ...related].flatMap(protections))];
    const blocked = [...reasons];
    const destructive = ['retire', 'demote', 'merge', 'supersede'].includes(kind);
    if (destructive) blocked.push(...exceptions);
    if (kind !== 'conflict' && conflicts.has(id)) blocked.push('Conflicting source evidence needs owner resolution before changes');
    if (destructive && item.record.lifecycle !== 'active') blocked.push('Only active originals are eligible');
    let tokens: number | null = null;
    let confidence: 'measured' | 'inferred' | 'unknown' = 'unknown';
    let basis = 'No supported saving estimate; retained history and live activation are unmeasured';
    if (kind === 'demote') {
      const preview = cost.demotionPreview!.targets.find(t => t.id === id)!;
      tokens = attribution.tokens === null ? null : attribution.tokens - preview.after.anchorTokens;
      confidence = tokens === null ? 'unknown' : 'inferred';
      basis = 'Conditional static resident bytes minus cost.ts retrieval anchors; provider regeneration and retrieval proof still required';
    }
    candidates.push({
      id: sha256(JSON.stringify({ kind, id, related: [...related].sort(), placement, category: info?.categoryCorrection ?? null })),
      kind, target: item.record, sourceDigest: item.sourceDigest ?? item.digest, related,
      relatedTargets: related.flatMap(key => {
        const input = items.get(key);
        return input?.record ? [{ record: input.record, sourceDigest: input.sourceDigest ?? input.digest }] : [];
      }),
      status: kind === 'conflict' ? 'conflict' : blocked.length ? 'blocked' : 'advisory', advisoryRank: 1,
      rationale, evidence: [
        { source: item.observation.evidence.source, detail: `Audit: ${item.observation.status}; ${item.category}; ${item.record.placement}; review ${item.reviewStatus}` },
        { source: attribution.estimator, detail: `Cost ${attribution.tokens ?? 'unknown'} tokens (${attribution.confidence}); utility ${attribution.utility.outcome}; evidence ${attribution.utility.evidence ?? 'unknown'}` },
        ...(info ? [{ source: info.source, detail: `Owner evidence: provenance ${info.provenance ?? 'unknown'}; history ${info.history ?? 'unknown'}; created ${info.createdAt ?? 'unknown'}; reviewed ${info.reviewedAt ?? 'unknown'}; obsolete ${info.obsolete ?? 'unknown'}` }] : []),
        ...audit.findings.filter(f => f.paths.includes(item.sourcePath)).map(f => ({ source: f.code, detail: f.detail })),
      ],
      uncertainty: ['Static inventory does not prove live loading, successful retrieval, or task outcomes',
        ...(!info?.createdAt ? ['Creation age is unknown; filesystem recency is not creation history'] : []),
        ...(info?.provenance !== 'verified' ? ['Provenance is unverified or conflicting'] : []),
        ...(!audit.coverage.complete ? ['Audit coverage is incomplete; absence is not evidence of disuse'] : [])],
      blockedReasons: [...new Set(blocked)], protectedItemExceptions: exceptions,
      expectedSavings: { residentTokens: tokens, estimator: attribution.estimator, confidence, basis },
      retrievalImpact: { detail: kind === 'retire' ? 'Exclude from ordinary retrieval; preserve source, tombstone and explicit history/restore lookup'
        : kind === 'conflict' || kind === 'supersede' ? 'Review source revisions and invalidate stale dependent summaries; never silently merge claims'
          : 'Preserve source identity and authority; verify indexed discovery and bounded task-pack recall before resident removal',
      requiresVerification: true, proposedPlacement: placement, category: kind === 'recategorize' ? info?.categoryCorrection ?? null : null,
      taskPack: { builder: 'buildWorkspaceContextPack', totalCharacters: config.thresholds.taskPackCharacters } },
      residentJustification: placement === 'resident' ? info?.residentProposal ?? null : null,
    });
  }
  const seenDigests = new Set<string>();
  for (const item of [...audit.items].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!item.record) continue;
    const id = item.id;
    const record = item.record;
    const info = metadata(id);
    const attribution = costs.get(id)!;
    const createdAge = age(info?.createdAt);
    const reviewAge = age(info?.reviewedAt);
    if (conflicts.has(id)) add(id, 'conflict', 'Conflicting claims or owner metadata need explicit source review', info?.conflictsWith ?? []);
    if (info?.categoryCorrection) add(id, 'recategorize', 'Owner evidence identifies a taxonomy correction; preserve placement, lifecycle and authority');
    if (info?.summaryStale || info?.supersededBy || ['stale', 'superseded'].includes(item.trust)
      || item.reviewStatus === 'deployed-drift' || record.supersedes.some(handle => !items.has(handle) || items.get(handle)?.record?.lifecycle === 'active')) {
      const related = info?.supersededBy ? [info.supersededBy] : record.supersedes;
      add(id, 'supersede', 'Review supersession links and stale derived summaries against original source evidence', related,
        ['A reviewer must supply the replacement and validate lineage; no generated summary is accepted as a source fact']);
    }
    if (record.lifecycle !== 'active') continue;
    if (attribution.duplicateGroup && !seenDigests.has(attribution.duplicateGroup)) {
      seenDigests.add(attribution.duplicateGroup);
      const copies = audit.items.filter(i => i.digest === item.digest && i.record && i.id !== id);
      const related = copies.map(i => i.id);
      const incompatible = copies.some(i => i.record!.scope !== record.scope || JSON.stringify(i.record!.authority) !== JSON.stringify(record.authority));
      add(id, 'merge', 'Identical content digests support consolidation review with immutable originals and source links retained', related,
        [...(incompatible ? ['Duplicate copies differ in scope or authority; no implicit merge is allowed'] : []),
          ...(related.some(key => conflicts.has(key)) ? ['A duplicate has conflicting source evidence; resolve the conflict first'] : []),
          ...(copies.some(copy => copy.record!.lifecycle !== 'active') ? ['Duplicate inputs include inactive originals; review retained history separately'] : [])]);
    }
    if (!attribution.duplicateGroup && audit.findings.some(f => f.code === 'duplicate-resident-copy'
      && (f.paths.includes(item.sourcePath) || item.exposures.some(e => f.paths.includes(e.path))))) {
      add(id, 'merge', 'Multiple physical resident copies share one immutable identity; consolidate exposure paths while retaining the canonical source', [],
        ['Copies already share one record identity; use the existing deployment/regeneration owner rather than merging a record with itself']);
    }
    if (record.placement === 'resident' && (attribution.tokens === null || attribution.tokens >= config.thresholds.demoteMinimumTokens)) {
      add(id, 'demote', 'Review resident footprint against observed utility; keep indexed retrieval and prefer a bounded task pack', [],
        [...(attribution.utility.used !== false || !attribution.utility.evidence ? ['No explicit evidence of unused resident context'] : []),
          ...(info?.provenance !== 'verified' ? ['Verify provenance before demotion'] : [])], 'indexed');
    }
    if (record.placement === 'indexed' && attribution.utility.used === true && attribution.utility.evidence) {
      add(id, 'promote', 'Successful-use evidence supports evaluating a bounded task pack before persistent residency', [], [], 'task-context');
    }
    if (info?.residentProposal) {
      const proposal = info.residentProposal;
      const reasons = [
        ...(!proposal.owner || proposal.owner !== record.authority.owner ? ['Always-loaded placement requires the existing owner'] : []),
        ...(!proposal.rationale ? ['Always-loaded placement requires a continuing rationale'] : []),
        ...(!proposal.budgetTokens ? ['Always-loaded placement requires a token budget'] : []),
        ...(!proposal.reviewDate || Date.parse(proposal.reviewDate) <= now ? ['Always-loaded placement requires a future review date'] : []),
        ...(attribution.tokens === null || !proposal.budgetTokens || attribution.tokens > proposal.budgetTokens ? ['Known footprint must fit the resident budget'] : []),
        ...(proposal.boundedPackEvaluated !== true ? ['Evaluate buildWorkspaceContextPack before persistent resident placement'] : []),
        ...(attribution.utility.used !== true || !attribution.utility.evidence ? ['Observed successful use is required'] : []),
        ...(info.provenance !== 'verified' ? ['Verify provenance before resident placement'] : []),
        ...(record.placement === 'resident' ? ['Item is already resident'] : []),
      ];
      add(id, 'promote', 'Explicit always-loaded proposal requires owner, rationale, budget, review date and prior bounded-pack evaluation', [], reasons, 'resident');
      const candidate = candidates.at(-1)!;
      if (candidate.blockedReasons.length) candidate.status = 'rejected';
    }
    // An old review opens investigation, never establishes retirement eligibility.
    if (info?.obsolete || info?.supersededBy || (reviewAge !== null && reviewAge >= config.thresholds.reviewAgeDays)
      || attribution.utility.rejected === true || (attribution.utility.used === false && Boolean(attribution.utility.evidence))) {
      add(id, 'retire', 'Review obsolete or superseded material; recency and frequency alone cannot justify retirement', [], [
        ...(info?.history !== 'known' ? ['Unknown history blocks retirement'] : []),
        ...(createdAge === null ? ['Unknown creation age blocks retirement'] : createdAge < config.thresholds.minimumAgeDays ? ['Freshly created notes are protected from retirement'] : []),
        ...(reviewAge !== null && reviewAge < 0 ? ['Review timestamp is in the future'] : []),
        ...(!info?.obsolete && !info?.supersededBy ? ['Age, frequency and rejection alone are insufficient; establish obsolete or superseded source evidence'] : []),
        ...(info?.provenance !== 'verified' ? ['Verified provenance is required for retirement'] : []),
        ...(attribution.utility.used === null || !attribution.utility.evidence ? ['Observed utility history is unknown'] : []),
        ...(attribution.utility.used === true ? ['Successful use contradicts retirement; resolve source evidence'] : []),
        ...(info?.supersededBy && !items.has(info.supersededBy) ? ['Successor is outside this inventory; verify retrieval and scope'] : []),
        ...(info?.supersededBy === id ? ['An item cannot supersede itself'] : []),
        ...(info?.supersededBy && items.has(info.supersededBy)
          && (items.get(info.supersededBy)?.record?.lifecycle !== 'active' || items.get(info.supersededBy)?.record?.scope !== record.scope)
          ? ['Successor must be active and retrievable in the same scope'] : []),
      ]);
    }
  }
  const priority = { conflict: 0, recategorize: 1, supersede: 2, merge: 3, demote: 4, promote: 5, retire: 6 };
  candidates.sort((a, b) => priority[a.kind] - priority[b.kind]
    || (b.expectedSavings.residentTokens ?? -1) - (a.expectedSavings.residentTokens ?? -1) || a.id.localeCompare(b.id));
  candidates.forEach((candidate, index) => { candidate.advisoryRank = index + 1; });
  return MemoryRecommendationsSchema.parse({
    schemaVersion: 'aiwg.memory-recommendations.v1', at, workspace: audit.workspace, scope: audit.scope,
    advisoryOnly: true, defaultPlacement: 'indexed', thresholds: config.thresholds,
    coverage: { complete: audit.coverage.complete, limitsHit: audit.coverage.limitsHit, exclusions: audit.coverage.exclusions },
    candidates, notes: [
      'Ranking is advisory: conflicts, taxonomy, lineage, duplicates, demotion, promotion, retirement; savings only break ties. No approval or mutation is produced.',
      'Thresholds are configurable local starting points to evaluate per workload, not research-established values.',
      'New knowledge defaults to indexed storage; evaluate buildWorkspaceContextPack with the stated character budget before resident placement.',
      'Owner plan validation, exact source review, retrieval verification and provider regeneration remain required. Savings are conditional and are not additive across overlapping candidates.',
    ],
  });
}

export function formatMemoryRecommendations(report: MemoryRecommendations): string {
  return [`Memory recommendations (${report.scope}): ${report.workspace}; advisory only`,
    ...report.candidates.flatMap(c => [
      `${c.advisoryRank}. ${c.kind} ${c.target.sourcePath}${c.retrievalImpact.proposedPlacement ? ` -> ${c.retrievalImpact.proposedPlacement}` : ''} [${c.status}] ${c.id}`,
      `   ${c.rationale}; resident savings ${c.expectedSavings.residentTokens ?? 'unknown'} tokens (${c.expectedSavings.confidence})`,
      ...c.evidence.map(e => `   Evidence: ${e.source}: ${e.detail}`),
      ...c.blockedReasons.map(reason => `   Blocked: ${reason}`),
      ...c.protectedItemExceptions.map(reason => `   Protected: ${reason}`),
      `   Retrieval: ${c.retrievalImpact.detail}; bounded pack ${c.retrievalImpact.taskPack.totalCharacters} characters`,
      ...(c.residentJustification ? [`   Resident justification: ${JSON.stringify(c.residentJustification)}`] : []),
      `   Uncertainty: ${c.uncertainty.join('; ')}`,
    ]), ...report.notes].join('\n');
}
