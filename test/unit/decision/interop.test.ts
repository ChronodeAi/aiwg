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
    expect(evaluateDmnProfile(mapping, { score: 1 }, { stored: decisionResult('success') })).toMatchObject({ status: 'defaulted', outcome: null, matchedRules: [] });
    for (const status of ['abstained', 'unsupported', 'error', 'cancelled'] as const) {
      const evaluation = decisionResult(status);
      expect(evaluateDmnProfile(mapping, { category: 'docs', score: 1 }, { stored: evaluation })).toMatchObject({
        status: 'review',
        reason: 'evaluation-failed',
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
    expect(evaluateDmnProfile(mapping, { category: 'docs', score: 1 }, { storedEvidence: decisionResult('success') })).toMatchObject({
      status: 'completed', outcome: 'docs-review', matchedRules: ['r'],
    });
    expect(evaluateDmnProfile(mapping, { category: 'docs', score: 1 }, { storedEvidence: decisionResult('unsupported') })).toMatchObject({
      status: 'review', reason: 'evaluation-failed', matchedRules: [],
    });
    expect(evaluateDmnProfile(mapping, { category: 'docs', score: 1 })).toMatchObject({
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
      input: { subject: 'operator', credentialRef: 'vault://secret', evidence: { value: 'docs', rawBody: 'private' } },
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

function decisionResult(status: DecisionResult['spec']['status']): DecisionResult {
  const ruleset = fixture('ruleset.json');
  return {
    apiVersion: 'decision.aiwg.io/v1alpha2',
    kind: 'DecisionResult',
    metadata: { id: 'stored', version: '1.0.0', description: 'stored evidence' },
    spec: {
      decision: { id: 'external-evidence', version: '1.0.0', digest: `sha256:${'0'.repeat(64)}` },
      ruleset: artifactPin(ruleset),
      binding: artifactPin(fixture('binding-jev.json')),
      alias: 'stored',
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
