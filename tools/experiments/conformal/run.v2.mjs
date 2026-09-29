import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { applyPrimitiveAcceptance } from '../../../src/decision/acceptance.ts';
import { buildIntegrityMetadata } from '../../eval/src/integrity.ts';
import {
  assertCompatibleProfile,
  digest,
  experimentCodeVersion,
  fitConformalProfile,
  compatibilityForTask,
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

function parseArgs(argv = process.argv.slice(2)) {
  const positionals = [];
  const args = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) positionals.push(value);
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
      args.set(value, argv[index + 1]);
      index += 1;
    } else flags.add(value);
  }
  return { positionals, args, flags };
}

function distributionHash(task, probabilities) {
  return digest(Object.fromEntries(task.labels.map((label, index) => [label, probabilities[index]])));
}

function syntheticScore(row, frozen) {
  const task = frozen.tasks[row.task];
  const probabilities = syntheticChoiceDistribution(row, task);
  return {
    ...row,
    probabilities,
    distributionHash: distributionHash(task, probabilities),
    topIndex: topIndex(probabilities),
    topProbability: Math.max(...probabilities),
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    latencyMs: 0,
  };
}

function scoreIndex(frozen) {
  const rows = Object.fromEntries(Object.entries(frozen.splits).flatMap(([split, members]) => members.map(row => [row.id, { ...row, split }])));
  return rows;
}

export function readLiveScores(path, frozen, preregistration, codeVersion) {
  const byId = new Map();
  const compatibilityByTask = new Map();
  let representative = true;
  const validRows = scoreIndex(frozen);
  for (const [lineNumber, line] of readFileSync(path, 'utf8').split('\n').entries()) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record.schemaVersion !== 'conformal-live-score/v2') throw new Error(`invalid live score schema at line ${lineNumber + 1}`);
    const frozenRow = validRows[record.id];
    if (!frozenRow) throw new Error(`live score row is not in frozen splits: ${record.id}`);
    if (frozenRow.task !== record.task || frozenRow.split !== record.split || frozenRow.label !== record.label) {
      throw new Error(`live score row does not match frozen row: ${record.id}`);
    }
    const task = frozen.tasks[record.task];
    const probabilities = task.labels.map(label => record.probabilities?.[label]);
    if (probabilities.some(value => !Number.isFinite(value) || value < 0 || value > 1)) throw new Error(`invalid probabilities for ${record.id}`);
    const sum = probabilities.reduce((total, value) => total + value, 0);
    if (Math.abs(sum - 1) > 1e-6) throw new Error(`probabilities do not sum to 1 for ${record.id}`);
    const expectedCompatibility = compatibilityForTask(frozen, record.task, 1 - preregistration.coverageTarget, codeVersion, {
      servedModel: record.compatibility?.servedModel,
      adapter: record.compatibility?.adapter,
      calibrationSplit: rowHash(orderedRows(frozen.splits.calibration.filter(row => row.task === record.task))),
    });
    assertCompatibleProfile(record.compatibility, expectedCompatibility);
    compatibilityByTask.set(record.task, record.compatibility);
    if (record.representative === false) representative = false;
    byId.set(record.id, {
      ...frozenRow,
      probabilities,
      compatibility: record.compatibility,
      distributionHash: distributionHash(task, probabilities),
      topIndex: topIndex(probabilities),
      topProbability: Math.max(...probabilities),
      usage: record.usage ?? null,
      latencyMs: record.latencyMs ?? 0,
      budgetChargeUsd: record.budgetChargeUsd ?? record.usage?.costUsd ?? 0,
      representative: record.representative !== false,
    });
  }
  return {
    mode: 'live',
    path,
    representative,
    scoreForRow(row) {
      const scored = byId.get(row.id);
      if (!scored) throw new Error(`missing live score for ${row.id}`);
      return scored;
    },
    hasRow(row) {
      return byId.has(row.id);
    },
    compatibilityForTask(taskId) {
      return compatibilityByTask.get(taskId) ?? null;
    },
    actuals() {
      const records = [...byId.values()];
      return {
        providerCalls: records.reduce((sum, row) => sum + (row.usage ? 1 : 0), 0),
        inputTokens: records.reduce((sum, row) => sum + (row.usage?.inputTokens ?? 0), 0),
        outputTokens: records.reduce((sum, row) => sum + (row.usage?.outputTokens ?? 0), 0),
        costUsd: Number(records.reduce((sum, row) => sum + (row.budgetChargeUsd ?? 0), 0).toFixed(6)),
      };
    },
  };
}

