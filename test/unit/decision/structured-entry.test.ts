import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  admitEntry, artifactPin, convertDecisionDefinitionV1Alpha1, DEFAULT_ENTRY_LIMITS,
  EntryAdmissionError, JevDecisionAdapter, LlmSubagentDecisionAdapter, parseCompressedDecisionJson, parseDecisionJson, validateDefinition, validateDecisionDocument,
  type DecisionDefinition, type DecisionAdapterRequest,
} from '../../../src/decision/index.js';
import { parseDecisionDoc } from '../../../src/artifacts/index-builder.js';

const old = (): DecisionDefinition => JSON.parse(readFileSync('examples/decision/decision-category.json', 'utf8')) as DecisionDefinition;
const structured = (): DecisionDefinition => {
  const value = convertDecisionDefinitionV1Alpha1(old()).definition;
  value.spec.question = { task: 'classify', context: ['plain', null, { weight: 1, active: true }] };
  if (value.spec.answer.kind === 'choice') value.spec.answer.options[0]!.description = { reason: 'documentation', hints: [null, 'guide'] };
  return value;
};
const request = (definition: DecisionDefinition): DecisionAdapterRequest => ({
  alias: 'category', definition, input: { message: 'example' },
  target: { adapter: 'jev', adapterVersion: '1.0.0', model: 'fixture', credentialRef: 'fixture', requiredCapabilities: [], acceptance: { mode: 'typed-value' }, timeoutMs: 1000, retry: { maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0 } },
  invocationId: 'structured-test', deadlineEpochMs: Date.now() + 1000,
  signal: new AbortController().signal, resolveCredential: async () => new TextEncoder().encode('token'),
});

