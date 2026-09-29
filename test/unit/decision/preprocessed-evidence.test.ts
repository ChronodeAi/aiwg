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
  type DecisionLifecyclePolicy,
  type DecisionLifecycleReference,
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
        value.spec.preprocessing.push({
          id: 'human-correction-1', ordinal: 2, kind: 'human-correction', tool: { id: 'review-console', version: '1' },
          configurationDigest: `sha256:${'6'.repeat(64)}`, runtime: 'recorded-fixture',
          startedAt: '2026-09-20T10:02:00.000Z', endedAt: '2026-09-20T10:02:01.000Z',
          inputDigest: value.spec.output.contentDigest,
          outputDigest: 'sha256:d09c74665cf6543a90a43e5c78150d0a36730770266647ba1c2286001bbd299c',
        });
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
      { id: 'video-0-4s', ordinal: 1, sourceLocator: { startMs: 0, endMs: 4000, frame: 0 },
        text: '00:00 Safety guard visible.', textDigest: preprocessedEvidenceContentDigest('00:00 Safety guard visible.') },
      { id: 'video-4-8s', ordinal: 2, sourceLocator: { startMs: 4000, endMs: 8000, frame: 96 },
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
    corrected.spec.preprocessing.push({
      id: 'human-correction-1', ordinal: 2, kind: 'human-correction', tool: { id: 'review-console', version: '1' },
      configurationDigest: `sha256:${'6'.repeat(64)}`, runtime: 'recorded-fixture',
      startedAt: '2026-09-20T10:02:00.000Z', endedAt: '2026-09-20T10:02:01.000Z',
      inputDigest: prior.contentDigest, outputDigest: preprocessedEvidenceContentDigest(`${prior.value} Corrected.`),
    });
    corrected.spec.output = { ...prior, version: 2, value: `${prior.value} Corrected.`,
      contentDigest: corrected.spec.preprocessing[1]!.outputDigest };
    corrected.spec.selectedSegments[0]!.outputVersion = 2;
    corrected.spec.selectedSegments[0]!.outputDigest = corrected.spec.output.contentDigest;
    corrected.spec.segments[0]!.text = corrected.spec.output.value;
    corrected.spec.segments[0]!.textDigest = corrected.spec.output.contentDigest;
    corrected.spec.transformations.push({ id: 'human-correction-event-1', kind: 'human-correction',
      inputDigest: prior.contentDigest, outputDigest: corrected.spec.output.contentDigest, at: '2026-09-20T10:02:01.000Z',
      reviewer: 'reviewer-fixture', rationale: 'Corrected OCR total',
      previousOutput: { id: prior.id, version: prior.version, digest: prior.contentDigest } });
    expect(() => resolvePreprocessedEvidence([corrected], { destination: jevDestination })).not.toThrow();
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
      inputDigest: value.spec.source.contentDigest, outputDigest: value.spec.source.contentDigest,
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
    const rawDeniedDerivedAllowed = resolvePreprocessedEvidence([manifest('image-description')], { destination: jevDestination });
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

  it('MML-PRIVACY-01 receipt and trace lineage pass canary scans unless explicit content retention is requested', () => {
    const value = manifest('image-description');
    value.spec.output.value = 'Image description: synthetic-person-canary@example.invalid cracked seal.';
    value.spec.output.contentDigest = preprocessedEvidenceContentDigest(value.spec.output.value);
    value.spec.preprocessing[0]!.outputDigest = value.spec.output.contentDigest;
    value.spec.segments[0]!.text = value.spec.output.value;
    value.spec.segments[0]!.textDigest = value.spec.output.contentDigest;
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
    const resolved = resolvePreprocessedEvidence([manifest('scanned-document-ocr')], { destination: jevDestination, minQualityScore: 0.8 });
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
    });
    expect(result.apiVersion).toBe('decision.aiwg.io/v1alpha2');
    expect(result.spec.preprocessingLineage).toEqual(resolved.receiptEvidence);
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

  it('MML-EVAL-REVIEW-01 routes review lineage to no-action even when decisions otherwise complete', async () => {
    const value = manifest('audio-transcription');
    value.spec.quality.flags = ['low-quality'];
    const resolved = resolvePreprocessedEvidence([value], { destination: jevDestination, minQualityScore: 0.8 });
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
      adapters: { jev: spyAdapter([]) },
      resolveCredential: vi.fn(async () => new Uint8Array([1])),
      projection: { resolve: () => projectionPolicy() },
      preprocessingLineage: resolved.receiptEvidence,
    });
    expect(result.spec.status).toBe('review');
    expect(result.spec.reason).toBe('insufficient-information');
    expect(result.spec.outcome).toBeUndefined();
  });

  it('MML-EGRESS-ORDER-01 projection denial happens before credential resolution', async () => {
    const resolved = resolvePreprocessedEvidence([manifest('scanned-document-ocr')], { destination: jevDestination });
    const resolveCredential = vi.fn(async () => new Uint8Array([1]));
    const badPolicy = projectionPolicy();
    badPolicy.origin = 'https://denied.example.invalid';
    const result = await evaluateDecisionRuleset({
      ruleset: addon<DecisionRuleset>('ruleset.json'),
      binding: addon<DecisionBinding>('binding-jev.json'),
      definitions: {
        category: addon<DecisionDefinition>('decision-category.json'),
        severity: addon<DecisionDefinition>('decision-severity.json'),
        core: addon<DecisionDefinition>('decision-core_unavailable.json'),
      },
      input: { message: resolved.state.text },
      runId: 'run', invocationId: 'mml-egress-order',
      adapters: { jev: spyAdapter([]) },
      resolveCredential,
      projection: { resolve: () => badPolicy },
      preprocessingLineage: resolved.receiptEvidence,
    });
    expect(result.spec.status).toBe('review');
    expect(resolveCredential).not.toHaveBeenCalled();
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
