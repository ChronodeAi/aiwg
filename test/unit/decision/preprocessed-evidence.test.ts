import { readFileSync } from 'node:fs';
import * as decisionRuntime from '../../../src/decision/index.js';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '../../../src/security/artifact-trust.js';
import {
  artifactPin,
  checkPreprocessedEvidenceReference,
  evaluateDecisionRuleset,
  preprocessedEvidenceContentDigest,
  preprocessedEvidencePin,
  PreprocessedEvidenceError,
  preprocessingLifecycleReferences,
  resolvePreprocessedEvidence,
  validateDecisionDocument,
  type AdapterObservation,
  type DecisionAdapter,
  type DecisionBinding,
  type DecisionDefinition,
  type DecisionProjectionPolicy,
  type DecisionRuleset,
  type PreprocessedEvidence,
  type RulesetResult,
} from '../../../src/decision/index.js';
import {
  DECISION_LIFECYCLE_SURFACES,
  DECISION_LIFECYCLE_VERSION,
  eraseDecisionSubject,
  placeDecisionLifecycleHold,
  restoreDecisionSubjectBackup,
  type DecisionLifecyclePolicy,
  type DecisionLifecycleReference,
  type DecisionLifecycleTombstone,
} from '../../../src/decision/lifecycle.js';
import { scanTelemetryCanaries } from '../../../src/decision/telemetry/index.js';
import { runTextNativeCases } from '../../fixtures/decision/preprocessing/text-native-cases.js';

interface FixtureFile { fixtures: Array<{ id: string; manifest: PreprocessedEvidence }> }

const fixtureFile = (): FixtureFile => JSON.parse(readFileSync('test/fixtures/decision/preprocessing/multimodal-lineage-v1.json', 'utf8')) as FixtureFile;
const manifest = (id: string): PreprocessedEvidence => structuredClone(fixtureFile().fixtures.find(item => item.id === id)!.manifest);
const addon = <T>(name: string): T => JSON.parse(readFileSync(`agentic/code/addons/decision-engine/examples/${name}`, 'utf8')) as T;
const textNativeGolden = (): { cases: Array<{ id: string; canonical: string }> } =>
  JSON.parse(readFileSync('test/fixtures/decision/preprocessing/text-native-golden-v1.json', 'utf8')) as { cases: Array<{ id: string; canonical: string }> };
const schema = (name: string) => JSON.parse(readFileSync(`schemas/decision/${name}`, 'utf8')) as object;

const ajv = new Ajv2020({ strict: true, allErrors: true });
(addFormats as unknown as (value: Ajv2020) => void)(ajv);
const preprocessingSchema = ajv.compile(schema('PreprocessedEvidence.v1.schema.json'));
const jevDestination = { provider: 'jev', origin: 'https://api.typesafe.ai' };

const success = (value: string | number, profile = 'typesafe-distribution-v1'): AdapterObservation => ({
  status: 'success', reason: 'none', value,
  uncertainty: { source: 'provider', profile, calibration: 'vendor-claimed', confidence: 0.9, distribution: null, calibrationRef: null },
  actualModel: 'fixture-model', usage: { inputTokens: 1, outputTokens: 1, costUsd: null }, requestId: 'fixture-request',
});

function projectionPolicy(): DecisionProjectionPolicy {
  return {
    version: '1.0.0', provider: 'jev', model: 'jev-latest', origin: 'https://api.typesafe.ai', region: 'us',
    purpose: 'triage', allowIncompleteContext: false,
    fields: [{
      pointer: '/message', output: 'message', source: 'preprocessed-evidence', subject: 'case-2617',
      trust: 'untrusted', sensitivity: 'confidential', purpose: 'triage', retentionClass: 'ephemeral',
      accessScopes: ['decision-runtime'], exportPolicy: 'denied', deletionPolicy: 'erase', backupPolicy: 'not-persisted',
      allowedProviders: ['jev'], allowedModels: ['jev-latest'], allowedOrigins: ['https://api.typesafe.ai'], allowedRegions: ['us'],
    }],
  };
}

function spyAdapter(seen: unknown[], egress: 'network' | 'none' = 'network'): DecisionAdapter {
  return {
    id: 'jev', version: '1.0.0',
    capabilities: async () => ({
      answerKinds: ['choice', 'ordinal-score', 'truth-probability'],
      features: ['choice', 'ordinal-score', 'truth-probability'],
      maxOptions: 255, maxLevels: 10, confidenceProfiles: ['typesafe-distribution-v1', 'typesafe-truth-v1'],
      executable: true, egress: egress === 'network'
        ? { mode: 'network', origin: 'https://api.typesafe.ai', region: 'us' }
        : { mode: 'none' },
    }),
    evaluate: async request => {
      seen.push(structuredClone({ input: request.input, projectionEvidence: request.projectionEvidence }));
      if (request.alias === 'category') return success('documentation');
      if (request.alias === 'severity') return success(0.25);
      return success(0.05, 'typesafe-truth-v1');
    },
  };
}

