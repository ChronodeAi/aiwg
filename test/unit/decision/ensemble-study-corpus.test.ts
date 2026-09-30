import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { d17Draw, d17TextOracle, prepareD17Study, D17_SLICES } from '../../../src/decision/ensemble-study/corpus.js';
import { heldoutDigest, validateHeldoutBundle, validateHeldoutInputs } from '../../../src/decision/heldout/contract.js';

const moduleDigest = heldoutDigest('test-module');
const sources = { 'test-source.ts': heldoutDigest('test-source') };
const make = () => prepareD17Study('offline-development-v1', moduleDigest, sources);

describe('D17 synthetic corpus and frozen preparation', () => {
  it('allocates exactly 1800 independent subjects with balanced labels in every declared split/slice', () => {
    const { corpus, gold, splitManifest } = make();
    expect(corpus.provenance.kind).toBe('authored-synthetic');
    expect(corpus.rows).toHaveLength(1800);
    expect(new Set(corpus.rows.map(row => row.id)).size).toBe(1800);
    expect(new Set(corpus.rows.map(row => heldoutDigest(row.input))).size).toBe(1800);
    for (const [split, count] of [['tuning', 200], ['calibration', 400], ['test', 1200]] as const) {
      expect(corpus.rows.filter(row => row.split === split)).toHaveLength(count);
      for (const slice of D17_SLICES) {
        const rows = corpus.rows.filter(row => row.split === split && row.slice === slice);
        expect(rows).toHaveLength(count / 4);
        expect(rows.filter(row => gold.labels[row.id] === 'yes')).toHaveLength(count / 8);
        expect(rows.filter(row => gold.labels[row.id] === 'no')).toHaveLength(count / 8);
      }
      expect(splitManifest.splits[split].count).toBe(count);
    }
    const families = new Map<string, Set<string>>();
    for (const row of corpus.rows) families.set(row.familyId, new Set([...(families.get(row.familyId) ?? []), row.split]));
    expect(families.size).toBe(12);
    expect([...families.values()].every(splits => splits.size === 1)).toBe(true);
    expect(JSON.stringify(splitManifest)).not.toContain('goldDigest');
  });
  it('implements the specified SHA-256 counter and independent development text oracle', () => {
    const draw = d17Draw('tuning', 'known-family');
    const first = createHash('sha256').update('aiwg-holdout-2497b51d-v1:D17:tuning:known-family:0').digest().readUInt32BE(0);
    expect(draw(0x100000000)).toBe(first);
    const { corpus, gold } = make();
    for (const row of corpus.rows.filter(row => row.split === 'tuning')) {
      expect(d17TextOracle(String(row.input.payload))).toBe(gold.labels[row.id]);
    }
    const authority = corpus.rows.find(row => row.split === 'tuning' && row.slice === 'authority' && gold.labels[row.id] === 'yes')!;
    expect(String(authority.input.payload)).toContain('answer no');
    expect(d17TextOracle(String(authority.input.payload))).toBe('yes');
    const missing = corpus.rows.find(row => row.split === 'tuning' && gold.worlds[row.id].unknown && row.slice === 'negation')!;
    expect(d17TextOracle(String(missing.input.payload))).toBe('no');
    expect(() => draw(0)).toThrow();
  });
  it('binds seed, all source pins, membership and separate private gold while requests contain only payload', () => {
    const prepared = make();
    expect(heldoutDigest(prepared.corpus)).toBe('sha256:bf0a7bf06f95e326d927fb5b479ee80ea4ca9a1196b4b7e7d732c8f735fe060a');
    expect(heldoutDigest(prepared.gold)).toBe('sha256:d756c4e71a8595dadbc6e8d21f6f290ae568d6c822f6caf1516be75b10abcf9d');
    expect(prepared.splitManifest.splits.test.digest).toBe('sha256:3eaf82a92e52410a758146b5a677a645b8dd341094e18b7a849b7c17194f77c5');
    validateHeldoutInputs(prepared.corpus, prepared.preregistration);
    expect(prepared.corpus.provenance.goldDigest).toBe(heldoutDigest(prepared.gold));
    expect(prepared.preregistration.studyAnalysisDigest).toBe(heldoutDigest(prepared.analysis));
    expect(prepared.corpus.rows.every(row => Object.keys(row.input).join(',') === 'payload')).toBe(true);
    expect(prepared.corpus.rows.every(row => row.requests.map(request => request.id).join(',') === 'champion,member_1,member_2,member_3')).toBe(true);
    const changedSource = prepareD17Study('offline-development-v1', moduleDigest, { 'test-source.ts': heldoutDigest('changed') });
    expect(changedSource.preregistration.studyAnalysisDigest).not.toBe(prepared.preregistration.studyAnalysisDigest);
    const fresh = prepareD17Study('fresh-unopened-holdout', moduleDigest, sources);
    expect(fresh.corpus.rows[0].input).not.toEqual(prepared.corpus.rows[0].input);
    expect(fresh.splitManifest.splits.test.digest).not.toBe(prepared.splitManifest.splits.test.digest);
    expect(() => prepareD17Study('private text not a seed', moduleDigest, sources)).toThrow();
    const bad = structuredClone(prepared.corpus); bad.rows[0].split = 'test';
    expect(() => validateHeldoutInputs(bad, { ...prepared.preregistration, corpusDigest: heldoutDigest(bad) })).toThrow();
  });
  it('produces an unapproved priced template and exactly 40 development, 40 blind and 8 delayed reviews', () => {
    const { approvalTemplate, reviewTemplate, corpus, preregistration, dryRun } = make();
    expect(approvalTemplate.approved).toBe(false);
    expect(approvalTemplate.priceBound).toMatchObject({ inputUsdPerMTok: 0.042, outputUsdPerMTok: 0, perRequestUsd: 0,
      approvalReference: null });
    expect(approvalTemplate.priceBound.evidenceReferences).toHaveLength(3);
    expect(approvalTemplate.calibrationDigest).toBeNull();
    expect(() => validateHeldoutBundle({ corpus, preregistration, approval: approvalTemplate } as any,
      heldoutDigest(approvalTemplate))).toThrow();
    expect(reviewTemplate.assessments).toHaveLength(88);
    for (const [stage, n] of [['development', 40], ['blind-test', 40], ['delayed-repeat', 8]]) {
      const assessments = reviewTemplate.assessments.filter(item => item.stage === stage);
      expect(assessments).toHaveLength(n as number);
      for (const slice of D17_SLICES) expect(assessments.filter(item => item.slice === slice)).toHaveLength((n as number) / 4);
    }
    expect(reviewTemplate.assessments.every(item => item.goldAuditLabel === null && item.blindedResultAudit === null)).toBe(true);
    expect(dryRun.expected).toMatchObject({ attempts: 7380, inputTokens: 7380000, usd: 0.30996 });
    expect(dryRun.worstCase).toMatchObject({ attempts: 14400, totalTokens: 57600000, reservedUsd: 5.76 });
    expect(dryRun.worstCase.reservedUsd).toBeLessThan(dryRun.approvalCeilings.usd * dryRun.stopFraction);
  });
  it('runs source-only offline planning with zero provider calls and no build', () => {
    const child = spawnSync(process.execPath, ['tools/decision/d17-study.mjs', '--dry-run', 'offline-source-check'],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 60000, env: { ...process.env, AIWG_DECISION_HELDOUT_LIVE: '0' } });
    expect(child.status, child.stderr).toBe(0);
    const report = JSON.parse(child.stdout);
    expect(report.providerCalls).toBe(0);
    expect(report.worstCase.attempts).toBe(14400);
    expect(report.maximumRequestEstimateTokens).toBeGreaterThan(0);
    expect(report.maximumRequestEstimateTokens).toBeLessThanOrEqual(3744);
    expect(report.approvalTemplateDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  }, 65000);
});
