import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import type { MemoryAudit } from '../../../src/memory/audit.js';
import { memoryRecordId } from '../../../src/memory/maintenance-record.js';
import { costMemory } from '../../../src/memory/cost.js';
import { sha256 } from '../../../src/memory/context-pack.js';
import { recommendMemory, MemoryRecommendationsSchema, formatMemoryRecommendations, type RecommendationInputs } from '../../../src/memory/recommend.js';
import { parseMemoryRecommendOptions } from '../../../src/memory/recommend-cli.js';

const at = '2026-10-24T12:00:00.000Z';
function fixture(names = ['rare-rule', 'fresh-note', 'stale-summary', 'duplicate-a', 'duplicate-b', 'used-note', 'old-note', 'unknown-note']): MemoryAudit {
  return {
    schemaVersion: 'aiwg.memory-audit.v1', at, workspace: '/synthetic/workspace', scope: 'project', providers: [],
    findings: [], coverage: { mode: 'static', complete: true, roots: [], limits: { maxDepth: 12, maxFiles: 5000, maxEntries: 20000, maxMs: 5000, maxFileBytes: 2000000, maxExposures: 20000 }, limitsHit: [], files: names.length, entries: names.length, exclusions: [] },
    items: names.map(name => {
      const digest = sha256(name.startsWith('duplicate') ? 'duplicate' : name);
      const sourcePath = `${name}.md`;
      const id = memoryRecordId(sourcePath, digest);
      const observation = { status: 'on-disk' as const, evidence: { source: 'synthetic-inventory', at, session: null, provider: null, version: null } };
      return { id, sourcePath, digest, category: 'memory-store', bytes: 4096, observation, exposures: [], trust: 'unknown', reviewStatus: 'unknown', managed: false,
        record: { schemaVersion: 'aiwg.memory-record.v1' as const, id, sourcePath, digest, version: 1, aliases: [], supersedes: [], mergedFrom: [], splitFrom: [],
          scope: 'project' as const, placement: name === 'rare-rule' ? 'resident' as const : 'indexed' as const, lifecycle: 'active' as const,
          authority: { owner: 'semantic-memory', source: 'operator' as const, protection: name === 'rare-rule' ? 'pinned' as const : 'unprotected' as const }, observation } };
    }),
  };
}
const id = (audit: MemoryAudit, name: string) => audit.items.find(item => item.sourcePath === `${name}.md`)!.id;
const evidence = JSON.parse(fs.readFileSync(new URL('../../fixtures/memory-maintenance/recommendation-evidence.json', import.meta.url), 'utf8'));
const old = { source: 'synthetic-reviewed-source', provenance: 'verified' as const, history: 'known' as const, createdAt: '2025-01-01T00:00:00.000Z', reviewedAt: '2025-01-01T00:00:00.000Z', obsolete: true };
const usage = (audit: MemoryAudit) => Object.fromEntries(audit.items.map(item => [item.id, { used: item.sourcePath === 'used-note.md', retrieved: true, evidence: 'synthetic-utility-observation' }]));
const inputs = (audit: MemoryAudit): RecommendationInputs => ({ items: {
  ...Object.fromEntries(Object.entries(evidence).map(([name, value]) => [id(audit, name), value])),
  [id(audit, 'old-note')]: old,
  [id(audit, 'unknown-note')]: { source: 'synthetic-obsolescence-claim', obsolete: true },
} });

