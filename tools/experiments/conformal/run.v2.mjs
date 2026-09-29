import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { applyPrimitiveAcceptance } from '../../../src/decision/acceptance.ts';
import { buildIntegrityMetadata } from '../../eval/src/integrity.ts';
import {
  digest,
  fitConformalProfile,
  metrics,
  orderedRows,
  predictionSet,
  rowHash,
  syntheticChoiceDistribution,
  topIndex,
  verifyFrozenOpenData,
  wilson,
} from './open-data.mjs';

const root = new URL('./', import.meta.url);
const preregistration = JSON.parse(readFileSync(new URL('preregister.v2.json', root), 'utf8'));
const frozen = JSON.parse(readFileSync(new URL('frozen.v2.json', root), 'utf8'));
verifyFrozenOpenData(frozen, preregistration);
const output = process.argv[2];
if (!output) throw new Error('explicit report output directory required');
mkdirSync(output, { recursive: true });
if (process.argv.includes('--reverse')) for (const rows of Object.values(frozen.splits)) rows.reverse();

const codeVersion = digest([
  readFileSync(new URL('open-data.mjs', root), 'utf8'),
  readFileSync(new URL('run.v2.mjs', root), 'utf8'),
].join('\n'));

function score(row) {
  const task = frozen.tasks[row.task];
  const probabilities = syntheticChoiceDistribution(row, task);
  return {
    ...row,
    probabilities,
    distributionHash: digest(Object.fromEntries(task.labels.map((label, index) => [label, probabilities[index]]))),
    topIndex: topIndex(probabilities),
    topProbability: Math.max(...probabilities),
  };
}

function riskBins(rows) {
  const bins = {};
  for (let bin = 0; bin <= 10; bin += 1) {
    const members = rows.filter(row => Math.floor(row.topProbability * 10) === bin);
    if (members.length) bins[bin] = {
      n: members.length,
      ...wilson(members.filter(row => row.topIndex !== row.labelIndex).length, members.length),
    };
  }
  return bins;
}

function primitivePolicySet(row, bins, calibrated) {
  const task = frozen.tasks[row.task];
  const selected = task.labels[row.topIndex];
  const risk = bins[Math.floor(row.topProbability * 10)];
  const definition = { spec: { answer: { kind: 'choice', options: task.labels.map(id => ({ id, description: id })) } } };
  const observation = {
    status: 'success',
    reason: 'none',
    value: selected,
    actualModel: 'synthetic-score-stand-in/v2',
    requestId: null,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    uncertainty: {
      source: 'provider',
      profile: 'synthetic-open-data/v2',
      calibration: calibrated ? 'measured' : 'uncalibrated',
      confidence: null,
      distribution: Object.fromEntries(task.labels.map((label, index) => [label, row.probabilities[index]])),
      calibrationRef: null,
      ...(calibrated && risk ? { calibratedRisk: { value: risk.upper, calibrationRef: `synthetic-train:${digest(bins)}` } } : {}),
    },
  };
  const review = { disposition: 'review' };
  const conditions = calibrated
    ? [{ metric: 'calibrated-risk', op: 'lte', thresholdBps: 1200 }]
    : [{ metric: 'selected-probability', op: 'gte', thresholdBps: 7500 }];
  const policy = {
    mode: 'primitive-policy',
    version: '2.0.0',
    compatibleUncertaintyProfiles: ['synthetic-open-data/v2'],
    precedence: 'first-match',
    calibration: calibrated ? 'required' : 'advisory',
    rules: [{ id: calibrated ? 'calibrated-risk' : 'selected-probability', primitive: 'choice', all: conditions, route: { disposition: 'act' } }],
    defaultRoute: review,
    missingEvidenceRoute: review,
    invalidEvidenceRoute: review,
    tieRoute: review,
  };
  return applyPrimitiveAcceptance(definition, policy, observation).acceptance.disposition === 'act' ? [row.topIndex] : [];
}

function summarize(scored, taskId) {
  const task = frozen.tasks[taskId];
  return {
    overall: metrics(scored),
    slices: Object.fromEntries([...new Set(scored.map(row => row.slice))].sort()
      .map(slice => [slice, metrics(scored.filter(row => row.slice === slice))])),
    classes: Object.fromEntries(task.labels.map((label, index) => [label, metrics(scored.filter(row => row.labelIndex === index))])),
  };
}

