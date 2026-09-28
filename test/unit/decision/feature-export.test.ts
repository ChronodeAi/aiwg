import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DECISION_API_VERSION,
  DECISION_API_VERSION_STRUCTURED,
  DECISION_LIFECYCLE_SURFACES,
  DECISION_LIFECYCLE_VERSION,
  DecisionFeatureExportError,
  DecisionFeatureExportService,
  MemoryDecisionFeatureExportStore,
  artifactPin,
  buildDecisionFeatureEvalIntegrity,
  createDecisionFeatureObservation,
  decisionFeatureTrainServeContract,
  deterministicFeatureSplit,
  eraseDecisionSubject,
  generateDecisionFeatureSet,
  loadDecisionFeatureCsv,
  placeDecisionLifecycleHold,
  restoreDecisionSubjectBackup,
  semanticFeatureContentDigest,
  serializeDecisionFeatureCsv,
  serializeDecisionFeatureJsonl,
  validateDecisionFeatureExportAuthorization,
  validateDecisionFeatureTrainServe,
  type DecisionBinding,
  type DecisionDefinition,
  type DecisionFeatureExportPolicy,
  type DecisionFeatureSourceLifecycleStore,
  type DecisionLifecycleBackupEntry,
  type DecisionLifecycleHold,
  type DecisionLifecyclePolicy,
  type DecisionLifecycleReference,
  type DecisionLifecycleReferenceState,
  type DecisionLifecycleTombstone,
  type DecisionResult,
  type DecisionRuleset,
  type RulesetResult,
} from '../../../src/decision/index.js';

function definition(alias: string, kind: 'choice' | 'ordinal-score' | 'truth-probability'): DecisionDefinition {
  const answer = kind === 'choice'
    ? { kind, options: [{ id: 'yes', description: 'yes' }, { id: 'no', description: 'no' }, { id: 'none', description: 'none' }] }
    : kind === 'ordinal-score' ? { kind, levels: ['low', 'medium', 'high'] }
      : { kind, trueDescription: 'true', falseDescription: 'false' };
  return {
    apiVersion: DECISION_API_VERSION_STRUCTURED,
    kind: 'DecisionDefinition',
    metadata: { id: `decision-${alias}`, version: '1.0.0', description: alias },
    spec: { purpose: alias, inputSchema: { type: 'object' }, question: `question-${alias}`, answer, requiredCapabilities: [] },
  } as DecisionDefinition;
}

const definitions = {
  category: definition('category', 'choice'),
  severity: definition('severity', 'ordinal-score'),
  risk: definition('risk', 'truth-probability'),
};

function ruleset(): DecisionRuleset {
  return {
    apiVersion: DECISION_API_VERSION_STRUCTURED,
    kind: 'DecisionRuleset',
    metadata: { id: 'triage-ruleset', version: '1.0.0', description: 'triage' },
    spec: {
      purpose: 'triage',
      inputSchema: { type: 'object' },
      evaluations: [
        { alias: 'category', decision: artifactPin(definitions.category), inputPointer: '' },
        { alias: 'severity', decision: artifactPin(definitions.severity), inputPointer: '' },
        { alias: 'risk', decision: artifactPin(definitions.risk), inputPointer: '' },
      ],
      rules: [{
        id: 'manual-review',
        priority: 1,
        when: { op: 'eq', left: { source: 'input', pointer: '/never' }, right: true },
        outcome: { route: 'review' },
      }],
      composition: 'collect',
      conflict: 'review',
      defaultOutcome: { route: 'review' },
      failureOutcome: { route: 'review' },
      outputSchema: { type: 'object' },
    },
  };
}

function binding(sourceRuleset = ruleset()): DecisionBinding {
  return {
    apiVersion: DECISION_API_VERSION_STRUCTURED,
    kind: 'DecisionBinding',
    metadata: { id: 'triage-binding', version: '1.0.0', description: 'binding' },
    spec: {
      ruleset: artifactPin(sourceRuleset),
      totalTimeoutMs: 1000,
      maxAttempts: 1,
      concurrency: 1,
      evaluations: Object.fromEntries(sourceRuleset.spec.evaluations.map(entry => [entry.alias, { targets: [{
        adapter: 'jev',
        adapterVersion: '2026-09-24',
        model: 'jev-fixture',
        credentialRef: 'typesafe-api',
        requiredCapabilities: [],
        acceptance: { mode: 'typed-value' },
        timeoutMs: 1000,
        retry: { maxRetries: 0, initialDelayMs: 1, maxDelayMs: 1 },
      }], fallbackOn: [] }])),
    },
  };
}

