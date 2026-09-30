import { heldoutDigest, validateHeldoutAttempt, validateHeldoutInputs } from '../heldout/contract.js';
import type { HeldoutStudyModule, Digest, HeldoutRow, HeldoutAttempt } from '../heldout/types.js';
import { artifactPin } from '../validate.js';
import { aggregateEnsembleResults } from '../ensemble/aggregate.js';
import { validateChampionChallenger, pairedThresholdsDigest } from '../ensemble/contract.js';
import { buildEnsembleIntegrityReport } from '../ensemble/report.js';
import { championChallengerInputSetDigest, championChallengerShadowBaseline, runChampionChallengerShadow } from '../ensemble/runtime.js';
import type { ChampionChallengerObservation } from '../ensemble/runtime.js';
import type { DecisionChampionChallenger, DecisionEnsemblePolicy, EnsembleMemberResult } from '../ensemble/types.js';
import { qualificationIntegrityAllowlistProblems } from '../qualification/release.js';
import type { QualificationIntegrityMetadata } from '../qualification/release.js';
import { evaluateBinaryHeldout, freezeQualificationSplit } from '../qualification/quality.js';
import { D17_ANALYSIS } from './protocol.js';
import { d17Statistics, type D17ArmMeasurement, type D17Pair } from './statistics.js';
import type { prepareD17Study } from './corpus.js';
import { validateD17Artifact } from './artifacts.js';

type ScoreInput = Parameters<HeldoutStudyModule['score']>[0];
type Prepared = ReturnType<typeof prepareD17Study>;

function policy(prepared: Prepared, rowAttempts: readonly HeldoutAttempt[]): DecisionEnsemblePolicy | null {
  const first = rowAttempts.find(attempt => attempt.result?.receipt)?.result?.receipt;
  if (!first) return null;
  const definition = artifactPin(prepared.corpus.definitions[0]!);
  return { schemaVersion: 'decision-ensemble-policy/v1', id: 'd17-synthetic-repeated-sample', version: '1.0.0',
    mode: 'offline-shadow', riskTiers: ['synthetic-diagnostic'], definition, primitive: 'choice', options: ['no', 'yes'],
    compatibleUncertaintyProfiles: ['typesafe-distribution-v1'], requiredCapabilities: ['choice', 'probability-distribution'],
    members: [{ id: 'jev', memberType: 'repeated-sample', definition, binding: first.spec.binding,
      adapter: { id: 'jev', version: '1.0.0' }, model: { provider: 'jev', backend: 'api', requested: 'jev-1.13.0', pinnedVersion: 'jev-1.13.0' },
      primitive: 'choice', uncertaintyProfile: 'typesafe-distribution-v1', requiredCapabilities: ['choice', 'probability-distribution'],
      capabilities: ['choice', 'probability-distribution'], calibration: null, samples: 3, fallbackDepth: 0,
      estimate: { attemptsPerSample: 2, tokensPerAttempt: 4000, costMicrosPerAttempt: 400, deadlineMsPerAttempt: prepared.preregistration.requestTimeoutMs },
      approvalReference: null }], aggregation: { algorithm: 'mean-probability-v1', tieRule: D17_ANALYSIS.acceptance.tieRule },
    disagreement: { metric: D17_ANALYSIS.acceptance.disagreementMetric, thresholdBps: D17_ANALYSIS.acceptance.maximumDisagreementBps, onExceeded: 'defer' },
    acceptance: { minimumSuccessfulMembers: D17_ANALYSIS.acceptance.minimumSuccessfulMembers, onInsufficientMembers: 'defer',
      highAgreementWarningBps: D17_ANALYSIS.acceptance.highAgreementWarningBps }, calibration: { requirement: 'advisory' },
    ceilings: { members: 1, attempts: 6, deadlineMs: prepared.preregistration.requestTimeoutMs * 6, tokens: 24000, costMicros: 2400,
      concurrency: 1, fallbackDepth: 0, unknownCost: { rule: 'reject' } } };
}

