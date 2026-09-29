import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  buildEnsembleIntegrityReport,
  championChallengerInputSetDigest,
  ensembleContractDigest,
  aggregateEnsembleResults,
  BoundedDecisionMetrics,
  executeDecisionEnsemble,
  executeDriftResponse,
  pinChampionForRun,
  preregisterChampionChallengerThresholds,
  promoteChampionChallenger,
  rollbackChampionForNewRuns,
  runChampionChallengerShadow,
  validateEnsemblePolicy,
  evaluateDecisionRuleset,
  type AliasEvent,
  type ChampionChallengerObservation,
  type DecisionAdapter,
  type DecisionBinding,
  type DecisionChampionChallenger,
  type DecisionDefinition,
  type DecisionDriftResponse,
  type DecisionEnsemblePolicy,
  type DecisionResult,
  type DriftSignal,
  type EnsembleMember,
  type EnsembleMemberResult,
  type IntegrityGateDecision,
  type PromotionEligibility,
  type QualificationIntegrityMetadata,
} from '../../../src/decision/index.js';
import { readFixture, records } from './ensemble-fixtures.js';

const fixture = <T>(name: string): T => JSON.parse(readFileSync(`agentic/code/addons/decision-engine/examples/${name}`, 'utf8')) as T;
const hash = (character: string) => `sha256:${character.repeat(64)}` as const;
const policies = records<DecisionEnsemblePolicy>('ensemble-policy.v1.valid.json');
const ccBase = records<DecisionChampionChallenger>('champion-challenger.v1.valid.json').get('triage-champion-challenger-2026-09')!;
const driftPolicy = records<DecisionDriftResponse>('drift-response.v1.valid.json').get('triage-drift-response')!;

function decisionResult(member: EnsembleMember, sampleIndex: number, status: DecisionResult['spec']['status'] = 'success'): DecisionResult {
  const success = status === 'success';
  return {
    apiVersion: 'decision.aiwg.io/v1alpha1',
    kind: 'DecisionResult',
    metadata: { id: `${member.id}-${sampleIndex}`, version: '1.0.0', description: member.id },
    spec: {
      decision: member.definition,
      ruleset: member.definition,
      binding: member.binding,
      alias: member.id,
      runId: 'ensemble-run',
      invocationId: `${member.id}:${sampleIndex}`,
      status,
      ...(success ? { value: member.id === 'jev-c' ? 'deny' : 'approve' } : {}),
      reason: success ? 'none' : status === 'abstained' ? 'insufficient-information' : 'service-error',
      uncertainty: success ? {
        source: 'provider',
        profile: member.uncertaintyProfile,
        calibration: 'vendor-claimed',
        confidence: 0.9,
        distribution: { approve: 0.7, deny: 0.2, escalate: 0.1 },
        calibrationRef: null,
      } : null,
      attempts: [{ ordinal: 1, adapter: member.adapter.id, adapterVersion: member.adapter.version,
        requestedModel: member.model.requested, actualModel: member.model.pinnedVersion, subagent: null,
        status, reason: success ? 'none' : 'service-error', durationMs: 5,
        usage: { inputTokens: 3, outputTokens: 2, costUsd: 0.001 }, requestId: `${member.id}-${sampleIndex}` }],
    },
  };
}

function definitions(): Record<string, DecisionDefinition> {
  return {
    category: fixture('decision-category.json'),
    severity: fixture('decision-severity.json'),
    core: fixture('decision-core_unavailable.json'),
  };
}

class FixtureAdapter implements DecisionAdapter {
  readonly id = 'jev' as const;
  readonly version = '1.0.0';
  async capabilities() {
    return { answerKinds: ['choice', 'ordinal-score', 'truth-probability'] as const,
      features: ['choice', 'ordinal-score', 'truth-probability'], maxOptions: 255, maxLevels: 10,
      confidenceProfiles: ['typesafe-distribution-v1', 'typesafe-truth-v1'], executable: true, egress: { mode: 'none' as const } };
  }
  async evaluate(request: Parameters<DecisionAdapter['evaluate']>[0]) {
    const value = request.alias === 'severity' ? 0.25 : request.alias === 'core_unavailable' ? 0.05 : 'documentation';
    return { status: 'success' as const, reason: 'none' as const, value,
      uncertainty: { source: 'provider' as const, profile: request.alias === 'core_unavailable' ? 'typesafe-truth-v1' : 'typesafe-distribution-v1',
        calibration: 'vendor-claimed' as const, confidence: 0.9, distribution: null, calibrationRef: null },
      actualModel: 'fixture-model', usage: { inputTokens: 1, outputTokens: 1, costUsd: null }, requestId: 'fixture-request' };
  }
}

