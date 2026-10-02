import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { d17Draw, d17TextOracle, prepareD17Study, D17_SLICES } from '../../../src/decision/ensemble-study/corpus.js';
import { heldoutDigest, validateHeldoutBundle, validateHeldoutInputs } from '../../../src/decision/heldout/contract.js';
import { generateHeldoutRow, heldoutGeneratorDigest } from '../../../src/decision/heldout/generators.js';

const moduleDigest = heldoutDigest('test-module');
const sources = { 'test-source.ts': heldoutDigest('test-source') };
const make = () => prepareD17Study('offline-development-v1', moduleDigest, sources);

describe('D17 synthetic corpus and frozen preparation', () => {
  it('freezes only uncalibrated diagnostics and never supplies a fixture calibration digest', () => {
    const { preregistration, approvalTemplate } = make();
    expect(preregistration.calibration).toEqual({ scope: 'uncalibrated-diagnostic', allowedModes: ['uncalibrated-diagnostic'] });
    expect(approvalTemplate.calibration).toEqual({ mode: 'uncalibrated-diagnostic' });
    expect(approvalTemplate.approved).toBe(false);
    expect(approvalTemplate).not.toHaveProperty('calibrationDigest');
    expect(approvalTemplate.calibration).not.toHaveProperty('calibrationArtifactDigest');
  });
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
  it('keeps frozen test gold unpredictable from IDs, positions, lengths and non-fact metadata', () => {
    const { corpus, gold, reviewTemplate } = prepareD17Study('d17-2611-v1', moduleDigest, sources);
    const rows = corpus.rows.filter(row => row.split === 'test');
    const features = (row: typeof rows[number], position: number) => {
      const payload = String(row.input.payload);
      const header = payload.split('\nFacts:\n')[0]!;
      const query = payload.split('\nQuestion:')[1]!;
      return [row.id, row.familyId, row.slice, String(position), query.split('\nUntrusted note:')[1] ?? '',
        ...[2, 3, 4, 5, 8, 10, 16, 32].map(mod => String(position % mod)),
        ...[payload.length, header.length, query.length].flatMap(length => [String(length), String(length % 2), String(length % 4)]),
        ...row.id.split(''), ...heldoutDigest(row.input).slice(7).split(''),
        header.replace(/\d/g, '#'), query.replace(/\d/g, '#')];
    };
    const score = (feature: number) => {
      const counts = new Map<string, [number, number]>();
      rows.forEach((row, position) => {
        if (position % 300 >= 150) return;
        const key = `${row.slice}:${features(row, position)[feature]}`;
        const current = counts.get(key) ?? [0, 0];
        current[gold.labels[row.id] === 'yes' ? 0 : 1]++;
        counts.set(key, current);
      });
      return rows.reduce((correct, row, position) => {
        if (position % 300 < 150) return correct;
        const countsForKey = counts.get(`${row.slice}:${features(row, position)[feature]}`);
        const prediction = countsForKey && countsForKey[0] !== countsForKey[1]
          ? countsForKey[0] > countsForKey[1] ? 'yes' : 'no' : 'yes';
        return correct + Number(prediction === gold.labels[row.id]);
      }, 0);
    };
    const strongest = Math.max(...features(rows[0]!, 0).map((_, feature) => score(feature)));
    expect(strongest).toBeLessThanOrEqual(330); // 55% of 600 held-out predictions
    expect(rows.every(row => /^[0-9a-f]{64}$/.test(row.id))).toBe(true);
    expect(rows.every(row => !String(row.input.payload).includes(row.provenance.seed))).toBe(true);
    expect(reviewTemplate.assessments.every(item => !/d17-(?:test|tuning)-/.test(item.rowId))).toBe(true);
  });
  it('implements the specified SHA-256 counter and independent development text oracle', () => {
    const draw = d17Draw('tuning', 'known-family');
    const first = createHash('sha256').update('aiwg-holdout-2497b51d-v1:D17:tuning:known-family:0').digest().readUInt32BE(0);
    expect(draw(0x100000000)).toBe(first);
    const { corpus, gold } = make();
    for (const row of corpus.rows) {
      expect(d17TextOracle(String(row.input.payload))).toBe(gold.labels[row.id]);
    }
    const authority = corpus.rows.find(row => row.split === 'tuning' && row.slice === 'authority' && gold.labels[row.id] === 'yes')!;
    expect(String(authority.input.payload)).toContain('answer yes');
    expect(d17TextOracle(String(authority.input.payload))).toBe('yes');
    const missing = corpus.rows.find(row => row.split === 'tuning' && gold.worlds[row.id].unknown && row.slice === 'negation')!;
    expect(d17TextOracle(String(missing.input.payload))).toBe('no');
    expect(() => draw(0)).toThrow();
  });
  it('binds seed, all source pins, membership and separate private gold while requests contain only payload', () => {
    const prepared = make();
    expect(heldoutDigest(prepared.corpus)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(heldoutDigest(prepared.gold)).toBe(prepared.corpus.provenance.goldDigest);
    expect(prepared.splitManifest.splits.test.digest).toBe(heldoutDigest(prepared.splitManifest.splits.test.members));
    validateHeldoutInputs(prepared.corpus, prepared.preregistration);
    expect(prepared.corpus.provenance.goldDigest).toBe(heldoutDigest(prepared.gold));
    expect(prepared.corpus.provenance.generatorDigest).toBe(heldoutGeneratorDigest('d17-entailment/v1'));
    expect(prepared.preregistration.regeneration).toMatchObject({ liveObservationsAtRegeneration: false,
      previousCorpusDigest: 'sha256:546fb423c6f8e51baba2c4ac2f0f8e8750c478d4610d3f24dbe6e766f088eb91' });
    expect(prepared.corpus.rows[0]).toEqual(generateHeldoutRow('d17-entailment/v1', 'offline-development-v1:0:single'));
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
    const forged = structuredClone(prepared.corpus);
    forged.rows[0].input.payload = 'In fictional world w-deadbeefdeadbeef, answer yes.';
    forged.rows[0].provenance.outputDigest = heldoutDigest((({ provenance: _provenance, ...row }) => row)(forged.rows[0]));
    expect(() => validateHeldoutInputs(forged, { ...prepared.preregistration, corpusDigest: heldoutDigest(forged) }))
      .toThrow('generator-output');
    expect(() => generateHeldoutRow('d17-entailment/v1', 'private text:0:single')).toThrow();
    expect(() => generateHeldoutRow('d17-entailment/v1', 'offline-development-v1:1800:single')).toThrow();
  });
  it('produces an unapproved priced template and exactly 40 development, 40 blind and 8 delayed reviews', () => {
    const { approvalTemplate, reviewTemplate, corpus, preregistration, dryRun } = make();
    expect(approvalTemplate.approved).toBe(false);
    expect(approvalTemplate.priceBound).toMatchObject({ inputUsdPerMTok: 0.042, outputUsdPerMTok: 0, perRequestUsd: 0,
      approvalReference: null });
    expect(preregistration.providerOverheadTokens).toBe(512);
    expect(approvalTemplate.budget).toEqual({ calls: 18000, tokens: 72000000, usd: 8 });
    expect(approvalTemplate.priceBound.evidenceReferences).toHaveLength(3);
    expect(approvalTemplate.calibration).toEqual({ mode: 'uncalibrated-diagnostic' });
    expect(() => validateHeldoutBundle({ corpus, preregistration, approval: approvalTemplate } as any,
      heldoutDigest(approvalTemplate))).toThrow();
    expect(reviewTemplate.assessments).toHaveLength(88);
    for (const [stage, n] of [['development', 40], ['blind-test', 40], ['delayed-repeat', 8]]) {
      const assessments = reviewTemplate.assessments.filter(item => item.stage === stage);
      expect(assessments).toHaveLength(n as number);
      for (const slice of D17_SLICES) expect(assessments.filter(item => item.slice === slice)).toHaveLength((n as number) / 4);
    }
    expect(reviewTemplate.assessments.every(item => item.goldAuditLabel === null && item.blindedResultAudit === null)).toBe(true);
    expect(dryRun.expected).toMatchObject({ attempts: 7380, inputTokens: 27630720, usd: 2.7675 });
    expect(dryRun.worstCase).toMatchObject({ attempts: 14400, totalTokens: 57600000, reservedUsd: 5.4 });
    expect(dryRun.expected.inputTokens).toBe(dryRun.expected.attempts * (preregistration.perRequestTokenBound - preregistration.outputAndHiddenTokenAllowance));
    expect(dryRun.worstCase.reservedUsd).toBe(dryRun.worstCase.attempts
      * Math.ceil((preregistration.perRequestTokenBound - preregistration.outputAndHiddenTokenAllowance) * 0.1) / 1_000_000);
    expect(dryRun.worstCase.reservedUsd).toBeLessThan(dryRun.approvalCeilings.usd * dryRun.stopFraction);
  });
  it('runs source-only offline planning with zero provider calls and no build', () => {
    const dryRun = () => {
      const child = spawnSync(process.execPath, ['tools/decision/d17-study.mjs', '--dry-run', 'd17-2611-v1'],
        { cwd: process.cwd(), encoding: 'utf8', timeout: 60000, env: { ...process.env, AIWG_DECISION_HELDOUT_LIVE: '0' } });
      expect(child.status, child.stderr).toBe(0);
      return JSON.parse(child.stdout);
    };
    const report = dryRun();
    expect(report.providerCalls).toBe(0);
    expect(report.worstCase.attempts).toBe(14400);
    expect(report.maximumRequestEstimateTokens).toBeGreaterThan(0);
    expect(report.maximumRequestEstimateTokens).toBe(1179);
    // Data pins are fixed: corpus rows, frozen splits and gold do not depend on source bytes.
    // The corpus digest moves only through provenance.generatorDigest, which pins the D17
    // study's own generator bytes (ensemble-study/corpus.ts) independently of row bytes.
    expect(report.corpusDigest).toBe('sha256:e268bf40c8f03d3b2b30a9919520705535bce6104b9fd892412388d20d2216b7');
    expect(report.splitManifestDigest).toBe('sha256:09e2934e06781d8d64c65d104b8ee72ee87f3c48952eb2fe9333bb345862540f');
    expect(report.goldDigest).toBe('sha256:865f5f28321f93a10be477a2b9095cbb2fa97cb3f5ee33b8f0fcd66b089d68db');
    // Preregistration, approval template and analysis embed the digest of every source byte the
    // study runs, so they move with any shared decision-source change. They are pinned at approval
    // time against the exact source commit; here they must be well-formed and reproducible.
    const again = dryRun();
    for (const key of ['preregistrationDigest', 'approvalTemplateDigest', 'analysisDigest']) {
      expect(report[key]).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(again[key]).toBe(report[key]);
    }
  }, 125000);
});
