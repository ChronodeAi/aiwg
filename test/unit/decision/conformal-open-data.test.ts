// @ts-nocheck
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
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
} from '../../../tools/experiments/conformal/open-data.mjs';
import {
  buildRuntimeArtifacts,
  collectLiveScores,
  conservativeUsdPerCall,
  estimateCollection,
  main as collectMain,
  scoreRowThroughRuntime,
} from '../../../tools/experiments/conformal/collect-jev.v2.mjs';
import { runAnalysis } from '../../../tools/experiments/conformal/run.v2.mjs';

const preregistration = JSON.parse(readFileSync('tools/experiments/conformal/preregister.v2.json', 'utf8'));
const frozen = JSON.parse(readFileSync('tools/experiments/conformal/frozen.v2.json', 'utf8'));
const conformalRoot = new URL('../../../tools/experiments/conformal/', import.meta.url);

function ajv() {
  const validator = new Ajv2020({ strict: false });
  addFormats(validator);
  return validator;
}

function fixtureProbabilities(row: any, labels: string[], mode: string) {
  const truth = row.labelIndex;
  const wrong = (truth + 1) % labels.length;
  const values = Array.from({ length: labels.length }, () => 0);
  const shouldMiss = (mode === 'conditional' && row.split === 'shift') || (mode === 'no-go' && row.split === 'finalTest');
  if (shouldMiss) {
    values[wrong] = 0.95;
    values[truth] = 0.03;
  } else {
    values[truth] = 0.95;
    values[wrong] = 0.03;
  }
  const empty = values.map((value, index) => ({ value, index })).filter(item => item.value === 0);
  for (const item of empty) values[item.index] = 0.02 / empty.length;
  return Object.fromEntries(labels.map((label, index) => [label, Number(values[index].toFixed(10))]));
}

