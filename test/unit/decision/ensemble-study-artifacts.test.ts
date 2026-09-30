import { describe, expect, it } from 'vitest';
import { validateD17Artifact, type D17Review } from '../../../src/decision/ensemble-study/artifacts.js';
import { prepareD17Study } from '../../../src/decision/ensemble-study/corpus.js';
import { heldoutDigest } from '../../../src/decision/heldout/contract.js';

const pin = `sha256:${'a'.repeat(64)}` as const;
const prepared = prepareD17Study('schema-tests', pin, { 'src/decision/ensemble-study/corpus.ts': pin });
const artifacts = { analysis: prepared.analysis, splits: prepared.splitManifest, gold: prepared.gold,
  review: prepared.reviewTemplate, guide: prepared.guide, nativeTemplates: prepared.nativeTemplates, dryRun: prepared.dryRun };

describe('D17 preparation artifact validation', () => {
  it.each(['analysis', 'splits', 'gold', 'review', 'guide', 'nativeTemplates', 'dryRun'] as const)('accepts complete %s and rejects versions and extra fields', name => {
    expect(() => validateD17Artifact(name, artifacts[name])).not.toThrow();
    expect(() => validateD17Artifact(name, { ...artifacts[name], schemaVersion: 'unknown/v2' })).toThrow();
    expect(() => validateD17Artifact(name, { ...artifacts[name], extra: true })).toThrow();
  });

  it('keeps incomplete native templates disabled and rejects forged approvals or calibration pins', () => {
    const template = prepared.nativeTemplates;
    expect(() => validateD17Artifact('nativeTemplates', { ...template, approved: true })).toThrow();
    expect(() => validateD17Artifact('nativeTemplates', { ...template, policy: { ...template.policy, mode: 'enabled' } })).toThrow();
    const calibration = structuredClone(template);
    Object.assign(calibration.policy.members[0]!, { calibration: { digest: pin } });
    expect(() => validateD17Artifact('nativeTemplates', calibration)).toThrow();
    const member = structuredClone(template);
    Object.assign(member.policy.members[0]!, { trusted: true });
    expect(() => validateD17Artifact('nativeTemplates', member)).toThrow();
    const altered = structuredClone(template);
    Object.assign(altered.comparison.pairedMetrics[0]!, { bound: -0.1 });
    expect(() => validateD17Artifact('nativeTemplates', altered)).toThrow();
  });

  it('freezes dry-run cost and call ceilings and leaves output token usage unknown', () => {
    const plan = prepared.dryRun;
    expect(plan.schemaVersion).toBe('decision-d17-dry-run/v1');
    expect(() => validateD17Artifact('dryRun', { ...plan, worstCase: { ...plan.worstCase, reservedUsd: 0 } })).toThrow();
    expect(() => validateD17Artifact('dryRun', { ...plan, expected: { ...plan.expected, outputTokens: 0 } })).toThrow();
    expect(() => validateD17Artifact('dryRun', { ...plan, approvalCeilings: { ...plan.approvalCeilings, calls: 18001 } })).toThrow();
    expect(() => validateD17Artifact('dryRun', { ...plan, worstCase: { ...plan.worstCase, reportedByProvider: true } })).toThrow();
  });

  it('references the frozen protocol and rejects changed nested thresholds or source pins', () => {
    const analysis = structuredClone(prepared.analysis);
    expect(() => validateD17Artifact('analysis', { ...analysis, protocol: { ...analysis.protocol,
      risk: { ...analysis.protocol.risk, maximumAcceptedErrorUpperBps: 1000 } } })).toThrow();
    expect(() => validateD17Artifact('analysis', { ...analysis, sourceDigests: { source: 'unknown' } })).toThrow();
    expect(() => validateD17Artifact('analysis', { ...analysis, sourceDigests: {} })).toThrow();
    expect(() => validateD17Artifact('analysis', { ...analysis, splitManifestDigest: null })).toThrow();
  });

  it('rejects changed split counts, undeclared member fields, stale digests and duplicate identities', () => {
    const manifest = structuredClone(prepared.splitManifest);
    manifest.splits.test.count = 1199;
    expect(() => validateD17Artifact('splits', manifest)).toThrow();
    const extra = structuredClone(prepared.splitManifest);
    Object.assign(extra.splits.test.members[0]!, { goldDigest: pin });
    expect(() => validateD17Artifact('splits', extra)).toThrow();
    const stale = structuredClone(prepared.splitManifest);
    stale.splits.test.members[0]!.inputDigest = pin;
    expect(() => validateD17Artifact('splits', stale)).toThrow('digest mismatch');
    const duplicate = structuredClone(prepared.splitManifest);
    duplicate.splits.test.members[1]!.id = duplicate.splits.test.members[0]!.id;
    duplicate.splits.test.digest = heldoutDigest(duplicate.splits.test.members);
    expect(() => validateD17Artifact('splits', duplicate)).toThrow('isolation');
  });

  it('rejects cross-split families despite recomputed member digests', () => {
    const manifest = structuredClone(prepared.splitManifest);
    manifest.splits.test.members[0]!.familyId = manifest.splits.tuning.members[0]!.familyId;
    manifest.splits.test.digest = heldoutDigest(manifest.splits.test.members);
    expect(() => validateD17Artifact('splits', manifest)).toThrow('isolation');
  });

  it('validates all 1800 local labels and closed world fields without accepting missing or foreign gold', () => {
    const id = Object.keys(prepared.gold.labels)[0]!;
    const missing = structuredClone(prepared.gold);
    delete missing.labels[id];
    expect(() => validateD17Artifact('gold', missing)).toThrow();
    const foreign = structuredClone(prepared.gold);
    foreign.labels['0'.repeat(64)] = foreign.labels[id]!;
    delete foreign.labels[id];
    expect(() => validateD17Artifact('gold', foreign)).toThrow('membership');
    const extra = structuredClone(prepared.gold);
    Object.assign(extra.worlds[id]!, { confidence: 1 });
    expect(() => validateD17Artifact('gold', extra)).toThrow();
    const invalidLabel = structuredClone(prepared.gold);
    Object.assign(invalidLabel.labels, { [id]: 'unknown' });
    expect(() => validateD17Artifact('gold', invalidLabel)).toThrow();
    const invalidWorld = structuredClone(prepared.gold);
    invalidWorld.worlds[id]!.day = 366;
    expect(() => validateD17Artifact('gold', invalidWorld)).toThrow();
  });

  it('accepts populated review responses while preserving the 88-item stratified sample', () => {
    const review: D17Review = structuredClone(prepared.reviewTemplate);
    review.reviewer = 'operator';
    review.preregistrationReview = 'external-immutable-record-1';
    review.finalDispositionReview = 'HOLD pending live evidence';
    Object.assign(review.assessments[0]!, { reviewedAt: '2026-09-30T12:00:00Z', goldAuditLabel: 'yes',
      goldAmbiguousOrIncorrect: false, blindedResultAudit: 'Agreement on the visible facts.', rationale: 'Explicit support.' });
    expect(() => validateD17Artifact('review', review)).not.toThrow();
    Object.assign(review.assessments[0]!, { unregisteredResponse: true });
    expect(() => validateD17Artifact('review', review)).toThrow();
  });

  it('rejects truncated, duplicated, wrong-stage or non-repeated review samples', () => {
    const truncated = structuredClone(prepared.reviewTemplate);
    truncated.assessments.pop();
    expect(() => validateD17Artifact('review', truncated)).toThrow();
    const duplicate = structuredClone(prepared.reviewTemplate);
    duplicate.assessments[1]!.assessmentId = duplicate.assessments[0]!.assessmentId;
    expect(() => validateD17Artifact('review', duplicate)).toThrow('review IDs');
    const stage = structuredClone(prepared.reviewTemplate);
    stage.assessments[0]!.stage = 'blind-test';
    expect(() => validateD17Artifact('review', stage)).toThrow('review sample');
    const mismatched = structuredClone(prepared.reviewTemplate);
    mismatched.assessments[0]!.inputDigest = heldoutDigest('different input');
    expect(() => validateD17Artifact('review', mismatched)).toThrow('review sample');
    const repeat = structuredClone(prepared.reviewTemplate);
    repeat.assessments[80]!.rowId = 'f'.repeat(64);
    expect(() => validateD17Artifact('review', repeat)).toThrow('review repeat');
  });

  it('admits object graphs before validators can evaluate accessors or non-JSON values', () => {
    let evaluated = false;
    const hostile = { ...prepared.guide };
    Object.defineProperty(hostile, 'population', { enumerable: true, get: () => { evaluated = true; return 'synthetic'; } });
    expect(() => validateD17Artifact('guide', hostile)).toThrow('accessor-or-hidden-field');
    expect(evaluated).toBe(false);
    expect(() => validateD17Artifact('guide', { ...prepared.guide, timing: undefined })).toThrow('non-json-value');
  });
});
