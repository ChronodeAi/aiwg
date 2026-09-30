// @ts-nocheck
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as openData from '../../../tools/experiments/conformal/open-data.mjs';
import * as collector from '../../../tools/experiments/conformal/collect-jev.v2.mjs';
import * as analysis from '../../../tools/experiments/conformal/run.v2.mjs';

const {
  digest,
  compatibilityForTask,
  experimentCodeVersion,
  fitConformalProfile,
  metrics,
  predictionSet,
  quantile,
  rowHash,
  syntheticChoiceDistribution,
  topIndex,
  verifyFrozenOpenData,
} = openData;
const { buildRuntimeArtifacts, collectLiveScores, estimateCollection, main: collectMain, scoreRowThroughRuntime } = collector;
const { runAnalysis } = analysis;

const preregistration = JSON.parse(readFileSync('tools/experiments/conformal/preregister.v2.json', 'utf8'));
const frozen = JSON.parse(readFileSync('tools/experiments/conformal/frozen.v2.json', 'utf8'));
const conformalRoot = new URL('../../../tools/experiments/conformal/', import.meta.url);
const CLINC = 'clinc150-intent-choice';
const BANKING = 'banking77-intent-choice';
const PIN = preregistration.pins.liveServedModel;
const REGION = 'fixture-region';

function ajv() {
  const validator = new Ajv2020({ strict: false });
  addFormats(validator);
  return validator;
}

/** Rows the live collector is allowed to score: the preregistered live subset (HEAD: all scored CLINC rows). */
function liveRows(): any[] {
  if (frozen.liveSubsets && typeof collector.liveSubsetRows === 'function') return collector.liveSubsetRows(frozen);
  return [...frozen.splits.calibration, ...frozen.splits.finalTest, ...frozen.splits.shift];
}

function splitIndex(rows: any[]) {
  const index = new Map<string, number>();
  for (const task of [CLINC, BANKING]) {
    for (const split of ['calibration', 'finalTest', 'shift']) {
      rows.filter(row => row.task === task && row.split === split).sort((a, b) => a.id.localeCompare(b.id)).forEach((row, i) => index.set(row.id, i));
    }
  }
  return index;
}

/**
 * A full native Choice distribution. Per task and split: 70% confident-correct rows (p=0.95), 20%
 * uncertain-correct rows (truth 0.62) and 10% confused rows (wrong 0.62, truth 0.36) sharing decile 6,
 * so the live decile baseline must review the whole decile while LAC accepts the uncertain rows.
 */
function fixtureDistribution(row: any, labels: string[], mode: string, position: number) {
  const truth = row.labelIndex;
  const wrong = (truth + 1) % labels.length;
  const values = Array.from({ length: labels.length }, () => 0);
  const miss = (mode === 'conditional' && row.split === 'shift') || (mode === 'no-go' && row.split === 'finalTest');
  if (miss) { values[wrong] = 0.95; values[truth] = 0.03; }
  else if (position % 5 === 0) { values[truth] = 0.62; values[wrong] = 0.33; }
  else if (position % 10 === 1) { values[wrong] = 0.62; values[truth] = 0.36; }
  else { values[truth] = 0.95; values[wrong] = 0.03; }
  const empty = values.map((value, index) => ({ value, index })).filter(item => item.value === 0);
  const remaining = 1 - values.reduce((sum, value) => sum + value, 0);
  for (const item of empty) values[item.index] = Number((remaining / empty.length).toFixed(12));
  return Object.fromEntries(labels.map((label, index) => [label, values[index]]));
}

const capabilities = async () => ({
  answerKinds: ['choice'],
  features: ['choice', 'probability-distribution', 'structured-entries'],
  maxOptions: 255,
  maxLevels: 10,
  confidenceProfiles: ['typesafe-distribution-v1'],
  executable: true,
  egress: { mode: 'none' },
});

/**
 * Fake Jev transport. `respond(row, call)` returns observation overrides or an Error to throw.
 * No network: the adapter never leaves the process.
 */
function fakeAdapter(rows: any[], respond: (row: any, call: number, request: any) => any = () => ({}), mode = 'go') {
  const byText = new Map(rows.map(row => [row.text, row]));
  const positions = splitIndex(rows);
  const state = { calls: 0 };
  const adapter = {
    id: 'jev',
    version: '1.0.0',
    capabilities,
    evaluate: async (request: any) => {
      state.calls += 1;
      const row = byText.get(request.input.text);
      const task = frozen.tasks[row.task];
      const distribution = fixtureDistribution(row, task.labels, mode, positions.get(row.id) ?? 1);
      const value = task.labels[topIndex(task.labels.map((label: string) => distribution[label]))];
      const override = respond(row, state.calls, request);
      if (override instanceof Error) throw override;
      return {
        status: 'success',
        reason: 'none',
        value,
        uncertainty: {
          source: 'provider',
          profile: 'typesafe-distribution-v1',
          calibration: 'vendor-claimed',
          confidence: null,
          distribution,
          calibrationRef: null,
        },
        actualModel: request.target.model,
        usage: { inputTokens: 1500, outputTokens: 8, costUsd: null },
        requestId: `fixture-${state.calls}`,
        ...override,
      };
    },
  };
  return { adapter, state };
}

function collectArgs(stateDir: string, rows: any[], adapter: any, overrides: Record<string, unknown> = {}) {
  return {
    preregistration,
    frozen,
    rows,
    model: PIN,
    region: REGION,
    credential: 'fixture',
    stateDir,
    output: join(stateDir, 'live-scores.v2.jsonl'),
    adapter,
    codeVersion: experimentCodeVersion(conformalRoot),
    ...overrides,
  };
}

async function readJsonl(path: string) {
  return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
}

