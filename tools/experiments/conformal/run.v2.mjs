import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { applyPrimitiveAcceptance } from '../../../src/decision/acceptance.ts';
import { buildIntegrityMetadata } from '../../eval/src/integrity.ts';
import {
  LEDGER_FILE,
  readJsonl,
  readSpendLedger,
  recordDigest,
  reservationMicros,
  hardCeilingMicros,
} from './collect-jev.v2.mjs';
import {
  assertCompatibleProfile,
  compatibilityForTask,
  digest,
  experimentCodeVersion,
  expectedLiveCompatibility,
  fitConformalProfile,
  liveSubsetRows,
  liveTaskIds,
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
    status: 'success',
    probabilities,
    distributionHash: distributionHash(task, probabilities),
    topIndex: topIndex(probabilities),
    topProbability: Math.max(...probabilities),
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    latencyMs: 0,
  };
}

function hasCollectorProvenance(record, preregistration) {
  if (record.collector?.version !== preregistration.pins.collectorCodeDigest) return 'collector version';
  if (record.collector?.preregistrationHash !== digest(preregistration)) return 'collector preregistration hash';
  if (typeof record.recordDigest !== 'string' || recordDigest(record) !== record.recordDigest) return 'record digest';
  if (!Array.isArray(record.attempts) || !record.attempts.length) return 'attempts';
  if (record.attempts.some(attempt => typeof attempt.reservationId !== 'string' || !attempt.reservationId)) return 'attempt reservation IDs';
  if (!Number.isSafeInteger(record.budgetChargeMicros)
    || record.attempts.reduce((sum, attempt) => sum + attempt.chargedMicros, 0) !== record.budgetChargeMicros) return 'budget charge matching its attempts';
  if (record.status === 'success') {
    if (typeof record.requestId !== 'string' || !record.requestId) return 'request ID';
    if (!Number.isSafeInteger(record.usage?.inputTokens) || !Number.isSafeInteger(record.usage?.outputTokens)) return 'usage tokens';
  }
  return null;
}

/**
 * Reads collector score records for the preregistered live subset. Structural or compatibility
 * violations throw; missing provenance only marks the evidence non-representative (no GO).
 */
