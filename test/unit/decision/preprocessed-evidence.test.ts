import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '../../../src/security/artifact-trust.js';
import {
  artifactPin,
  evaluateDecisionRuleset,
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

interface FixtureFile { fixtures: Array<{ id: string; manifest: PreprocessedEvidence }> }

const fixtureFile = (): FixtureFile => JSON.parse(readFileSync('test/fixtures/decision/preprocessing/multimodal-lineage-v1.json', 'utf8')) as FixtureFile;
const manifest = (id: string): PreprocessedEvidence => structuredClone(fixtureFile().fixtures.find(item => item.id === id)!.manifest);
const addon = <T>(name: string): T => JSON.parse(readFileSync(`agentic/code/addons/decision-engine/examples/${name}`, 'utf8')) as T;
const schema = (name: string) => JSON.parse(readFileSync(`schemas/decision/${name}`, 'utf8')) as object;

const ajv = new Ajv2020({ strict: true, allErrors: true });
(addFormats as unknown as (value: Ajv2020) => void)(ajv);
const preprocessingSchema = ajv.compile(schema('PreprocessedEvidence.v1.schema.json'));

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
      expect(() => resolvePreprocessedEvidence([value], { destination: 'jev', minQualityScore: 0.8 })).not.toThrow();
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
          at: '2026-09-20T10:02:01.000Z', reviewer: 'reviewer-fixture', rationale: 'Corrected OCR total' });
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
    expect(() => resolvePreprocessedEvidence([broken], { destination: 'jev' })).toThrow(/continuity/);
    const mismatch = structuredClone(source);
    mismatch.spec.output.value += ' changed';
    expect(() => resolvePreprocessedEvidence([mismatch], { destination: 'jev' })).toThrow(/output content digest/);
    const wrongType = structuredClone(source);
    wrongType.spec.source.mediaType = '';
    expect(() => resolvePreprocessedEvidence([wrongType], { destination: 'jev' })).toThrow(PreprocessedEvidenceError);
    const cycle = structuredClone(source);
    cycle.spec.preprocessing.push({ ...structuredClone(cycle.spec.preprocessing[0]!), id: 'cycle', ordinal: 2,
      inputDigest: cycle.spec.preprocessing[0]!.outputDigest, outputDigest: cycle.spec.source.contentDigest });
    expect(() => resolvePreprocessedEvidence([cycle], { destination: 'jev' })).toThrow(/cycle/);
    const remote = structuredClone(source);
    remote.spec.source.locator = { class: 'remote-url', value: 'https://example.invalid/raw.pdf' };
    expect(() => resolvePreprocessedEvidence([remote], { destination: 'jev' })).toThrow(/locator class/);
    const unsupported = structuredClone(source) as unknown as { spec: { transformations: Array<Record<string, unknown>> } };
    unsupported.spec.transformations.push({ id: 'unsupported', kind: 'rotate', inputDigest: source.spec.output.contentDigest,
      outputDigest: source.spec.output.contentDigest, at: '2026-09-20T10:05:00.000Z' });
    expect(preprocessingSchema(unsupported)).toBe(false);
    expect(() => resolvePreprocessedEvidence([unsupported as unknown as PreprocessedEvidence], { destination: 'jev' })).toThrow(/transformation/);
  });

  it('MML-ROUTE-01 marks stale, low-quality, truncated and incomplete extraction for review without relabeling confidence', () => {
    const value = manifest('audio-transcription');
    value.spec.quality = { ...value.spec.quality, score: 0.3, flags: ['low-quality', 'truncated', 'incomplete'] };
    value.spec.selectedSegments[0]!.outputVersion = 2;
    const resolved = resolvePreprocessedEvidence([value], {
      destination: 'jev', minQualityScore: 0.8, maxAgeMs: 1,
      now: () => Date.parse('2026-09-29T00:00:00.000Z'),
    });
    expect(resolved.status).toBe('review');
    expect(resolved.reasons).toEqual(expect.arrayContaining(['low-quality', 'truncated', 'incomplete', 'stale']));
    expect(resolved.receiptEvidence.references[0]!.quality).toMatchObject({
      source: 'preprocessor', profile: 'fixture-asr-quality-v1', label: 'word-confidence', score: 0.3,
    });
    expect(canonicalJson(resolved.receiptEvidence)).not.toContain(value.spec.output.value);
  });

  it('MML-POLICY-01 evaluates raw and derived egress independently before dispatch', () => {
    const rawDeniedDerivedAllowed = resolvePreprocessedEvidence([manifest('image-description')], { destination: 'jev' });
    expect(rawDeniedDerivedAllowed.status).toBe('ready');
    expect(rawDeniedDerivedAllowed.state.text).toContain('Image description');
    expect(rawDeniedDerivedAllowed.receiptEvidence.references[0]!.policy).toMatchObject({
      rawEgressAllowed: false, derivedEgressAllowed: true,
    });

    const derivedDenied = manifest('image-description');
    derivedDenied.spec.policy.rawEgress = { allowed: true, destinations: ['jev'] };
    derivedDenied.spec.policy.derivedEgress = { allowed: false, destinations: [] };
    const denied = resolvePreprocessedEvidence([derivedDenied], { destination: 'jev' });
    expect(denied.status).toBe('review');
    expect(denied.reasons).toContain('derived-egress-denied');
    expect(denied.state.text).toBe('');
  });
});

describe('preprocessed evidence evaluator integration', () => {
  it('MML-E2E-01 projects recorded extraction text into Jev input while receipts keep only lineage refs', async () => {
    const resolved = resolvePreprocessedEvidence([manifest('scanned-document-ocr')], { destination: 'jev', minQualityScore: 0.8 });
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

  it('MML-DEFAULT-01 leaves text-native decisions byte-identical when no manifest is present', async () => {
    const baseRequest = {
      ruleset: addon<DecisionRuleset>('ruleset.json'),
      binding: addon<DecisionBinding>('binding-jev.json'),
      definitions: {
        category: addon<DecisionDefinition>('decision-category.json'),
        severity: addon<DecisionDefinition>('decision-severity.json'),
        core: addon<DecisionDefinition>('decision-core_unavailable.json'),
      },
      input: addon('input.json'),
      runId: 'run',
      adapters: { jev: spyAdapter([], 'none') },
      now: () => 1000,
    };
    const plain = await evaluateDecisionRuleset({ ...baseRequest, invocationId: 'plain' });
    const disabled = await evaluateDecisionRuleset({ ...baseRequest, invocationId: 'plain' });
    expect(canonicalJson(disabled)).toBe(canonicalJson(plain));
    expect((plain as RulesetResult).apiVersion).toBe('decision.aiwg.io/v1alpha1');
    expect((plain.spec as Record<string, unknown>).preprocessingLineage).toBeUndefined();
  });

  it('MML-RECEIPT-01 accepts only body-free preprocessing lineage in RulesetResult', () => {
    const resolved = resolvePreprocessedEvidence([manifest('video-caption-segments')], { destination: 'jev' });
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
});