/** Hand-written score records with no collector provenance (the HEAD-era fixture shape). */
async function writeHandWrittenScores(path: string, mutate: (record: any) => void = () => {}) {
  const rows = liveRows();
  const positions = splitIndex(rows);
  const codeVersion = experimentCodeVersion(conformalRoot);
  const lines = rows.map((row: any) => {
    const task = frozen.tasks[row.task];
    const compatibility = typeof openData.expectedLiveCompatibility === 'function'
      ? openData.expectedLiveCompatibility(frozen, preregistration, row.task)
      : compatibilityForTask(frozen, row.task, 1 - preregistration.coverageTarget, codeVersion, {
        servedModel: 'fixture-live-model',
        adapter: 'jev-decision-runtime/v2',
        calibrationSplit: rowHash(frozen.splits.calibration.filter((candidate: any) => candidate.task === row.task)),
      });
    const probabilities = fixtureDistribution(row, task.labels, 'go', positions.get(row.id));
    const record = {
      schemaVersion: 'conformal-live-score/v2',
      final: true,
      id: row.id,
      task: row.task,
      split: row.split,
      label: row.label,
      status: 'success',
      reason: 'none',
      value: task.labels[topIndex(task.labels.map((label: string) => probabilities[label]))],
      uncertainty: { source: 'provider', profile: 'typesafe-distribution-v1', calibration: 'vendor-claimed', confidence: null, distribution: probabilities },
      probabilities,
      actualModel: compatibility.servedModel,
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 },
      requestId: `fixture-${digest(row).slice(7, 15)}`,
      compatibility,
      attempts: [{ attempt: 1, status: 'success', chargeUsd: 0.001 }],
      budgetChargeUsd: 0.001,
      latencyMs: 1,
    };
    mutate(record);
    return JSON.stringify(record);
  });
  await writeFile(path, `${lines.join('\n')}\n`);
}

/** Recompute a ledger hash chain after edits, as a forger with file access could. */
function rechain(entries: any[]) {
  let prev = null;
  return entries.map((entry, seq) => {
    const { digest: _old, ...rest } = entry;
    const next: any = { ...rest, seq, prev };
    next.digest = digest(next);
    prev = next.digest;
    return next;
  });
}

function redigest(record: any) {
  const { recordDigest: _old, ...rest } = record;
  return { ...rest, recordDigest: digest(rest) };
}

async function writeJsonl(path: string, rows: any[]) {
  await writeFile(path, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
}

const temporaryRoots: string[] = [];
async function temporary(prefix: string) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(path);
  return path;
}

afterAll(async () => {
  await Promise.all(temporaryRoots.map(path => rm(path, { recursive: true, force: true })));
});