describe('decision structured entry contract', () => {
  it('keeps v1alpha1 digests and converts explicitly to a new v1alpha2 digest', () => {
    const source = old();
    const before = artifactPin(source).digest;
    validateDefinition(source);
    const converted = convertDecisionDefinitionV1Alpha1(source);
    expect(converted.previousDigest).toBe(before);
    expect(converted.digest).not.toBe(before);
    expect(source.apiVersion).toBe('decision.aiwg.io/v1alpha1');
    expect(converted.definition.apiVersion).toBe('decision.aiwg.io/v1alpha2');
    validateDefinition(converted.definition);
  });

  it('round trips nested values through schema, canonical digest, JSON parser, and discovery', () => {
    const value = structured();
    validateDefinition(value);
    const source = JSON.stringify(value);
    expect(parseDecisionJson(source)).toEqual(value);
    expect(artifactPin(parseDecisionJson(source) as DecisionDefinition)).toEqual(artifactPin(value));
    expect(parseDecisionDoc(source, 'decision.json')).toMatchObject({ kind: 'DecisionDefinition' });
    const reordered = structured();
    reordered.spec.question = { context: ['plain', null, { active: true, weight: 1 }], task: 'classify' };
    expect(artifactPin(reordered).digest).toBe(artifactPin(value).digest);
  });

  it.each([
    ['cycle', () => { const x: Record<string, unknown> = {}; x.self = x; return x; }],
    ['function', () => ({ value: () => 1 })],
    ['symbol', () => ({ [Symbol('key')]: 1 })],
    ['nonfinite', () => ({ value: Number.POSITIVE_INFINITY })],
    ['prototype', () => Object.create({ inherited: 'bad' })],
    ['unsafe-key', () => JSON.parse('{"__proto__":true}')],
    ['depth', () => { let x: unknown = 'leaf'; for (let i = 0; i < 34; i++) x = [x]; return x; }],
    ['property-count', () => Object.fromEntries(Array.from({ length: 4097 }, (_, i) => [`k${i}`, i]))],
    ['array-length', () => Array.from({ length: 4097 }, () => 1)],
    ['proxy', () => new Proxy({}, { get: () => { throw new Error('must not execute'); } })],
    ['array-getter', () => { const x = [1]; Object.defineProperty(x, 0, { get: () => { throw new Error('must not execute'); } }); return x; }],
    ['array-symbol', () => Object.assign([1], { [Symbol('key')]: true })],
    ['string-length', () => 'a'.repeat(65_537)],
  ] as const)('rejects %s before canonicalization', (_name, make) => {
    expect(() => admitEntry(make())).toThrow();
  });

  it('rejects duplicate JSON keys, unsupported fields, and primitive domain violations', () => {
    expect(() => parseDecisionJson('{"a":1,"a":2}')).toThrow(/duplicate/);
    const value = structured();
    (value.spec as Record<string, unknown>).state = { admin: true };
    expect(() => validateDefinition(value)).toThrow();
    delete (value.spec as Record<string, unknown>).state;
    if (value.spec.answer.kind === 'choice') value.spec.answer.options = value.spec.answer.options.slice(0, 1);
    expect(() => validateDefinition(value)).toThrow();
  });

  it('keeps the structured Jev instruction and criteria as JSON values', async () => {
    const definition = structured();
    let body: Record<string, unknown> | undefined;
    const adapter = new JevDecisionAdapter({ fetch: vi.fn(async (_url, options) => {
      body = JSON.parse(String(options?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ answers: { category: { type: 'choice', choice: 'documentation', probabilities: { documentation: 1, code: 0, configuration: 0 }, confidence: 1 } }, model: 'fixture' }), { status: 200 });
    }) as typeof fetch });
    await adapter.evaluate(request(definition));
    const question = (body?.questions as Record<string, Record<string, unknown>>).category;
    expect(question.instructions).toEqual(definition.spec.question);
    expect((question.criteria as Record<string, unknown>).documentation).toEqual(definition.spec.answer.kind === 'choice' ? definition.spec.answer.options[0]?.description : null);
    expect(body?.state).toEqual({ message: 'example' });
    expect(body?.model).toBe('fixture');
  });

  it('passes structured values through the subagent prompt as JSON', async () => {
    const definition = structured();
    const worker = { metadata: { id: 'worker', version: '1.0.0' } };
    const workerPin = artifactPin(worker);
    let prompt = '';
    const adapter = new LlmSubagentDecisionAdapter({
      resolveWorker: async () => worker,
      runWorker: async task => { prompt = task.prompt; return { started: true, terminal: true, output: { status: 'abstained', reason: 'insufficient-information' } }; },
    });
    const req = request(definition);
    req.target = { ...req.target, adapter: 'llm-subagent', subagent: workerPin };
    await adapter.evaluate(req);
    const parsed = JSON.parse(prompt) as Record<string, unknown>;
    expect(parsed.question).toEqual(definition.spec.question);
    expect(parsed.answer).toEqual(definition.spec.answer);
  });

  it('enforces explicit byte limits before parsing', () => {
    expect(() => parseDecisionJson('"' + 'x'.repeat(DEFAULT_ENTRY_LIMITS.serializedBytes) + '"')).toThrow(/serialized-bytes/);
    expect(() => parseCompressedDecisionJson(gzipSync('"' + 'x'.repeat(DEFAULT_ENTRY_LIMITS.serializedBytes) + '"'))).toThrow(/decompressed-bytes/);
  });

  it('returns a typed nonretryable reason and counts for entry/time budgets', () => {
    const many = [Array.from({ length: 4096 }, () => 1), Array.from({ length: 4096 }, () => 1)];
    expect(() => admitEntry(many)).toThrowError(EntryAdmissionError);
    try { admitEntry(many); } catch (error) {
      expect(error).toMatchObject({ reasonCode: 'entry-count', counts: { entries: 8193 } });
      expect(String(error)).not.toContain('4096');
    }
    expect(() => admitEntry({ entry: 'safe' }, { ...DEFAULT_ENTRY_LIMITS, timeMs: -1 })).toThrow(/time-budget/);
  });

  it('keeps v1alpha1 strict while dual readers accept v1alpha2 artifacts', () => {
    const definition = structured();
    validateDecisionDocument(definition);
    const oldVersion = structured(); oldVersion.apiVersion = 'decision.aiwg.io/v1alpha1';
    expect(() => validateDecisionDocument(oldVersion)).toThrow();
    for (const [file, kind] of [['ruleset.json', 'DecisionRuleset'], ['binding-jev.json', 'DecisionBinding']] as const) {
      const oldDoc = JSON.parse(readFileSync(`examples/decision/${file}`, 'utf8')) as { apiVersion: string; kind: string; spec: Record<string, unknown> };
      validateDecisionDocument(oldDoc);
      oldDoc.apiVersion = 'decision.aiwg.io/v1alpha2';
      validateDecisionDocument(oldDoc);
      expect(oldDoc.kind).toBe(kind);
      oldDoc.spec.structuredAcceptance = { override: true };
      expect(() => validateDecisionDocument(oldDoc)).toThrow();
    }
  });
});