describe('preprocessed evidence schema and resolver', () => {
  it('SCHEMA-MML-01 accepts recorded OCR, ASR, video caption and image description fixtures', () => {
    expect(fixtureFile().fixtures.map(item => item.id)).toEqual([
      'scanned-document-ocr', 'audio-transcription', 'video-caption-segments', 'image-description',
    ]);
    for (const { manifest: value } of fixtureFile().fixtures) {
      expect(preprocessingSchema(value), JSON.stringify(preprocessingSchema.errors)).toBe(true);
      expect(() => resolvePreprocessedEvidence([value], { destination: jevDestination, minQualityScore: 0.8 })).not.toThrow();
    }
  });

  it('MML-DIGEST-01 changes pins for source, model, configuration, redaction, translation and human correction mutations', () => {
    const source = manifest('scanned-document-ocr');
    const original = preprocessedEvidencePin(source).digest;
    const mutations: Array<(value: PreprocessedEvidence) => void> = [
      value => { value.spec.source.contentDigest = `sha256:${'9'.repeat(64)}`; value.spec.preprocessing[0]!.inputDigest = value.spec.source.contentDigest; },
      value => { value.spec.preprocessing[0]!.model!.version = '2'; },
      value => { value.spec.preprocessing[0]!.configurationDigest = `sha256:${'8'.repeat(64)}`; },
      value => {
        value.spec.preprocessing.push({
          id: 'redact-1', ordinal: 2, kind: 'redaction', tool: { id: 'fixture-redactor', version: '1' },
          configurationDigest: `sha256:${'7'.repeat(64)}`, runtime: 'recorded-fixture',
          startedAt: '2026-09-20T10:01:02.000Z', endedAt: '2026-09-20T10:01:03.000Z',
          inputDigest: value.spec.output.contentDigest,
          outputDigest: 'sha256:c219f5a1c0797ef8847cdc749626cf3d052933f0a7af912265218bb0be165081',
        });
        value.spec.transformations.push({ id: 'redact-event-1', kind: 'redaction', inputDigest: value.spec.output.contentDigest,
          outputDigest: 'sha256:c219f5a1c0797ef8847cdc749626cf3d052933f0a7af912265218bb0be165081', at: '2026-09-20T10:01:03.000Z' });
        value.spec.output = { ...value.spec.output, version: 2, contentDigest: 'sha256:c219f5a1c0797ef8847cdc749626cf3d052933f0a7af912265218bb0be165081',
          value: 'Invoice 314 total 128.40 USD. Vendor: Northwind Clinic. Due 2026-10-15. Account number redacted.' };
        value.spec.selectedSegments[0]!.outputVersion = 2;
        value.spec.selectedSegments[0]!.outputDigest = value.spec.output.contentDigest;
      },
      value => {
        value.spec.preprocessing[0]!.kind = 'translation';
        value.spec.preprocessing[0]!.outputDigest = 'sha256:83529e38a37dc45c753243d0102509ca50893a4573e9be35fad0c16de72138b3';
        value.spec.output = { ...value.spec.output, language: 'es', contentDigest: value.spec.preprocessing[0]!.outputDigest,
          value: 'Factura 314 total 128.40 USD. Proveedor: Northwind Clinic. Vence 2026-10-15.' };
        value.spec.selectedSegments[0]!.outputDigest = value.spec.output.contentDigest;
      },
      value => {
        value.spec.transformations.push({ id: 'human-correction-event-1', kind: 'human-correction', inputDigest: value.spec.output.contentDigest,
          outputDigest: 'sha256:d09c74665cf6543a90a43e5c78150d0a36730770266647ba1c2286001bbd299c',
          at: '2026-09-20T10:02:01.000Z', reviewer: 'reviewer-fixture', rationale: 'Corrected OCR total',
          previousOutput: { id: value.spec.output.id, version: value.spec.output.version, digest: value.spec.output.contentDigest } });
        value.spec.output = { ...value.spec.output, version: 2, contentDigest: 'sha256:d09c74665cf6543a90a43e5c78150d0a36730770266647ba1c2286001bbd299c',
          value: 'Invoice 314 total 128.40 USD. Vendor: Northwind Clinic. Due 2026-10-15. Reviewer corrected OCR total from 123.40.' };
        value.spec.selectedSegments[0]!.outputVersion = 2;
        value.spec.selectedSegments[0]!.outputDigest = value.spec.output.contentDigest;
        value.spec.quality.flags = ['human-corrected'];
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(source);
      mutate(changed);
      expect(preprocessedEvidencePin(changed).digest).not.toBe(original);
    }
  });

  it('MML-REJECT-01 rejects broken links, digest mismatch, wrong media type, cycles, remote locators and unsupported transformations', () => {
    const source = manifest('scanned-document-ocr');
    const broken = structuredClone(source);
    broken.spec.preprocessing[0]!.inputDigest = `sha256:${'5'.repeat(64)}`;
    expect(() => resolvePreprocessedEvidence([broken], { destination: jevDestination })).toThrow(/continuity/);
    const mismatch = structuredClone(source);
    mismatch.spec.output.value += ' changed';
    expect(() => resolvePreprocessedEvidence([mismatch], { destination: jevDestination })).toThrow(/output content digest/);
    const wrongType = structuredClone(source);
    wrongType.spec.source.mediaType = 'audio/wav';
    expect(() => resolvePreprocessedEvidence([wrongType], { destination: jevDestination })).toThrow(/OCR source media type/);
    const cycle = structuredClone(source);
    cycle.spec.preprocessing.push({ ...structuredClone(cycle.spec.preprocessing[0]!), id: 'cycle', ordinal: 2,
      inputDigest: cycle.spec.preprocessing[0]!.outputDigest, outputDigest: cycle.spec.source.contentDigest });
    expect(() => resolvePreprocessedEvidence([cycle], { destination: jevDestination })).toThrow(/cycle/);
    const remote = structuredClone(source);
    remote.spec.source.locator = { class: 'remote-url', value: 'https://example.invalid/raw.pdf' };
    expect(() => resolvePreprocessedEvidence([remote], { destination: jevDestination })).toThrow(/locator class/);
    const unsupported = structuredClone(source) as unknown as { spec: { transformations: Array<Record<string, unknown>> } };
    unsupported.spec.transformations.push({ id: 'unsupported', kind: 'rotate', inputDigest: source.spec.output.contentDigest,
      outputDigest: source.spec.output.contentDigest, at: '2026-09-20T10:05:00.000Z' });
    expect(preprocessingSchema(unsupported)).toBe(false);
    expect(() => resolvePreprocessedEvidence([unsupported as unknown as PreprocessedEvidence], { destination: jevDestination })).toThrow(/transformation/);
    const audioPage = manifest('audio-transcription');
    audioPage.spec.segments[0]!.sourceLocator = { page: 1 };
    expect(() => resolvePreprocessedEvidence([audioPage], { destination: jevDestination })).toThrow(/audio segments require/);
  });

  it('MML-SEGMENT-01 projects only selected segment text and rejects tampered segment digests or duplicate identities', () => {
    const value = manifest('video-caption-segments');
    value.spec.output.value = '00:00 Safety guard visible.\n00:08 Operator pauses the line and points to panel B.';
    value.spec.output.contentDigest = preprocessedEvidenceContentDigest(value.spec.output.value);
    value.spec.preprocessing[0]!.outputDigest = value.spec.output.contentDigest;
    value.spec.segments = [
      { id: 'video-0-4s', ordinal: 1, sourceLocator: { startMs: 0, endMs: 4000, frame: 0 }, outputRange: { start: 0, end: 27 },
        text: '00:00 Safety guard visible.', textDigest: preprocessedEvidenceContentDigest('00:00 Safety guard visible.') },
      { id: 'video-4-8s', ordinal: 2, sourceLocator: { startMs: 4000, endMs: 8000, frame: 96 }, outputRange: { start: 28, end: 81 },
        text: '00:08 Operator pauses the line and points to panel B.',
        textDigest: preprocessedEvidenceContentDigest('00:08 Operator pauses the line and points to panel B.') },
    ];
    value.spec.selectedSegments = [{ segmentId: 'video-4-8s', outputVersion: 1, outputDigest: value.spec.output.contentDigest }];
    const resolved = resolvePreprocessedEvidence([value], { destination: jevDestination });
    expect(resolved.state.text).toBe('00:08 Operator pauses the line and points to panel B.');

    const tampered = structuredClone(value);
    tampered.spec.segments[1]!.textDigest = tampered.spec.segments[0]!.textDigest;
    expect(() => resolvePreprocessedEvidence([tampered], { destination: jevDestination })).toThrow(/segment text digest/);
    const duplicate = structuredClone(value);
    duplicate.spec.segments[1]!.id = duplicate.spec.segments[0]!.id;
    expect(() => resolvePreprocessedEvidence([duplicate], { destination: jevDestination })).toThrow(/duplicate/);
    const duplicateOrdinal = structuredClone(value);
    duplicateOrdinal.spec.segments[1]!.ordinal = duplicateOrdinal.spec.segments[0]!.ordinal;
    expect(() => resolvePreprocessedEvidence([duplicateOrdinal], { destination: jevDestination })).toThrow(/duplicate/);
  });

  it('MML-STALE-01 marks references stale when preprocessor identity changes even if output text is identical', () => {
    const value = manifest('scanned-document-ocr');
    const resolved = resolvePreprocessedEvidence([value], { destination: jevDestination });
    expect(checkPreprocessedEvidenceReference(resolved.receiptEvidence.references[0]!, value)).toEqual({ status: 'current', reasons: [] });
    const modelChanged = structuredClone(value);
    modelChanged.spec.preprocessing[0]!.model!.version = '2';
    const stale = checkPreprocessedEvidenceReference(resolved.receiptEvidence.references[0]!, modelChanged);
    expect(stale.status).toBe('stale');
    expect(stale.reasons).toEqual(expect.arrayContaining(['manifest-pin', 'segments']));
  });

  it('MML-HUMAN-01 requires reviewer, rationale, prior output link and a higher output version for corrections', () => {
    const value = manifest('scanned-document-ocr');
    const corrected = structuredClone(value);
    const prior = corrected.spec.output;
    // Correction is an append-only event, not a preprocessing step; the extraction step is untouched.
    corrected.spec.output = { ...prior, version: 2, value: `${prior.value} Corrected.`,
      contentDigest: preprocessedEvidenceContentDigest(`${prior.value} Corrected.`) };
    corrected.spec.selectedSegments[0]!.outputVersion = 2;
    corrected.spec.selectedSegments[0]!.outputDigest = corrected.spec.output.contentDigest;
    corrected.spec.segments[0]!.text = corrected.spec.output.value;
    corrected.spec.segments[0]!.textDigest = corrected.spec.output.contentDigest;
    corrected.spec.segments[0]!.outputRange = { start: 0, end: Buffer.byteLength(corrected.spec.output.value) };
    corrected.spec.transformations.push({ id: 'human-correction-event-1', kind: 'human-correction',
      inputDigest: prior.contentDigest, outputDigest: corrected.spec.output.contentDigest, at: '2026-09-20T10:02:01.000Z',
      reviewer: 'reviewer-fixture', rationale: 'Corrected OCR total',
      previousOutput: { id: prior.id, version: prior.version, digest: prior.contentDigest } });
    const resolvedCorrection = resolvePreprocessedEvidence([corrected], { destination: jevDestination });
    expect(resolvedCorrection.state.text).toBe(corrected.spec.output.value);
    expect(corrected.spec.preprocessing).toEqual(value.spec.preprocessing);
    expect(resolvedCorrection.receiptEvidence.references[0]!.selectedSegments[0]!.preprocessingDigest)
      .not.toBe(resolvePreprocessedEvidence([value], { destination: jevDestination }).receiptEvidence.references[0]!.selectedSegments[0]!.preprocessingDigest);
    const missingReviewer = structuredClone(corrected);
    delete missingReviewer.spec.transformations[0]!.reviewer;
    expect(preprocessingSchema(missingReviewer)).toBe(false);
    expect(() => resolvePreprocessedEvidence([missingReviewer], { destination: jevDestination })).toThrow(/human correction/);
    const unchangedVersion = structuredClone(corrected);
    unchangedVersion.spec.output.version = 1;
    unchangedVersion.spec.selectedSegments[0]!.outputVersion = 1;
    expect(() => resolvePreprocessedEvidence([unchangedVersion], { destination: jevDestination })).toThrow(/newer linked output/);
  });

  it('MML-CHAIN-01 permits explicit no-op identity steps while still rejecting real cycles', () => {
    const value = manifest('scanned-document-ocr');
    value.spec.preprocessing.unshift({
      id: 'noop-normalize', ordinal: 1, kind: 'normalization', tool: { id: 'fixture-normalizer', version: '1' },
      configurationDigest: `sha256:${'1'.repeat(64)}`, runtime: 'recorded-fixture',
      startedAt: '2026-09-20T10:00:30.000Z', endedAt: '2026-09-20T10:00:31.000Z',
      inputDigest: value.spec.source.contentDigest, outputDigest: value.spec.source.contentDigest, noOp: true,
    });
    value.spec.preprocessing[1]!.ordinal = 2;
    expect(() => resolvePreprocessedEvidence([value], { destination: jevDestination })).not.toThrow();
  });

  it('MML-ROUTE-01 marks stale, low-quality, truncated and incomplete extraction for review without relabeling confidence', () => {
    const value = manifest('audio-transcription');
    value.spec.quality = { ...value.spec.quality, score: 0.3, flags: ['low-quality', 'truncated', 'incomplete'] };
    value.spec.selectedSegments[0]!.outputVersion = 2;
    const resolved = resolvePreprocessedEvidence([value], {
      destination: jevDestination, minQualityScore: 0.8, maxAgeMs: 1,
      now: () => Date.parse('2026-09-29T00:00:00.000Z'),
    });
    expect(resolved.status).toBe('review');
    expect(resolved.reasons).toEqual(expect.arrayContaining(['low-quality', 'truncated', 'incomplete', 'stale']));
    expect(resolved.receiptEvidence.references[0]!.quality).toMatchObject({
      source: 'preprocessor', score: 0.3,
    });
    expect(canonicalJson(resolved.receiptEvidence)).not.toContain('fixture-asr-quality-v1');
    expect(canonicalJson(resolved.receiptEvidence)).not.toContain('word-confidence');
    expect(canonicalJson(resolved.receiptEvidence)).not.toContain(value.spec.output.value);
  });

  it('MML-POLICY-01 evaluates raw and derived egress independently before dispatch', () => {
    const imageVerified = manifest('image-description');
    imageVerified.spec.policy.trust = 'verified';
    const rawDeniedDerivedAllowed = resolvePreprocessedEvidence([imageVerified], { destination: jevDestination });
    expect(rawDeniedDerivedAllowed.status).toBe('ready');
    expect(rawDeniedDerivedAllowed.state.text).toContain('Image description');
    expect(rawDeniedDerivedAllowed.receiptEvidence.references[0]!.policy).toMatchObject({
      rawEgressAllowed: false, derivedEgressAllowed: true,
    });

    const derivedDenied = manifest('image-description');
    derivedDenied.spec.policy.rawEgress = { allowed: true, destinations: [jevDestination] };
    derivedDenied.spec.policy.derivedEgress = { allowed: false, destinations: [] };
    const denied = resolvePreprocessedEvidence([derivedDenied], { destination: jevDestination });
    expect(denied.status).toBe('review');
    expect(denied.reasons).toContain('derived-egress-denied');
    expect(denied.state.text).toBe('');

    const bothDenied = manifest('image-description');
    bothDenied.spec.policy.rawEgress = { allowed: false, destinations: [] };
    bothDenied.spec.policy.derivedEgress = { allowed: false, destinations: [] };
    const deniedBoth = resolvePreprocessedEvidence([bothDenied], { destination: jevDestination, requireRawEgress: true });
    expect(deniedBoth.reasons).toEqual(expect.arrayContaining(['raw-egress-denied', 'derived-egress-denied']));
  });

  it('MML-PRIVACY-01 receipt and trace lineage pass canary scans; receipts never carry derived text', () => {
    const value = manifest('image-description');
    value.spec.output.value = 'Image description: synthetic-person-canary@example.invalid cracked seal.';
    value.spec.output.contentDigest = preprocessedEvidenceContentDigest(value.spec.output.value);
    value.spec.preprocessing[0]!.outputDigest = value.spec.output.contentDigest;
    value.spec.segments[0]!.text = value.spec.output.value;
    value.spec.segments[0]!.textDigest = value.spec.output.contentDigest;
    value.spec.segments[0]!.outputRange = { start: 0, end: Buffer.byteLength(value.spec.output.value) };
    value.spec.selectedSegments[0]!.outputDigest = value.spec.output.contentDigest;
    value.spec.quality.profile = 'Bearer synthetic-secret-canary';
    value.spec.quality.label = 'synthetic-person-canary@example.invalid';
    const resolved = resolvePreprocessedEvidence([value], { destination: jevDestination });
    expect(resolved.state.text).toContain('synthetic-person-canary');
    expect(scanTelemetryCanaries(resolved.receiptEvidence, ['synthetic-person-canary@example.invalid', 'synthetic-secret-canary'])).toEqual([]);
  });
});

describe('preprocessed evidence evaluator integration', () => {
  it('MML-E2E-01 projects recorded extraction text into Jev input while receipts keep only lineage refs', async () => {
    const source = manifest('scanned-document-ocr');
    const resolved = resolvePreprocessedEvidence([source], { destination: jevDestination, minQualityScore: 0.8 });
    const calls: unknown[] = [];
    const result = await evaluateDecisionRuleset({
      ruleset: addon<DecisionRuleset>('ruleset.json'),
      binding: addon<DecisionBinding>('binding-jev.json'),
      definitions: {
        category: addon<DecisionDefinition>('decision-category.json'),
        severity: addon<DecisionDefinition>('decision-severity.json'),
        core: addon<DecisionDefinition>('decision-core_unavailable.json'),
      },
      input: { message: resolved.state.text },
      runId: 'run', invocationId: 'mml-e2e',
      adapters: { jev: spyAdapter(calls) },
      resolveCredential: vi.fn(async () => new Uint8Array([1])),
      projection: { resolve: () => projectionPolicy() },
      preprocessingLineage: resolved.receiptEvidence,
      preprocessingVerification: { manifests: [source] },
    });
    expect(result.apiVersion).toBe('decision.aiwg.io/v1alpha2');
    expect(result.spec.preprocessingLineage).toEqual({ ...resolved.receiptEvidence, dispatchGate: { outcome: 'allowed', reasons: [] } });
    expect(result.spec.status).toBe('completed');
    expect(calls).toHaveLength(3);
    expect(canonicalJson(calls)).toContain('Invoice 314 total');
    expect(canonicalJson(calls)).not.toContain('asset-invoice-scan-314');
    expect(canonicalJson(result)).not.toContain('Invoice 314 total');
    expect(canonicalJson(result)).not.toContain('fixture:invoice-scan-314');
    validateDecisionDocument(result);
  });

  it('MML-EXAMPLE-01 runs the packaged offline preprocessing lineage example', async () => {
    const module = await import('../../../agentic/code/addons/decision-engine/examples/preprocessing-lineage-offline.mjs') as {
      runPreprocessingLineageExample: (runtime: typeof decisionRuntime) => Promise<{
        status: string; lineageReferences: number; dispatchedTextOnly: boolean; receiptBodyFree: boolean; result: RulesetResult;
      }>;
    };
    const summary = await module.runPreprocessingLineageExample(decisionRuntime);
    expect(summary).toMatchObject({
      status: 'completed',
      lineageReferences: 1,
      dispatchedTextOnly: true,
      receiptBodyFree: true,
    });
    validateDecisionDocument(summary.result);
  });

  it('MML-DEFAULT-01 text-native requests without a manifest match the origin/main golden result, receipt and dispatch bytes', async () => {
    // The golden was generated by running text-native-cases.ts against origin/main's runtime
    // (see generate-text-native-golden.ts); this test runs the same cases against this branch.
    const golden = textNativeGolden();
    expect(golden.cases.map(item => item.id)).toEqual(['local-no-egress', 'local-receipt-store', 'network-projected']);
    const cases = await runTextNativeCases(decisionRuntime as never);
    expect(cases.map(item => ({ id: item.id, canonical: canonicalJson(item) }))).toEqual(golden.cases);
    const [local, stored, network] = cases;
    expect((local!.result as RulesetResult).apiVersion).toBe('decision.aiwg.io/v1alpha1');
    expect((stored!.receipt as { state: string }).state).toBe('completed');
    expect(network!.dispatched).toHaveLength(3);
  });

  it('MML-RECEIPT-01 accepts only body-free preprocessing lineage in RulesetResult', () => {
    const resolved = resolvePreprocessedEvidence([manifest('video-caption-segments')], { destination: jevDestination });
    const result: RulesetResult = {
      apiVersion: 'decision.aiwg.io/v1alpha2', kind: 'RulesetResult',
      metadata: { id: 'lineage-only', version: '1.0.0', description: 'lineage evidence schema check' },
      spec: {
        ruleset: artifactPin(addon<DecisionRuleset>('ruleset.json')),
        binding: artifactPin(addon<DecisionBinding>('binding-jev.json')),
        runId: 'run', invocationId: 'lineage-only', status: 'review', reason: 'insufficient-information',
        matchedRules: [], evaluations: {}, preprocessingLineage: resolved.receiptEvidence,
      },
    };
    validateDecisionDocument(result);
    (result.spec.preprocessingLineage as unknown as Record<string, unknown>).rawText = manifest('video-caption-segments').spec.output.value;
    expect(() => validateDecisionDocument(result)).toThrow();
  });

  it('MML-EVAL-REVIEW-01 routes review lineage to no-action before any dispatch', async () => {
    const value = manifest('audio-transcription');
    value.spec.policy.trust = 'verified';
    value.spec.quality.flags = ['low-quality'];
    const resolved = resolvePreprocessedEvidence([value], { destination: jevDestination, minQualityScore: 0.8 });
    const seen: unknown[] = [];
    const result = await evaluateDecisionRuleset({
      ruleset: addon<DecisionRuleset>('ruleset.json'),
      binding: addon<DecisionBinding>('binding-jev.json'),
      definitions: {
        category: addon<DecisionDefinition>('decision-category.json'),
        severity: addon<DecisionDefinition>('decision-severity.json'),
        core: addon<DecisionDefinition>('decision-core_unavailable.json'),
      },
      input: { message: resolved.state.text },
      runId: 'run', invocationId: 'mml-review',
      adapters: { jev: spyAdapter(seen) },
      resolveCredential: vi.fn(async () => new Uint8Array([1])),
      projection: { resolve: () => projectionPolicy() },
      preprocessingLineage: resolved.receiptEvidence,
      preprocessingVerification: { manifests: [value] },
    });
    expect(result.spec.status).toBe('review');
    expect(result.spec.reason).toBe('insufficient-information');
    expect(result.spec.outcome).toBeUndefined();
    expect(result.spec.preprocessingLineage?.dispatchGate).toEqual({ outcome: 'review', reasons: ['low-quality'] });
    expect(seen).toEqual([]);
  });

  it('MML-EGRESS-ORDER-01 preprocessing derived-egress denial happens before credential resolution and transport', async () => {
    // Raw media is allowed to Jev but derived text is only authorized for another destination:
    // the D10 projection itself would allow this request, so only the lineage gate can stop it.
    const value = manifest('scanned-document-ocr');
    value.spec.policy.rawEgress = { allowed: true, destinations: [jevDestination] };
    value.spec.policy.derivedEgress = { allowed: true, destinations: [{ provider: 'llm-subagent', origin: 'local://worker' }] };
    const run = async (lineageManifest: PreprocessedEvidence) => {
      const resolved = resolvePreprocessedEvidence([lineageManifest], { destination: jevDestination, requireRawEgress: true });
      const seen: unknown[] = [];
      const adapter = spyAdapter(seen);
      const evaluate = vi.spyOn(adapter, 'evaluate');
      const resolveCredential = vi.fn(async () => new Uint8Array([1]));
      const result = await evaluateDecisionRuleset({
        ruleset: addon<DecisionRuleset>('ruleset.json'),
        binding: addon<DecisionBinding>('binding-jev.json'),
        definitions: {
          category: addon<DecisionDefinition>('decision-category.json'),
          severity: addon<DecisionDefinition>('decision-severity.json'),
          core: addon<DecisionDefinition>('decision-core_unavailable.json'),
        },
        input: { message: 'Invoice 314 total 128.40 USD.' },
        runId: 'run', invocationId: 'mml-egress-order',
        adapters: { jev: adapter },
        resolveCredential,
        projection: { resolve: () => projectionPolicy() },
        preprocessingLineage: resolved.receiptEvidence,
        preprocessingVerification: { manifests: [lineageManifest] },
      });
      return { result, resolved, evaluate, resolveCredential };
    };
    const denied = await run(value);
    expect(denied.resolved.receiptEvidence.references[0]!.policy).toMatchObject({ rawEgressAllowed: true, derivedEgressAllowed: false });
    expect(denied.result.spec.status).toBe('error');
    expect(denied.result.spec.reason).toBe('data-boundary-denied');
    expect(denied.result.spec.preprocessingLineage?.dispatchGate).toEqual({ outcome: 'refused', reasons: ['derived-egress-denied'] });
    expect(denied.evaluate).not.toHaveBeenCalled();
    expect(denied.resolveCredential).not.toHaveBeenCalled();

    // Control: the identical request with derived egress authorized for Jev dispatches all three decisions.
    const allowed = structuredClone(value);
    allowed.spec.policy.derivedEgress = { allowed: true, destinations: [jevDestination] };
    const dispatched = await run(allowed);
    expect(dispatched.result.spec.status).toBe('completed');
    expect(dispatched.evaluate).toHaveBeenCalledTimes(3);
  });
});

describe('preprocessed evidence D10 lifecycle surface', () => {
  const policy = (): DecisionLifecyclePolicy => ({ version: DECISION_LIFECYCLE_VERSION,
    surfaces: Object.fromEntries(DECISION_LIFECYCLE_SURFACES.map(surface => [surface, {
      classification: 'confidential', accessScopes: ['case-worker'], retentionMs: 1_000,
      export: 'sanitized', deletion: 'erase', backup: 'expire-with-primary',
    }])) as DecisionLifecyclePolicy['surfaces'] });
  const reference = (opaqueId: string): DecisionLifecycleReference => ({ surface: 'preprocessing-lineage', opaqueId });

  it('MML-LIFE-01 cascades deletion/tombstone and honors legal hold for lineage records', async () => {
    const erased: DecisionLifecycleReference[] = [];
    const tombstones: unknown[] = [];
    let holds: Awaited<ReturnType<typeof placeDecisionLifecycleHold>>[] = [];
    const store = {
      erase: vi.fn(async (ref: DecisionLifecycleReference) => { erased.push(ref); }),
      tombstone: vi.fn(async (value: unknown) => { tombstones.push(value); }),
      links: vi.fn(async () => [reference('lineage-case-7'), { surface: 'receipt' as const, opaqueId: 'receipt-case-7' }]),
      holds: vi.fn(async () => holds),
      recordHold: vi.fn(async (hold: Awaited<ReturnType<typeof placeDecisionLifecycleHold>>) => { holds.push(hold); }),
      releaseHold: vi.fn(async () => { holds = []; }),
    };
    const hold = await placeDecisionLifecycleHold({ subject: 'case-7', reason: 'legal hold',
      scope: ['preprocessing-lineage'], expiresAt: 500, authorizedBy: 'privacy-owner' }, async () => true, store, 100);
    await expect(eraseDecisionSubject('case-7', policy(), store, 200)).rejects.toThrow(/hold/);
    holds = [{ ...hold, expiresAt: 150 }];
    const deleted = await eraseDecisionSubject('case-7', policy(), store, 200);
    expect(deleted.map(item => item.reference.surface)).toEqual(['preprocessing-lineage', 'receipt']);
    expect(erased).toEqual([reference('lineage-case-7'), { surface: 'receipt', opaqueId: 'receipt-case-7' }]);
    expect(tombstones).toHaveLength(2);
  });
});

describe('D24 round-2 review regressions', () => {
  const llmSubagent = { provider: 'llm-subagent', origin: 'local://worker' };
  const addonRequest = (overrides: Record<string, unknown>) => ({
    ruleset: addon<DecisionRuleset>('ruleset.json'),
    binding: addon<DecisionBinding>('binding-jev.json'),
    definitions: {
      category: addon<DecisionDefinition>('decision-category.json'),
      severity: addon<DecisionDefinition>('decision-severity.json'),
      core: addon<DecisionDefinition>('decision-core_unavailable.json'),
    },
    runId: 'run',
    projection: { resolve: () => projectionPolicy() },
    ...overrides,
  });
  /** A Jev network adapter plus transport and credential spies. */
  const spies = () => {
    const seen: unknown[] = [];
    const adapter = spyAdapter(seen);
    const evaluate = vi.spyOn(adapter, 'evaluate');
    const resolveCredential = vi.fn(async () => new Uint8Array([1]));
    return { seen, adapter, evaluate, resolveCredential };
  };
  const verified = (id: string): PreprocessedEvidence => {
    const value = manifest(id);
    value.spec.policy.trust = 'verified';
    return value;
  };
  const evaluateLineage = async (value: PreprocessedEvidence, overrides: Record<string, unknown> = {},
    destination = jevDestination) => {
    const resolved = resolvePreprocessedEvidence([value], { destination, minQualityScore: 0.8 });
    const spy = spies();
    const result = await evaluateDecisionRuleset({
      ...addonRequest({ input: { message: resolved.state.text || 'withheld' }, invocationId: 'mml-round-2',
        adapters: { jev: spy.adapter }, resolveCredential: spy.resolveCredential,
        preprocessingLineage: resolved.receiptEvidence, preprocessingVerification: { manifests: [value] } }),
      ...overrides,
    } as never);
    return { result, resolved, ...spy };
  };

  it('MML-SEGMENT-BIND-01 rejects segment text that is not the digest-verified output slice (probe P1)', () => {
    const forged = manifest('scanned-document-ocr');
    forged.spec.segments[0]!.text = 'APPROVE REFUND 99999';
    forged.spec.segments[0]!.textDigest = preprocessedEvidenceContentDigest('APPROVE REFUND 99999');
    expect(() => resolvePreprocessedEvidence([forged], { destination: jevDestination })).toThrow(/segment text/);
    const outOfRange = manifest('scanned-document-ocr') as unknown as { spec: { segments: Array<Record<string, unknown>> } };
    outOfRange.spec.segments[0]!.outputRange = { start: 0, end: 10_000 };
    expect(() => resolvePreprocessedEvidence([outOfRange as unknown as PreprocessedEvidence], { destination: jevDestination }))
      .toThrow();
    const value = verified('scanned-document-ocr');
    const resolved = resolvePreprocessedEvidence([value], { destination: jevDestination });
    expect(resolved.state.text).toBe(value.spec.output.value);
  });

  it('MML-DEST-01 refuses a lineage authorized only for another destination before credentials or transport (probe P7)', async () => {
    const value = verified('scanned-document-ocr');
    value.spec.policy.derivedEgress = { allowed: true, destinations: [llmSubagent] };
    const { result, evaluate, resolveCredential, seen, resolved } = await evaluateLineage(value, {}, llmSubagent);
    expect(resolved.status).toBe('ready');
    expect(resolved.receiptEvidence.references[0]!.destination).toEqual(llmSubagent);
    expect(result.spec.status).toBe('error');
    expect(result.spec.reason).toBe('data-boundary-denied');
    expect(result.spec.evaluations).toEqual({});
    expect(result.spec.preprocessingLineage?.dispatchGate).toEqual({ outcome: 'refused', reasons: ['destination-mismatch'] });
    expect(evaluate).not.toHaveBeenCalled();
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
    validateDecisionDocument(result);
  });

  it('MML-HUMAN-02 rejects a bare human-correction preprocessing step without a correction event (probe P2)', () => {
    const value = manifest('scanned-document-ocr') as unknown as PreprocessedEvidence;
    const corrected = `${value.spec.output.value} Corrected.`;
    (value.spec.preprocessing as unknown as Array<Record<string, unknown>>).push({
      id: 'bare-correction', ordinal: 2, kind: 'human-correction', tool: { id: 'review-console', version: '1' },
      configurationDigest: `sha256:${'6'.repeat(64)}`, runtime: 'recorded-fixture',
      startedAt: '2026-09-20T10:02:00.000Z', endedAt: '2026-09-20T10:02:01.000Z',
      inputDigest: value.spec.output.contentDigest, outputDigest: preprocessedEvidenceContentDigest(corrected),
    });
    value.spec.output = { ...value.spec.output, value: corrected, contentDigest: preprocessedEvidenceContentDigest(corrected) };
    value.spec.selectedSegments[0]!.outputDigest = value.spec.output.contentDigest;
    expect(preprocessingSchema(value)).toBe(false);
    expect(() => resolvePreprocessedEvidence([value], { destination: jevDestination })).toThrow(/preprocessing step/);
  });

  it('MML-REMOTE-02 rejects an unauthorized remote-url output reference like a source locator (probe P3)', () => {
    const value = manifest('scanned-document-ocr');
    value.spec.output.reference = { class: 'remote-url', value: 'https://example.invalid/derived.txt' };
    expect(() => resolvePreprocessedEvidence([value], { destination: jevDestination })).toThrow(/output locator class/);
    const allowedLocal = manifest('scanned-document-ocr');
    allowedLocal.spec.output.reference = { class: 'artifact-ref', value: 'artifact:derived-314' };
    expect(() => resolvePreprocessedEvidence([allowedLocal], { destination: jevDestination })).not.toThrow();
  });

  it('MML-FLAGS-01 routes quality-flagged lineage to review before dispatch, even with traces removed (probes P5b, P6)', async () => {
    const value = verified('scanned-document-ocr');
    value.spec.quality.flags = ['truncated'];
    const flagged = await evaluateLineage(value);
    expect(flagged.result.spec.status).toBe('review');
    expect(flagged.result.spec.reason).toBe('insufficient-information');
    expect(flagged.evaluate).not.toHaveBeenCalled();
    expect(flagged.resolveCredential).not.toHaveBeenCalled();

    const resolved = resolvePreprocessedEvidence([value], { destination: jevDestination });
    const hostLineage = { ...resolved.receiptEvidence, status: 'ready', traces: [] };
    const traceless = await evaluateLineage(value, { preprocessingLineage: hostLineage });
    expect(traceless.result.spec.status).toBe('review');
    expect(traceless.result.spec.preprocessingLineage?.dispatchGate?.reasons).toContain('truncated');
    expect(traceless.evaluate).not.toHaveBeenCalled();
    expect(traceless.resolveCredential).not.toHaveBeenCalled();
  });

  it('MML-EMPTY-01 treats an empty lineage resolution as absent, byte-identical to the origin/main golden (probe P8)', async () => {
    const empty = resolvePreprocessedEvidence([], { destination: jevDestination }).receiptEvidence;
    const cases = await runTextNativeCases(decisionRuntime as never, { preprocessingLineage: empty });
    expect(cases.map(item => ({ id: item.id, canonical: canonicalJson(item) }))).toEqual(textNativeGolden().cases);
  });

  it('MML-PRIVACY-02 keeps free-text retention and residency out of receipts and traces (probe P11)', () => {
    const value = manifest('scanned-document-ocr');
    value.spec.policy.retention = 'retain until synthetic-retention-canary@example.invalid approves';
    value.spec.policy.residency = 'synthetic-residency-canary vault';
    const resolved = resolvePreprocessedEvidence([value], { destination: jevDestination });
    expect(scanTelemetryCanaries(resolved.receiptEvidence,
      ['synthetic-retention-canary@example.invalid', 'synthetic-residency-canary'])).toEqual([]);
    expect(resolved.receiptEvidence.references[0]!.policy.retentionDigest)
      .toBe(preprocessedEvidenceContentDigest(value.spec.policy.retention));
  });

  it('MML-SCHEMA-ALIGN-01 runtime rejects every schema violation the closed schema rejects (probe P10)', () => {
    const violations: Array<[string, (value: PreprocessedEvidence) => void, string?]> = [
      ['negative time range', value => { value.spec.segments[0]!.sourceLocator = { startMs: -5, endMs: -1 }; }, 'audio-transcription'],
      ['zero page', value => { value.spec.segments[0]!.sourceLocator = { page: 0 }; }],
      ['negative bbox width', value => { value.spec.segments[0]!.sourceLocator.bbox!.width = -1; }],
      ['non-semver metadata version', value => { value.metadata.version = 'v1'; }],
      ['non date-time acquiredAt', value => { value.spec.source.acquiredAt = 'yesterday'; }],
      ['non date-time transformation', value => {
        value.spec.transformations.push({ id: 't', kind: 'normalization', inputDigest: value.spec.output.contentDigest,
          outputDigest: value.spec.output.contentDigest, at: '1' });
      }],
    ];
    for (const [label, mutate, fixture = 'scanned-document-ocr'] of violations) {
      const value = manifest(fixture);
      mutate(value);
      expect(preprocessingSchema(value), label).toBe(false);
      expect(() => resolvePreprocessedEvidence([value], { destination: jevDestination }), label).toThrow(PreprocessedEvidenceError);
    }
  });

  it('MML-TRUST-01 untrusted derived evidence resolves to review and is not dispatched (probe P4)', async () => {
    const value = manifest('audio-transcription');
    expect(value.spec.policy.trust).toBe('untrusted');
    const resolved = resolvePreprocessedEvidence([value], { destination: jevDestination });
    expect(resolved.status).toBe('review');
    expect(resolved.reasons).toContain('untrusted');
    const evaluated = await evaluateLineage(value);
    expect(evaluated.result.spec.status).toBe('review');
    expect(evaluated.evaluate).not.toHaveBeenCalled();
  });

  it('MML-STALE-02 evaluator checks stored references against current manifests before dispatch', async () => {
    const stored = verified('scanned-document-ocr');
    const current = structuredClone(stored);
    current.spec.preprocessing[0]!.model!.version = '2';
    const stale = await evaluateLineage(stored, { preprocessingVerification: { manifests: [current] } });
    expect(stale.result.spec.status).toBe('review');
    expect(stale.result.spec.preprocessingLineage?.dispatchGate?.reasons).toContain('stale');
    expect(stale.evaluate).not.toHaveBeenCalled();
    expect(stale.resolveCredential).not.toHaveBeenCalled();

    const unverified = await evaluateLineage(stored, { preprocessingVerification: undefined });
    expect(unverified.result.spec.status).toBe('review');
    expect(unverified.result.spec.preprocessingLineage?.dispatchGate?.reasons).toContain('unverified');
    expect(unverified.evaluate).not.toHaveBeenCalled();

    const fresh = await evaluateLineage(stored);
    expect(fresh.result.spec.status).toBe('completed');
    expect(fresh.evaluate).toHaveBeenCalledTimes(3);
  });

  it('MML-LIFE-02 tombstoned, held or unavailable lineage invalidates dependents and never falls back to stale text', async () => {
    const value = verified('scanned-document-ocr');
    const lineageLinks = preprocessingLifecycleReferences(value);
    expect(lineageLinks.map(item => item.role).sort()).toEqual(['manifest', 'output', 'source', 'transformation']);
    expect(lineageLinks.every(item => item.reference.surface === 'preprocessing-lineage')).toBe(true);
    const tombstones: DecisionLifecycleTombstone[] = [];
    const store = {
      erase: vi.fn(async () => undefined),
      tombstone: vi.fn(async (entry: DecisionLifecycleTombstone) => { tombstones.push(entry); }),
      links: vi.fn(async () => [...lineageLinks.map(item => item.reference), { surface: 'receipt' as const, opaqueId: 'receipt-2617' }]),
      holds: vi.fn(async () => []),
      recordHold: vi.fn(async () => undefined),
      releaseHold: vi.fn(async () => undefined),
    };
    const lifecyclePolicy: DecisionLifecyclePolicy = { version: DECISION_LIFECYCLE_VERSION,
      surfaces: Object.fromEntries(DECISION_LIFECYCLE_SURFACES.map(surface => [surface, {
        classification: 'confidential', accessScopes: ['case-worker'], retentionMs: 10_000,
        export: 'sanitized', deletion: 'erase', backup: 'expire-with-primary',
      }])) as DecisionLifecyclePolicy['surfaces'] };
    await eraseDecisionSubject('case-2617', lifecyclePolicy, store, 200);
    const erased = { subject: 'case-2617', now: 300, tombstones, holds: [] };

    const resolvedAfterErase = resolvePreprocessedEvidence([value], { destination: jevDestination, lifecycle: erased });
    expect(resolvedAfterErase.status).toBe('review');
    expect(resolvedAfterErase.reasons).toContain('lifecycle-unavailable');
    expect(resolvedAfterErase.state.text).toBe('');

    const afterErase = await evaluateLineage(value, { preprocessingVerification: { manifests: [value], lifecycle: erased } });
    expect(afterErase.result.spec.status).toBe('review');
    expect(afterErase.result.spec.preprocessingLineage?.dispatchGate?.reasons).toContain('lifecycle-unavailable');
    expect(afterErase.evaluate).not.toHaveBeenCalled();
    expect(afterErase.resolveCredential).not.toHaveBeenCalled();

    // A tombstoned transformation shared by two manifests invalidates both dependents.
    const sibling = structuredClone(value);
    sibling.metadata.id = 'sibling-manifest';
    const step = lineageLinks.find(item => item.role === 'transformation')!.reference;
    const stepOnly = { subject: 'case-2617', now: 300, holds: [],
      tombstones: [{ subject: 'case-2617', reference: step, deletedAt: 200 }] };
    for (const dependent of [value, sibling]) {
      expect(resolvePreprocessedEvidence([dependent], { destination: jevDestination, lifecycle: stepOnly }).reasons)
        .toContain('lifecycle-unavailable');
    }

    const held = { subject: 'case-2617', now: 300, tombstones: [], holds: [{ subject: 'case-2617', reason: 'litigation',
      scope: ['preprocessing-lineage' as const], expiresAt: 1_000, authorizedBy: 'privacy-owner' }] };
    const onHold = await evaluateLineage(value, { preprocessingVerification: { manifests: [value], lifecycle: held } });
    expect(onHold.result.spec.preprocessingLineage?.dispatchGate?.reasons).toContain('legal-hold');
    expect(onHold.evaluate).not.toHaveBeenCalled();

    const deleted = await evaluateLineage(value, { preprocessingVerification: { manifests: [] } });
    expect(deleted.result.spec.status).toBe('review');
    expect(deleted.result.spec.preprocessingLineage?.dispatchGate?.reasons).toContain('unavailable');
    expect(deleted.evaluate).not.toHaveBeenCalled();

    const restored = await restoreDecisionSubjectBackup(lineageLinks.map(item => ({ subject: 'case-2617',
      reference: item.reference, createdAt: 100 })), lifecyclePolicy, tombstones,
    { 'preprocessing-lineage': vi.fn(async () => undefined) }, 300);
    expect(restored.restored).toEqual([]);
    expect(restored.refused.every(item => item.reason === 'tombstoned')).toBe(true);
  });

  it('MML-CACHE-01 refuses the result cache for lineage requests so a cache hit cannot bypass the gate', async () => {
    const value = verified('scanned-document-ocr');
    const resolved = resolvePreprocessedEvidence([value], { destination: jevDestination });
    const spy = spies();
    const service = { evaluate: vi.fn() };
    await expect(evaluateDecisionRuleset(addonRequest({ input: { message: resolved.state.text }, invocationId: 'mml-cache',
      adapters: { jev: spy.adapter }, resolveCredential: spy.resolveCredential,
      preprocessingLineage: resolved.receiptEvidence, preprocessingVerification: { manifests: [value] },
      resultCache: { policy: { enabled: true, sideEffectFree: true }, service } }) as never))
      .rejects.toThrow(/preprocessing lineage/);
    expect(service.evaluate).not.toHaveBeenCalled();
    expect(spy.evaluate).not.toHaveBeenCalled();
  });

  it('MML-NOOP-01 records identity steps explicitly as no-op in the manifest and the lineage trace', () => {
    const value = manifest('scanned-document-ocr');
    value.spec.preprocessing.unshift({
      id: 'noop-normalize', ordinal: 1, kind: 'normalization', tool: { id: 'fixture-normalizer', version: '1' },
      configurationDigest: `sha256:${'1'.repeat(64)}`, runtime: 'recorded-fixture',
      startedAt: '2026-09-20T10:00:30.000Z', endedAt: '2026-09-20T10:00:31.000Z',
      inputDigest: value.spec.source.contentDigest, outputDigest: value.spec.source.contentDigest,
    });
    value.spec.preprocessing[1]!.ordinal = 2;
    expect(() => resolvePreprocessedEvidence([value], { destination: jevDestination })).toThrow(/no-op/);
    (value.spec.preprocessing[0] as unknown as Record<string, unknown>).noOp = true;
    expect(preprocessingSchema(value), JSON.stringify(preprocessingSchema.errors)).toBe(true);
    const resolved = resolvePreprocessedEvidence([value], { destination: jevDestination });
    expect(resolved.receiptEvidence.traces[0]!.noOpStepIds).toEqual(['noop-normalize']);
    const mislabelled = manifest('scanned-document-ocr');
    (mislabelled.spec.preprocessing[0] as unknown as Record<string, unknown>).noOp = true;
    expect(() => resolvePreprocessedEvidence([mislabelled], { destination: jevDestination })).toThrow(/no-op/);
  });
});