const perExample = [];
const report = {
  schemaVersion: 'conformal-open-data-report/v2',
  issue: 2613,
  outcome: 'INSUFFICIENT EVIDENCE',
  status: 'experimental-default-off',
  preregistrationHash: digest(preregistration),
  frozenSampleDigest: frozen.sampleDigest,
  splitHashes: frozen.splitHashes,
  sourceFiles: frozen.sourceFiles,
  actuals: { providerCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
  compatibility: {},
  tasks: {},
  gaps: [
    'No live Jev scores were collected; AIWG_DECISION_JEV_LIVE_SMOKE remains unset in this offline run.',
    'No approved D09 calibrated-risk artifact is available for these open-data populations.',
    'No D14 provider-backed lineage/retention record exists because this run is synthetic-score only.',
    'No Noul or Score task is evaluated in v2; the operator-selected public replacements are Choice datasets.',
  ],
};

for (const taskId of Object.keys(frozen.tasks)) {
  const trainRows = orderedRows(frozen.splits.train.filter(row => row.task === taskId)).map(score);
  const calibrationRows = orderedRows(frozen.splits.calibration.filter(row => row.task === taskId));
  const profile = fitConformalProfile(calibrationRows, frozen, taskId, preregistration.coverageTarget ? 1 - preregistration.coverageTarget : 0.1, codeVersion);
  const bins = riskBins(trainRows);
  report.compatibility[taskId] = profile.compatibility;
  report.tasks[taskId] = {
    profile,
    calibratedBaseline: {
      source: 'synthetic train split decile error upper bound; not an approved D09 calibration profile',
      bins,
    },
    splits: {},
  };
  for (const split of ['finalTest', 'shift']) {
    const scoredRows = orderedRows(frozen.splits[split].filter(row => row.task === taskId)).map(score);
    const methods = {
      lac: row => predictionSet(row.probabilities, profile.q),
      raw: row => primitivePolicySet(row, bins, false),
      calibrated: row => primitivePolicySet(row, bins, true),
      alwaysReview: () => [],
      alwaysPredict: row => [row.topIndex],
    };
    report.tasks[taskId].splits[split] = {};
    for (const [method, fn] of Object.entries(methods)) {
      const rows = scoredRows.map(row => {
        const set = fn(row);
        return {
          id: row.id,
          task: taskId,
          split,
          slice: row.slice,
          method,
          labelIndex: row.labelIndex,
          topIndex: row.topIndex,
          topProbability: row.topProbability,
          distributionHash: row.distributionHash,
          set,
          nativeEvidenceHash: digest({ id: row.id, text: row.text, label: row.label, probabilities: row.probabilities }),
          latencyMs: 0,
        };
      });
      perExample.push(...rows);
      report.tasks[taskId].splits[split][method] = summarize(rows, taskId);
    }
    const lac = report.tasks[taskId].splits[split].lac.overall;
    const calibrated = report.tasks[taskId].splits[split].calibrated.overall;
    const gates = preregistration.usefulnessGates;
    report.tasks[taskId].splits[split].gateDiagnostics = {
      coverage: lac.coverage95?.lower >= gates.minimumCoverageWilsonLower,
      usefulSize: lac.meanSetSize <= frozen.tasks[taskId].labels.length * gates.maximumMeanSetSizeFractionOfLabels,
      review: lac.reviewRate <= gates.maximumReviewRate,
      selectiveRisk: lac.selectiveRisk !== null && lac.selectiveRisk <= gates.maximumSelectiveRisk,
      baselineImprovement: calibrated.selectiveRisk !== null && lac.selectiveRisk !== null
        && lac.selectiveRisk <= calibrated.selectiveRisk && lac.reviewRate < calibrated.reviewRate,
      representativeLiveScores: false,
      exchangeabilityApplicable: split === 'finalTest',
    };
  }
}

perExample.sort((a, b) => `${a.task}/${a.split}/${a.method}/${a.id}`.localeCompare(`${b.task}/${b.split}/${b.method}/${b.id}`));
const nominalLac = perExample.filter(row => row.split === 'finalTest' && row.method === 'lac');
const nominalCovered = nominalLac.filter(row => row.set.includes(row.labelIndex)).length;
const upstream = buildIntegrityMetadata({
  mode: 'standard',
  freshWorkspaceRequired: true,
  freshWorkspaceVerified: false,
  changedArtifacts: [],
  sampleN: nominalLac.length,
  passedN: nominalCovered,
  overallScore: 100 * nominalCovered / nominalLac.length,
});
report.integrity = {
  ...upstream,
  conformal: {
    schemaVersion: 'conformal-evidence/v2',
    outcome: report.outcome,
    preregistrationHash: report.preregistrationHash,
    frozenSampleDigest: report.frozenSampleDigest,
    perExampleHash: digest(perExample),
    scoreMeaning: 'Pooled final-test LAC set coverage from synthetic-score stand-in; not live Jev evidence.',
  },
  release_gate: {
    ...upstream.release_gate,
    decision: upstream.release_gate.decision === 'ROLLBACK' ? 'ROLLBACK' : 'HOLD',
  },
};
report.perExampleHash = digest(perExample);
report.latency = {
  scope: 'deterministic offline report records zero provider latency; live provider latency is pending live collection',
  elapsedMs: 0,
};

writeFileSync(`${output}/report.v2.json`, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(`${output}/per-example.v2.jsonl`, `${perExample.map(row => JSON.stringify(row)).join('\n')}\n`);
writeFileSync(`${output}/summary.v2.json`, `${JSON.stringify({
  outcome: report.outcome,
  report: `${output}/report.v2.json`,
  perExampleHash: report.perExampleHash,
  splitHashes: frozen.splitHashes,
  actuals: report.actuals,
}, null, 2)}\n`);
console.log(JSON.stringify({
  outcome: report.outcome,
  report: `${output}/report.v2.json`,
  perExampleHash: report.perExampleHash,
  splitHashes: frozen.splitHashes,
}, null, 2));