/** Maps retained provider distributions only; confidence and agreement never become calibrated probability. */
export async function scoreD17Study(input: ScoreInput, prepared: Prepared) {
  validateHeldoutInputs(input.corpus, input.preregistration);
  if (heldoutDigest(input.corpus) !== heldoutDigest(prepared.corpus)
    || heldoutDigest(input.preregistration) !== heldoutDigest(prepared.preregistration)
    || heldoutDigest(input.gold) !== input.corpus.provenance.goldDigest
    || heldoutDigest(prepared.gold) !== input.corpus.provenance.goldDigest) throw new Error('D17 frozen scoring pins');
  const integrityProblems = qualificationIntegrityAllowlistProblems(input.integrity);
  if (integrityProblems.includes('integrity-invalid')) throw new Error('D17 invalid integrity');
  const rows = new Map(input.corpus.rows.map(row => [row.id, row]));
  const seen = new Set<string>();
  for (const attempt of input.attempts) {
    validateHeldoutAttempt(attempt);
    const row = rows.get(attempt.rowId), key = `${attempt.rowId}/${attempt.requestId}/${attempt.ordinal}`;
    if (!row || !row.requests.some(request => request.id === attempt.requestId) || seen.has(key)
      || attempt.corpusDigest !== input.preregistration.corpusDigest || attempt.study !== 'D17'
      || attempt.preregistrationDigest !== heldoutDigest(input.preregistration)) throw new Error('D17 attempt membership');
    seen.add(key);
  }
  const armAttempts = (row: HeldoutRow, candidate: boolean) => input.attempts.filter(attempt => attempt.rowId === row.id
    && (candidate ? attempt.requestId.startsWith('member_') : attempt.requestId === 'champion'));
  const member = (row: HeldoutRow, requestId: string): EnsembleMemberResult => {
    const attempts = input.attempts.filter(attempt => attempt.rowId === row.id && attempt.requestId === requestId).sort((a, b) => a.ordinal - b.ordinal);
    const terminal = attempts.at(-1)?.result;
    const decision = terminal?.receipt?.spec.evaluations.q0;
    const uncertainty = decision?.spec.uncertainty;
    const ok = terminal?.disposition === 'success' && terminal.servedModel === 'jev-1.13.0'
      && decision?.spec.status === 'success' && uncertainty?.source === 'provider'
      && uncertainty.profile === 'typesafe-distribution-v1' && uncertainty.distribution !== null;
    if (ok && (Object.keys(uncertainty.distribution!).sort().join(',') !== 'no,yes'
      || !['yes', 'no'].includes(String(decision.spec.value)))) throw new Error('D17 native distribution');
    return { memberId: 'jev', sampleIndex: requestId === 'champion' ? 0 : Number(requestId.slice(-1)) - 1,
      status: ok ? 'succeeded' : 'failed', resultDigest: heldoutDigest(attempts), value: ok ? decision.spec.value! : null,
      distribution: ok ? uncertainty.distribution : null, uncertaintyProfile: ok ? uncertainty.profile : null };
  };
  const measured = (probability: number, accepted: boolean, value: unknown, gold: string, attempts: readonly HeldoutAttempt[]): D17ArmMeasurement => ({
    probability, accepted, correct: accepted && value === gold, brier: (probability - Number(gold === 'yes')) ** 2,
    latencyMs: attempts.reduce((sum, attempt) => sum + (attempt.result?.latencyMs ?? 0), 0),
    tokens: attempts.some(attempt => !attempt.result || attempt.result.inputTokens === null || attempt.result.outputTokens === null) ? null
      : attempts.reduce((sum, attempt) => sum + attempt.result!.inputTokens! + attempt.result!.outputTokens!, 0),
    reservedCostMicros: attempts.reduce((sum, attempt) => sum + Math.max(attempt.reservedUsdMicros, attempt.result?.accountedUsdMicros ?? 0), 0),
  });
  const pairs: D17Pair[] = [], observations: Array<{ id: string; champion: ChampionChallengerObservation | null;
    challenger: ChampionChallengerObservation | null; aggregate: ReturnType<typeof aggregateEnsembleResults> | null }> = [];
  let championCorrect = 0, challengerCorrect = 0;
  const test = input.corpus.rows.filter(row => row.split === 'test');
  for (const row of test) {
    const single = member(row, 'champion'), members = [1, 2, 3].map(n => member(row, `member_${n}`));
    const candidateAttempts = armAttempts(row, true), championAttempts = armAttempts(row, false);
    const ensemblePolicy = policy(prepared, candidateAttempts);
    const aggregate = ensemblePolicy ? aggregateEnsembleResults(ensemblePolicy, members) : null;
    const gold = prepared.gold.labels[row.id]!;
    const champion = single.status === 'succeeded' ? measured(single.distribution!.yes!, single.distribution!.yes !== single.distribution!.no,
      single.value, gold, championAttempts) : null;
    const challenger = members.every(m => m.status === 'succeeded') && aggregate?.statistics.meanDistribution
      ? measured(aggregate.statistics.meanDistribution.yes!, aggregate.outcome.disposition === 'accept', aggregate.outcome.value, gold, candidateAttempts) : null;
    championCorrect += Number(champion?.correct ?? false); challengerCorrect += Number(challenger?.correct ?? false);
    if (champion && challenger) pairs.push({ id: row.id, slice: row.slice, champion, challenger });
    const observation = (arm: D17ArmMeasurement | null, attempts: readonly HeldoutAttempt[]): ChampionChallengerObservation | null => arm ? {
      inputDigest: heldoutDigest(row.input), receiptDigest: heldoutDigest(attempts), quality: Number(arm.correct), calibration: arm.brier,
      riskCoverage: Number(arm.accepted && !arm.correct), abstention: Number(!arm.accepted), latencyMs: arm.latencyMs,
      tokens: arm.tokens, costMicros: arm.reservedCostMicros, slice: Number(arm.correct),
    } : null;
    observations.push({ id: row.id, champion: observation(champion, championAttempts), challenger: observation(challenger, candidateAttempts), aggregate });
  }
  const statistics = d17Statistics(pairs, test.map(row => row.id));
  statistics.worstCaseFailureAsError.championCorrect = championCorrect;
  statistics.worstCaseFailureAsError.challengerCorrect = challengerCorrect;
  const splits = (['tuning', 'calibration', 'test'] as const).map(split =>
    freezeQualificationSplit(split, input.corpus.rows.filter(row => row.split === split).map(row => row.id)));
  const binary = (role: 'champion' | 'challenger') => pairs.length === test.length ? evaluateBinaryHeldout(splits, pairs.map(pair => {
    const attempts = armAttempts(rows.get(pair.id)!, role === 'challenger');
    const known = (key: 'inputTokens' | 'outputTokens' | 'providerCostUsd') => attempts.some(a => !a.result || a.result[key] === null)
      ? null : attempts.reduce((sum, a) => sum + a.result![key]!, 0);
    return { id: pair.id, slice: pair.slice, label: Number(prepared.gold.labels[pair.id] === 'yes') as 0 | 1,
      probability: pair[role].probability, accepted: pair[role].accepted, latencyMs: pair[role].latencyMs,
      inputTokens: known('inputTokens'), outputTokens: known('outputTokens'), costUsd: known('providerCostUsd'),
      calls: attempts.length, retries: attempts.filter(a => a.ordinal > 1).length, fallbacks: 0 };
  })) : null;
  const reservation = (attempts: readonly HeldoutAttempt[]) => attempts.reduce((sum, attempt) =>
    sum + Math.max(attempt.reservedUsdMicros, attempt.result?.accountedUsdMicros ?? 0), 0);
  const definitionPin = artifactPin(input.corpus.definitions[0]!);
  const successful = input.attempts.filter(attempt => attempt.result?.disposition === 'success');
  const bindingPin = successful[0]?.result?.receipt?.spec.binding ?? null;
  if (successful.some(attempt => !attempt.result?.receipt
    || heldoutDigest(attempt.result.receipt.spec.binding) !== heldoutDigest(bindingPin)
    || Object.values(attempt.result.receipt.spec.evaluations).some(result => heldoutDigest(result.spec.decision) !== heldoutDigest(definitionPin)))) {
    throw new Error('D17 mixed execution pins');
  }
  const testIds = new Set(test.map(row => row.id));
  const testAttempts = input.attempts.filter(attempt => testIds.has(attempt.rowId));
  const championReservations = reservation(testAttempts.filter(attempt => attempt.requestId === 'champion'));
  const challengerReservations = reservation(testAttempts.filter(attempt => attempt.requestId !== 'champion'));
  const report = { schemaVersion: 'decision-d17-study-report/v1', scope: 'synthetic-diagnostic-only',
    corpusDigest: heldoutDigest(input.corpus), preregistrationDigest: heldoutDigest(input.preregistration),
    executionPins: { definition: definitionPin, binding: bindingPin, model: 'jev-1.13.0', adapter: { id: 'jev', version: '1.0.0' },
      aggregatePolicyDigest: observations.find(row => row.aggregate)?.aggregate?.policy.digest ?? null },
    integrityDigest: heldoutDigest(input.integrity), integrity: structuredClone(input.integrity), integrityProblems,
    statistics, statisticsDigest: heldoutDigest(statistics), pairs, observations,
    accounting: { allSplits: { attempts: input.attempts.length, reservedCostMicros: reservation(input.attempts) },
      test: { championReservedCostMicros: championReservations, challengerReservedCostMicros: challengerReservations,
        netSavingsMicros: championReservations - challengerReservations, complete: pairs.length === test.length } },
    calibrationDiagnostics: { champion: binary('champion'), challenger: binary('challenger'), calibrated: false },
    pending: ['D09 compatible member and aggregate calibration', 'blind gold audit and delayed repeats', 'separate extra-cost tradeoff approval',
      'protected native report approval and eligibility'],
    decision: input.integrity.release_gate.decision === 'ROLLBACK' || input.integrity.compromise_labels.length ? 'ROLLBACK' : 'HOLD' };
  validateD17Artifact('report', report);
  return report;
}