function policy(): DecisionFeatureExportPolicy {
  return {
    tenantId: 'tenant',
    projectId: 'project',
    actorId: 'actor',
    recipient: 'offline-lab',
    purpose: 'feature-export-smoke',
    datasetPolicyId: 'dataset-policy-v1',
    accessScope: 'feature-exporter',
    operations: ['create', 'list', 'read', 'export', 'delete', 'share'],
    allowExternalDelivery: true,
    allowRawState: false,
    allowOutcomeLabels: false,
    reidentificationCanary: 'CANARY_NEVER_IN_FEATURES',
  };
}

function lifecyclePolicy(): DecisionLifecyclePolicy {
  const rule = { classification: 'restricted' as const, accessScopes: ['feature-exporter'], retentionMs: 86_400_000,
    export: 'sanitized' as const, deletion: 'tombstone' as const, backup: 'expire-with-primary' as const };
  return { version: DECISION_LIFECYCLE_VERSION,
    surfaces: Object.fromEntries(DECISION_LIFECYCLE_SURFACES.map(surface => [surface, { ...rule }])) as DecisionLifecyclePolicy['surfaces'] };
}

function featureSet() {
  const sourceRuleset = ruleset();
  return generateDecisionFeatureSet({
    id: 'triage-features',
    version: '1.0.0',
    description: 'triage feature set',
    ruleset: sourceRuleset,
    binding: binding(sourceRuleset),
    definitions,
    compatibleServedModels: { category: ['jev-fixture-v1'], severity: ['jev-fixture-v1'], risk: ['jev-fixture-v1'] },
    calibration: { risk: { calibrationRef: 'calibration:risk@sha256:1234', maxAgeMs: 1000, recordedAtEpochMs: 100 } },
    privacy: {
      classification: 'restricted',
      retentionMs: 86_400_000,
      accessScope: 'feature-exporter',
      exportPolicyId: 'dataset-policy-v1',
      deletion: 'tombstone',
      lifecycleSurface: 'export',
    },
  });
}

function decision(alias: keyof typeof definitions, value: string | number,
  distribution: Record<string, number> | null, source: 'provider' | 'model-self-report' = 'provider'): DecisionResult {
  const sourceRuleset = ruleset();
  const sourceBinding = binding(sourceRuleset);
  return {
    apiVersion: DECISION_API_VERSION_STRUCTURED,
    kind: 'DecisionResult',
    metadata: { id: `result-${alias}`, version: '1.0.0', description: alias },
    spec: {
      decision: artifactPin(definitions[alias]),
      ruleset: artifactPin(sourceRuleset),
      binding: artifactPin(sourceBinding),
      alias,
      runId: 'run-1',
      invocationId: 'invocation-1',
      status: 'success',
      value,
      reason: 'none',
      uncertainty: {
        source,
        profile: source === 'provider' ? 'typesafe-distribution-v1' : 'llm-self-report-v1',
        calibration: 'measured',
        confidence: source === 'model-self-report' ? 0.61 : 0.9,
        distribution,
        calibrationRef: alias === 'risk' ? 'calibration:risk@sha256:1234' : null,
        ...(alias === 'risk' ? { calibratedRisk: { value: 0.08, calibrationRef: 'calibration:risk@sha256:1234' } } : {}),
      },
      attempts: [{
        ordinal: 1,
        adapter: 'jev',
        adapterVersion: '2026-09-24',
        requestedModel: 'jev-fixture',
        actualModel: 'jev-fixture-v1',
        subagent: null,
        status: 'success',
        reason: 'none',
        durationMs: 5,
        usage: { inputTokens: null, outputTokens: null, costUsd: null },
        requestId: null,
      }],
    },
  };
}



