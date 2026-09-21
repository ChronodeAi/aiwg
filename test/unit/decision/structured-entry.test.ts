import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dump as dumpYaml, load as loadYaml } from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';
import {
  admitEntry, artifactPin, convertDecisionDefinitionV1Alpha1, DEFAULT_ENTRY_LIMITS,
  EntryAdmissionError, evaluateDecisionRuleset, JevDecisionAdapter, LlmSubagentDecisionAdapter, MemoryDecisionReceiptStore, parseCompressedDecisionJson, parseDecisionJson, validateDefinition, validateDecisionDocument,
  type DecisionAdapter, type DecisionBinding, type DecisionRuleset,
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
    const yaml = dumpYaml(value);
    expect(parseDecisionDoc(yaml, 'decision.yaml')).toMatchObject({ kind: 'DecisionDefinition' });
    expect(artifactPin(loadYaml(yaml) as DecisionDefinition).digest).toBe(artifactPin(value).digest);
    const reordered = structured();
    reordered.spec.question = { context: ['plain', null, { active: true, weight: 1 }], task: 'classify' };
    expect(artifactPin(reordered).digest).toBe(artifactPin(value).digest);
    const unicode = structured();
    unicode.spec.question = { 'é': { '漢': [0.000001, -0, true, null] }, '😀': 'café' };
    const unicodeReordered = structured();
    unicodeReordered.spec.question = { '😀': 'café', 'é': { '漢': [0.000001, 0, true, null] } };
    expect(artifactPin(unicode).digest).toBe(artifactPin(unicodeReordered).digest);
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

  it('pre-admits malformed rulesets before digesting or dispatching', async () => {
    const ruleset = JSON.parse(readFileSync('examples/decision/ruleset.json', 'utf8')) as DecisionRuleset;
    (ruleset.spec as Record<string, unknown>).poison = ruleset;
    const adapter = { id: 'jev', version: '1.0.0', capabilities: vi.fn(), evaluate: vi.fn() } as unknown as DecisionAdapter;
    const result = await evaluateDecisionRuleset({
      ruleset, binding: JSON.parse(readFileSync('examples/decision/binding-jev.json', 'utf8')) as DecisionBinding,
      definitions: {}, input: { message: 'hello' }, runId: 'run', invocationId: 'bad-ruleset', adapters: { jev: adapter },
    });
    expect(result.spec.reason).toBe('invalid-definition');
    expect(adapter.evaluate).not.toHaveBeenCalled();
  });

  it('classifies cyclic input as invalid-input before dispatch', async () => {
    const input: Record<string, unknown> = { message: 'hello' }; input.self = input;
    const adapter = { id: 'jev', version: '1.0.0', capabilities: vi.fn(), evaluate: vi.fn() } as unknown as DecisionAdapter;
    const result = await evaluateDecisionRuleset({
      ruleset: JSON.parse(readFileSync('examples/decision/ruleset.json', 'utf8')) as DecisionRuleset,
      binding: JSON.parse(readFileSync('examples/decision/binding-jev.json', 'utf8')) as DecisionBinding,
      definitions: {}, input, runId: 'run', invocationId: 'bad-input', adapters: { jev: adapter },
    });
    expect(result.spec.reason).toBe('invalid-input');
    expect(adapter.evaluate).not.toHaveBeenCalled();
  });

  it('requires structured-entry capability and emits v1alpha2 provenance', async () => {
    const definition = structured();
    const ruleset = JSON.parse(readFileSync('examples/decision/ruleset.json', 'utf8')) as DecisionRuleset;
    ruleset.spec.evaluations[0]!.decision = artifactPin(definition);
    const binding = JSON.parse(readFileSync('examples/decision/binding-jev.json', 'utf8')) as DecisionBinding;
    binding.spec.ruleset = artifactPin(ruleset);
    const plain = JSON.parse(readFileSync('examples/decision/decision-severity.json', 'utf8')) as DecisionDefinition;
    const core = JSON.parse(readFileSync('examples/decision/decision-core_unavailable.json', 'utf8')) as DecisionDefinition;
    const adapter: DecisionAdapter = {
      id: 'jev', version: '1.0.0',
      capabilities: async () => ({ answerKinds: ['choice', 'ordinal-score', 'truth-probability'], features: ['typed-output'], maxOptions: 255, maxLevels: 10, confidenceProfiles: ['typesafe-distribution-v1'], executable: true }),
      evaluate: vi.fn(async () => ({ status: 'success', reason: 'none', value: 'documentation', uncertainty: null, actualModel: 'fixture', usage: { inputTokens: null, outputTokens: null, costUsd: null }, requestId: null })),
    };
    const store = new MemoryDecisionReceiptStore();
    const result = await evaluateDecisionRuleset({
      ruleset, binding, definitions: { category: definition, severity: plain, core },
      input: JSON.parse(readFileSync('examples/decision/input.json', 'utf8')),
      runId: 'run', invocationId: 'structured-run', adapters: { jev: adapter }, receiptStore: store,
    });
    expect(result.apiVersion).toBe('decision.aiwg.io/v1alpha2');
    expect(result.spec.evaluations.category?.apiVersion).toBe('decision.aiwg.io/v1alpha2');
    expect(result.spec.evaluations.category?.spec.reason).toBe('unsupported-capability');
    expect(vi.mocked(adapter.evaluate).mock.calls.some(([req]) => req.alias === 'category')).toBe(false);
    const receipt = await store.read('structured-run');
    expect(receipt?.result?.apiVersion).toBe('decision.aiwg.io/v1alpha2');
    expect(receipt?.result?.spec.evaluations.category?.spec.decision.digest).toBe(artifactPin(definition).digest);
    validateDecisionDocument(result);
  });

  it('keeps planned state, instructions, and target controls isolated from adapter mutation', async () => {
    const definition = structured();
    const originalQuestion = structuredClone(definition.spec.question);
    const ruleset = JSON.parse(readFileSync('examples/decision/ruleset.json', 'utf8')) as DecisionRuleset;
    ruleset.spec.evaluations[0]!.decision = artifactPin(definition);
    const binding = JSON.parse(readFileSync('examples/decision/binding-jev.json', 'utf8')) as DecisionBinding;
    binding.spec.ruleset = artifactPin(ruleset);
    const input = JSON.parse(readFileSync('examples/decision/input.json', 'utf8')) as { message: string };
    const originalInput = structuredClone(input);
    const adapter: DecisionAdapter = {
      id: 'jev', version: '1.0.0',
      capabilities: async () => ({ answerKinds: ['choice', 'ordinal-score', 'truth-probability'], features: ['structured-entries'], maxOptions: 255, maxLevels: 10, confidenceProfiles: ['typesafe-distribution-v1'], executable: true }),
      evaluate: async req => {
        req.definition.spec.question = { state: 'override', model: 'override', questions: 'override' };
        (req.input as { message: string }).message = 'changed';
        req.target.model = 'override';
        return { status: 'success', reason: 'none', value: req.alias === 'category' ? 'documentation' : 0.1,
          uncertainty: null, actualModel: 'fixture', usage: { inputTokens: null, outputTokens: null, costUsd: null }, requestId: null };
      },
    };
    const result = await evaluateDecisionRuleset({
      ruleset, binding, definitions: { category: definition,
        severity: JSON.parse(readFileSync('examples/decision/decision-severity.json', 'utf8')) as DecisionDefinition,
        core: JSON.parse(readFileSync('examples/decision/decision-core_unavailable.json', 'utf8')) as DecisionDefinition },
      input, runId: 'run', invocationId: 'mutation-test', adapters: { jev: adapter },
    });
    expect(definition.spec.question).toEqual(originalQuestion);
    expect(input).toEqual(originalInput);
    expect(binding.spec.evaluations.category?.targets[0]?.model).toBe('jev-latest');
    expect(result.spec.evaluations.category?.spec.attempts[0]?.requestedModel).toBe('jev-latest');
  });

});
