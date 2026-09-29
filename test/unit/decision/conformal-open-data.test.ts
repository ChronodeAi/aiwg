// @ts-nocheck
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it, vi } from 'vitest';
import {
  digest,
  fitConformalProfile,
  metrics,
  predictionSet,
  rowHash,
  syntheticChoiceDistribution,
  verifyFrozenOpenData,
} from '../../../tools/experiments/conformal/open-data.mjs';
import {
  buildRuntimeArtifacts,
  estimateCollection,
  scoreRowThroughRuntime,
} from '../../../tools/experiments/conformal/collect-jev.v2.mjs';

const preregistration = JSON.parse(readFileSync('tools/experiments/conformal/preregister.v2.json', 'utf8'));
const frozen = JSON.parse(readFileSync('tools/experiments/conformal/frozen.v2.json', 'utf8'));

function ajv() {
  const validator = new Ajv2020({ strict: false });
  addFormats(validator);
  return validator;
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
    expect(frozen.sourceFiles.map((file: { license: string }) => file.license)).toEqual(['CC-BY-4.0', 'CC-BY-4.0', 'CC-BY-4.0']);
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
      expect(report.actuals).toEqual({ providerCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
      expect(report.integrity.release_gate.decision).toBe('HOLD');
      expect(report.tasks['clinc150-intent-choice'].splits.shift.lac.overall.coverage)
        .toBeLessThan(report.tasks['clinc150-intent-choice'].splits.finalTest.lac.overall.coverage);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it('CONF2-06 dry-run collection estimates budget and refuses over-ceiling item counts without credentials', () => {
    expect(estimateCollection(preregistration, 10)).toMatchObject({ providerCalls: 10, estimatedUsd: 0.1, hardCeilingUsd: 8 });
    expect(() => estimateCollection(preregistration, preregistration.resourceBudget.liveMaxItems + 1)).toThrow(/exceeds manifest max/);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'tools/experiments/conformal/collect-jev.v2.mjs', '--limit', '5'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'dry-run', rows: 5, noCallsMade: true });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
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
});