function mutateCsvCell(payload: string, column: string, value: string): string {
  const rows = payload.trimEnd().split('\n');
  const header = rows[0]!.split(',');
  const index = header.indexOf(column);
  if (index < 0) throw new Error(`missing CSV column ${column}`);
  const cells = parseSimpleCsvRow(rows[1]!);
  cells[index] = value;
  rows[1] = cells.map(cell => /[",\n\r]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell).join(',');
  return `${rows.join('\n')}\n`;
}

function parseSimpleCsvRow(row: string): string[] {
  const cells: string[] = [];
  let cell = ''; let quoted = false;
  for (let index = 0; index < row.length; index++) {
    const char = row[index]!;
    if (quoted) {
      if (char === '"' && row[index + 1] === '"') { cell += '"'; index++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { cells.push(cell); cell = ''; }
    else cell += char;
  }
  cells.push(cell);
  return cells;
}

function qualificationIntegrity(decision: 'PROMOTE' | 'HOLD' | 'ROLLBACK' = 'HOLD') {
  return {
    sample_n: 12,
    uncertainty: { method: 'heldout' },
    paired_baseline: null,
    integrity_mode: 'offline-deterministic',
    fresh_workspace_required: true,
    fresh_workspace_verified: true,
    integrity_state: decision === 'PROMOTE' ? 'clean' : 'hold',
    trusted_score_source: 'fixture-heldout',
    compromise_labels: [],
    weak_signal_reason: decision === 'PROMOTE' ? null : 'fixture hold',
    release_gate: { decision, reasons: decision === 'PROMOTE' ? [] : ['fixture hold'] },
  } as const;
}


function qualificationRelease(decision: 'PROMOTE' | 'HOLD' | 'ROLLBACK' = 'HOLD') {
  const fields = {
    schemaVersion: 'decision-qualification-release/v1' as const,
    runId: `feature-export-${decision.toLowerCase()}`,
    sourceCommit: '0123456789abcdef0123456789abcdef01234567',
    dirty: false,
    environment: 'unit',
    commands: ['vitest feature-export'],
    pins: {},
    budgets: {},
    actuals: {},
    reviewer: null,
    suites: [],
    gates: [],
    integrity: qualificationIntegrity(decision),
    benchmark: null,
    metrics: null,
    integritySnapshot: null,
    cacheLayers: null,
    decision,
  };
  return { ...fields, digest: `sha256:${createHash('sha256').update(JSON.stringify(fields)).digest('hex')}` as const };
}

class LifecycleFixtureStore implements DecisionFeatureSourceLifecycleStore {
  readonly registered: Array<{ subject: string; reference: DecisionLifecycleReference }> = [];
  readonly tombstones: DecisionLifecycleTombstone[] = [];
  private readonly activeHolds: DecisionLifecycleHold[] = [];

  async register(subject: string, reference: { surface: 'export'; opaqueId: string }): Promise<void> {
    this.registered.push({ subject, reference });
  }

  async erase(reference: DecisionLifecycleReference): Promise<void> {
    const linked = this.registered.find(item => item.reference.surface === reference.surface && item.reference.opaqueId === reference.opaqueId);
    if (linked) this.registered.splice(this.registered.indexOf(linked), 1);
  }

  async tombstone(value: DecisionLifecycleTombstone): Promise<void> {
    this.tombstones.push(structuredClone(value));
  }

  async links(subject: string): Promise<DecisionLifecycleReference[]> {
    return this.registered.filter(item => item.subject === subject).map(item => structuredClone(item.reference));
  }

  async holds(subject: string): Promise<DecisionLifecycleHold[]> {
    return this.activeHolds.filter(hold => hold.subject === subject).map(hold => structuredClone(hold));
  }

  async recordHold(hold: DecisionLifecycleHold): Promise<void> {
    this.activeHolds.push(structuredClone(hold));
  }

  async releaseHold(hold: DecisionLifecycleHold): Promise<void> {
    const found = this.activeHolds.find(item => item.subject === hold.subject && item.reason === hold.reason);
    if (found) this.activeHolds.splice(this.activeHolds.indexOf(found), 1);
  }

  async resolveReference(reference: DecisionLifecycleReference): Promise<DecisionLifecycleReferenceState> {
    const tombstone = this.tombstones.find(item => item.reference.surface === reference.surface && item.reference.opaqueId === reference.opaqueId);
    if (tombstone) return { state: 'tombstoned', reference: structuredClone(reference), deletedAt: tombstone.deletedAt };
    if (this.registered.some(item => item.reference.surface === reference.surface && item.reference.opaqueId === reference.opaqueId)) {
      return { state: 'linked', reference: structuredClone(reference) };
    }
    return { state: 'unknown', reference: structuredClone(reference) };
  }
}

function result(): RulesetResult {
  const sourceRuleset = ruleset();
  const sourceBinding = binding(sourceRuleset);
  return {
    apiVersion: DECISION_API_VERSION_STRUCTURED,
    kind: 'RulesetResult',
    metadata: { id: 'ruleset-result', version: '1.0.0', description: 'result' },
    spec: {
      ruleset: artifactPin(sourceRuleset),
      binding: artifactPin(sourceBinding),
      runId: 'run-1',
      invocationId: 'invocation-1',
      status: 'completed',
      reason: 'none',
      outcome: { route: 'review' },
      matchedRules: [],
      evaluations: {
        category: decision('category', 'yes', { yes: 0.5, no: 0.5, none: 0 }),
        severity: decision('severity', 1, { 0: 0.5, 1: 0, 2: 0.5 }),
        risk: decision('risk', 0.73, null),
      },
      batchRequests: [{
        groupId: 'batch-1',
        ordinal: 1,
        questionIds: ['category', 'severity', 'risk'],
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
        requestId: null,
      }],
    },
  };
}

describe('decision feature export', () => {
  it('exports primitive uncertainty without collapsing missingness or provenance', () => {
    const set = featureSet();
    const observation = createDecisionFeatureObservation({
      featureSet: set,
      result: result(),
      definitions,
      subjectId: 'subject-1',
      eventTime: '2026-09-24T00:00:00.000Z',
      exportTime: '2026-09-24T00:00:01.000Z',
      authorization: policy(),
    });
    expect(observation.features['raw.provider.category.choice.yes.probability']).toMatchObject({ value: 0.5, source: 'provider-native' });
    expect(observation.features['raw.provider.category.choice.no.probability']).toMatchObject({ value: 0.5 });
    expect(observation.features['compat.one_hot.category.choice.yes']).toMatchObject({ value: 1, source: 'adapter-one-hot' });
    expect(observation.features['derived.category.top_two_margin']).toMatchObject({ value: 0, source: 'derived' });
    expect(observation.features['raw.provider.severity.score.level_0.probability']).toMatchObject({ value: 0.5 });
    expect(observation.features['derived.severity.expected_score']).toMatchObject({ value: 1 });
    expect(observation.features['derived.severity.variance']).toMatchObject({ value: 1 });
    expect(observation.features['raw.provider.risk.noul.truth_probability']).toMatchObject({ value: 0.73 });
    expect(observation.features['calibrated.risk.risk']).toMatchObject({ value: 0.08, source: 'calibrated' });
    expect(observation.features['raw.provider.risk.noul.truth_probability']?.missingReason).toBeNull();
    expect(JSON.stringify(observation)).not.toContain('CANARY_NEVER_IN_FEATURES');
  });

  it('keeps JSONL and CSV semantically equivalent and byte-stable', () => {
    const set = featureSet();
    const row = createDecisionFeatureObservation({
      featureSet: set, result: result(), definitions, subjectId: 'subject-1',
      eventTime: '2026-09-24T00:00:00.000Z', exportTime: '2026-09-24T00:00:01.000Z', authorization: policy(),
    });
    const first = serializeDecisionFeatureJsonl(set, [row], policy(), '2026-09-24T00:00:02.000Z');
    const second = serializeDecisionFeatureJsonl(set, [row], policy(), '2026-09-24T00:00:02.000Z');
    expect(second.payload).toBe(first.payload);
    expect(second.manifest.payloadDigest).toBe(first.manifest.payloadDigest);
    const csv = serializeDecisionFeatureCsv(set, [row], policy(), '2026-09-24T00:00:02.000Z');
    expect(csv.manifest.semanticContentDigest).toBe(first.manifest.semanticContentDigest);
    const loaded = loadDecisionFeatureCsv(set, csv.payload);
    expect(semanticFeatureContentDigest(loaded)).toBe(first.manifest.semanticContentDigest);
    for (const column of ['observationId', 'subjectId', 'eventTime', 'exportTime', 'featureSetId', 'featureSetVersion', 'featureSetDigest']) {
      expect(() => loadDecisionFeatureCsv(set, mutateCsvCell(csv.payload, column, `tampered-${column}`)), column)
        .toThrow(/CSV fixed column/);
    }
    expect(() => loadDecisionFeatureCsv(set, mutateCsvCell(csv.payload, 'ruleset.category.status_success__value', 'garbage')))
      .toThrow(/CSV boolean feature/);
    expect(() => loadDecisionFeatureCsv(set, mutateCsvCell(csv.payload, 'raw.provider.category.choice.yes.probability__value', ' ')))
      .toThrow(/CSV numeric feature/);
    expect(() => loadDecisionFeatureCsv(set, mutateCsvCell(csv.payload, 'raw.provider.category.choice.yes.probability__value', '01')))
      .toThrow(/CSV numeric feature/);
    const header = csv.payload.split('\n')[0]!;
    expect(() => loadDecisionFeatureCsv(set, `${header}\n"abc\n`)).toThrow(/unterminated/);
    expect(() => loadDecisionFeatureCsv(set, `${header}\nab"cd\n`)).toThrow(/quote inside unquoted/);
    expect(() => loadDecisionFeatureCsv(set, `${header}\n"abc"def\n`)).toThrow(/trailing characters/);
    expect(() => loadDecisionFeatureCsv(set, `${header}\na\rb\n`)).toThrow(/bare carriage return/);
    expect(semanticFeatureContentDigest(loadDecisionFeatureCsv(set, csv.payload.replaceAll('\n', '\r\n'))))
      .toBe(first.manifest.semanticContentDigest);
  });

  it('denies cross-project manifest serialization before any manifest is produced', () => {
    const set = featureSet();
    const row = createDecisionFeatureObservation({
      featureSet: set, result: result(), definitions, subjectId: 'subject-1',
      eventTime: '2026-09-24T00:00:00.000Z', exportTime: '2026-09-24T00:00:01.000Z', authorization: policy(),
    });
    let exported: ReturnType<typeof serializeDecisionFeatureJsonl> | undefined;
    expect(() => { exported = serializeDecisionFeatureJsonl(set, [row], { ...policy(), projectId: 'other-project' },
      '2026-09-24T00:00:02.000Z'); }).toThrow(/authorization/);
    expect(exported).toBeUndefined();
  });

  it('rejects train/serve drift before downstream inference', () => {
    const set = featureSet();
    const row = createDecisionFeatureObservation({
      featureSet: set, result: result(), definitions, subjectId: 'subject-1',
      eventTime: '2026-09-24T00:00:00.000Z', exportTime: '2026-09-24T00:00:01.000Z', authorization: policy(),
    });
    const contract = decisionFeatureTrainServeContract(set);
    expect(() => validateDecisionFeatureTrainServe(set, contract, row, 500)).not.toThrow();
    expect(() => validateDecisionFeatureTrainServe(set, { ...contract,
      columns: [...contract.columns].reverse() }, row, 500)).toThrow(/domain mismatch/);
    expect(() => validateDecisionFeatureTrainServe(set, { ...contract,
      featureSet: { ...contract.featureSet, digest: `sha256:${'a'.repeat(64)}` } }, row, 500)).toThrow(/pin mismatch/);
    expect(() => validateDecisionFeatureTrainServe(set, { ...contract,
      compatibleServedModels: { ...contract.compatibleServedModels, risk: ['other-model'] } }, row, 500)).toThrow(/model compatibility/);
    expect(() => validateDecisionFeatureTrainServe(set, contract, row, 2000)).toThrow(/stale calibration/);
  });

  it('fails validation when definition domains or feature export authorization drift', () => {
    const set = featureSet();
    const changed = definition('category', 'choice');
    (changed.spec.answer as Extract<DecisionDefinition['spec']['answer'], { kind: 'choice' }>).options.push({ id: 'maybe', description: 'maybe' });
    expect(() => createDecisionFeatureObservation({
      featureSet: set, result: result(), definitions: { ...definitions, category: changed },
      subjectId: 'subject-1', eventTime: '2026-09-24T00:00:00.000Z', exportTime: '2026-09-24T00:00:01.000Z',
      authorization: policy(),
    })).toThrow(/pin mismatch/);
    expect(() => validateDecisionFeatureExportAuthorization({ ...policy(), operations: ['read'], allowExternalDelivery: false }, 'export'))
      .toThrow(/not authorized/);
    expect(() => validateDecisionFeatureExportAuthorization({ ...policy(), allowExternalDelivery: false }, 'share'))
      .toThrow(/External feature delivery/);
  });

  it('keeps v1alpha1 receipts readable by explicit missingness and records batch accounting once', () => {
    const set = featureSet();
    const legacy = decision('category', 'yes', null);
    legacy.apiVersion = DECISION_API_VERSION;
    legacy.spec.uncertainty = { source: 'model-self-report', profile: 'legacy-confidence', calibration: 'uncalibrated',
      confidence: 0.4, distribution: null, calibrationRef: null };
    const row = createDecisionFeatureObservation({
      featureSet: set,
      result: legacy,
      definitions,
      subjectId: 'subject-legacy',
      eventTime: '2026-09-24T00:00:00.000Z',
      exportTime: '2026-09-24T00:00:01.000Z',
      authorization: policy(),
    });
    expect(row.features['raw.provider.category.choice.yes.probability']).toMatchObject({ value: null, state: 'missing' });
    expect(row.features['model_self_report.category.confidence']).toMatchObject({ value: 0.4, source: 'model-self-report' });
    const batchRow = createDecisionFeatureObservation({
      featureSet: set, result: result(), definitions, subjectId: 'subject-1',
      eventTime: '2026-09-24T00:00:00.000Z', exportTime: '2026-09-24T00:00:01.000Z', authorization: policy(),
    });
    expect(batchRow.batchAccounting).toMatchObject({
      scope: 'ruleset-batch-request',
      authoritativeUsage: null,
      owners: [expect.objectContaining({ runId: 'run-1', invocationId: 'invocation-1', groupId: 'batch-1', ordinal: 1, requestId: null, questionIds: ['category', 'risk', 'severity'] })],
      allocation: { kind: 'estimated', algorithm: 'largest-remainder-weighted' },
    });
    const exported = serializeDecisionFeatureJsonl(set, [batchRow], policy(), '2026-09-24T00:00:02.000Z');
    expect(exported.manifest.batchAccounting).toMatchObject([{
      scope: 'ruleset-batch-request',
      ownerId: expect.stringMatching(/^ruleset-batch-request:/),
      groupId: 'batch-1',
      ordinal: 1,
      requestId: null,
      questionIds: ['category', 'risk', 'severity'],
      authoritativeUsage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
      rowAllocations: [{ observationId: batchRow.observationId, kind: 'estimated' }],
    }]);
    expect(Object.values(batchRow.features).some(cell => JSON.stringify(cell).includes('costUsd'))).toBe(false);

    const retry = result();
    retry.spec.batchRequests!.push({ groupId: 'batch-1', ordinal: 2, questionIds: ['category', 'severity', 'risk'],
      usage: { inputTokens: 3, outputTokens: 2, costUsd: 0.0002 }, requestId: 'retry-request' });
    const retryRow = createDecisionFeatureObservation({
      featureSet: set, result: retry, definitions, subjectId: 'subject-retry',
      eventTime: '2026-09-24T00:00:00.000Z', exportTime: '2026-09-24T00:00:01.000Z', authorization: policy(),
    });
    expect(retryRow.batchAccounting.owners).toHaveLength(2);
    const retryExport = serializeDecisionFeatureJsonl(set, [retryRow], policy(), '2026-09-24T00:00:02.000Z');
    expect(retryExport.manifest.batchAccounting).toHaveLength(2);
    expect(retryExport.manifest.batchAccounting.map(item => item.ordinal).sort()).toEqual([1, 2]);
    expect(retryExport.manifest.batchAccounting.find(item => item.ordinal === 2)?.authoritativeUsage)
      .toEqual({ inputTokens: 3, outputTokens: 2, costUsd: 0.0002 });
    expect(retryExport.manifest.batchAccounting.every(item => item.rowAllocations.every(allocation => allocation.usage === null))).toBe(true);

    const conflictingResult = result();
    conflictingResult.spec.batchRequests![0]!.usage = { inputTokens: 11, outputTokens: 5, costUsd: 0.001 };
    const conflicting = createDecisionFeatureObservation({
      featureSet: set, result: conflictingResult, definitions, subjectId: 'subject-conflict',
      eventTime: '2026-09-24T00:00:00.000Z', exportTime: '2026-09-24T00:00:01.000Z', authorization: policy(),
    });
    expect(() => serializeDecisionFeatureJsonl(set, [batchRow, conflicting], policy(), '2026-09-24T00:00:02.000Z'))
      .toThrow(/conflicting authoritative batch accounting/);

    const persisted = JSON.parse(JSON.stringify(batchRow));
    expect(() => serializeDecisionFeatureJsonl(set, [persisted], policy(), '2026-09-24T00:00:02.000Z'))
      .toThrow(/authoritative batch accounting is missing/);
    expect(serializeDecisionFeatureJsonl(set, [persisted], policy(), { generatedAt: '2026-09-24T00:00:02.000Z',
      batchAccountingEvidence: [{ ...batchRow.batchAccounting.owners[0]!, authoritativeUsage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 } }] }))
      .toMatchObject({ manifest: { batchAccounting: [{ authoritativeUsage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 } }] } });
  });


  it('rejects sensitive metadata identifiers before JSONL or CSV export', () => {
    const set = featureSet();
    const cases: Array<{ name: string; subjectId?: string; mutate?: (value: RulesetResult) => void; canary: string }> = [
      { name: 'email subject', subjectId: 'person@example.test', canary: 'person@example.test' },
      { name: 'private URL invocation', mutate: value => { value.spec.invocationId = 'file:///home/private/LOCATOR_CANARY'; }, canary: 'LOCATOR_CANARY' },
      { name: 'bearer run', mutate: value => { value.spec.runId = 'Bearer SECRET_CANARY_TOKEN'; }, canary: 'SECRET_CANARY_TOKEN' },
      { name: 'key-like request', mutate: value => { value.spec.batchRequests![0]!.requestId = 'AKIA1234567890ABCDEF'; }, canary: 'AKIA1234567890ABCDEF' },
    ];
    for (const item of cases) {
      const source = result();
      item.mutate?.(source);
      const row = createDecisionFeatureObservation({
        featureSet: set, result: source, definitions, subjectId: item.subjectId ?? `subject-${item.name.replace(/[^a-z]/gu, '-')}`,
        eventTime: '2026-09-24T00:00:00.000Z', exportTime: '2026-09-24T00:00:01.000Z', authorization: policy(),
      });
      for (const serialize of [serializeDecisionFeatureJsonl, serializeDecisionFeatureCsv]) {
        let error: unknown;
        try { serialize(set, [row], policy(), '2026-09-24T00:00:02.000Z'); } catch (caught) { error = caught; }
        expect(error, item.name).toBeInstanceOf(DecisionFeatureExportError);
        expect(String(error)).toContain('safe opaque subset');
        expect(String(error)).not.toContain(item.canary);
      }
    }
  });

  it('records deterministic split provenance and preserves supplied eval-integrity without upgrading', () => {
    const set = featureSet();
    const rows = ['subject-1', 'subject-2', 'subject-3'].map(subjectId => createDecisionFeatureObservation({
      featureSet: set, result: result(), definitions, subjectId,
      eventTime: '2026-09-24T00:00:00.000Z', exportTime: '2026-09-24T00:00:01.000Z', authorization: policy(),
    }));
    expect(deterministicFeatureSplit(rows, 42)).toEqual(deterministicFeatureSplit(rows, 42));
    const evalIntegrity = buildDecisionFeatureEvalIntegrity({ qualificationRelease: qualificationRelease('HOLD'), reportRef: 'offline-feature-export-smoke' });
    const exported = serializeDecisionFeatureJsonl(set, rows, policy(), { generatedAt: '2026-09-24T00:00:02.000Z', evalIntegrity });
    expect(exported.manifest.evalIntegrity).toEqual(evalIntegrity);
    expect(exported.manifest.evalIntegrity?.qualificationRelease.integrity.release_gate.decision).toBe('HOLD');
    expect(() => serializeDecisionFeatureJsonl(set, rows, policy(), { generatedAt: '2026-09-24T00:00:02.000Z',
      evalIntegrity: buildDecisionFeatureEvalIntegrity({ qualificationRelease: qualificationRelease('ROLLBACK'), reportRef: 'rollback-smoke', disposition: 'PROMOTE' }) }))
      .toThrow(/cannot upgrade/);
    const forged = { ...evalIntegrity, digest: `sha256:${'f'.repeat(64)}` as const };
    expect(() => serializeDecisionFeatureJsonl(set, rows, policy(), { generatedAt: '2026-09-24T00:00:02.000Z', evalIntegrity: forged }))
      .toThrow(/digest/);
  });

  it('enforces scoped read list share delete and lifecycle denial through the export service', async () => {
    const set = featureSet();
    const service = new DecisionFeatureExportService(set, new MemoryDecisionFeatureExportStore());
    const row = await service.create({ featureSet: set, result: result(), definitions, subjectId: 'subject-1',
      eventTime: '2026-09-24T00:00:00.000Z', exportTime: '2026-09-24T00:00:01.000Z', authorization: policy() });
    await expect(service.read({ ...policy(), projectId: 'other-project' }, row.observationId, Date.parse('2026-09-24T00:00:02.000Z')))
      .resolves.toBeNull();
    await expect(service.share(policy(), row.observationId, Date.parse('2026-09-24T00:00:02.000Z'))).resolves.toEqual(row);
    await expect(service.exportJsonl(policy(), '2026-09-24T00:00:02.000Z', Date.parse('2026-09-24T00:00:02.000Z')))
      .resolves.toMatchObject({ manifest: { rowCount: 1 } });
    await service.delete(policy(), row.observationId, Date.parse('2026-09-24T00:00:03.000Z'));
    await expect(service.read(policy(), row.observationId, Date.parse('2026-09-24T00:00:04.000Z'))).rejects.toThrow(/lifecycle/);
    await expect(service.exportJsonl(policy(), '2026-09-24T00:00:04.000Z', Date.parse('2026-09-24T00:00:04.000Z')))
      .resolves.toMatchObject({ manifest: { rowCount: 0 } });
  });

  it('rejects cross-feature-set service create and shared-store reads', async () => {
    const set = featureSet();
    const other = generateDecisionFeatureSet({
      id: 'triage-features-other',
      version: '1.0.0',
      description: 'other feature set',
      ruleset: ruleset(),
      binding: binding(),
      definitions,
      compatibleServedModels: { category: ['jev-fixture-v1'], severity: ['jev-fixture-v1'], risk: ['jev-fixture-v1'] },
      privacy: { classification: 'restricted', retentionMs: 86_400_000, accessScope: 'feature-exporter',
        exportPolicyId: 'dataset-policy-v1', deletion: 'tombstone', lifecycleSurface: 'export' },
    });
    const store = new MemoryDecisionFeatureExportStore();
    const service = new DecisionFeatureExportService(set, store);
    await expect(service.create({ featureSet: other, result: result(), definitions, subjectId: 'subject-1',
      eventTime: '2026-09-24T00:00:00.000Z', exportTime: '2026-09-24T00:00:01.000Z', authorization: policy() }))
      .rejects.toThrow(/feature set/);
    const otherRow = createDecisionFeatureObservation({ featureSet: other, result: result(), definitions, subjectId: 'subject-2',
      eventTime: '2026-09-24T00:00:00.000Z', exportTime: '2026-09-24T00:00:01.000Z', authorization: policy() });
    await store.create(otherRow);
    await expect(service.read(policy(), otherRow.observationId, Date.parse('2026-09-24T00:00:02.000Z'))).rejects.toThrow(/feature set/);
    await expect(service.revoke(policy(), otherRow.observationId, Date.parse('2026-09-24T00:00:02.000Z'))).rejects.toThrow(/feature set/);
    await expect(service.list(policy(), Date.parse('2026-09-24T00:00:02.000Z'))).resolves.toEqual([]);
  });

  it('uses host D10 lifecycle links, tombstones and holds rather than row self-assertions', async () => {
    const set = featureSet();
    const lifecycle = new LifecycleFixtureStore();
    const store = new MemoryDecisionFeatureExportStore();
    const service = new DecisionFeatureExportService(set, store, lifecyclePolicy(), lifecycle);
    const row = await service.create({ featureSet: set, result: result(), definitions, subjectId: 'subject-1',
      eventTime: '2026-09-24T00:00:00.000Z', exportTime: '2026-09-24T00:00:01.000Z', authorization: policy() });
    expect(lifecycle.registered).toHaveLength(1);

    const backup: DecisionLifecycleBackupEntry[] = [{ subject: 'subject-1',
      reference: { surface: 'export', opaqueId: row.lifecycle.reference }, createdAt: Date.parse('2026-09-24T00:00:01.000Z') }];
    const backedUpRow = structuredClone(row);
    await eraseDecisionSubject('subject-1', lifecyclePolicy(), lifecycle, Date.parse('2026-09-24T00:00:02.000Z'));
    let restoreHandlerCalls = 0;
    const restoreReport = await restoreDecisionSubjectBackup(backup, lifecyclePolicy(), lifecycle.tombstones, {
      export: async () => { restoreHandlerCalls++; await store.create(backedUpRow); },
    }, Date.parse('2026-09-24T00:00:03.000Z'));
    expect(restoreHandlerCalls).toBe(0);
    expect(restoreReport.restored).toEqual([]);
    expect(restoreReport.refused).toMatchObject([{ reason: 'tombstoned' }]);
    await expect(service.read(policy(), row.observationId, Date.parse('2026-09-24T00:00:04.000Z'))).rejects.toThrow(/lifecycle reference/);
    await expect(service.list(policy(), Date.parse('2026-09-24T00:00:04.000Z'))).resolves.toEqual([]);
    await expect(service.exportJsonl(policy(), '2026-09-24T00:00:04.000Z', Date.parse('2026-09-24T00:00:04.000Z')))
      .resolves.toMatchObject({ manifest: { rowCount: 0 } });

    const heldLifecycle = new LifecycleFixtureStore();
    const heldService = new DecisionFeatureExportService(set, new MemoryDecisionFeatureExportStore(), lifecyclePolicy(), heldLifecycle);
    const held = await heldService.create({ featureSet: set, result: result(), definitions, subjectId: 'subject-2',
      eventTime: '2026-09-24T00:00:00.000Z', exportTime: '2026-09-24T00:00:01.000Z', authorization: policy() });
    await placeDecisionLifecycleHold({ subject: 'subject-2', reason: 'legal', scope: ['export'],
      expiresAt: Date.parse('2026-09-25T00:00:00.000Z'), authorizedBy: 'counsel' }, async () => true,
    heldLifecycle, Date.parse('2026-09-24T00:00:02.000Z'));
    await expect(eraseDecisionSubject('subject-2', lifecyclePolicy(), heldLifecycle, Date.parse('2026-09-24T00:00:03.000Z')))
      .rejects.toThrow(/hold/);
    await expect(heldService.delete(policy(), held.observationId, Date.parse('2026-09-24T00:00:03.000Z'))).rejects.toThrow(/legal hold/);
  });
});
