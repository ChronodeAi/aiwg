import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  artifactPin,
  DECISION_INTEROP_DMN_NAMESPACE,
  DECISION_INTEROP_PROFILE_VERSION,
  evaluateDmnProfile,
  exportDmnDecisionTable,
  exportOpaDecisionLog,
  importDmnDecisionTable,
  validateOpaInteropEnvelope,
  type DecisionInteropMapping,
  type DecisionResult,
  type DmnHitPolicy,
  type RulesetResult,
} from '../../../src/decision/index.js';

const fixture = <T>(name: string): T => JSON.parse(readFileSync(`agentic/code/addons/decision-engine/examples/${name}`, 'utf8')) as T;
const schema = (name: string) => JSON.parse(readFileSync(`schemas/decision/${name}.schema.json`, 'utf8'));
const pin = (id: string) => ({ id, version: '1.0.0', digest: `sha256:${'1'.repeat(64)}` as const });

function dmn(hitPolicy: DmnHitPolicy, rows: string, aggregation = '', extra = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="${DECISION_INTEROP_DMN_NAMESPACE}" xmlns:aiwg="https://aiwg.io/spec/decision-interop/v1" id="interop" name="Interop" namespace="https://aiwg.io/test">
  <decision id="route" name="Route">
    <decisionTable id="route-table" hitPolicy="${hitPolicy}"${aggregation ? ` aggregation="${aggregation}"` : ''}${extra}>
      <input id="category"><inputExpression typeRef="string"><text>/category</text></inputExpression></input>
      <input id="score"><inputExpression typeRef="number"><text>/score</text></inputExpression></input>
      <output id="outcome" name="outcome" />
${rows}
    </decisionTable>
  </decision>
</definitions>`;
}

const row = (id: string, order: number, category: string, score: string, outcome: string) => `      <rule id="${id}" aiwg:order="${order}">
        <inputEntry><text>${category}</text></inputEntry>
        <inputEntry><text>${score}</text></inputEntry>
        <outputEntry><text>${outcome}</text></outputEntry>
      </rule>`;

function importProfile(hitPolicy: DmnHitPolicy, rows: string, aggregation = '', extra = ''): DecisionInteropMapping {
  return importDmnDecisionTable(dmn(hitPolicy, rows, aggregation, extra), { origin: `${hitPolicy}.dmn`, signatureState: 'verified' });
}

describe('DMN/OPA decision interoperability profile', () => {
  function logValue(value: string) {
    const result = rulesetResult();
    result.spec.outcome = value;
    return exportOpaDecisionLog(result, {
      profileVersion: DECISION_INTEROP_PROFILE_VERSION,
      bundle: { name: 'authz', revision: 'rev-1' },
      decisionId: 'decision-1', policyPath: '/aiwg/decision/allow',
      input: { value }, inputProjectionAllowlist: ['/value'],
    });
  }

  it.each(['a'.repeat(60_000), `a@${'.'.repeat(60_000)}!`, 'a'.repeat(64 * 1024), 'a'.repeat(64 * 1024 + 1), 'a'.repeat(1_000_000)].map(value => ({ value, size: value.length })))('bounds email redaction for pathological input of length $size (alert 2)', ({ value }) => {
    const started = performance.now();
    const log = logValue(value);
    expect(performance.now() - started).toBeLessThan(5_000);
    if (value.length > 64 * 1024) {
      expect(log.result).toBe('[redacted]');
      expect(log.input).toEqual({ value: '[redacted]' });
      expect(log.redaction.removed).toEqual(['$.input/value', '$.result']);
    } else {
      expect(log.result).toBe(value);
      expect(log.input).toEqual({ value });
    }
  });

  it.each([65_535, 65_536, 65_537])('applies the OPA redaction cap at %i UTF-16 code units', size => {
    // Non-ASCII content distinguishes the string-length cap from a byte cap.
    const value = 'é'.repeat(size);
    const log = logValue(value);
    const expected = size > 65_536 ? '[redacted]' : value;
    expect(log.result).toBe(expected);
    expect(log.input).toEqual({ value: expected });
    expect(log.redaction.removed).toEqual(size > 65_536 ? ['$.input/value', '$.result'] : []);

    const sensitive = `${value.slice(0, size - 7)}a@b.com`;
    const sensitiveLog = logValue(sensitive);
    expect(sensitiveLog.result).toBe('[redacted]');
    expect(sensitiveLog.input).toEqual({ value: '[redacted]' });
    expect(sensitiveLog.redaction.removed).toEqual(['$.input/value', '$.result']);
  });

  it('emits schema-valid dry-run mapping provenance and round-trips supported DMN', () => {
    const mapping = importProfile('FIRST', [
      row('review', 1, '= "docs"', '>= 0.7', '"manual-review"'),
      row('accept', 2, '= "docs"', '-', '"docs-review"'),
    ].join('\n'), '', ' aiwg:conflict="defer-on-conflict"');
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    ajv.addSchema(schema('DecisionRuleset.v1alpha2'));
    expect(ajv.validate(schema('DecisionInteropMapping.v1'), mapping), JSON.stringify(ajv.errors)).toBe(true);
    expect(mapping.spec).toMatchObject({
      dryRun: true,
      activation: 'requires-review-publish',
      profile: { dmnVersion: '1.6', hitPolicy: 'FIRST', ruleOrder: ['review', 'accept'] },
      source: { signature: { state: 'verified' } },
    });
    const exported = exportDmnDecisionTable(mapping);
    const roundTrip = importDmnDecisionTable(exported, { trustedSource: true });
    expect(roundTrip.spec.normalizedRuleset.spec.rules).toEqual(mapping.spec.normalizedRuleset.spec.rules);
  });

  it('implements Unique, Any, First, Rule Order, and Collect hit-policy semantics exactly', () => {
    const twoEqual = [row('a', 1, '= "docs"', '-', '"same"'), row('b', 2, '= "docs"', '-', '"same"')].join('\n');
    const twoDifferent = [row('a', 1, '= "docs"', '-', '"a"'), row('b', 2, '= "docs"', '-', '"b"')].join('\n');
    expect(evaluateDmnProfile(importProfile('UNIQUE', twoEqual), { category: 'docs', score: 1 })).toMatchObject({
      status: 'error', reason: 'conflicting-outcomes', matchedRules: ['a', 'b'],
    });
    expect(evaluateDmnProfile(importProfile('ANY', twoEqual), { category: 'docs', score: 1 })).toMatchObject({
      status: 'completed', outcome: 'same', matchedRules: ['a', 'b'],
    });
    expect(evaluateDmnProfile(importProfile('ANY', twoDifferent), { category: 'docs', score: 1 })).toMatchObject({
      status: 'error', reason: 'conflicting-outcomes',
    });
    expect(evaluateDmnProfile(importProfile('FIRST', twoDifferent), { category: 'docs', score: 1 })).toMatchObject({
      status: 'completed', outcome: 'a', matchedRules: ['a'],
    });
    expect(evaluateDmnProfile(importProfile('RULE ORDER', twoDifferent), { category: 'docs', score: 1 })).toMatchObject({
      status: 'completed', outcome: ['a', 'b'], matchedRules: ['a', 'b'],
    });
    expect(evaluateDmnProfile(importProfile('COLLECT', twoDifferent), { category: 'missing', score: 1 })).toMatchObject({
      status: 'defaulted', outcome: [],
    });
    const collect = importProfile('COLLECT', [row('low', 1, '-', '&lt; 10', '1'), row('high', 2, '-', '>= 5', '3')].join('\n'), 'SUM');
    expect(evaluateDmnProfile(collect, { category: 'anything', score: 7 })).toMatchObject({ status: 'completed', outcome: 4 });
    const invalid = importProfile('COLLECT', [row('bad', 1, '-', '-', '"not-number"')].join('\n'), 'SUM');
    expect(() => evaluateDmnProfile(invalid, { category: 'anything', score: 7 })).toThrow(/requires finite numeric/);
  });

  it('does not coerce unknown or unsuccessful required evidence into a permissive match', () => {
    const xml = dmn('FIRST', row('requires-category', 1, '= "docs"', '-', '"docs-review"'))
      .replace('<decision id="route" name="Route">', '<decision id="stored" name="Stored evidence"></decision><decision id="route" name="Route"><informationRequirement><requiredDecision href="#stored"/></informationRequirement>');
    const mapping = importDmnDecisionTable(xml, { externalDecisionPins: { stored: pin('stored') } });
    expect(evaluateDmnProfile(mapping, { score: 1 }, { stored: decisionResult('success', pin('stored')) })).toMatchObject({ status: 'defaulted', outcome: null, matchedRules: [] });
    for (const status of ['abstained', 'unsupported', 'error', 'cancelled'] as const) {
      const evaluation = decisionResult(status, pin('stored'));
      expect(evaluateDmnProfile(mapping, { category: 'docs', score: 1 }, { stored: evaluation })).toMatchObject({
        status: 'review',
        reason: 'evaluation-failed',
      });
    }
  });

  it('preserves the legacy guard that any supplied failed evidence forces review, even for input-only rules', () => {
    const mapping = importProfile('FIRST', row('input-only', 1, '= "docs"', '-', '"docs-review"'));
    expect(evaluateDmnProfile(mapping, { category: 'docs', score: 1 })).toMatchObject({
      status: 'completed', outcome: 'docs-review', matchedRules: ['input-only'],
    });
    for (const status of ['abstained', 'unsupported', 'error', 'cancelled'] as const) {
      expect(evaluateDmnProfile(mapping, { category: 'docs', score: 1 }, { unrelated: decisionResult(status) })).toMatchObject({
        status: 'review', reason: 'evaluation-failed', matchedRules: [],
      });
    }
  });

  it('maps equivalent DMN information requirements to explicit external evidence dependencies', () => {
    const xml = dmn('FIRST', row('r', 1, '= "docs"', '-', '"docs-review"'))
      .replace('<decision id="route" name="Route">', '<decision id="storedEvidence" name="Stored evidence"></decision><decision id="route" name="Route"><informationRequirement><requiredDecision href="#storedEvidence"/></informationRequirement>');
    const mapping = importDmnDecisionTable(xml, { signatureState: 'verified', externalDecisionPins: { storedEvidence: pin('storedEvidence') } });
    expect(mapping.spec.normalizedRuleset.spec.evaluations).toEqual([{
      alias: 'storedEvidence',
      decision: pin('storedEvidence'),
      inputPointer: '',
    }]);
    expect(evaluateDmnProfile(mapping, { category: 'docs', score: 1 }, { storedEvidence: decisionResult('success', pin('storedEvidence'), 'storedEvidence') })).toMatchObject({
      status: 'completed', outcome: 'docs-review', matchedRules: ['r'],
    });
    expect(evaluateDmnProfile(mapping, { category: 'docs', score: 1 }, { storedEvidence: decisionResult('unsupported', pin('storedEvidence'), 'storedEvidence') })).toMatchObject({
      status: 'review', reason: 'evaluation-failed', matchedRules: [],
    });
    expect(evaluateDmnProfile(mapping, { category: 'docs', score: 1 })).toMatchObject({
      status: 'review', reason: 'evaluation-failed', matchedRules: [],
    });

    expect(evaluateDmnProfile(mapping, { category: 'docs', score: 1 }, { storedEvidence: decisionResult('success', pin('wrong'), 'storedEvidence') })).toMatchObject({
      status: 'review', reason: 'evaluation-failed', matchedRules: [],
    });
    const exported = exportDmnDecisionTable(mapping);
    const roundTrip = importDmnDecisionTable(exported, { externalDecisionPins: { storedEvidence: pin('storedEvidence') } });
    expect(roundTrip.spec.normalizedRuleset.spec.evaluations).toEqual(mapping.spec.normalizedRuleset.spec.evaluations);
  });


  it('rejects unsupported cyclic or unpinned DMN dependency graphs instead of silently weakening them', () => {
    const base = dmn('FIRST', row('r', 1, '= "docs"', '-', '"docs-review"'));
    const cyclic = base.replace('<decision id="route" name="Route">', '<decision id="storedEvidence" name="Stored evidence"><informationRequirement><requiredDecision href="#route"/></informationRequirement></decision><decision id="route" name="Route"><informationRequirement><requiredDecision href="#storedEvidence"/></informationRequirement>');
    expect(() => importDmnDecisionTable(cyclic, { externalDecisionPins: { storedEvidence: pin('storedEvidence') } })).toThrow(/cyclic/);
    const transitive = base.replace('<decision id="route" name="Route">', '<decision id="rawEvidence" name="Raw evidence"></decision><decision id="storedEvidence" name="Stored evidence"><informationRequirement><requiredDecision href="#rawEvidence"/></informationRequirement></decision><decision id="route" name="Route"><informationRequirement><requiredDecision href="#storedEvidence"/></informationRequirement>');
    expect(() => importDmnDecisionTable(transitive, { externalDecisionPins: { storedEvidence: pin('storedEvidence') } })).toThrow(/caller-supplied external decision pin/);
    const mapping = importDmnDecisionTable(transitive, { externalDecisionPins: { storedEvidence: pin('storedEvidence'), rawEvidence: pin('rawEvidence') } });
    expect(mapping.spec.normalizedRuleset.spec.evaluations.map(evaluation => evaluation.alias)).toEqual(['rawEvidence', 'storedEvidence']);
  });

  it('fails closed on unsupported FEEL, executable extensions, remote references, ambiguous order, bounds, and namespace confusion', () => {
    expect(() => importDmnDecisionTable(dmn('FIRST', row('r', 1, 'contains(category, "x")', '-', '"x"')))).toThrow(/Unsupported FEEL/);
    expect(() => importDmnDecisionTable(dmn('FIRST', row('r', 1, '-', '-', '"x"')).replace('</decisionTable>', '<literalExpression><text>1+1</text></literalExpression></decisionTable>'))).toThrow(/script-extension/);
    expect(() => importDmnDecisionTable(dmn('FIRST', row('r', 1, '-', '-', '"x"')).replace('<definitions ', '<definitions xsi:schemaLocation="https://evil.invalid/dmn.xsd" '))).toThrow(/remote-reference|parse/);
    expect(() => importDmnDecisionTable(dmn('FIRST', row('r', 1, '-', '-', '"x"')).replace(' aiwg:order="1"', ''))).toThrow(/explicit aiwg:order/);
    expect(() => importDmnDecisionTable(dmn('FIRST', row('r', 1, '-', '-', '"x"')), { bounds: { maxRules: 0 } })).toThrow(/rule count/);
    expect(() => importDmnDecisionTable(dmn('FIRST', row('r', 1, '-', '-', '"x"')).replace(DECISION_INTEROP_DMN_NAMESPACE, 'https://example.invalid/dmn'))).toThrow(/namespace/);
    expect(() => importDmnDecisionTable(`<?xml version="1.0"?><!DOCTYPE d [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><d>&xxe;</d>`)).toThrow(/dmn-doctype/);
  });

  it('exports sanitized OPA decision logs and rejects imported control-plane overrides', () => {
    const result = rulesetResult();
    const log = exportOpaDecisionLog(result, {
      profileVersion: DECISION_INTEROP_PROFILE_VERSION,
      bundle: { name: 'authz', revision: 'rev-1', digest: `sha256:${'a'.repeat(64)}` },
      decisionId: 'decision-1',
      traceId: 'trace-1',
      spanId: 'span-1',
      policyPath: '/aiwg/decision/allow',
      metrics: { timer_rego_query_eval_ns: 1 },
      input: { subject: 'operator', token: 'vault://secret', evidence: { value: 'docs', rawBody: 'private' } },
      result: 'docs-review',
    });
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    expect(ajv.validate(schema('OpaDecisionLogExport.v1'), log), JSON.stringify(ajv.errors)).toBe(true);
    expect(JSON.stringify(log)).not.toContain('vault://secret');
    expect(JSON.stringify(log)).not.toContain('s3://private');
    expect(log).toMatchObject({
      decision_id: 'decision-1',
      trace_id: 'trace-1',
      bundles: { authz: { revision: 'rev-1' } },
      enforcement: { separated: true },
    });
    expect(log.redaction.removed).toContain('$.input');
    expect(() => validateOpaInteropEnvelope({
      profileVersion: DECISION_INTEROP_PROFILE_VERSION,
      bundle: { name: 'authz', revision: 'rev-1' },
      decisionId: 'decision-2',
      policyPath: '/aiwg/decision/allow',
      input: { provider: 'attacker-selected' },
      result: true,
    })).toThrow(/cannot set/);
  });
});

describe('OPA input projection prototype safety', () => {
  const project = (input: Parameters<typeof exportOpaDecisionLog>[1]['input'], allowlist: string[]) => exportOpaDecisionLog(rulesetResult(), {
    profileVersion: DECISION_INTEROP_PROFILE_VERSION,
    bundle: { name: 'authz', revision: 'rev-1' },
    decisionId: 'decision-1',
    policyPath: '/aiwg/decision/allow',
    input,
    inputProjectionAllowlist: allowlist,
    result: 'docs-review',
  });

  it.each([
    ...['__proto__'].flatMap(segment => [
      `/${segment}`,
      `/${segment}/wp4Polluted`,
      `/safe/${segment}/wp4Polluted`,
      `/safe/nested/${segment}`,
    ]),
  ])('rejects unsafe projection %s for present and absent values', pointer => {
    const input = pointer.slice(1).split('/').reduceRight<Parameters<typeof project>[0]>(
      (child, segment) => Object.fromEntries([[segment, child]]), true,
    );
    const prototype = Object.getOwnPropertyDescriptors(Object.prototype);
    try {
      expect(() => project(input, [pointer])).toThrow(expect.objectContaining({ code: 'opa-input-projection' }));
      expect(() => project({}, [pointer])).toThrow(expect.objectContaining({ code: 'opa-input-projection' }));
      expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(prototype);
    } finally {
      delete (Object.prototype as Record<string, unknown>).wp4Polluted;
    }
  });

  it('preserves escaped keys, arrays and overlapping projections in ordinary exported objects', () => {
    const input = { 'a/b': { '~key': { value: 7, sibling: false } }, items: [{ value: 3 }] };
    const log = project(input, ['/a~1b/~0key', '/a~1b/~0key/value', '/items/0/value']);
    expect(JSON.parse(JSON.stringify(log.input))).toEqual({
      'a/b': { '~key': { value: 7, sibling: false } }, items: { '0': { value: 3 } },
    });
    const output = log.input as Record<string, Record<string, unknown>>;
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(output['a/b'])).toBe(Object.prototype);
    expect(Object.getPrototypeOf(output['a/b']['~key'])).toBe(Object.prototype);
    expect(output instanceof Object).toBe(true);
    expect(output.hasOwnProperty('a/b')).toBe(true);
    expect(output['a/b'].hasOwnProperty('~key')).toBe(true);
  });

  it('copies prototype-named JSON data as own properties without changing object prototypes', () => {
    const data = JSON.parse('{"__proto__":{"wp4Polluted":true},"constructor":{"prototype":{"value":1}}}');
    const log = project({ safe: data }, ['/safe']);
    const safe = (log.input as Record<string, unknown>).safe as Record<string, unknown>;
    expect(Object.getPrototypeOf(safe)).toBe(Object.prototype);
    expect(Object.hasOwn(safe, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(safe, '__proto__')).toEqual({
      value: { wp4Polluted: true }, enumerable: true, writable: true, configurable: true,
    });
    expect(safe.wp4Polluted).toBeUndefined();
    expect(JSON.parse(JSON.stringify(safe))).toEqual(data);
    expect(Object.hasOwn(Object.prototype, 'wp4Polluted')).toBe(false);
  });

  it('projects constructor and prototype as data keys at intermediate and final segments', () => {
    const input = { constructor: { prototype: { value: 7 } }, safe: { constructor: 'own', prototype: 3 } };
    for (const allowlist of [
      ['/constructor/prototype/value', '/safe/constructor', '/safe/prototype'],
      ['/constructor', '/constructor/prototype/value', '/safe'],
    ]) {
      const projected = project(input, allowlist).input as Record<string, unknown>;
      expect(JSON.parse(JSON.stringify(projected))).toEqual(input);
      expect(Object.getPrototypeOf(projected)).toBe(Object.prototype);
      expect(Object.hasOwn(projected, 'constructor')).toBe(true);
      expect(Object.getPrototypeOf(projected.constructor)).toBe(Object.prototype);
    }
    const absent = project({ safe: {} }, ['/constructor/prototype/value', '/safe/constructor', '/safe/prototype']).input;
    expect(absent).toEqual({});
    expect(Object.hasOwn(absent as object, 'constructor')).toBe(false);
  });

  it('exports ordinary empty input and nested result objects, including objects in arrays', () => {
    const result = rulesetResult();
    const outcome = JSON.parse('{"items":[{"value":3}],"__proto__":{"wp4Polluted":true}}');
    result.spec.outcome = outcome;
    const log = exportOpaDecisionLog(result, {
      profileVersion: DECISION_INTEROP_PROFILE_VERSION,
      bundle: { name: 'authz', revision: 'rev-1' },
      decisionId: 'decision-1',
      policyPath: '/aiwg/decision/allow',
      input: {},
      result: outcome,
    });
    expect(Object.getPrototypeOf(log.input)).toBe(Object.prototype);
    const exported = log.result as Record<string, unknown>;
    expect(Object.getPrototypeOf(exported)).toBe(Object.prototype);
    const items = exported.items as Array<Record<string, unknown>>;
    expect(Object.getPrototypeOf(items[0])).toBe(Object.prototype);
    expect(items[0].hasOwnProperty('value')).toBe(true);
    expect(Object.hasOwn(exported, '__proto__')).toBe(true);
    expect(JSON.parse(JSON.stringify(exported))).toEqual(outcome);
    expect(Object.hasOwn(Object.prototype, 'wp4Polluted')).toBe(false);
  });
});

function decisionResult(status: DecisionResult['spec']['status'], decision = { id: 'external-evidence', version: '1.0.0', digest: `sha256:${'0'.repeat(64)}` as const }, alias = 'stored'): DecisionResult {
  const ruleset = fixture('ruleset.json');
  return {
    apiVersion: 'decision.aiwg.io/v1alpha2',
    kind: 'DecisionResult',
    metadata: { id: 'stored', version: '1.0.0', description: 'stored evidence' },
    spec: {
      decision,
      ruleset: artifactPin(ruleset),
      binding: artifactPin(fixture('binding-jev.json')),
      alias,
      runId: 'run',
      invocationId: 'invocation',
      status,
      reason: status === 'success' ? 'none' : 'evaluation-failed',
      uncertainty: null,
      attempts: [{ ordinal: 1, adapter: 'fixture', adapterVersion: '1', requestedModel: 'fixture', actualModel: 'fixture', subagent: null, status, reason: status === 'success' ? 'none' : 'evaluation-failed', durationMs: 0, usage: { inputTokens: 0, outputTokens: 0, costUsd: null }, requestId: null }],
    },
  };
}

function rulesetResult(): RulesetResult {
  return {
    apiVersion: 'decision.aiwg.io/v1alpha2',
    kind: 'RulesetResult',
    metadata: { id: 'run', version: '1.0.0', description: 'run' },
    spec: {
      ruleset: artifactPin(fixture('ruleset.json')),
      binding: artifactPin(fixture('binding-jev.json')),
      runId: 'run',
      invocationId: 'invocation',
      status: 'completed',
      reason: 'none',
      outcome: 'docs-review',
      matchedRules: ['docs'],
      evaluations: {},
    },
  };
}