describe('conformal open-data v2 experiment (#2613)', () => {
  it('CONF2-01 validates closed schemas, source metadata and immutable split hashes', () => {
    const validator = ajv();
    for (const [schemaPath, artifact] of [
      ['schemas/decision/ConformalPreregistration.v2.schema.json', preregistration],
      ['schemas/decision/ConformalFrozenOpenData.v2.schema.json', frozen],
    ] as const) {
      const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
      expect(validator.validate(schema, artifact), JSON.stringify(validator.errors)).toBe(true);
      expect(validator.validate(schema, { ...artifact, unexpected: true })).toBe(false);
    }
    expect(() => verifyFrozenOpenData(frozen, preregistration)).not.toThrow();
    expect(frozen.license).toBe('mixed: CLINC150 CC-BY-3.0; Banking77 CC-BY-4.0');
    expect(frozen.sourceFiles.map((file: { license: string }) => file.license)).toEqual(['CC-BY-3.0', 'CC-BY-4.0', 'CC-BY-4.0']);
    expect(frozen.sourceFiles[0].licenseUrl).toBe('https://raw.githubusercontent.com/clinc/oos-eval/master/LICENSE');
    expect(frozen.sourceFiles[0].licenseSha256).toBe('e6bc9e9c474700b708f568bac9e5a8a9bcb2b1dad53442f5ba449fcb848b8e76');
    expect(frozen.sourceFiles.map((file: { retrievalDate: string }) => file.retrievalDate)).toEqual(['2026-09-29', '2026-09-29', '2026-09-29']);
    const changed = structuredClone(frozen);
    changed.splits.finalTest[0].text += ' changed';
    expect(() => verifyFrozenOpenData(changed, preregistration)).toThrow(/split hash mismatch/);
  });

  it('CONF2-02 keeps calibration/final/shift source rows disjoint and below the manifest ceiling', () => {
    const keys = new Set<string>();
    for (const rows of Object.values(frozen.splits) as Array<Array<{ task: string; sourceDataset: string; sourceId: string }>>) {
      for (const row of rows) {
        const key = `${row.task}/${row.sourceDataset}/${row.sourceId}`;
        expect(keys.has(key)).toBe(false);
        keys.add(key);
      }
    }
    expect(keys.size).toBeLessThanOrEqual(preregistration.resourceBudget.sampleMaxItems);
    expect(frozen.splits.finalTest.filter((row: { task: string }) => row.task === CLINC)).toHaveLength(450);
    expect(frozen.splits.finalTest.every((row: { task: string; canonicalSplit: string }) => row.task !== BANKING || row.canonicalSplit === 'train.csv')).toBe(true);
    expect(frozen.splits.shift.some((row: { task: string; canonicalSplit: string }) => row.task === BANKING && row.canonicalSplit === 'test.csv')).toBe(true);
    expect(frozen.splits.shift.some((row: { slice: string }) => row.slice === 'controlled-oos')).toBe(true);
  });

  it('CONF2-03 fits LAC profiles without mutating native labels or relabeling Choice probabilities', () => {
    const calibration = frozen.splits.calibration.filter((row: { task: string }) => row.task === CLINC);
    const before = structuredClone(calibration);
    const profile = fitConformalProfile(calibration, frozen, CLINC, 0.1, 'test-code');
    expect(calibration).toEqual(before);
    expect(profile.compatibility).toMatchObject({
      servedModel: 'synthetic-score-stand-in/v2',
      primitive: 'choice',
      method: 'lac-v1',
      calibrationSplit: rowHash(calibration),
    });
    const distribution = syntheticChoiceDistribution(calibration[0], frozen.tasks[CLINC]);
    expect(distribution).toHaveLength(frozen.tasks[CLINC].labels.length);
    expect(distribution.reduce((sum: number, value: number) => sum + value, 0)).toBeCloseTo(1, 8);
    expect(predictionSet(distribution, profile.q).length).toBeGreaterThan(0);
  });

  it('CONF2-03b handles quantile edges, ties, empty sets and full sets', () => {
    expect(quantile([0.1, 0.2, 0.2, 0.9], 0.25)).toBe(0.9);
    expect(quantile([0.1], 0.1)).toBe(Infinity);
    expect(() => quantile([], 0.1)).toThrow(/invalid calibration/);
    expect(predictionSet([0.75, 0.75, 0.1], 0.25)).toEqual([0, 1]);
    expect(predictionSet([0.2, 0.2], 0.1)).toEqual([]);
    expect(predictionSet([0.2, 0.2], Infinity)).toEqual([0, 1]);
    expect(topIndex([0.4, 0.4, 0.2])).toBe(0);
  });

  it('CONF2-04 reports correct metric denominators for review, selective risk and false-auto', () => {
    const result = metrics([
      { labelIndex: 0, set: [0] },
      { labelIndex: 1, set: [0] },
      { labelIndex: 1, set: [0, 1] },
      { labelIndex: 0, set: [] },
    ]);
    expect(result.coverage).toBe(0.5);
    expect(result.reviewRate).toBe(0.5);
    expect(result.selectiveRisk).toBe(0.5);
    expect(result.falseAutoRate).toBe(0.25);
  });

  it('CONF2-05 runs the synthetic analysis deterministically and validates the report schema', async () => {
    const root = await temporary('aiwg-conformal-v2-');
    for (const [name, args] of [['first', []], ['reverse', ['--reverse']]] as const) {
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'tools/experiments/conformal/run.v2.mjs', join(root, name), ...args], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH },
        timeout: 60_000,
      });
      expect(result.status, result.stderr).toBe(0);
    }
    const firstReport = await readFile(join(root, 'first/report.v2.json'), 'utf8');
    expect(firstReport).toBe(await readFile(join(root, 'reverse/report.v2.json'), 'utf8'));
    expect(await readFile(join(root, 'first/per-example.v2.jsonl'), 'utf8')).toBe(await readFile(join(root, 'reverse/per-example.v2.jsonl'), 'utf8'));
    const report = JSON.parse(firstReport);
    const schema = JSON.parse(readFileSync('schemas/decision/ConformalOpenDataReport.v2.schema.json', 'utf8'));
    const validator = ajv();
    expect(validator.validate(schema, report), JSON.stringify(validator.errors)).toBe(true);
    expect(report.outcome).toBe('INSUFFICIENT EVIDENCE');
    expect(report.scoreMode).toBe('synthetic');
    expect(report.actuals).toEqual({ providerCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
    expect(report.integrity.release_gate.decision).toBe('HOLD');
    expect(report.tasks[CLINC].splits.shift.gateDiagnostics.exchangeabilityApplicable).toBe(false);
  });

  it('CONF2-06 dry-run collection plans the live subset within the ceiling and refuses without the live gates', async () => {
    const reservation = collector.reservationMicros(preregistration);
    expect(estimateCollection(preregistration, 10)).toMatchObject({ providerCalls: 10, worstCaseUsd: 10 * reservation / 1e6, hardCeilingUsd: 8 });
    expect(() => estimateCollection(preregistration, preregistration.resourceBudget.liveMaxItems + 1)).toThrow(/exceeds/);
    expect(() => estimateCollection(preregistration, 10, 8_000_000 - 9 * reservation)).toThrow(/exceeds remaining/);
    const stateRoot = await temporary('aiwg-conformal-dry-');
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'tools/experiments/conformal/collect-jev.v2.mjs', '--limit', '5'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, XDG_STATE_HOME: stateRoot },
      timeout: 60_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'dry-run', rows: 5, noCallsMade: true, model: PIN });
    const env = { XDG_STATE_HOME: stateRoot };
    await expect(collectMain(env, ['--live', '--limit', '1'])).rejects.toThrow(/AIWG_DECISION_JEV_LIVE_SMOKE/);
    await expect(collectMain({ ...env, AIWG_DECISION_JEV_LIVE_SMOKE: '1' }, ['--live', '--limit', '1'])).rejects.toThrow(/AIWG_DECISION_JEV_API_KEY/);
    await expect(collectMain({ ...env, AIWG_DECISION_JEV_LIVE_SMOKE: '1', AIWG_DECISION_JEV_API_KEY: 'fixture' }, ['--live', '--limit', '1']))
      .rejects.toThrow(/AIWG_DECISION_JEV_REGION/);
    await expect(collectMain({ ...env, AIWG_DECISION_JEV_LIVE_SMOKE: '1', AIWG_DECISION_JEV_API_KEY: 'fixture', AIWG_DECISION_JEV_REGION: REGION }, ['--live', '--limit', '1']))
      .rejects.toThrow(/AIWG_DECISION_JEV_PRICE_CEILING_ATTESTED/);
  });

  it('CONF2-07 live scorer path uses normalized runtime artifacts and preserves native uncertainty', async () => {
    const row = liveRows()[0];
    const { adapter } = fakeAdapter([row]);
    const artifacts = buildRuntimeArtifacts({ row, task: frozen.tasks[row.task], model: PIN });
    expect(artifacts.binding.spec.evaluations.label.targets[0].adapter).toBe('jev');
    const scored = await scoreRowThroughRuntime({ row, task: frozen.tasks[row.task], model: PIN, region: REGION, adapter, credential: 'fixture' });
    expect(scored).toMatchObject({ id: row.id, status: 'success' });
    expect(scored.uncertainty.profile).toBe('typesafe-distribution-v1');
    expect(Object.keys(scored.uncertainty.distribution)).toHaveLength(frozen.tasks[row.task].labels.length);
  });

  describe('collector-generated live fixtures', () => {
    const outcomes: Record<string, { stateDir: string; summary: any; report: any }> = {};

    beforeAll(async () => {
      for (const mode of ['go', 'conditional', 'no-go', 'insufficient']) {
        const stateDir = await temporary(`aiwg-conformal-${mode}-`);
        const rows = liveRows();
        const failing = new Set(rows.filter(row => row.split === 'finalTest').sort((a, b) => a.id.localeCompare(b.id))
          .filter((_, index) => index % 10 === 0).map(row => row.id));
        const { adapter } = fakeAdapter(rows, row => (mode === 'insufficient' && failing.has(row.id) ? new Error('fixture transport failure') : {}), mode);
        await collectLiveScores(collectArgs(stateDir, rows, adapter));
        const summary = runAnalysis({ output: join(stateDir, 'report'), scoresPath: join(stateDir, 'live-scores.v2.jsonl') });
        const report = JSON.parse(await readFile(join(stateDir, 'report/report.v2.json'), 'utf8'));
        outcomes[mode] = { stateDir, summary, report };
      }
    }, 240_000);

    it('CONF2-09 computes preregistered outcomes only from collector-provenanced live records', () => {
      expect(outcomes.go.report.provenance.representative).toBe(true);
      expect(outcomes.go.summary.outcome).toBe('GO');
      expect(outcomes.go.report.outcomeCaps).toEqual([]);
      expect(outcomes.conditional.summary.outcome).toBe('CONDITIONAL');
      expect(outcomes['no-go'].summary.outcome).toBe('NO-GO');
      expect(outcomes.insufficient.summary.outcome).toBe('INSUFFICIENT EVIDENCE');
      const schema = JSON.parse(readFileSync('schemas/decision/ConformalOpenDataReport.v2.schema.json', 'utf8'));
      const validator = ajv();
      for (const { report } of Object.values(outcomes)) {
        expect(report.scoreMode).toBe('live');
        expect(validator.validate(schema, report), JSON.stringify(validator.errors)).toBe(true);
        expect(report.integrity.release_gate.decision).not.toBe('PROMOTE');
      }
      expect(outcomes.go.report.actuals.providerCalls).toBe(liveRows().length);
    });

    it('CONF2-09b decideOutcome reaches GO only when every preregistered task has passing live evidence', () => {
      const pass = { enoughRows: true, coverage: true, usefulSize: true, review: true, selectiveRisk: true, baselineImprovement: true, representativeLiveScores: true };
      const task = (shiftPass: boolean) => ({ live: true, splits: { finalTest: { gateDiagnostics: pass }, shift: { gateDiagnostics: { ...pass, coverage: shiftPass } } } });
      const report = (tasks: any) => ({ scoreMode: 'live', provenance: { representative: true }, tasks });
      expect(analysis.decideOutcome(report({ a: task(true), b: task(true) })).outcome).toBe('GO');
      expect(analysis.decideOutcome(report({ a: task(true), b: { live: false, splits: {} } })).outcome).toBe('CONDITIONAL');
      expect(analysis.decideOutcome(report({ a: task(false), b: task(true) })).outcome).toBe('CONDITIONAL');
      expect(analysis.decideOutcome({ ...report({ a: task(true), b: task(true) }), provenance: { representative: false } }).outcome).toBe('INSUFFICIENT EVIDENCE');
    });

    it('CONF2-R2-07 fits the calibrated-risk baseline on the live calibration subset, not synthetic scores', () => {
      const { report } = outcomes.go;
      const baseline = report.tasks[CLINC].calibratedBaseline;
      const binned = Object.values(baseline.bins).reduce((sum: number, bin: any) => sum + bin.n, 0);
      expect(binned).toBe(liveRows().filter(row => row.task === CLINC && row.split === 'calibration').length);
      expect(baseline.source).toMatch(/live calibration/);
      // A regressed calibrated baseline (bins fitted on live data with an uncertain decile) reviews rows LAC accepts.
      const final = report.tasks[CLINC].splits.finalTest;
      expect(final.calibrated.overall.reviewRate).toBeGreaterThan(final.lac.overall.reviewRate);
      expect(final.gateDiagnostics.baselineImprovement).toBe(true);
      // The NO-GO fixture's regressed final-test scores fail the improvement gate against the same live baseline.
      expect(outcomes['no-go'].report.tasks[CLINC].splits.finalTest.gateDiagnostics.coverage).toBe(false);
    });

    it('CONF2-R2-10 treats records as representative only with a verified collector ledger chain', async () => {
      const { stateDir } = outcomes.go;
      const copy = await temporary('aiwg-conformal-tamper-');
      await cp(stateDir, copy, { recursive: true });
      const scoresPath = join(copy, 'live-scores.v2.jsonl');
      const records = await readJsonl(scoresPath);
      records[0].probabilities = records[1].probabilities;
      await writeFile(scoresPath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
      const tampered = runAnalysis({ output: join(copy, 'report'), scoresPath });
      expect(tampered.outcome).toBe('INSUFFICIENT EVIDENCE');
      const report = JSON.parse(await readFile(join(copy, 'report/report.v2.json'), 'utf8'));
      expect(report.provenance.representative).toBe(false);
      expect(report.provenance.reasons.join(' ')).toMatch(/digest/);
    });

    it('CONF2-R2-10c rejects forged ledgers: attempts must match reserve/settle entries and request IDs must be unique', async () => {
      const { stateDir } = outcomes.go;
      const scoresName = 'live-scores.v2.jsonl';
      const ledgerName = 'spend-ledger.v2.jsonl';
      const genuine = await readJsonl(join(stateDir, scoresName));
      const ledger = await readJsonl(join(stateDir, ledgerName));

      // Forgery 1: hand-written records chained into a ledger holding only record entries.
      const forged = await temporary('aiwg-conformal-forged-');
      await writeJsonl(join(forged, scoresName), genuine);
      await writeJsonl(join(forged, ledgerName), rechain(ledger.filter(entry => entry.type === 'record')));
      runAnalysis({ output: join(forged, 'report'), scoresPath: join(forged, scoresName) });
      const forgedReport = JSON.parse(await readFile(join(forged, 'report/report.v2.json'), 'utf8'));
      expect(forgedReport.provenance.representative).toBe(false);
      expect(forgedReport.provenance.reasons.join(' ')).toMatch(/reservation/);

      // Forgery 2: duplicated request IDs with every digest recomputed.
      const duplicated = await temporary('aiwg-conformal-dupid-');
      const sameId = genuine.map(record => redigest({ ...record, requestId: 'fixture-1' }));
      const digests = new Map(sameId.map(record => [record.id, record.recordDigest]));
      await writeJsonl(join(duplicated, scoresName), sameId);
      await writeJsonl(join(duplicated, ledgerName), rechain(ledger.map(entry => (entry.type === 'record' ? { ...entry, recordDigest: digests.get(entry.itemId) } : entry))));
      runAnalysis({ output: join(duplicated, 'report'), scoresPath: join(duplicated, scoresName) });
      const duplicateReport = JSON.parse(await readFile(join(duplicated, 'report/report.v2.json'), 'utf8'));
      expect(duplicateReport.provenance.representative).toBe(false);
      expect(duplicateReport.provenance.reasons.join(' ')).toMatch(/request ID/);

      // Forgery 3: a ledger written under a different preregistration.
      const otherPrereg = await temporary('aiwg-conformal-prereg-');
      await writeJsonl(join(otherPrereg, scoresName), genuine);
      await writeJsonl(join(otherPrereg, ledgerName), rechain(ledger.map(entry => ({ ...entry, preregistrationHash: digest('another preregistration') }))));
      runAnalysis({ output: join(otherPrereg, 'report'), scoresPath: join(otherPrereg, scoresName) });
      const preregReport = JSON.parse(await readFile(join(otherPrereg, 'report/report.v2.json'), 'utf8'));
      expect(preregReport.provenance.representative).toBe(false);
      expect(preregReport.provenance.reasons.join(' ')).toMatch(/preregistration/);
    });
  });

  it('CONF2-R2-10b cannot reach GO from a hand-written JSONL without collector provenance', async () => {
    const root = await temporary('aiwg-conformal-handwritten-');
    await writeHandWrittenScores(join(root, 'scores.jsonl'));
    const summary = runAnalysis({ output: join(root, 'report'), scoresPath: join(root, 'scores.jsonl') });
    expect(summary.outcome).not.toBe('GO');
    const report = JSON.parse(await readFile(join(root, 'report/report.v2.json'), 'utf8'));
    expect(report.provenance?.representative).toBe(false);
  });

  it('CONF2-R2-07b fits live-mode calibrated-risk bins from the supplied calibration scores only', async () => {
    const root = await temporary('aiwg-conformal-baseline-');
    await writeHandWrittenScores(join(root, 'scores.jsonl'));
    runAnalysis({ output: join(root, 'report'), scoresPath: join(root, 'scores.jsonl') });
    const report = JSON.parse(await readFile(join(root, 'report/report.v2.json'), 'utf8'));
    const calibrationRows = liveRows().filter(row => row.split === 'calibration' && row.task === CLINC).length;
    const bins = report.tasks[CLINC].calibratedBaseline.bins;
    expect(Object.values(bins).reduce((sum: number, bin: any) => sum + bin.n, 0)).toBe(calibrationRows);
    // Every hand-written calibration row sits in decile 9 (p=0.95) or decile 6 (p=0.62); synthetic scores would not.
    expect(Object.keys(bins).sort()).toEqual(['6', '9']);
  });

  it('CONF2-R2-15 resumes after partial spend by planning and limiting over pending rows only', async () => {
    const root = await temporary('aiwg-conformal-partial-');
    const stateDir = join(root, 'aiwg/conformal-2613');
    await rm(stateDir, { recursive: true, force: true });
    const rows = liveRows();
    // Earlier spend of USD 2.25 recorded in another score file, then 80 rows collected.
    await (await import('node:fs/promises')).mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'earlier.jsonl'), `${JSON.stringify({ schemaVersion: 'conformal-live-score/v2', final: true, id: 'earlier', budgetChargeMicros: 2_250_000 })}\n`);
    await collectLiveScores(collectArgs(stateDir, rows.slice(0, 80), fakeAdapter(rows).adapter));
    // Three consecutive errors stop a run; those rows stay pending.
    const failing = fakeAdapter(rows, () => new Error('fixture transport failure'));
    const stopped = await collectLiveScores(collectArgs(stateDir, rows.slice(80, 90), failing.adapter));
    expect(stopped.stoppedReason).toBe('consecutive-errors');

    const plan = await collectMain({ XDG_STATE_HOME: root, PATH: process.env.PATH }, []);
    expect(plan.rows).toBe(rows.length - 80);
    const limited = await collectMain({ XDG_STATE_HOME: root }, ['--limit', '5']);
    expect(limited.rows).toBe(5);
    expect(limited.rowIds).toEqual(rows.slice(80, 85).map(row => row.id));

    const pending = collector.pendingLiveRows({ preregistration, frozen, stateDir });
    expect(pending.map(row => row.id)).toEqual(rows.slice(80).map(row => row.id));
    const resumed = await collectLiveScores(collectArgs(stateDir, pending, fakeAdapter(rows).adapter));
    expect(resumed.stoppedReason).toBeNull();
    expect(resumed.endingSpentMicros).toBeLessThanOrEqual(8_000_000);
    const latest = new Map((await readJsonl(join(stateDir, 'live-scores.v2.jsonl'))).map(record => [record.id, record.status]));
    expect(rows.every(row => latest.get(row.id) === 'success')).toBe(true);
    expect(collector.pendingLiveRows({ preregistration, frozen, stateDir })).toEqual([]);
  }, 120_000);

  it('CONF2-R2-16 refuses relative, unset and volatile live state directories', async () => {
    const home = await temporary('aiwg-conformal-home-');
    const emptyXdg = await collectMain({ XDG_STATE_HOME: '', HOME: home }, ['--limit', '1']);
    expect(emptyXdg.stateDir).toBe(join(home, '.local/state/aiwg/conformal-2613'));
    await expect(collectMain({ XDG_STATE_HOME: '' }, ['--limit', '1'])).rejects.toThrow(/state directory/);
    await expect(collectMain({ XDG_STATE_HOME: 'relative/state' }, ['--limit', '1'])).rejects.toThrow(/absolute/);
    await expect(collectMain({ HOME: home }, ['--limit', '1', '--state-dir', 'relative/dir'])).rejects.toThrow(/absolute/);
    const volatileRoot = await temporary('aiwg-conformal-volatile-');
    const rows = liveRows();
    const { adapter, state } = fakeAdapter(rows);
    const liveEnv = {
      XDG_STATE_HOME: volatileRoot,
      AIWG_DECISION_JEV_LIVE_SMOKE: '1',
      AIWG_DECISION_JEV_API_KEY: 'fixture',
      AIWG_DECISION_JEV_REGION: REGION,
      AIWG_DECISION_JEV_PRICE_CEILING_ATTESTED: collector.priceCeilingAttestation(preregistration),
    };
    await expect(collectMain(liveEnv, ['--live', '--limit', '1'], { adapter })).rejects.toThrow(/volatile/);
    await expect(collectMain({ ...liveEnv, XDG_STATE_HOME: '' , HOME: '/tmp' }, ['--live', '--limit', '1'], { adapter })).rejects.toThrow(/volatile/);
    expect(state.calls).toBe(0);
  });

  it('CONF2-R2-01 stops at once when a reported provider cost exceeds the per-call worst-case reservation', async () => {
    const stateDir = await temporary('aiwg-conformal-overrun-');
    const rows = liveRows().slice(0, 3);
    const { adapter, state } = fakeAdapter(rows, () => ({ usage: { inputTokens: 100, outputTokens: 5, costUsd: 5 } }));
    const result = await collectLiveScores(collectArgs(stateDir, rows, adapter));
    expect(state.calls).toBe(1);
    expect(result.stoppedReason).toBe('reservation-overrun');
    const again = await collectLiveScores(collectArgs(stateDir, rows, adapter));
    expect(state.calls).toBe(1);
    expect(again.stoppedReason).toBe('ledger-halted');
    // With spend already at ceiling minus one reservation plus one micro-dollar, no call may be dispatched.
    const nearCeiling = await temporary('aiwg-conformal-ceiling-');
    const reservation = collector.reservationMicros(preregistration);
    await writeFile(join(nearCeiling, 'earlier.jsonl'), `${JSON.stringify({ schemaVersion: 'conformal-live-score/v2', final: true, id: 'earlier', budgetChargeMicros: 8_000_000 - reservation + 1, budgetChargeUsd: (8_000_000 - reservation + 1) / 1e6 })}\n`);
    const blocked = fakeAdapter(rows);
    const refused = await collectLiveScores(collectArgs(nearCeiling, rows, blocked.adapter));
    expect(blocked.state.calls).toBe(0);
    expect(refused.stoppedReason).toBe('budget-ceiling');
  });

  it('CONF2-R2-02 enforces one global USD ceiling across resumes, split outputs and a durable ledger', async () => {
    // Probe: two runs on the same output at $3.90 per call must not spend more than the ceiling.
    const repeated = await temporary('aiwg-conformal-resume-');
    const rows = liveRows().slice(0, 4);
    const expensive = fakeAdapter(rows, () => ({ usage: { inputTokens: 1, outputTokens: 1, costUsd: 3.9 } }));
    await collectLiveScores(collectArgs(repeated, rows, expensive.adapter));
    await collectLiveScores(collectArgs(repeated, rows, expensive.adapter));
    expect(expensive.state.calls * 3.9).toBeLessThanOrEqual(8);

    // Probe: a per-split output in the same experiment state directory does not get a fresh budget.
    const split = await temporary('aiwg-conformal-split-');
    await writeFile(join(split, 'calibration-run.jsonl'), `${JSON.stringify({ schemaVersion: 'conformal-live-score/v2', final: true, id: 'prior', budgetChargeMicros: 8_000_000 - collector.reservationMicros(preregistration) + 1 })}\n`);
    const fresh = fakeAdapter(rows);
    const result = await collectLiveScores(collectArgs(split, rows, fresh.adapter, { output: join(split, 'final-run.jsonl') }));
    expect(fresh.state.calls).toBe(0);
    expect(result.stoppedReason).toBe('budget-ceiling');

    // The ledger survives deletion of every score file.
    const durable = await temporary('aiwg-conformal-ledger-');
    const first = fakeAdapter(rows);
    const initial = await collectLiveScores(collectArgs(durable, rows.slice(0, 2), first.adapter));
    await rm(join(durable, 'live-scores.v2.jsonl'));
    const second = await collectLiveScores(collectArgs(durable, rows.slice(0, 2), fakeAdapter(rows).adapter));
    expect(second.startingSpentMicros).toBe(initial.endingSpentMicros);
    expect(second.endingSpentMicros).toBeGreaterThan(initial.endingSpentMicros);

    // A crash between reserve and settle leaves the reservation counted as spent, and the retry of that
    // item must not reuse (and so overwrite) the orphaned reservation.
    const crashed = await temporary('aiwg-conformal-crash-');
    await collectLiveScores(collectArgs(crashed, rows.slice(0, 1), fakeAdapter(rows).adapter));
    const ledgerPath = join(crashed, 'spend-ledger.v2.jsonl');
    const entries = await readJsonl(ledgerPath);
    const last = entries.at(-1);
    const orphan: any = { schemaVersion: last.schemaVersion, seq: entries.length, prev: last.digest, preregistrationHash: last.preregistrationHash,
      type: 'reserve', reservationId: `${rows[1].id}#1`, itemId: rows[1].id, reservedMicros: collector.reservationMicros(preregistration) };
    orphan.digest = digest(orphan);
    await appendFile(ledgerPath, `${JSON.stringify(orphan)}\n`);
    const before = collector.readSpendLedger(ledgerPath).spentMicros;
    const retried = await collectLiveScores(collectArgs(crashed, rows.slice(0, 2), fakeAdapter(rows).adapter));
    expect(retried.startingSpentMicros).toBe(before);
    const after = collector.readSpendLedger(ledgerPath);
    expect(after.spentMicros).toBe(retried.endingSpentMicros);
    expect(after.spentMicros - before).toBe(retried.endingSpentMicros - retried.startingSpentMicros);
    expect(after.spentMicros).toBeGreaterThan(before);
    expect(after.reservationsByItem.get(rows[1].id)).toBe(2);
  });

  it('CONF2-R2-03 charges reported tokens at the pinned price ceiling and a full reservation when usage is unknown', async () => {
    const budget = preregistration.resourceBudget;
    const stateDir = await temporary('aiwg-conformal-tokens-');
    const rows = liveRows().slice(0, 2);
    const { adapter } = fakeAdapter(rows, (_row, call) => ({
      usage: call === 1 ? { inputTokens: 5000, outputTokens: 100, costUsd: null } : { inputTokens: null, outputTokens: null, costUsd: null },
    }));
    await collectLiveScores(collectArgs(stateDir, rows, adapter));
    const records = await readJsonl(join(stateDir, 'live-scores.v2.jsonl'));
    const expectedTokenCharge = Math.ceil(5000 * budget.inputUsdPerMillionTokensCeiling + 100 * budget.outputUsdPerMillionTokensCeiling);
    expect(records[0].budgetChargeMicros).toBe(expectedTokenCharge);
    expect(records[1].budgetChargeMicros).toBe(collector.reservationMicros(preregistration));
    // The preregistered per-call input bound covers the measured 151-option CLINC request body.
    const measured = Math.max(...await Promise.all(liveRows().map(row => collector.measureRequestBytes({ row, task: frozen.tasks[row.task], model: PIN, region: REGION }))));
    expect(measured).toBe(budget.measuredMaxRequestBodyBytes);
    expect(measured + budget.serverOverheadTokensAllowance).toBeLessThanOrEqual(budget.maxInputTokensPerCall);
  }, 60_000);

  it('CONF2-R2-04 preregisters the full two-task live design whose worst-case cost fits the USD 8 and item caps', async () => {
    const budget = preregistration.resourceBudget;
    const live = frozen.liveSubsets;
    expect(live.policy.tasks).toEqual([CLINC, BANKING]);
    const rows = liveRows();
    expect(rows).toHaveLength(1816);
    expect(rows).toHaveLength(budget.liveSubsetItems);
    expect(rows.length).toBeLessThanOrEqual(budget.liveMaxItems);
    expect(budget.liveMaxItems).toBe(2000);
    expect(collector.reservationMicros(preregistration)).toBe(566);
    expect(rows.length * collector.reservationMicros(preregistration)).toBe(1_027_856);
    expect(collector.priceCeilingAttestation(preregistration)).toBe('0.10/0.10');
    for (const split of ['calibration', 'finalTest', 'shift']) {
      const members = rows.filter(row => row.split === split);
      expect(rowHash(members)).toBe(rowHash(frozen.splits[split]));
      expect(rowHash(members)).toBe(live.hashes[split]);
    }
    expect(rows.filter(row => row.split === 'shift' && row.task === BANKING).every(row => row.slice === 'nominal-heldout')).toBe(true);
    // Probe: the analysis reads exactly the preregistered live subset and rejects rows outside it.
    const root = await temporary('aiwg-conformal-subset-');
    await writeHandWrittenScores(join(root, 'scores.jsonl'));
    expect(() => runAnalysis({ output: join(root, 'report'), scoresPath: join(root, 'scores.jsonl') })).not.toThrow();
    const outside = frozen.splits.train.find((row: any) => row.task === CLINC);
    const extra = JSON.parse((await readFile(join(root, 'scores.jsonl'), 'utf8')).split('\n')[0]);
    await appendFile(join(root, 'scores.jsonl'), `${JSON.stringify({ ...extra, id: outside.id, label: outside.label, split: 'train' })}\n`);
    expect(() => runAnalysis({ output: join(root, 'report-outside'), scoresPath: join(root, 'scores.jsonl') })).toThrow(/live subset/);
  });

  it('CONF2-R2-05 rejects served-model, adapter, alpha and code-version drift against the preregistered pins', async () => {
    const root = await temporary('aiwg-conformal-compat-');
    for (const [field, value, pattern] of [
      ['servedModel', 'fixture-live-model', /servedModel/],
      ['adapter', 'other-adapter/v9', /adapter/],
      ['alpha', 0.2, /alpha/],
      ['codeVersion', 'sha256:0000000000000000000000000000000000000000000000000000000000000000', /codeVersion/],
    ] as const) {
      const path = join(root, `${field}.jsonl`);
      await writeHandWrittenScores(path, record => { record.compatibility = { ...record.compatibility, [field]: value }; if (field === 'servedModel') record.actualModel = value; });
      expect(() => runAnalysis({ output: join(root, field), scoresPath: path })).toThrow(pattern);
    }
    const rows = liveRows().slice(0, 1);
    const unpinned = fakeAdapter(rows);
    await expect(collectLiveScores(collectArgs(root, rows, unpinned.adapter, { model: 'jev-other-model' }))).rejects.toThrow(/pinned/);
    expect(unpinned.state.calls).toBe(0);
    const resumeDir = await temporary('aiwg-conformal-compat-resume-');
    await writeHandWrittenScores(join(resumeDir, 'live-scores.v2.jsonl'), record => { record.compatibility = { ...record.compatibility, servedModel: 'jev-other-model' }; });
    const resume = fakeAdapter(rows);
    await expect(collectLiveScores(collectArgs(resumeDir, rows, resume.adapter))).rejects.toThrow(/incompatible/);
    expect(resume.state.calls).toBe(0);
  });

  it('CONF2-R2-06 records a success without a native distribution as missing-distribution, never one-hot probabilities', async () => {
    const stateDir = await temporary('aiwg-conformal-missing-');
    const rows = liveRows().slice(0, 1);
    const { adapter } = fakeAdapter(rows, () => ({ uncertainty: null }));
    await collectLiveScores(collectArgs(stateDir, rows, adapter));
    const [record] = await readJsonl(join(stateDir, 'live-scores.v2.jsonl'));
    expect(record.status).toBe('missing-distribution');
    expect(record.probabilities).toBeUndefined();
  });

  it('CONF2-R2-08 binds the exact live prompt template and collector code into the preregistered compatibility key', async () => {
    const collectorSource = readFileSync('tools/experiments/conformal/collect-jev.v2.mjs', 'utf8');
    expect(preregistration.pins.collectorCodeDigest).toBe(digest(collectorSource));
    expect(preregistration.pins.livePromptDigest).toBe(collector.livePromptDigest(frozen, PIN));
    const root = await temporary('aiwg-conformal-prompt-');
    await writeHandWrittenScores(join(root, 'scores.jsonl'), record => { record.compatibility = { ...record.compatibility, prompt: digest('different question text') }; });
    expect(() => runAnalysis({ output: join(root, 'report'), scoresPath: join(root, 'scores.jsonl') })).toThrow(/prompt/);
    const changed = structuredClone(preregistration);
    changed.pins.livePromptDigest = digest('different question text');
    const rows = liveRows().slice(0, 1);
    const { adapter, state } = fakeAdapter(rows);
    await expect(collectLiveScores(collectArgs(root, rows, adapter, { preregistration: changed }))).rejects.toThrow(/prompt/);
    expect(state.calls).toBe(0);
  });

  it('CONF2-R2-09 retries error records on resume and counts terminal errors instead of throwing', async () => {
    const stateDir = await temporary('aiwg-conformal-errors-');
    const rows = liveRows().slice(0, 2);
    const failing = fakeAdapter(rows, () => new Error('fixture transport failure'));
    await collectLiveScores(collectArgs(stateDir, rows, failing.adapter));
    expect((await readJsonl(join(stateDir, 'live-scores.v2.jsonl'))).every(record => record.status === 'error')).toBe(true);
    const healthy = fakeAdapter(rows);
    await collectLiveScores(collectArgs(stateDir, rows, healthy.adapter));
    expect(healthy.state.calls).toBe(2);
    const latest = new Map((await readJsonl(join(stateDir, 'live-scores.v2.jsonl'))).map(record => [record.id, record]));
    expect([...latest.values()].every(record => record.status === 'success')).toBe(true);

    const root = await temporary('aiwg-conformal-error-analysis-');
    const errorIds = new Set(liveRows().filter(row => row.split === 'finalTest' && row.task === CLINC).slice(0, 30).map(row => row.id));
    await writeHandWrittenScores(join(root, 'scores.jsonl'), record => {
      if (!errorIds.has(record.id)) return;
      Object.assign(record, { status: 'error', value: null, uncertainty: null });
      delete record.probabilities;
    });
    const summary = runAnalysis({ output: join(root, 'report'), scoresPath: join(root, 'scores.jsonl') });
    expect(summary.outcome).toBe('INSUFFICIENT EVIDENCE');
    const report = JSON.parse(await readFile(join(root, 'report/report.v2.json'), 'utf8'));
    expect(report.tasks[CLINC].splits.finalTest.failures).toMatchObject({ error: 30, missingDistribution: 0, notCollected: 0 });
    expect(report.tasks[CLINC].splits.finalTest.gateDiagnostics.failureTolerance).toBe(false);
  });

  it('CONF2-R2-11 quarantines one truncated trailing line and resumes', async () => {
    const stateDir = await temporary('aiwg-conformal-truncated-');
    const rows = liveRows().slice(0, 2);
    await collectLiveScores(collectArgs(stateDir, rows.slice(0, 1), fakeAdapter(rows).adapter));
    const output = join(stateDir, 'live-scores.v2.jsonl');
    await appendFile(output, '{"schemaVersion":"conformal-live-sc');
    const resumed = fakeAdapter(rows);
    await collectLiveScores(collectArgs(stateDir, rows, resumed.adapter));
    expect(resumed.state.calls).toBe(1);
    expect((await readJsonl(output)).map(record => record.id)).toEqual(rows.map(row => row.id));
    expect(await readFile(`${output}.quarantine`, 'utf8')).toContain('"schemaVersion":"conformal-live-sc');
  });

  it('CONF2-R2-12 labels the Banking77 test.csv slice as nominal held-out, not a shift', () => {
    const banking = frozen.splits.shift.filter((row: any) => row.task === BANKING);
    expect(banking.length).toBeGreaterThan(0);
    expect(banking.every((row: any) => row.slice === 'nominal-heldout')).toBe(true);
    const clinc = frozen.splits.shift.filter((row: any) => row.task === CLINC);
    expect(clinc.every((row: any) => row.slice === 'controlled-oos')).toBe(true);
  });

  it('CONF2-R2-13 closes the report integrity extension schema', () => {
    const schema = JSON.parse(readFileSync('schemas/decision/ConformalOpenDataReport.v2.schema.json', 'utf8'));
    const integrity = schema.properties.integrity;
    expect(integrity.additionalProperties).toBe(false);
    expect(integrity.properties.release_gate.additionalProperties).toBe(false);
    expect(integrity.properties.conformal.additionalProperties).toBe(false);
  });

  it('CONF2-R2-14 records the Banking77 licence file SHA-256', () => {
    for (const file of frozen.sourceFiles.filter((entry: any) => entry.dataset === 'Banking77')) {
      expect(file.licenseUrl).toBe('https://raw.githubusercontent.com/PolyAI-LDN/task-specific-datasets/master/LICENSE');
      expect(file.licenseSha256).toBe('7e7170e3cebf88a9f60c7b8421418323c09304da1af4d5e90f4da1dc1c8a2661');
    }
    const schema = JSON.parse(readFileSync('schemas/decision/ConformalFrozenOpenData.v2.schema.json', 'utf8'));
    const withoutLicenseHash = structuredClone(frozen);
    delete withoutLicenseHash.sourceFiles[1].licenseSha256;
    expect(ajv().validate(schema, withoutLicenseHash)).toBe(false);
    expect(existsSync('tools/experiments/conformal/frozen.v2.json')).toBe(true);
  });
});