export function readLiveScores(path, frozen, preregistration, { ledgerPath = join(dirname(path), LEDGER_FILE) } = {}) {
  const liveRows = new Map(liveSubsetRows(frozen).map(row => [row.id, row]));
  const { entries, trailingPartial } = readJsonl(path);
  const latest = new Map();
  const all = [];
  entries.forEach((record, index) => {
    if (record?.schemaVersion !== 'conformal-live-score/v2') throw new Error(`invalid live score schema at line ${index + 1}`);
    const frozenRow = liveRows.get(record.id);
    if (!frozenRow) throw new Error(`live score row is not in the preregistered live subset: ${record.id}`);
    if (frozenRow.task !== record.task || frozenRow.split !== record.split || frozenRow.label !== record.label) {
      throw new Error(`live score row does not match frozen row: ${record.id}`);
    }
    try {
      assertCompatibleProfile(record.compatibility, expectedLiveCompatibility(frozen, preregistration, record.task));
    } catch (error) {
      throw new Error(`live score ${record.id}: ${error.message}`);
    }
    const task = frozen.tasks[record.task];
    if (record.status === 'success') {
      if (record.actualModel !== preregistration.pins.liveServedModel) throw new Error(`live score ${record.id}: served model differs from the pinned servedModel`);
      const probabilities = task.labels.map(label => record.probabilities?.[label]);
      if (probabilities.some(value => !Number.isFinite(value) || value < 0 || value > 1)) throw new Error(`invalid probabilities for ${record.id}`);
      if (Math.abs(probabilities.reduce((total, value) => total + value, 0) - 1) > 1e-6) throw new Error(`probabilities do not sum to 1 for ${record.id}`);
    } else if (record.status === 'error' || record.status === 'missing-distribution') {
      if (record.probabilities !== undefined) throw new Error(`live score ${record.id}: ${record.status} records must not carry probabilities`);
    } else throw new Error(`live score ${record.id}: unknown status ${record.status}`);
    all.push(record);
    latest.set(record.id, record);
  });

  const reasons = new Map();
  const note = reason => reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  let ledger = null;
  if (!existsSync(ledgerPath)) note('no collector spend ledger next to the score file');
  else {
    try {
      ledger = readSpendLedger(ledgerPath);
    } catch (error) {
      note(`spend ledger rejected: ${error.message}`);
    }
  }
  // Cross-check every record against the ledger: its attempts must be exactly the reservations and
  // settlements the collector wrote for that item under this preregistration, each claimed once.
  const preregistrationHash = digest(preregistration);
  const reserves = new Map();
  const settles = new Map();
  const recordEntries = new Map();
  for (const entry of ledger?.entries ?? []) {
    if (entry.type === 'reserve') reserves.set(entry.reservationId, entry);
    else if (entry.type === 'settle') settles.set(entry.reservationId, entry);
    else if (entry.type === 'record') recordEntries.set(`${entry.itemId}\0${entry.recordDigest}`, entry);
  }
  const claimed = new Set();
  const requestIds = new Set();
  for (const record of all) {
    const missing = hasCollectorProvenance(record, preregistration);
    if (missing) {
      note(`record lacks collector provenance: ${missing}`);
      continue;
    }
    if (record.status === 'success') {
      if (requestIds.has(record.requestId)) note('duplicate request ID across success records');
      requestIds.add(record.requestId);
    }
    if (!ledger) continue;
    const recordEntry = recordEntries.get(`${record.id}\0${record.recordDigest}`);
    if (!recordEntry) note('record digest is not chained into the spend ledger');
    else if (recordEntry.preregistrationHash !== preregistrationHash) note('ledger record entry preregistration hash differs from this preregistration');
    for (const attempt of record.attempts) {
      const reserve = reserves.get(attempt.reservationId);
      const settle = settles.get(attempt.reservationId);
      if (!reserve || !settle || reserve.itemId !== record.id) {
        note('attempt has no matching ledger reservation and settlement');
        continue;
      }
      if (reserve.preregistrationHash !== preregistrationHash || settle.preregistrationHash !== preregistrationHash) {
        note('ledger reservation preregistration hash differs from this preregistration');
      }
      if (reserve.reservedMicros !== attempt.reservedMicros || settle.chargedMicros !== attempt.chargedMicros) note('attempt charge differs from its ledger settlement');
      if (claimed.has(attempt.reservationId)) note('ledger reservation claimed by more than one attempt');
      claimed.add(attempt.reservationId);
    }
  }
  if (trailingPartial) note('a truncated trailing line was ignored');

  const byId = new Map([...latest].map(([id, record]) => {
    const frozenRow = liveRows.get(id);
    if (record.status !== 'success') return [id, { ...frozenRow, status: record.status }];
    const task = frozen.tasks[record.task];
    const probabilities = task.labels.map(label => record.probabilities[label]);
    return [id, {
      ...frozenRow,
      status: 'success',
      probabilities,
      distributionHash: distributionHash(task, probabilities),
      topIndex: topIndex(probabilities),
      topProbability: Math.max(...probabilities),
      latencyMs: record.latencyMs ?? 0,
    }];
  }));
  const provenanceReasons = [...reasons].map(([reason, count]) => `${reason} (${count})`).sort();
  return {
    mode: 'live',
    path,
    provenance: {
      representative: provenanceReasons.length === 0,
      ledgerVerified: Boolean(ledger),
      reasons: provenanceReasons,
    },
    liveTask: taskId => liveTaskIds(frozen).includes(taskId),
    rowsFor: (taskId, split) => liveSubsetRows(frozen, split).filter(row => row.task === taskId),
    scoreForRow: row => byId.get(row.id) ?? { ...row, status: 'not-collected' },
    actuals() {
      const attempts = all.flatMap(record => record.attempts ?? []);
      return {
        providerCalls: attempts.length,
        inputTokens: attempts.reduce((sum, entry) => sum + (entry.inputTokens ?? 0), 0),
        outputTokens: attempts.reduce((sum, entry) => sum + (entry.outputTokens ?? 0), 0),
        costUsd: all.reduce((sum, record) => sum + (record.budgetChargeMicros ?? 0), 0) / 1e6,
      };
    },
  };
}

function syntheticSource(frozen) {
  return {
    mode: 'synthetic',
    provenance: { representative: false, ledgerVerified: false, reasons: ['synthetic-score stand-in; no live collection'] },
    liveTask: () => true,
    rowsFor: (taskId, split) => orderedRows(frozen.splits[split].filter(row => row.task === taskId)),
    scoreForRow: row => syntheticScore(row, frozen),
    actuals: () => ({ providerCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }),
  };
}

