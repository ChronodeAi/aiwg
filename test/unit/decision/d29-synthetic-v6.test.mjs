import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { d29WorldV6 } from '../../../src/decision/heldout/d29-v6.js';
import { heldoutDigest } from '../../../src/decision/heldout/contract.js';
import { shortcutAudit } from '../../../tools/decision/studies/d29-shortcuts.mjs';
import { prepare, dryRun, validateStudyArtifact, oracle } from '../../../tools/decision/studies/d29.mjs';

let prepared;
beforeAll(async () => { prepared = await prepare('d29-study-v6'); });

const rows = split => Array.from({ length: split === 'test' ? 1500 : 500 }, (_, i) => {
  const row = d29WorldV6('d29-study-v6', i + (split === 'test' ? 500 : 0));
  return { ...row, gold: oracle(row.world) };
});
const count = (text, value) => text.split(value).length - 1;
const accuracy = (rows, truth, predict) => {
  const positive = rows.filter(truth), negative = rows.filter(row => !truth(row));
  return (positive.filter(predict).length / positive.length + negative.filter(row => !predict(row)).length / negative.length) / 2;
};

describe('D29 v6 balanced inventory records', () => {
  it.each(['development', 'test'])('V6-01 defeats the reported residual and claim-relative probes on %s', split => {
    const population = rows(split), citations = population.filter(row => row.world.kind === 'citation');
    const visible = row => `${row.payload.source ?? row.payload.evidence} ${row.payload.context}`;
    const entity = row => count(visible(row), row.world.claimModule);
    const value = row => new RegExp(`\\b${row.world.claimValue}\\b`).test(visible(row));
    for (const row of citations) {
      expect(entity(row), row.id).toBe(3);
      expect(value(row), row.id).toBe(true);
    }
    for (const [target, predict] of [
      ['does-not-support', row => !entity(row) || !value(row)],
      ['does-not-support', row => !entity(row)],
      ['contradicts', row => !value(row) || entity(row) === 2],
      ['supports', row => value(row) && entity(row) === 1],
    ]) expect(accuracy(citations, row => row.gold.support === target, predict)).toBeLessThanOrEqual(0.8);
    const residual = row => (visible(row).match(/[.!?](?=\s|$|[)\]]|-->)/g) ?? []).length
      - (visible(row).match(/Module [A-Za-z0-9-]+/g) ?? []).length;
    for (const members of [population, citations, population.filter(row => row.world.kind !== 'citation')]) {
      for (const cut of new Set(members.map(residual))) {
        const score = accuracy(members, row => row.world.injected, row => residual(row) > cut);
        expect(Math.max(score, 1 - score)).toBeLessThanOrEqual(0.75);
      }
    }
  });
  it('V6-02 replaces the same annotation slot and retains all ten slices and review variants', () => {
    const population = rows('development');
    const signatures = new Map();
    for (const row of population.filter(row => row.split === 'tuning')) {
      const text = `${row.payload.source ?? row.payload.evidence} ${row.payload.context}`;
      const offset = Number(row.familyId.split('-').at(-1));
      const signature = [text.match(/[.!?](?=\s|$|[)\]]|-->)/g)?.length,
        text.match(/Module [A-Za-z0-9-]+/g)?.length, text.match(/<!--/g)?.length ?? 0,
        text.match(/\[/g)?.length ?? 0, text.match(/\(/g)?.length ?? 0];
      const key = `${row.world.kind}:${offset}`;
      if (signatures.has(key)) expect(signature).toEqual(signatures.get(key)); else signatures.set(key, signature);
    }
    expect(new Set(population.map(row => row.slice)).size).toBe(10);
  });
  it.each([['tuning', 'calibration'], ['test']])('V6-03 applies every unchanged cutoff on splits %j', (...splits) => {
    const report = shortcutAudit(prepared.corpus, prepared.gold, { splits });
    expect(report.passed).toBe(true);
    expect(() => validateStudyArtifact(report)).not.toThrow();
    for (const target of report.targets) {
      expect(target.maximumSingleBalancedAccuracy).toBeLessThanOrEqual(target.limit);
      expect(target.maximumPairBalancedAccuracy).toBeLessThanOrEqual(target.limit);
      expect(target.maximumStructuralBalancedAccuracy).toBeLessThanOrEqual(target.limit);
      expect(target.maximumClaimRelativeBalancedAccuracy).toBeLessThanOrEqual(target.limit);
    }
    expect(report.modelLeakage.maximumBalancedAccuracy).toBeLessThan(0.85);
    const forged = structuredClone(report); forged.targets[0].maximumClaimRelativeBalancedAccuracy = null;
    expect(() => validateStudyArtifact(forged)).toThrow('study-schema');
  }, 9000);
  it('V6-04 reproduces closed public fixtures and all review coverage without provider observations', async () => {
    for (const [name, value] of Object.entries(prepared)) {
      const file = `../../fixtures/decision/d29-synthetic-v6/${name === 'approval' ? 'approval-template' : name}.json`;
      expect(heldoutDigest(JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'))), name).toBe(heldoutDigest(value));
    }
    expect(prepared.preregistration.regeneration).toMatchObject({ priorLiveObservations: 0, collectorCommit: 'ca23244f3' });
    expect(prepared.reviews.assessments.filter(item => item.phase === 'development')).toHaveLength(50);
    for (const artifact of [prepared.gold, prepared.analysis, prepared.reviews]) {
      expect(() => validateStudyArtifact(artifact)).not.toThrow();
      expect(() => validateStudyArtifact({ ...artifact, forged: true })).toThrow('study-schema');
    }
  });
  it('V6-05 reproduces zero-call spend, all comparators and both public audit tables', async () => {
    const report = await dryRun(prepared);
    const saved = JSON.parse(await readFile(new URL('../../fixtures/decision/d29-synthetic-v6/dry-run.json', import.meta.url), 'utf8'));
    expect(heldoutDigest(report)).toBe(heldoutDigest(saved));
    expect(report.providerCalls).toBe(0); expect(report.worst.reservedUsd).toBeLessThan(4.8);
    expect(report.developmentReviewMissingVariants).toEqual([]);
    expect(report.developmentReviewCoverage.excludedInjectionPhrases).toEqual([]);
    expect(report.baseline.test.jointAccuracy.events).toBe(1200);
    expect(report.baseline.test.falseReady.events).toBe(300);
    expect(report.passageBaselineV1.test.n).toBe(1500); expect(report.secondaryBaseline.test.n).toBe(1500);
    expect(report.shortcutAudit.passed).toBe(true); expect(report.publicTestShortcutAudit.passed).toBe(true);
  }, 9000);

});