/** Native serialization requires a separately anchored record. It cannot create approval or eligibility. */
export async function buildD17NativeReport(input: { report: Awaited<ReturnType<typeof scoreD17Study>>; prepared: Prepared;
  record: DecisionChampionChallenger; integrity: QualificationIntegrityMetadata; trustedIntegrityDigest: Digest; trustedReportDigest: Digest }) {
  validateD17Artifact('report', input.report);
  const { record } = validateChampionChallenger(input.record);
  const problems = qualificationIntegrityAllowlistProblems(input.integrity);
  if (problems.includes('integrity-invalid') || heldoutDigest(input.integrity) !== input.trustedIntegrityDigest
    || record.evaluationIntegrityReport.digest !== input.trustedIntegrityDigest) throw new Error('D17 native integrity pin');
  if (heldoutDigest(input.report) !== input.trustedReportDigest || input.report.integrityDigest !== heldoutDigest(input.report.integrity)
    || input.report.corpusDigest !== heldoutDigest(input.prepared.corpus)
    || input.report.preregistrationDigest !== heldoutDigest(input.prepared.preregistration)
    || input.report.statisticsDigest !== heldoutDigest(input.report.statistics)
    || record.preregistration.thresholdsDigest !== pairedThresholdsDigest([...D17_ANALYSIS.native])
    || input.integrity.release_gate.decision === 'PROMOTE'
    || input.report.decision === 'ROLLBACK' && input.integrity.release_gate.decision !== 'ROLLBACK') throw new Error('D17 native report needs anchored HOLD or ROLLBACK');
  const pins = input.report.executionPins;
  if (!pins.binding || !pins.aggregatePolicyDigest || record.champion.ensemblePolicy !== null
    || record.challenger.ensemblePolicy?.digest !== pins.aggregatePolicyDigest
    || [record.champion, record.challenger].some(role => role.actualModel !== pins.model
      || heldoutDigest(role.binding) !== heldoutDigest(pins.binding) || heldoutDigest(role.adapter) !== heldoutDigest(pins.adapter))) {
    throw new Error('D17 native execution pins');
  }
  const items = input.prepared.corpus.rows.filter(row => row.split === 'test').map(row => ({ id: row.id, input: row.input, slice: row.slice }));
  if (record.inputSet.digest !== championChallengerInputSetDigest(items)) throw new Error('D17 native membership');
  const shadow = await runChampionChallengerShadow(record, { enabled: true, invocationId: 'd17-recorded-replay', items,
    evaluate: async ({ role, item }) => {
      const observation = input.report.observations.find(row => row.id === item.id)?.[role];
      if (!observation || observation.tokens === null) throw new Error('D17 incomplete native endpoints');
      return observation;
    } });
  const baseline = championChallengerShadowBaseline(record, shadow);
  const upstream = input.integrity.paired_baseline as Record<string, unknown> | null;
  if (!upstream || heldoutDigest(upstream.championChallengerShadow ?? null) !== heldoutDigest(baseline)
    || upstream.d17StatisticsDigest !== input.report.statisticsDigest) throw new Error('D17 unbound native statistics');
  return buildEnsembleIntegrityReport({ record, integrity: input.integrity, pairedDeltas: shadow.pairedDeltas, eligibility: null });
}