function failureCounts(scored) {
  return {
    error: scored.filter(row => row.status === 'error').length,
    missingDistribution: scored.filter(row => row.status === 'missing-distribution').length,
    notCollected: scored.filter(row => row.status === 'not-collected').length,
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

function primitivePolicySet(row, bins, calibrated, frozen, profileId) {
  const task = frozen.tasks[row.task];
  const selected = task.labels[row.topIndex];
  const risk = bins[Math.floor(row.topProbability * 10)];
  const definition = { spec: { answer: { kind: 'choice', options: task.labels.map(id => ({ id, description: id })) } } };
  const observation = {
    status: 'success',
    reason: 'none',
    value: selected,
    actualModel: 'conformal-2613-replay/v2',
    requestId: null,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    uncertainty: {
      source: 'provider',
      profile: profileId,
      calibration: calibrated ? 'measured' : 'uncalibrated',
      confidence: null,
      distribution: Object.fromEntries(task.labels.map((label, index) => [label, row.probabilities[index]])),
      calibrationRef: null,
      ...(calibrated && risk ? { calibratedRisk: { value: risk.upper, calibrationRef: `calibration-deciles:${digest(bins)}` } } : {}),
    },
  };
  const review = { disposition: 'review' };
  const conditions = calibrated
    ? [{ metric: 'calibrated-risk', op: 'lte', thresholdBps: 1200 }]
    : [{ metric: 'selected-probability', op: 'gte', thresholdBps: 7500 }];
  const policy = {
    mode: 'primitive-policy',
    version: '2.0.0',
    compatibleUncertaintyProfiles: [profileId],
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

function withinTolerance(failures, size, tolerance) {
  const failed = failures.error + failures.missingDistribution + failures.notCollected;
  return size > 0 && failed / size <= tolerance;
}

function gateDiagnostics({ lac, calibrated, split, scoredRows, task, preregistration, source, failures, subsetSize, calibrationTolerance }) {
  const gates = preregistration.usefulnessGates;
  return {
    // Realized-n rule: at least the preregistered floor and at least (1 - tolerance) of the subset.
    enoughRows: scoredRows.length >= Math.max(split === 'finalTest' ? gates.minimumFinalRowsPerTask : gates.minimumSliceRows,
      Math.ceil(subsetSize * (1 - preregistration.resourceBudget.maxTerminalFailureFraction))),
    // The Wilson lower bound is computed on the realized scored n, so the covered count it needs varies with n.
    failureTolerance: calibrationTolerance && withinTolerance(failures, subsetSize, preregistration.resourceBudget.maxTerminalFailureFraction),
    coverage: lac.coverage95?.lower >= gates.minimumCoverageWilsonLower,
    usefulSize: lac.meanSetSize !== null && lac.meanSetSize <= task.labels.length * gates.maximumMeanSetSizeFractionOfLabels,
    review: lac.reviewRate !== null && lac.reviewRate <= gates.maximumReviewRate,
    selectiveRisk: lac.selectiveRisk !== null && lac.selectiveRisk <= gates.maximumSelectiveRisk,
    baselineImprovement: lac.selectiveRisk !== null && lac.reviewRate < calibrated.reviewRate
      && (calibrated.selectiveRisk === null
        ? calibrated.acceptedN === 0 && lac.acceptedN > 0
        : lac.selectiveRisk <= calibrated.selectiveRisk),
    representativeLiveScores: source.mode === 'live' && source.provenance.representative,
    exchangeabilityApplicable: split === 'finalTest' || scoredRows.every(row => row.slice === 'nominal' || row.slice === 'nominal-heldout'),
  };
}

function passes(diag) {
  return diag.enoughRows && diag.failureTolerance !== false && diag.coverage && diag.usefulSize && diag.review
    && diag.selectiveRisk && diag.baselineImprovement && diag.representativeLiveScores;
}

/**
 * Exactly one preregistered outcome. Only collector-provenanced live evidence can leave
 * INSUFFICIENT EVIDENCE, and GO needs passing live evidence for every preregistered task.
 */
export function decideOutcome(report) {
  const caps = Object.entries(report.tasks).filter(([, task]) => task.live === false)
    .map(([taskId]) => `${taskId} has no preregistered live subset, so a passing live result is capped at CONDITIONAL`);
  const insufficient = { outcome: 'INSUFFICIENT EVIDENCE', caps };
  if (report.scoreMode !== 'live' || !report.provenance?.representative) return insufficient;
  const liveTasks = Object.values(report.tasks).filter(task => task.live !== false);
  if (!liveTasks.length) return insufficient;
  const taskSplits = liveTasks.flatMap(task => Object.entries(task.splits).map(([split, value]) => ({ split, diag: value.gateDiagnostics })));
  if (taskSplits.some(item => !item.diag.enoughRows || !item.diag.representativeLiveScores || item.diag.failureTolerance === false)) return insufficient;
  const final = taskSplits.filter(item => item.split === 'finalTest');
  const shift = taskSplits.filter(item => item.split === 'shift');
  let outcome = 'INSUFFICIENT EVIDENCE';
  if (final.every(item => passes(item.diag)) && shift.every(item => passes(item.diag))) outcome = 'GO';
  else if (final.every(item => passes(item.diag))) outcome = 'CONDITIONAL';
  else if (final.some(item => !passes(item.diag))) outcome = 'NO-GO';
  if (outcome === 'GO' && caps.length) outcome = 'CONDITIONAL';
  return { outcome, caps };
}

export function runAnalysis({ output, scoresPath = null, ledgerPath, reverse = false, testDesign } = {}) {
  if (!output) throw new Error('explicit report output directory required');
  if (testDesign && (!testDesign.preregistration || !testDesign.frozen)) throw new Error('test design requires preregistration and frozen data');
  const preregistration = testDesign?.preregistration ?? JSON.parse(readFileSync(new URL('preregister.v2.json', root), 'utf8'));
  const frozen = testDesign?.frozen ?? JSON.parse(readFileSync(new URL('frozen.v2.json', root), 'utf8'));
  verifyFrozenOpenData(frozen, preregistration);
  if (reverse) for (const rows of Object.values(frozen.splits)) rows.reverse();
  const codeVersion = experimentCodeVersion(root);
  const source = scoresPath ? readLiveScores(scoresPath, frozen, preregistration, ledgerPath ? { ledgerPath } : {}) : syntheticSource(frozen);
  const tolerance = preregistration.resourceBudget.maxTerminalFailureFraction;
  mkdirSync(output, { recursive: true });
  const perExample = [];
  const report = {
    schemaVersion: 'conformal-open-data-report/v2',
    issue: 2613,
    outcome: 'INSUFFICIENT EVIDENCE',
    outcomeCaps: [],
    status: 'experimental-default-off',
    scoreMode: source.mode,
    analysisCodeVersion: codeVersion,
    preregistrationHash: digest(preregistration),
    frozenSampleDigest: frozen.sampleDigest,
    splitHashes: frozen.splitHashes,
    liveSubsetHashes: frozen.liveSubsets.hashes,
    sourceFiles: frozen.sourceFiles,
    provenance: source.provenance,
    budget: {
      hardCeilingUsd: hardCeilingMicros(preregistration) / 1e6,
      reservationUsdPerCall: reservationMicros(preregistration) / 1e6,
      liveSubsetItems: liveSubsetRows(frozen).length,
      worstCaseLiveSubsetUsd: liveSubsetRows(frozen).length * reservationMicros(preregistration) / 1e6,
    },
    actuals: source.actuals(),
    compatibility: {},
    tasks: {},
    gaps: [
      ...(source.mode === 'synthetic' ? ['No live Jev scores were collected; synthetic-score stand-in evidence cannot yield GO.'] : []),
      'No approved D09 calibrated-risk artifact exists; the calibrated-risk baseline is fitted on the same calibration subset as the conformal threshold.',
      'No D14 provider-backed lineage/retention record exists for any provider-backed run reviewed here.',
      'No Noul or Score task is evaluated in v2; the operator-selected public replacements are Choice datasets.',
      'Banking77 test.csv is an exchangeable nominal held-out slice, not a distribution shift; the controlled shift is CLINC150 OOS only.',
      'Class-conditional coverage is unsupported for classes with n < 50 in this bounded sample.',
    ],
  };

  for (const taskId of Object.keys(frozen.tasks)) {
    if (!source.liveTask(taskId)) {
      report.tasks[taskId] = { live: false, status: 'no-live-subset', splits: {} };
      continue;
    }
    const calibrationRows = source.rowsFor(taskId, 'calibration');
    const calibrationScored = calibrationRows.map(row => source.scoreForRow(row));
    const calibrationUsable = calibrationScored.filter(row => row.status === 'success');
    const calibrationFailures = failureCounts(calibrationScored);
    const calibrationTolerance = withinTolerance(calibrationFailures, calibrationRows.length, tolerance);
    const compatibility = source.mode === 'live'
      ? expectedLiveCompatibility(frozen, preregistration, taskId)
      : compatibilityForTask(frozen, taskId, preregistration.alpha, codeVersion, { calibrationSplit: rowHash(calibrationRows) });
    const profile = calibrationUsable.length
      ? fitConformalProfile(calibrationUsable, frozen, taskId, preregistration.alpha, codeVersion, {
        probabilitiesForRow: row => row.probabilities,
        compatibility,
      })
      : null;
    const bins = riskBins(calibrationUsable);
    const profileId = source.mode === 'live' ? 'typesafe-distribution-v1' : 'synthetic-open-data/v2';
    report.compatibility[taskId] = compatibility;
    report.tasks[taskId] = {
      live: true,
      profile: profile ? { ...profile, calibrationRowsUsed: calibrationUsable.length } : null,
      calibrationFailures,
      calibratedBaseline: {
        source: source.mode === 'live'
          ? 'live calibration subset top-probability decile Wilson upper error; not an approved D09 calibration profile'
          : 'synthetic calibration split top-probability decile Wilson upper error; not an approved D09 calibration profile',
        bins,
      },
      splits: {},
    };
    for (const split of ['finalTest', 'shift']) {
      const splitRows = source.rowsFor(taskId, split);
      const allScored = splitRows.map(row => source.scoreForRow(row));
      const scoredRows = allScored.filter(row => row.status === 'success');
      const failures = failureCounts(allScored);
      const methods = {
        lac: row => (profile ? predictionSet(row.probabilities, profile.q) : []),
        raw: row => primitivePolicySet(row, bins, false, frozen, profileId),
        calibrated: row => primitivePolicySet(row, bins, true, frozen, profileId),
        alwaysReview: () => [],
        alwaysPredict: row => [row.topIndex],
      };
      const entry = { failures };
      for (const [method, fn] of Object.entries(methods)) {
        const rows = scoredRows.map(row => ({
          id: row.id,
          task: taskId,
          split,
          slice: row.slice,
          method,
          labelIndex: row.labelIndex,
          topIndex: row.topIndex,
          topProbability: row.topProbability,
          distributionHash: row.distributionHash,
          set: fn(row),
          nativeEvidenceHash: digest({ id: row.id, text: row.text, label: row.label, probabilities: row.probabilities }),
          latencyMs: row.latencyMs ?? 0,
        }));
        perExample.push(...rows);
        entry[method] = summarize(rows, frozen, taskId);
      }
      entry.gateDiagnostics = gateDiagnostics({
        lac: entry.lac.overall,
        calibrated: entry.calibrated.overall,
        split,
        scoredRows,
        task: frozen.tasks[taskId],
        preregistration,
        source,
        failures,
        subsetSize: splitRows.length,
        calibrationTolerance: calibrationTolerance && profile !== null,
      });
      report.tasks[taskId].splits[split] = entry;
    }
  }

  perExample.sort((a, b) => `${a.task}/${a.split}/${a.method}/${a.id}`.localeCompare(`${b.task}/${b.split}/${b.method}/${b.id}`));
  const decision = decideOutcome(report);
  report.outcome = decision.outcome;
  report.outcomeCaps = decision.caps;
  const nominalLac = perExample.filter(row => row.split === 'finalTest' && row.method === 'lac');
  const nominalCovered = nominalLac.filter(row => row.set.includes(row.labelIndex)).length;
  const upstream = buildIntegrityMetadata({
    mode: 'standard',
    freshWorkspaceRequired: true,
    freshWorkspaceVerified: false,
    changedArtifacts: [],
    sampleN: nominalLac.length,
    passedN: nominalCovered,
    overallScore: nominalLac.length ? 100 * nominalCovered / nominalLac.length : 0,
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
        : 'Pooled final-test LAC set coverage on the preregistered live subset; pending independent D09/D11/D14 review.',
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
      : 'latency values come from collector attempt durations in the live-score JSONL',
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
    ledgerPath: parsed.args.get('--ledger') ?? undefined,
    reverse: parsed.flags.has('--reverse'),
  });
  console.log(JSON.stringify(summary, null, 2));
}