describe('evidence-ranked memory recommendations', () => {
  it('explains all candidate kinds from inventory, cost and explicit utility', () => {
    const audit = fixture();
    const report = recommendMemory(audit, inputs(audit), { usage: usage(audit) });
    expect(new Set(report.candidates.map(c => c.kind))).toEqual(new Set(['merge', 'recategorize', 'conflict', 'supersede', 'demote', 'promote', 'retire']));
    expect(report.defaultPlacement).toBe('indexed');
    expect(report.advisoryOnly).toBe(true);
    for (const candidate of report.candidates) {
      expect(candidate.evidence.length).toBeGreaterThanOrEqual(2);
      expect(candidate.uncertainty.length).toBeGreaterThan(0);
      expect(candidate.retrievalImpact.requiresVerification).toBe(true);
      expect(candidate.retrievalImpact.taskPack.builder).toBe('buildWorkspaceContextPack');
    }
    expect(formatMemoryRecommendations(report)).toMatch(/advisory only/);
    expect(report.candidates.map(c => c.advisoryRank)).toEqual(report.candidates.map((_, index) => index + 1));
  });

  it('keeps low-frequency critical rules and rare-obligation pins as blocked candidates', () => {
    const audit = fixture();
    const report = recommendMemory(audit, inputs(audit), { usage: usage(audit) });
    const retirement = report.candidates.find(c => c.kind === 'retire' && c.target.id === id(audit, 'rare-rule'))!;
    expect(retirement.status).toBe('blocked');
    expect(retirement.protectedItemExceptions.join(' ')).toMatch(/Owner pin.*Rare obligation.*Critical/);
    expect(retirement.blockedReasons).toEqual(expect.arrayContaining(retirement.protectedItemExceptions));
  });

  it('cannot clear a source pin through caller evidence', () => {
    const audit = fixture(['rare-rule']);
    const report = recommendMemory(audit, { items: { [audit.items[0].id]: { ...old, ownerPinned: false } } }, { usage: usage(audit) });
    expect(report.candidates.find(c => c.kind === 'retire')!.blockedReasons).toContain('Owner pin protects this item');
  });

  it('protects freshly created notes even with claimed obsolescence and old review dates', () => {
    const audit = fixture();
    const report = recommendMemory(audit, inputs(audit), { usage: usage(audit) });
    const retirement = report.candidates.find(c => c.kind === 'retire' && c.target.id === id(audit, 'fresh-note'))!;
    expect(retirement.status).toBe('blocked');
    expect(retirement.blockedReasons.join(' ')).toMatch(/Freshly created/);
  });

  it('reports unknown history as blocked rather than treating missing telemetry as disuse', () => {
    const audit = fixture();
    const retirement = recommendMemory(audit, inputs(audit)).candidates.find(c => c.kind === 'retire' && c.target.id === id(audit, 'unknown-note'))!;
    expect(retirement.status).toBe('blocked');
    expect(retirement.blockedReasons.join(' ')).toMatch(/Unknown history.*Unknown creation age.*Observed utility history is unknown/);
  });

  it('never uses review age, retrieval frequency or rejection alone to retire', () => {
    const audit = fixture(['old-note']);
    const report = recommendMemory(audit, { items: { [audit.items[0].id]: { ...old, obsolete: false } } }, { usage: { [audit.items[0].id]: { used: false, rejected: true, evidence: 'synthetic-outcome' } } });
    expect(report.candidates.find(c => c.kind === 'retire')!.blockedReasons.join(' ')).toMatch(/insufficient/);
  });

  it('permits advisory retirement only with corroborating evidence and preserves source axes', () => {
    const audit = fixture(['old-note']);
    const report = recommendMemory(audit, { items: { [audit.items[0].id]: old } }, { usage: usage(audit) });
    const candidate = report.candidates.find(c => c.kind === 'retire')!;
    expect(candidate.status).toBe('advisory');
    expect(candidate.target).toEqual(audit.items[0].record);
    expect(candidate.retrievalImpact.detail).toMatch(/tombstone.*history\/restore/);
  });

  it('marks stale summaries for source and supersession repair without inventing replacement facts', () => {
    const audit = fixture();
    const report = recommendMemory(audit, inputs(audit));
    const summary = report.candidates.filter(c => c.target.id === id(audit, 'stale-summary'));
    expect(summary.map(c => c.kind)).toEqual(expect.arrayContaining(['conflict', 'supersede', 'recategorize']));
    expect(summary.find(c => c.kind === 'supersede')!.blockedReasons.join(' ')).toMatch(/replacement.*lineage/);
    expect(JSON.stringify(report)).not.toContain('replacements');
  });

  it('surfaces conflicting duplicate source evidence and never silently merges it', () => {
    const audit = fixture(['duplicate-a', 'duplicate-b']);
    audit.findings.push({ code: 'conflicting-owner-metadata', paths: audit.items.map(i => i.sourcePath), detail: 'Synthetic contradictory sources' });
    const report = recommendMemory(audit);
    expect(report.candidates.filter(c => c.kind === 'conflict')).toHaveLength(2);
    expect(report.candidates.find(c => c.kind === 'merge')!.status).toBe('blocked');
    expect(report.candidates.find(c => c.kind === 'merge')!.evidence.some(e => e.detail.includes('contradictory'))).toBe(true);
  });

  it('reports physical duplicates that audit deduplicated to one immutable identity', () => {
    const audit = fixture(['rare-rule']);
    audit.findings.push({ code: 'duplicate-resident-copy', paths: ['rare-rule.md', 'derived-copy.md'], detail: 'Synthetic duplicate exposure paths' });
    const merge = recommendMemory(audit).candidates.find(c => c.kind === 'merge')!;
    expect(merge.status).toBe('blocked');
    expect(merge.blockedReasons.join(' ')).toMatch(/deployment\/regeneration/);
    expect(merge.related).toEqual([]);
  });

  it('blocks a merge across scope, authority, inactive originals or protected related items', () => {
    const audit = fixture(['duplicate-a', 'duplicate-b']);
    audit.items[1].record!.authority.protection = 'pinned';
    audit.items[1].record!.scope = 'global';
    const candidate = recommendMemory(audit).candidates.find(c => c.kind === 'merge')!;
    expect(candidate.status).toBe('blocked');
    expect(candidate.blockedReasons.join(' ')).toMatch(/scope or authority/);
    expect(candidate.protectedItemExceptions).toContain('Owner pin protects this item');
  });

  it('prefers bounded task packs for observed use and rejects an incomplete resident proposal', () => {
    const audit = fixture(['used-note']);
    const report = recommendMemory(audit, { items: { [audit.items[0].id]: { source: 'synthetic-owner-request', residentProposal: {} } } }, { usage: usage(audit) });
    expect(report.candidates.find(c => c.retrievalImpact.proposedPlacement === 'task-context')!.status).toBe('advisory');
    const resident = report.candidates.find(c => c.retrievalImpact.proposedPlacement === 'resident')!;
    expect(resident.status).toBe('rejected');
    expect(resident.blockedReasons.join(' ')).toMatch(/owner.*rationale.*budget.*review date.*buildWorkspaceContextPack/i);
  });

  it('accepts a budgeted, dated resident proposal only after bounded-pack evaluation', () => {
    const audit = fixture(['used-note']);
    const report = recommendMemory(audit, { items: { [audit.items[0].id]: { source: 'synthetic-owner-request', provenance: 'verified', residentProposal: {
      owner: 'semantic-memory', rationale: 'Continuing task obligation', budgetTokens: 1024, reviewDate: '2026-11-01T00:00:00.000Z', boundedPackEvaluated: true,
    } } } }, { usage: usage(audit) });
    const resident = report.candidates.find(c => c.retrievalImpact.proposedPlacement === 'resident')!;
    expect(resident.status).toBe('advisory');
    expect(resident.residentJustification?.owner).toBe('semantic-memory');
    expect(resident.target.authority).toEqual(audit.items[0].record!.authority);
  });

  it.each([
    { owner: 'another-owner' }, { budgetTokens: 1 }, { reviewDate: '2026-01-01T00:00:00.000Z' }, { boundedPackEvaluated: false },
  ])('rejects resident placement with invalid justification %j', override => {
    const audit = fixture(['used-note']);
    const report = recommendMemory(audit, { items: { [audit.items[0].id]: { source: 'synthetic-owner-request', provenance: 'verified', residentProposal: {
      owner: 'semantic-memory', rationale: 'Continuing obligation', budgetTokens: 1024, reviewDate: '2026-11-01T00:00:00.000Z', boundedPackEvaluated: true, ...override,
    } } } }, { usage: usage(audit) });
    expect(report.candidates.find(c => c.retrievalImpact.proposedPlacement === 'resident')!.status).toBe('rejected');
  });

  it('rejects self-supersession as retirement evidence', () => {
    const audit = fixture(['old-note']);
    const report = recommendMemory(audit, { items: { [audit.items[0].id]: { ...old, supersededBy: audit.items[0].id } } }, { usage: usage(audit) });
    expect(report.candidates.find(c => c.kind === 'retire')!.blockedReasons).toContain('An item cannot supersede itself');
  });

  it('retains cost.ts confidence and anchor overhead; unmeasurable savings stay unknown', () => {
    const audit = fixture(['rare-rule']);
    const candidate = recommendMemory(audit).candidates.find(c => c.kind === 'demote')!;
    const cost = costMemory(audit, { demote: [audit.items[0].id] });
    const preview = cost.demotionPreview!.targets[0];
    expect(candidate.expectedSavings.residentTokens).toBe(preview.before.tokens! - preview.after.anchorTokens);
    expect(candidate.expectedSavings.confidence).toBe('inferred');
    audit.items[0].bytes = null;
    const unknown = recommendMemory(audit).candidates.find(c => c.kind === 'demote')!;
    expect(unknown.expectedSavings.residentTokens).toBeNull();
    expect(unknown.expectedSavings.confidence).toBe('unknown');
  });

  it('honors configurable local thresholds and reports incomplete coverage', () => {
    const audit = fixture(['rare-rule']);
    audit.coverage.complete = false;
    audit.coverage.limitsHit = ['maxFiles'];
    const report = recommendMemory(audit, { thresholds: { demoteMinimumTokens: 2000, minimumAgeDays: 7, reviewAgeDays: 14, taskPackCharacters: 4000 } });
    expect(report.candidates).toHaveLength(0);
    expect(report.thresholds.minimumAgeDays).toBe(7);
    expect(report.coverage).toMatchObject({ complete: false, limitsHit: ['maxFiles'] });
    expect(report.notes.join(' ')).toMatch(/local starting points.*not research-established/);
  });

  it('rejects malformed thresholds, unknown evidence targets and false utility types', () => {
    const audit = fixture(['old-note']);
    expect(() => recommendMemory(audit, { thresholds: { minimumAgeDays: -1 } })).toThrow();
    expect(() => recommendMemory(audit, { items: { missing: old } })).toThrow(/outside/);
    expect(() => recommendMemory(audit, {}, { usage: { [audit.items[0].id]: { used: 'false' as unknown as boolean } } })).toThrow();
  });

  it('leaves its input inventory and evidence unchanged and ranks deterministically', () => {
    const audit = fixture();
    const config = inputs(audit);
    const before = JSON.stringify({ audit, config });
    const a = recommendMemory(audit, config, { usage: usage(audit) });
    const b = recommendMemory({ ...audit, items: [...audit.items].reverse() }, config, { usage: usage(audit) });
    expect(JSON.stringify({ audit, config })).toBe(before);
    expect(a).toEqual(b);
  });

  it('validates reports with the published JSON schema and rejects mutation-shaped output', () => {
    const require = createRequire(import.meta.url);
    const Ajv2020 = require('ajv/dist/2020.js').default;
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    require('ajv-formats')(ajv);
    for (const name of ['memory-taxonomy', 'memory-record', 'memory-recommendations']) {
      ajv.addSchema(JSON.parse(fs.readFileSync(new URL(`../../../schemas/memory/${name}.v1.schema.json`, import.meta.url), 'utf8')));
    }
    const validate = ajv.getSchema('https://aiwg.io/schemas/memory/memory-recommendations.v1.schema.json');
    const audit = fixture();
    const report = recommendMemory(audit, inputs(audit), { usage: usage(audit) });
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    expect(MemoryRecommendationsSchema.safeParse(report).success).toBe(true);
    expect(validate({ ...report, advisoryOnly: false })).toBe(false);
    expect(validate({ ...report, operations: [] })).toBe(false);
    expect(validate({ ...report, schemaVersion: 'aiwg.memory-recommendations.v2' })).toBe(false);
    expect(validate(recommendMemory(fixture([])))).toBe(true);
  });
});

describe('recommend strict CLI options', () => {
  it.each([
    ['--write'], ['--apply'], ['--json=true'], ['--scope'], ['--scope', 'provider'], ['--scope', 'workspace'],
    ['--provider=claude', '--provider', 'codex'], ['--evidence'], ['--evidence=a', '--evidence=b'],
    ['--candidate=x'], ['--emit-review-input'], ['--emit-review-input=true'], ['--usage'], ['--demote=x'],
  ])('rejects invalid arguments %j', (...args) => { expect(() => parseMemoryRecommendOptions(args)).toThrow(); });
  it('uses shared scope/provider conventions and paired stdout export', () => {
    expect(parseMemoryRecommendOptions(['--scope=provider', '--provider=codex', '--evidence=e.json', '--usage=u.json', '--candidate=id', '--emit-review-input'])).toMatchObject({ scope: 'provider', provider: 'codex', evidence: 'e.json', usage: 'u.json', candidate: 'id', emitReviewInput: true });
  });
});