function tinyChampionChallenger() {
  const items = [{ id: 'a', input: { text: 'alpha' }, slice: 'all' }, { id: 'b', input: { text: 'beta' }, slice: 'all' }];
  const record = structuredClone(ccBase);
  record.inputSet = { ...record.inputSet, itemCount: items.length, digest: championChallengerInputSetDigest(items) };
  record.pairedMetrics = record.pairedMetrics.map(metric => ({ ...metric, minimumPairs: metric.metric === 'slice' ? 1 : 2 }));
  return { record: preregisterChampionChallengerThresholds(record), items };
}

function eligibility(record: DecisionChampionChallenger): PromotionEligibility {
  return {
    id: record.eligibilityId,
    alias: record.alias,
    candidateIdentityDigest: record.challenger.identityDigest,
    candidateActualModel: record.challenger.actualModel,
    evaluationIntegrityReport: record.evaluationIntegrityReport,
    approvalReference: record.approval.reference,
    rollbackTarget: record.rollbackTarget,
    eligible: true,
    reasons: [],
    recordedAt: '2026-09-05T00:00:00.000Z',
  };
}

function integrity(decision: IntegrityGateDecision): QualificationIntegrityMetadata {
  return {
    sample_n: 2,
    uncertainty: { method: 'paired-bootstrap', level: 0.95 },
    paired_baseline: { id: 'champion-shadow' },
    integrity_mode: 'isolated',
    fresh_workspace_required: true,
    fresh_workspace_verified: true,
    integrity_state: 'verified',
    trusted_score_source: 'signed-runner',
    compromise_labels: [],
    weak_signal_reason: null,
    release_gate: { decision, reasons: [] },
  };
}