function syntheticSource(frozen) {
  return {
    mode: 'synthetic',
    scoreForRow: row => syntheticScore(row, frozen),
    hasRow: () => true,
    compatibilityForTask: () => null,
    actuals: () => ({ providerCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }),
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

function primitivePolicySet(row, bins, calibrated, frozen) {
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

function summarize(scored, frozen, taskId) {
  const task = frozen.tasks[taskId];
  return {
    overall: metrics(scored),
    slices: Object.fromEntries([...new Set(scored.map(row => row.slice))].sort()
      .map(slice => [slice, metrics(scored.filter(row => row.slice === slice))])),
    classes: Object.fromEntries(task.labels.map((label, index) => [label, metrics(scored.filter(row => row.labelIndex === index))])),
  };
}

function gateDiagnostics({ lac, calibrated, split, scoredRows, task, preregistration, sourceMode }) {
  const gates = preregistration.usefulnessGates;
  return {
    enoughRows: scoredRows.length >= (split === 'finalTest' ? gates.minimumFinalRowsPerTask : gates.minimumSliceRows),
    coverage: lac.coverage95?.lower >= gates.minimumCoverageWilsonLower,
    usefulSize: lac.meanSetSize <= task.labels.length * gates.maximumMeanSetSizeFractionOfLabels,
    review: lac.reviewRate <= gates.maximumReviewRate,
    selectiveRisk: lac.selectiveRisk !== null && lac.selectiveRisk <= gates.maximumSelectiveRisk,
    baselineImprovement: lac.selectiveRisk !== null && lac.reviewRate < calibrated.reviewRate
      && (calibrated.selectiveRisk === null
        ? calibrated.acceptedN === 0 && lac.acceptedN > 0
        : lac.selectiveRisk <= calibrated.selectiveRisk),
    representativeLiveScores: sourceMode === 'live' && scoredRows.every(row => row.representative !== false),
    exchangeabilityApplicable: split === 'finalTest',
  };
}

function passes(diag) {
  return diag.enoughRows && diag.coverage && diag.usefulSize && diag.review && diag.selectiveRisk && diag.baselineImprovement && diag.representativeLiveScores;
}

function decideOutcome(report) {
  if (report.scoreMode !== 'live') return 'INSUFFICIENT EVIDENCE';
  const taskSplits = Object.values(report.tasks).flatMap(task => Object.entries(task.splits).map(([split, value]) => ({ split, diag: value.gateDiagnostics })));
  if (taskSplits.some(item => !item.diag.enoughRows || !item.diag.representativeLiveScores)) return 'INSUFFICIENT EVIDENCE';
  const final = taskSplits.filter(item => item.split === 'finalTest');
  const shift = taskSplits.filter(item => item.split === 'shift');
  if (final.every(item => passes(item.diag)) && shift.every(item => passes(item.diag))) return 'GO';
  if (final.every(item => passes(item.diag)) && shift.some(item => !passes(item.diag))) return 'CONDITIONAL';
  if (final.some(item => !passes(item.diag))) return 'NO-GO';
  return 'INSUFFICIENT EVIDENCE';
}

export function runAnalysis({ output, scoresPath = null, reverse = false } = {}) {
  if (!output) throw new Error('explicit report output directory required');
  const preregistration = JSON.parse(readFileSync(new URL('preregister.v2.json', root), 'utf8'));
  const frozen = JSON.parse(readFileSync(new URL('frozen.v2.json', root), 'utf8'));
  verifyFrozenOpenData(frozen, preregistration);
  if (reverse) for (const rows of Object.values(frozen.splits)) rows.reverse();
  const codeVersion = experimentCodeVersion(root);
  const source = scoresPath ? readLiveScores(scoresPath, frozen, preregistration, codeVersion) : syntheticSource(frozen);
  mkdirSync(output, { recursive: true });
  const perExample = [];
  const report = {
    schemaVersion: 'conformal-open-data-report/v2',
    issue: 2613,
    outcome: 'INSUFFICIENT EVIDENCE',
    status: 'experimental-default-off',
    scoreMode: source.mode,
    preregistrationHash: digest(preregistration),
    frozenSampleDigest: frozen.sampleDigest,
    splitHashes: frozen.splitHashes,
    sourceFiles: frozen.sourceFiles,
    actuals: source.actuals(),
    compatibility: {},
    tasks: {},
    gaps: [
      ...(source.mode === 'synthetic' ? ['No live Jev scores were collected; synthetic-score stand-in evidence cannot yield GO.'] : []),
      'No approved D09 calibrated-risk artifact is available for these open-data populations.',
      'No D14 provider-backed lineage/retention record exists for any provider-backed run reviewed here.',
      'No Noul or Score task is evaluated in v2; the operator-selected public replacements are Choice datasets.',
      'Class-conditional coverage is unsupported for classes with n < 50 in this bounded sample.',
    ],
  };

  for (const taskId of Object.keys(frozen.tasks)) {
    const trainRows = orderedRows(frozen.splits.train.filter(row => row.task === taskId)).map(row => syntheticScore(row, frozen));
    const calibrationRows = orderedRows(frozen.splits.calibration.filter(row => row.task === taskId));
    const liveCompatibility = source.compatibilityForTask(taskId);
    const profile = fitConformalProfile(calibrationRows, frozen, taskId, 1 - preregistration.coverageTarget, codeVersion, {
      probabilitiesForRow: row => source.scoreForRow(row).probabilities,
      servedModel: liveCompatibility?.servedModel,
      adapter: liveCompatibility?.adapter,
    });
    if (liveCompatibility) assertCompatibleProfile(liveCompatibility, profile.compatibility);
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
      const splitRows = orderedRows(frozen.splits[split].filter(row => row.task === taskId));
      const scoredRows = splitRows.map(row => source.scoreForRow(row));
      const methods = {
        lac: row => predictionSet(row.probabilities, profile.q),
        raw: row => primitivePolicySet(row, bins, false, frozen),
        calibrated: row => primitivePolicySet(row, bins, true, frozen),
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
            latencyMs: row.latencyMs ?? 0,
          };
        });
        perExample.push(...rows);
        report.tasks[taskId].splits[split][method] = summarize(rows, frozen, taskId);
      }
      const lac = report.tasks[taskId].splits[split].lac.overall;
      const calibrated = report.tasks[taskId].splits[split].calibrated.overall;
      report.tasks[taskId].splits[split].gateDiagnostics = gateDiagnostics({
        lac,
        calibrated,
        split,
        scoredRows,
        task: frozen.tasks[taskId],
        preregistration,
        sourceMode: source.mode,
      });
    }
  }

  perExample.sort((a, b) => `${a.task}/${a.split}/${a.method}/${a.id}`.localeCompare(`${b.task}/${b.split}/${b.method}/${b.id}`));
  report.outcome = decideOutcome(report);
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
      scoreMeaning: source.mode === 'synthetic'
        ? 'Pooled final-test LAC set coverage from synthetic-score stand-in; not live Jev evidence.'
        : 'Pooled final-test LAC set coverage from validated live-score JSONL; pending independent D09/D11/D14 review.',
    },
    release_gate: {
      ...upstream.release_gate,
      decision: upstream.release_gate.decision === 'ROLLBACK' ? 'ROLLBACK' : 'HOLD',
    },
  };
  report.perExampleHash = digest(perExample);
  report.latency = {
    scope: source.mode === 'synthetic'
      ? 'deterministic offline report records zero provider latency; live provider latency is pending live collection'
      : 'latency values come from the supplied live-score JSONL when present',
    elapsedMs: 0,
  };

  writeFileSync(`${output}/report.v2.json`, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(`${output}/per-example.v2.jsonl`, `${perExample.map(row => JSON.stringify(row)).join('\n')}\n`);
  const summary = {
    outcome: report.outcome,
    report: `${output}/report.v2.json`,
    perExampleHash: report.perExampleHash,
    splitHashes: frozen.splitHashes,
    actuals: report.actuals,
  };
  writeFileSync(`${output}/summary.v2.json`, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const parsed = parseArgs();
  const output = parsed.positionals[0];
  const summary = runAnalysis({
    output,
    scoresPath: parsed.args.get('--scores') ?? null,
    reverse: parsed.flags.has('--reverse'),
  });
  console.log(JSON.stringify(summary, null, 2));
}