async function writeLiveScoreFixture(path: string, mode: 'go' | 'conditional' | 'no-go' | 'insufficient') {
  const codeVersion = experimentCodeVersion(conformalRoot);
  const rows = [...frozen.splits.calibration, ...frozen.splits.finalTest, ...frozen.splits.shift];
  const lines = rows.map((row: any) => {
    const task = frozen.tasks[row.task];
    const compatibility = compatibilityForTask(frozen, row.task, 1 - preregistration.coverageTarget, codeVersion, {
      servedModel: 'fixture-live-model',
      adapter: 'jev-decision-runtime/v2',
      calibrationSplit: rowHash(frozen.splits.calibration.filter((candidate: any) => candidate.task === row.task)),
    });
    const probabilities = fixtureProbabilities(row, task.labels, mode);
    return JSON.stringify({
      schemaVersion: 'conformal-live-score/v2',
      final: true,
      representative: mode !== 'insufficient',
      id: row.id,
      task: row.task,
      split: row.split,
      label: row.label,
      status: 'success',
      reason: 'none',
      value: task.labels[topIndex(task.labels.map((label: string) => probabilities[label]))],
      uncertainty: {
        source: 'provider',
        profile: 'typesafe-distribution-v1',
        calibration: 'vendor-claimed',
        confidence: null,
        distribution: probabilities,
      },
      probabilities,
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 },
      requestId: `fixture-${digest(row).slice(7, 15)}`,
      compatibility,
      attempts: [{ attempt: 1, status: 'success', chargeUsd: 0.001 }],
      budgetChargeUsd: 0.001,
      latencyMs: 1,
    });
  });
  await writeFile(path, `${lines.join('\n')}\n`);
}

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
    expect(frozen.splits.finalTest.filter((row: { task: string }) => row.task === 'clinc150-intent-choice')).toHaveLength(450);
    expect(frozen.splits.finalTest.every((row: { task: string; canonicalSplit: string }) => row.task !== 'banking77-intent-choice' || row.canonicalSplit === 'train.csv')).toBe(true);
    expect(frozen.splits.shift.some((row: { task: string; canonicalSplit: string }) => row.task === 'banking77-intent-choice' && row.canonicalSplit === 'test.csv')).toBe(true);
    expect(frozen.splits.shift.some((row: { slice: string }) => row.slice === 'controlled-oos')).toBe(true);
    expect(frozen.splits.shift.some((row: { slice: string }) => row.slice === 'source-separated')).toBe(true);
  });

  it('CONF2-03 fits LAC profiles without mutating native labels or relabeling Choice probabilities', () => {
    const taskId = 'clinc150-intent-choice';
    const calibration = frozen.splits.calibration.filter((row: { task: string }) => row.task === taskId);
    const before = structuredClone(calibration);
    const profile = fitConformalProfile(calibration, frozen, taskId, 0.1, 'test-code');
    expect(calibration).toEqual(before);
    expect(profile.compatibility).toMatchObject({
      servedModel: 'synthetic-score-stand-in/v2',
      primitive: 'choice',
      method: 'lac-v1',
      calibrationSplit: rowHash(calibration),
    });
    const row = calibration[0];
    const distribution = syntheticChoiceDistribution(row, frozen.tasks[taskId]);
    expect(distribution).toHaveLength(frozen.tasks[taskId].labels.length);
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
    const temporary = await mkdtemp(join(tmpdir(), 'aiwg-conformal-v2-'));
    try {
      for (const [name, args] of [['first', []], ['reverse', ['--reverse']]] as const) {
        const result = spawnSync(process.execPath, ['--import', 'tsx', 'tools/experiments/conformal/run.v2.mjs', join(temporary, name), ...args], {
          encoding: 'utf8',
          env: { PATH: process.env.PATH },
          timeout: 60_000,
        });
        expect(result.status, result.stderr).toBe(0);
      }
      const firstReport = await readFile(join(temporary, 'first/report.v2.json'), 'utf8');
      const reverseReport = await readFile(join(temporary, 'reverse/report.v2.json'), 'utf8');
      const firstExamples = await readFile(join(temporary, 'first/per-example.v2.jsonl'), 'utf8');
      const reverseExamples = await readFile(join(temporary, 'reverse/per-example.v2.jsonl'), 'utf8');
      expect(firstReport).toBe(reverseReport);
      expect(firstExamples).toBe(reverseExamples);
      const report = JSON.parse(firstReport);
      const schema = JSON.parse(readFileSync('schemas/decision/ConformalOpenDataReport.v2.schema.json', 'utf8'));
      const validator = ajv();
      expect(validator.validate(schema, report), JSON.stringify(validator.errors)).toBe(true);
      expect(report.outcome).toBe('INSUFFICIENT EVIDENCE');
      expect(report.scoreMode).toBe('synthetic');
      expect(report.actuals).toEqual({ providerCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
      expect(report.integrity.release_gate.decision).toBe('HOLD');
      expect(report.tasks['clinc150-intent-choice'].splits.shift.gateDiagnostics.exchangeabilityApplicable).toBe(false);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it('CONF2-06 dry-run collection estimates budget and refuses over-ceiling item counts without credentials', async () => {
    expect(conservativeUsdPerCall(preregistration)).toBe(0.01);
    expect(estimateCollection(preregistration, 10)).toMatchObject({ providerCalls: 10, estimatedUsd: 0.1, hardCeilingUsd: 8 });
    expect(() => estimateCollection(preregistration, preregistration.resourceBudget.liveMaxItems + 1)).toThrow(/exceeds manifest max/);
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'tools/experiments/conformal/collect-jev.v2.mjs', '--limit', '5'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
      timeout: 60_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'dry-run', rows: 5, noCallsMade: true });
    await expect(collectMain({}, ['--live', '--limit', '1'])).rejects.toThrow(/AIWG_DECISION_JEV_LIVE_SMOKE/);
    await expect(collectMain({ AIWG_DECISION_JEV_LIVE_SMOKE: '1' }, ['--live', '--limit', '1'])).rejects.toThrow(/AIWG_DECISION_JEV_API_KEY/);
    await expect(collectMain({ AIWG_DECISION_JEV_LIVE_SMOKE: '1', AIWG_DECISION_JEV_API_KEY: 'fixture' }, ['--live', '--limit', '1']))
      .rejects.toThrow(/AIWG_DECISION_JEV_REGION/);
  });

  it('CONF2-07 live scorer path uses normalized runtime artifacts and preserves native uncertainty', async () => {
    const row = frozen.splits.finalTest.find((candidate: { task: string }) => candidate.task === 'banking77-intent-choice');
    const task = frozen.tasks[row.task];
    const distribution = Object.fromEntries(task.labels.map((label: string, index: number) => [label, index === row.labelIndex ? 1 : 0]));
    const adapter = {
      id: 'jev',
      version: '1.0.0',
      capabilities: async () => ({
        answerKinds: ['choice'],
        features: ['choice', 'probability-distribution', 'structured-entries'],
        maxOptions: 255,
        maxLevels: 10,
        confidenceProfiles: ['typesafe-distribution-v1'],
        executable: true,
        egress: { mode: 'none' },
      }),
      evaluate: async request => ({
        status: 'success',
        reason: 'none',
        value: row.label,
        uncertainty: {
          source: 'provider',
          profile: 'typesafe-distribution-v1',
          calibration: 'vendor-claimed',
          confidence: null,
          distribution,
          calibrationRef: null,
        },
        actualModel: request.target.model,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
        requestId: 'fixture',
      }),
    };
    const artifacts = buildRuntimeArtifacts({ row, task, model: 'fixture-jev' });
    expect(artifacts.binding.spec.evaluations.label.targets[0].adapter).toBe('jev');
    const scored = await scoreRowThroughRuntime({ row, task, model: 'fixture-jev', region: 'test-region', adapter, credential: 'fixture' });
    expect(scored).toMatchObject({ id: row.id, status: 'success', value: row.label });
    expect(scored.uncertainty.profile).toBe('typesafe-distribution-v1');
    expect(digest(scored.uncertainty.distribution)).toBe(digest(distribution));
  });

  it('CONF2-08 durably appends live records, resumes by ID, tracks fallback budget and stops repeated errors', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'aiwg-conformal-collector-'));
    try {
      const rows = frozen.splits.finalTest.filter((row: { task: string }) => row.task === 'banking77-intent-choice').slice(0, 3);
      const output = join(temporary, 'scores.jsonl');
      let calls = 0;
      const task = frozen.tasks[rows[0].task];
      const adapter = {
        id: 'jev',
        version: '1.0.0',
        capabilities: async () => ({
          answerKinds: ['choice'],
          features: ['choice', 'probability-distribution', 'structured-entries'],
          maxOptions: 255,
          maxLevels: 10,
          confidenceProfiles: ['typesafe-distribution-v1'],
          executable: true,
          egress: { mode: 'none' },
        }),
        evaluate: async () => {
          calls += 1;
          const label = task.labels[0];
          return {
            status: 'success',
            reason: 'none',
            value: label,
            uncertainty: {
              source: 'provider',
              profile: 'typesafe-distribution-v1',
              calibration: 'vendor-claimed',
              confidence: null,
              distribution: Object.fromEntries(task.labels.map((entry: string, index: number) => [entry, index === 0 ? 1 : 0])),
              calibrationRef: null,
            },
            actualModel: 'fixture-jev',
            usage: { inputTokens: 2, outputTokens: 1, costUsd: null },
            requestId: `fixture-${calls}`,
          };
        },
      };
      const first = await collectLiveScores({
        preregistration,
        frozen,
        rows: rows.slice(0, 2),
        model: 'fixture-jev',
        region: 'fixture-region',
        credential: 'fixture',
        output,
        adapter,
        codeVersion: experimentCodeVersion(conformalRoot),
      });
      expect(first).toMatchObject({ completed: 2, providerCalls: 2, costUsd: 0.02, stoppedReason: null });
      expect((await readFile(output, 'utf8')).trim().split('\n')).toHaveLength(2);
      const second = await collectLiveScores({
        preregistration,
        frozen,
        rows,
        model: 'fixture-jev',
        region: 'fixture-region',
        credential: 'fixture',
        output,
        adapter,
        codeVersion: experimentCodeVersion(conformalRoot),
      });
      expect(second).toMatchObject({ skipped: 2, completed: 1, providerCalls: 1 });
      expect((await readFile(output, 'utf8')).trim().split('\n')).toHaveLength(3);

      const failing = {
        ...adapter,
        evaluate: async () => {
          throw new Error('fixture transport failure');
        },
      };
      const failed = await collectLiveScores({
        preregistration,
        frozen,
        rows,
        model: 'fixture-jev',
        region: 'fixture-region',
        credential: 'fixture',
        output: join(temporary, 'failed.jsonl'),
        adapter: failing,
        codeVersion: experimentCodeVersion(conformalRoot),
      });
      expect(failed.stoppedReason).toBe('consecutive-errors');
      expect(failed.providerCalls).toBe(preregistration.resourceBudget.maxConsecutiveErrors * (preregistration.resourceBudget.maxRetriesPerItem + 1));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it('CONF2-09 computes GO, CONDITIONAL, NO-GO and INSUFFICIENT outcomes from validated live-score fixtures', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'aiwg-conformal-outcomes-'));
    try {
      const expected = {
        go: 'GO',
        conditional: 'CONDITIONAL',
        'no-go': 'NO-GO',
        insufficient: 'INSUFFICIENT EVIDENCE',
      } as const;
      for (const [mode, outcome] of Object.entries(expected)) {
        const scores = join(temporary, `${mode}.jsonl`);
        await writeLiveScoreFixture(scores, mode as keyof typeof expected);
        const summary = runAnalysis({ output: join(temporary, mode), scoresPath: scores });
        expect(summary.outcome).toBe(outcome);
        const report = JSON.parse(await readFile(join(temporary, mode, 'report.v2.json'), 'utf8'));
        expect(report.scoreMode).toBe('live');
        expect(report.outcome).toBe(outcome);
        expect(report.actuals.providerCalls).toBe(frozen.splits.calibration.length + frozen.splits.finalTest.length + frozen.splits.shift.length);
      }

      const scores = join(temporary, 'incompatible.jsonl');
      await writeLiveScoreFixture(scores, 'go');
      const [first, ...rest] = (await readFile(scores, 'utf8')).trim().split('\n');
      const record = JSON.parse(first);
      record.compatibility.definition = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
      await writeFile(scores, `${[JSON.stringify(record), ...rest].join('\n')}\n`);
      expect(() => runAnalysis({ output: join(temporary, 'incompatible'), scoresPath: scores })).toThrow(/definition/);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