describe('D17 ensemble runtime (#2611)', () => {
  it('is default-off and leaves existing decision evaluation byte-identical when unused', async () => {
    const binding = fixture<DecisionBinding>('binding-jev.json');
    const request = { ruleset: fixture('ruleset.json'), binding, definitions: definitions(), input: fixture('input.json'),
      runId: 'run', invocationId: 'baseline', adapters: { jev: new FixtureAdapter() } };
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const before = await evaluateDecisionRuleset(request);
      vi.setSystemTime(1_000);
      const disabled = await executeDecisionEnsemble(policies.get('triage-choice-ensemble')!, {
        invocationId: 'disabled',
        dispatch: async () => { throw new Error('dispatch should not run while disabled'); },
      });
      vi.setSystemTime(1_000);
      const after = await evaluateDecisionRuleset(request);
      expect(disabled).toMatchObject({ status: 'disabled', aggregate: null, memberResults: [] });
      expect(after).toEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ENS-RUN-01 enforces authorization, budget preflight, concurrency and retained member evidence', async () => {
    const policy = policies.get('triage-choice-ensemble')!;
    const spans: unknown[] = [];
    let active = 0;
    let maximum = 0;
    const calls: string[] = [];
    vi.useFakeTimers();
    try {
      const running = executeDecisionEnsemble(policy, {
        enabled: true,
        invocationId: 'ens-run',
        hostCeilings: [{ concurrency: 2 }],
        authorizeMember: member => {
          calls.push(`auth:${member.id}`);
          return true;
        },
        dispatch: async request => {
          calls.push(`dispatch:${request.member.id}`);
          active += 1;
          maximum = Math.max(maximum, active);
          await new Promise(resolve => setTimeout(resolve, request.member.id === 'jev-a' ? 20 : 5));
          active -= 1;
          return decisionResult(request.member, request.sampleIndex);
        },
        telemetry: { hook: { emit: span => { spans.push(span); } } },
      });
      await vi.advanceTimersByTimeAsync(25);
      const result = await running;
      expect(maximum).toBe(2);
      expect(calls.slice(0, 3)).toEqual(['auth:jev-a', 'auth:jev-c', 'auth:llm-b']);
      expect(result.aggregate?.outcome).toMatchObject({ disposition: 'accept', value: 'approve' });
      expect(Object.keys(result.retainedResults).sort()).toEqual(result.memberResults.map(item => item.resultDigest).sort());
      expect(spans).toHaveLength(1);
      expect(JSON.stringify(spans)).not.toContain('alpha');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ENS-RUN-02 refuses disallowed members and budget/unknown-cost violations before dispatch', async () => {
    const policy = policies.get('triage-choice-ensemble')!;
    let dispatched = false;
    await expect(executeDecisionEnsemble(policy, {
      enabled: true,
      invocationId: 'denied',
      authorizeMember: member => member.id !== 'llm-b',
      dispatch: async request => { dispatched = true; return decisionResult(request.member, request.sampleIndex); },
    })).rejects.toThrow(/authorization/);
    expect(dispatched).toBe(false);
    expect(() => validateEnsemblePolicy(policy, { hostCeilings: [{ attempts: 2 }] })).toThrow(/attempts demand/);
    const unknownCost = structuredClone(policy);
    unknownCost.members[0]!.estimate.costMicrosPerAttempt = null;
    expect(() => validateEnsemblePolicy(unknownCost)).toThrow(/unknown cost/);
  });

  it('DRF-RUN-01 runs paired shadow on identical immutable inputs and reports required deltas', async () => {
    const { record, items } = tinyChampionChallenger();
    const seen: string[] = [];
    const result = await runChampionChallengerShadow(record, {
      enabled: true,
      invocationId: 'shadow',
      items,
      eligibility: eligibility(record),
      aliasHistory: [{ revision: 1, alias: record.alias, actualIdentityDigest: record.champion.identityDigest,
        actualModel: record.champion.actualModel, recordedAt: '2026-09-01T00:00:00.000Z', kind: 'observed', promotionEligibilityId: null }],
      evaluate: async ({ role, item }): Promise<ChampionChallengerObservation> => {
        seen.push(`${item.id}:${role}:${ensembleContractDigest(item.input)}`);
        const challenger = role === 'challenger';
        return { inputDigest: ensembleContractDigest(item.input), receiptDigest: hash(challenger ? 'c' : 'a'),
          quality: challenger ? 0.91 : 0.9, calibration: challenger ? 0.051 : 0.05, riskCoverage: challenger ? 0.8 : 0.78,
          abstention: challenger ? 0.1 : 0.11, latencyMs: challenger ? 120 : 100, tokens: challenger ? 50 : 45,
          costMicros: challenger ? 20 : 15, slice: challenger ? 0.92 : 0.9 };
      },
    });
    expect(result.status).toBe('completed');
    expect(result.pairedDeltas.map(item => item.metric).sort()).toEqual(
      ['abstention', 'calibration', 'cost', 'latency', 'quality', 'risk-coverage', 'slice', 'tokens']);
    expect(result.pairedDeltas.find(item => item.metric === 'quality')).toEqual({ metric: 'quality', delta: 0.01, pairs: 2 });
    expect(seen[0]!.split(':').at(-1)).toBe(seen[1]!.split(':').at(-1));
  });

  it('DRF-RUN-02 gates promotion on D09 plus eval-integrity and rolls back only new run pins', () => {
    const { record } = tinyChampionChallenger();
    const active = pinChampionForRun(record, 'active-run');
    const history: AliasEvent[] = [{ revision: 1, alias: record.alias, actualIdentityDigest: record.champion.identityDigest,
      actualModel: record.champion.actualModel, recordedAt: '2026-09-01T00:00:00.000Z', kind: 'observed', promotionEligibilityId: null }];
    const gateway = {
      aliasHistory: () => history,
      promoteAlias: (eligibilityId: string, at: string) => {
        const event: AliasEvent = { revision: history.length + 1, alias: record.alias, actualIdentityDigest: record.challenger.identityDigest,
          actualModel: record.challenger.actualModel, recordedAt: at, kind: 'promoted', promotionEligibilityId: eligibilityId };
        history.push(event);
        return event;
      },
      rollbackAlias: (alias: string, targetRevision: number, approvalReference: string, at: string) => {
        const target = history.find(item => item.revision === targetRevision)!;
        const event: AliasEvent = { ...target, revision: history.length + 1, alias, recordedAt: at,
          kind: 'rolled-back', promotionEligibilityId: `rollback-approval:${approvalReference}` };
        history.push(event);
        return event;
      },
    };
    const deltas = record.pairedMetrics.map(metric => ({ metric: metric.metric, delta: metric.metric === 'quality' || metric.metric === 'slice' ? 0 : 0,
      pairs: metric.minimumPairs }));
    const report = buildEnsembleIntegrityReport({ record, integrity: integrity('PROMOTE'), pairedDeltas: deltas, eligibility: eligibility(record) });
    expect(promoteChampionChallenger({ record, integrityReport: report, eligibility: eligibility(record), gateway, at: '2026-09-06T00:00:00.000Z' }))
      .toMatchObject({ kind: 'promoted', actualIdentityDigest: record.challenger.identityDigest });
    const held = { ...report, decision: 'HOLD' as const };
    expect(() => promoteChampionChallenger({ record, integrityReport: held, eligibility: eligibility(record), gateway, at: '2026-09-06T00:00:00.000Z' }))
      .toThrow(/promotion requires/);
    expect(rollbackChampionForNewRuns({ record, gateway, approvalReference: 'incident-1', at: '2026-09-07T00:00:00.000Z' }))
      .toMatchObject({ kind: 'rolled-back', actualIdentityDigest: record.champion.identityDigest });
    expect(active).toEqual({ runId: 'active-run', alias: record.alias, aliasRevision: 1,
      identityDigest: record.champion.identityDigest, actualModel: record.champion.actualModel });
    expect(history.map(item => item.kind)).toEqual(['observed', 'promoted', 'rolled-back']);
  });

  it('DRF-RUN-03 executes the exact configured drift response and rejects stale threshold versions', async () => {
    const signal: DriftSignal = { source: 'output-distribution', id: 'dist-1', alias: driftPolicy.alias,
      metric: 'population-stability-index-v1', valueBps: 3000, sampleN: 300, thresholdsVersion: driftPolicy.thresholds.version,
      observedAt: '2026-09-10T00:00:00.000Z' };
    const executed: string[] = [];
    const metrics = new BoundedDecisionMetrics();
    const { decision } = await executeDriftResponse(driftPolicy, signal, {
      'reduce-coverage': item => { executed.push(`${item.signalId}:${item.response}`); },
    }, { metrics });
    expect(decision).toMatchObject({ state: 'breached', response: 'reduce-coverage', evidence: 'unlabeled-distribution-warning' });
    expect(executed).toEqual(['dist-1:reduce-coverage']);
    expect(metrics.snapshot()).toEqual(expect.arrayContaining([{ name: 'decision.drift', value: 3000, dimensions: {} }]));
    await expect(executeDriftResponse(driftPolicy, { ...signal, thresholdsVersion: 'old' })).rejects.toThrow(/different threshold/);
  });

  it('ENS-RUN-03 keeps agreement as a stability signal, not a calibration gate', async () => {
    const { cases } = readFixture<{ cases: Array<{ id: string; policy: string; results: EnsembleMemberResult[] }> }>('aggregation-vectors.v1.json');
    const shared = cases.find(item => item.id === 'ENS-SHARED-01')!;
    const aggregate = aggregateEnsembleResults(policies.get(shared.policy)!, shared.results);
    expect(aggregate.warnings).toEqual(expect.arrayContaining(['high-agreement-not-correctness', 'shared-systematic-error-risk']));
    expect(aggregate.correctnessGate.status).toBe('not-satisfied');
  });
});
