import { createHash } from 'node:crypto';
import { SaxesParser, type SaxesTag } from 'saxes';
import { canonicalJson } from '../security/artifact-trust.js';
import { composeRuleset, type CompositionResult } from './compose.js';
import { evaluatePredicate } from './predicates.js';
import { DECISION_API_VERSION_STRUCTURED, type DecisionPredicate, type DecisionResult, type DecisionRuleset, type JsonSchema, type JsonValue, type RulesetResult } from './types.js';
import { artifactDigest, validateAgainstSchema } from './validate.js';

export const DECISION_INTEROP_PROFILE_VERSION = 'decision-interop.aiwg.io/v1' as const;
export const DECISION_INTEROP_DMN_VERSION = '1.6' as const;
export const DECISION_INTEROP_DMN_NAMESPACE = 'https://www.omg.org/spec/DMN/20240513/MODEL/' as const;

export type DmnHitPolicy = 'UNIQUE' | 'ANY' | 'FIRST' | 'RULE ORDER' | 'COLLECT';
export type DmnCollectAggregation = 'LIST' | 'SUM' | 'MIN' | 'MAX' | 'COUNT';

export interface DecisionInteropSource {
  format: 'dmn-xml' | 'opa-profile' | 'aiwg-profile';
  version: string;
  origin: string;
  digest: `sha256:${string}`;
  signature: { state: 'not-provided' | 'verified' | 'untrusted'; keyId?: string };
  parser: { id: 'aiwg-decision-interop'; version: typeof DECISION_INTEROP_PROFILE_VERSION };
  bounds: DecisionInteropBoundsReport;
}

export interface DecisionInteropBounds {
  maxBytes: number;
  maxElements: number;
  maxDepth: number;
  maxRules: number;
  maxInputs: number;
  maxOutputs: number;
  maxTextBytes: number;
}

export interface DecisionInteropBoundsReport extends DecisionInteropBounds {
  bytes: number;
  elements: number;
  maxObservedDepth: number;
  rules: number;
  inputs: number;
  outputs: number;
}

export interface DecisionInteropDmnProfile {
  profileVersion: typeof DECISION_INTEROP_PROFILE_VERSION;
  dmnVersion: typeof DECISION_INTEROP_DMN_VERSION;
  namespace: typeof DECISION_INTEROP_DMN_NAMESPACE;
  hitPolicy: DmnHitPolicy;
  aggregation: DmnCollectAggregation | null;
  ruleOrder: string[];
  supportedUnaryTests: Array<'dash' | 'literal' | 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'>;
  unsupportedConstructs: string[];
  extensions: Array<'aiwg:order' | 'aiwg:defer-on-conflict'>;
}

export interface DecisionInteropMapping {
  apiVersion: typeof DECISION_INTEROP_PROFILE_VERSION;
  kind: 'DecisionInteropMapping';
  metadata: { id: string; version: string; description: string };
  spec: {
    source: DecisionInteropSource;
    dryRun: true;
    activation: 'requires-review-publish';
    profile: DecisionInteropDmnProfile;
    normalizedRuleset: DecisionRuleset;
    normalizedDigest: `sha256:${string}`;
    warnings: string[];
    errors: string[];
    roundTripStatus: 'not-run' | 'equivalent' | 'not-equivalent';
  };
}

export interface OpaDecisionLogExport {
  schemaVersion: typeof DECISION_INTEROP_PROFILE_VERSION;
  decision_id: string;
  trace_id?: string;
  span_id?: string;
  path: string;
  timestamp?: string;
  bundles: Array<{ name: string; revision: string; digest?: `sha256:${string}` }>;
  result: JsonValue;
  input: JsonValue;
  metrics?: Record<string, number>;
  labels?: Record<string, string>;
  revisionLineage: Array<{ kind: 'ruleset' | 'binding' | 'policy-bundle' | 'calibration'; id: string; version: string; digest: `sha256:${string}` }>;
  redaction: { mode: 'default-deny-sensitive'; removed: string[] };
  enforcement: { separated: true; contract: 'decision-only-action-requires-aiwg-authorization' };
}

export interface OpaInteropEnvelope {
  profileVersion: typeof DECISION_INTEROP_PROFILE_VERSION;
  input: JsonValue;
  result: JsonValue;
  bundle: { name: string; revision: string; digest?: `sha256:${string}` };
  decisionId: string;
  traceId?: string;
  spanId?: string;
  metrics?: Record<string, number>;
  policyPath: string;
}

export class DecisionInteropError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DecisionInteropError';
  }
}

const DEFAULT_BOUNDS: DecisionInteropBounds = {
  maxBytes: 256_000,
  maxElements: 4_000,
  maxDepth: 32,
  maxRules: 512,
  maxInputs: 32,
  maxOutputs: 8,
  maxTextBytes: 64_000,
};

const FORBIDDEN_XML = [
  { code: 'dmn-doctype', pattern: /<!DOCTYPE/i },
  { code: 'dmn-entity', pattern: /<!ENTITY|&(?!(?:amp|lt|gt|quot|apos);)[a-z][a-z0-9_.:-]*;/i },
  { code: 'dmn-xinclude', pattern: /(?:xi:include|xinclude)/i },
  { code: 'dmn-remote-reference', pattern: /\b(?:schemaLocation|href|src|importLocation)\s*=\s*["'](?:https?:|file:|ftp:)/i },
  { code: 'dmn-path-traversal', pattern: /\b(?:href|src|importLocation)\s*=\s*["'][^"']*(?:\.\.|%2e%2e)/i },
  { code: 'dmn-script-extension', pattern: /<(?:\w+:)?(?:script|literalExpression|context|functionDefinition|invocation)\b/i },
];

const FORBIDDEN_CONTROL_FIELDS = new Set([
  'provider', 'credentialRef', 'credential', 'egressPolicy', 'model', 'calibrationRecord',
  'calibration', 'executor', 'backend', 'acceptance', 'artifactPin', 'actionAuthorization',
]);

const SENSITIVE_LOG_KEY = /(?:raw|body|secret|token|credential|private|locator|state|authorization|password|key)/iu;

interface DmnCell {
  text: string;
}

interface DmnRule {
  id: string;
  order: number | null;
  inputs: DmnCell[];
  outputs: DmnCell[];
}

interface DmnTable {
  definitionsId: string;
  decisionId: string;
  decisionName: string;
  tableId: string;
  hitPolicy: DmnHitPolicy;
  aggregation: DmnCollectAggregation | null;
  inputs: Array<{ id: string; pointer: string }>;
  outputs: Array<{ id: string; name: string }>;
  rules: DmnRule[];
  deferOnConflict: boolean;
}

interface XmlElement {
  local: string;
  uri: string;
  attributes: Record<string, string>;
  text: string;
  children: XmlElement[];
}

export function decisionInteropDefaultBounds(overrides: Partial<DecisionInteropBounds> = {}): DecisionInteropBounds {
  return { ...DEFAULT_BOUNDS, ...overrides };
}

export function importDmnDecisionTable(xml: string, options: {
  origin?: string;
  trustedSource?: boolean;
  bounds?: Partial<DecisionInteropBounds>;
} = {}): DecisionInteropMapping {
  const bounds = decisionInteropDefaultBounds(options.bounds);
  const bytes = Buffer.byteLength(xml, 'utf8');
  if (bytes > bounds.maxBytes) throw new DecisionInteropError('dmn-input-too-large', `DMN input exceeds ${bounds.maxBytes} bytes`);
  for (const forbidden of FORBIDDEN_XML) {
    if (forbidden.pattern.test(xml)) throw new DecisionInteropError(forbidden.code, `DMN import rejected by ${forbidden.code}`);
  }
  const parsed = parseBoundedXml(xml, bounds);
  const table = extractDmnTable(parsed.root, bounds);
  const ruleset = tableToRuleset(table);
  const profile: DecisionInteropDmnProfile = {
    profileVersion: DECISION_INTEROP_PROFILE_VERSION,
    dmnVersion: DECISION_INTEROP_DMN_VERSION,
    namespace: DECISION_INTEROP_DMN_NAMESPACE,
    hitPolicy: table.hitPolicy,
    aggregation: table.aggregation,
    ruleOrder: table.rules.map(rule => rule.id),
    supportedUnaryTests: ['dash', 'literal', 'eq', 'ne', 'lt', 'lte', 'gt', 'gte'],
    unsupportedConstructs: [],
    extensions: table.deferOnConflict ? ['aiwg:order', 'aiwg:defer-on-conflict'] : ['aiwg:order'],
  };
  const source: DecisionInteropSource = {
    format: 'dmn-xml',
    version: DECISION_INTEROP_DMN_VERSION,
    origin: options.origin ?? 'inline',
    digest: sha256(xml),
    signature: { state: options.trustedSource ? 'verified' : 'not-provided' },
    parser: { id: 'aiwg-decision-interop', version: DECISION_INTEROP_PROFILE_VERSION },
    bounds: { ...bounds, ...parsed.report, rules: table.rules.length, inputs: table.inputs.length, outputs: table.outputs.length },
  };
  return {
    apiVersion: DECISION_INTEROP_PROFILE_VERSION,
    kind: 'DecisionInteropMapping',
    metadata: {
      id: `${table.definitionsId}.${table.decisionId}`,
      version: '1.0.0',
      description: `Dry-run DMN import for ${table.decisionName}`,
    },
    spec: {
      source,
      dryRun: true,
      activation: 'requires-review-publish',
      profile,
      normalizedRuleset: ruleset,
      normalizedDigest: artifactDigest(ruleset),
      warnings: options.trustedSource ? [] : ['source signature was not verified; activation requires ordinary review/publish authorization'],
      errors: [],
      roundTripStatus: 'not-run',
    },
  };
}

export function exportDmnDecisionTable(mapping: Pick<DecisionInteropMapping, 'spec'>): string {
  const { normalizedRuleset: ruleset, profile } = mapping.spec;
  const inputs = collectRuleInputs(ruleset);
  const outputNames = outputNamesFor(ruleset);
  const hitPolicyAttrs = [
    `hitPolicy="${escapeXml(profile.hitPolicy)}"`,
    profile.aggregation && profile.aggregation !== 'LIST' ? `aggregation="${escapeXml(profile.aggregation)}"` : '',
    profile.extensions.includes('aiwg:defer-on-conflict') ? 'aiwg:conflict="defer-on-conflict"' : '',
  ].filter(Boolean).join(' ');
  const rows = ruleset.spec.rules.map((rule, index) => {
    const inputEntries = inputs.map(input => `          <inputEntry><text>${escapeXml(unaryTestFor(rule.when, input.pointer))}</text></inputEntry>`).join('\n');
    const outcome = outputNames.map(name => `          <outputEntry><text>${escapeXml(outputEntryFor(rule.outcome, name, outputNames.length))}</text></outputEntry>`).join('\n');
    return `        <rule id="${escapeXml(rule.id)}" aiwg:order="${index + 1}">
${inputEntries}
${outcome}
        </rule>`;
  }).join('\n');
  const rendered = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="${DECISION_INTEROP_DMN_NAMESPACE}" xmlns:aiwg="https://aiwg.io/spec/decision-interop/v1" id="${escapeXml(ruleset.metadata.id)}" name="${escapeXml(ruleset.metadata.description)}" namespace="https://aiwg.io/decision/interop">
  <decision id="${escapeXml(ruleset.metadata.id)}" name="${escapeXml(ruleset.metadata.description)}">
    <decisionTable id="${escapeXml(`${ruleset.metadata.id}-table`)}" ${hitPolicyAttrs}>
${inputs.map(input => `      <input id="${escapeXml(input.id)}"><inputExpression typeRef="${escapeXml(input.typeRef)}"><text>${escapeXml(input.pointer)}</text></inputExpression></input>`).join('\n')}
${outputNames.map(name => `      <output id="${escapeXml(`out-${name}`)}" name="${escapeXml(name)}" />`).join('\n')}
${rows}
    </decisionTable>
  </decision>
</definitions>
`;
  const roundTrip = importDmnDecisionTable(rendered, { origin: 'round-trip-export', trustedSource: true });
  const left = canonicalJson(roundTrip.spec.normalizedRuleset.spec);
  const right = canonicalJson(ruleset.spec);
  if (left !== right) throw new DecisionInteropError('dmn-round-trip-mismatch', 'Exported DMN did not import to an equivalent normalized ruleset');
  return rendered;
}

export function evaluateDmnProfile(mapping: Pick<DecisionInteropMapping, 'spec'>, input: unknown, evaluations: Record<string, DecisionResult> = {}): CompositionResult {
  const { normalizedRuleset: ruleset, profile } = mapping.spec;
  if (profile.hitPolicy === 'FIRST') return composeRuleset(ruleset, input, evaluations);
  const failed = Object.values(evaluations).some(result => result.spec.status !== 'success');
  if (failed) return { status: 'review', reason: 'evaluation-failed', outcome: structuredClone(ruleset.spec.failureOutcome), matchedRules: [] };
  const matches = profile.ruleOrder
    .map(id => ruleset.spec.rules.find(rule => rule.id === id))
    .filter((rule): rule is DecisionRuleset['spec']['rules'][number] => Boolean(rule))
    .filter(rule => evaluatePredicate(rule.when, input, evaluations) === true);
  if (matches.length === 0) {
    validateAgainstSchema(ruleset.spec.outputSchema, ruleset.spec.defaultOutcome, 'defaultOutcome');
    return { status: 'defaulted', reason: 'no-match', outcome: structuredClone(ruleset.spec.defaultOutcome), matchedRules: [] };
  }
  if (profile.hitPolicy === 'UNIQUE' && matches.length > 1) return conflictResult(ruleset, matches);
  if (profile.hitPolicy === 'ANY') {
    const first = canonicalJson(matches[0]!.outcome);
    if (matches.some(rule => canonicalJson(rule.outcome) !== first)) return conflictResult(ruleset, matches);
    const outcome = structuredClone(matches[0]!.outcome);
    validateAgainstSchema(ruleset.spec.outputSchema, outcome, 'matched outcome');
    return { status: 'completed', reason: 'none', outcome, matchedRules: matches.map(rule => rule.id) };
  }
  if (profile.hitPolicy === 'RULE ORDER') {
    const outcome = matches.map(rule => structuredClone(rule.outcome)) as JsonValue;
    validateAgainstSchema(ruleset.spec.outputSchema, outcome, 'rule-order outcome');
    return { status: 'completed', reason: 'none', outcome, matchedRules: matches.map(rule => rule.id) };
  }
  if (profile.hitPolicy === 'COLLECT') {
    const outcome = collectOutcome(matches.map(rule => rule.outcome), profile.aggregation ?? 'LIST');
    validateAgainstSchema(ruleset.spec.outputSchema, outcome, 'collect outcome');
    return { status: 'completed', reason: 'none', outcome, matchedRules: matches.map(rule => rule.id) };
  }
  return composeRuleset(ruleset, input, evaluations);
}

export function exportOpaDecisionLog(result: RulesetResult, envelope: OpaInteropEnvelope): OpaDecisionLogExport {
  const redaction = { removed: [] as string[] };
  const sanitizedInput = sanitizeJson(envelope.input, '$.input', redaction);
  const sanitizedResult = sanitizeJson(envelope.result, '$.result', redaction);
  const lineage: OpaDecisionLogExport['revisionLineage'] = [
    { kind: 'ruleset', ...result.spec.ruleset },
    { kind: 'binding', ...result.spec.binding },
    { kind: 'policy-bundle', id: envelope.bundle.name, version: envelope.bundle.revision, digest: envelope.bundle.digest ?? sha256(envelope.bundle) },
  ];
  return {
    schemaVersion: DECISION_INTEROP_PROFILE_VERSION,
    decision_id: envelope.decisionId,
    ...(envelope.traceId ? { trace_id: envelope.traceId } : {}),
    ...(envelope.spanId ? { span_id: envelope.spanId } : {}),
    path: envelope.policyPath,
    bundles: [structuredClone(envelope.bundle)],
    result: sanitizedResult,
    input: sanitizedInput,
    ...(envelope.metrics ? { metrics: structuredClone(envelope.metrics) } : {}),
    revisionLineage: lineage,
    redaction: { mode: 'default-deny-sensitive', removed: redaction.removed.sort() },
    enforcement: { separated: true, contract: 'decision-only-action-requires-aiwg-authorization' },
  };
}

export function validateOpaInteropEnvelope(envelope: OpaInteropEnvelope): void {
  assertNoControlOverride(envelope, '$');
  if (envelope.profileVersion !== DECISION_INTEROP_PROFILE_VERSION) {
    throw new DecisionInteropError('opa-profile-version', 'OPA interop envelope has an unsupported profile version');
  }
  if (!envelope.bundle.revision || !envelope.decisionId || !envelope.policyPath) {
    throw new DecisionInteropError('opa-missing-identity', 'OPA interop envelope requires bundle revision, decision ID, and policy path');
  }
}

function conflictResult(ruleset: DecisionRuleset, matches: DecisionRuleset['spec']['rules']): CompositionResult {
  if (ruleset.spec.conflict === 'review') {
    validateAgainstSchema(ruleset.spec.outputSchema, ruleset.spec.failureOutcome, 'failureOutcome');
    return { status: 'review', reason: 'conflicting-outcomes', outcome: structuredClone(ruleset.spec.failureOutcome), matchedRules: matches.map(rule => rule.id) };
  }
  return { status: 'error', reason: 'conflicting-outcomes', matchedRules: matches.map(rule => rule.id) };
}

function collectOutcome(values: JsonValue[], aggregation: DmnCollectAggregation): JsonValue {
  if (aggregation === 'LIST') return values.map(value => structuredClone(value)) as JsonValue;
  if (aggregation === 'COUNT') return values.length;
  if (!values.every(value => typeof value === 'number' && Number.isFinite(value))) {
    throw new DecisionInteropError('dmn-collect-aggregate-type', `${aggregation} aggregation requires finite numeric outputs`);
  }
  const numbers = values as number[];
  if (aggregation === 'SUM') return numbers.reduce((sum, value) => sum + value, 0);
  if (aggregation === 'MIN') return Math.min(...numbers);
  if (aggregation === 'MAX') return Math.max(...numbers);
  return values as JsonValue;
}

function parseBoundedXml(xml: string, bounds: DecisionInteropBounds): { root: XmlElement; report: Pick<DecisionInteropBoundsReport, 'bytes' | 'elements' | 'maxObservedDepth'> } {
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let elements = 0;
  let maxObservedDepth = 0;
  let textBytes = 0;
  const parser = new SaxesParser({ xmlns: true, fragment: false, resolvePrefix: (prefix: string) => prefix === 'xml' ? 'http://www.w3.org/XML/1998/namespace' : undefined });
  parser.on('opentag', tag => {
    elements += 1;
    if (elements > bounds.maxElements) throw new DecisionInteropError('dmn-element-bound', `DMN XML exceeds ${bounds.maxElements} elements`);
    maxObservedDepth = Math.max(maxObservedDepth, stack.length + 1);
    if (maxObservedDepth > bounds.maxDepth) throw new DecisionInteropError('dmn-depth-bound', `DMN XML exceeds depth ${bounds.maxDepth}`);
    const element = elementFromTag(tag);
    if (!allowedNamespace(element)) throw new DecisionInteropError('dmn-namespace', `Unsupported DMN namespace for ${element.local}`);
    stack.at(-1)?.children.push(element);
    stack.push(element);
  });
  parser.on('text', text => {
    if (!stack.length) return;
    textBytes += Buffer.byteLength(text, 'utf8');
    if (textBytes > bounds.maxTextBytes) throw new DecisionInteropError('dmn-text-bound', `DMN XML text exceeds ${bounds.maxTextBytes} bytes`);
    stack[stack.length - 1]!.text += text;
  });
  parser.on('closetag', () => {
    const closed = stack.pop();
    if (!stack.length && closed) root = closed;
  });
  parser.on('error', error => {
    throw new DecisionInteropError('dmn-xml-parse', error.message);
  });
  parser.write(xml).close();
  if (!root) throw new DecisionInteropError('dmn-empty', 'DMN XML has no root element');
  return { root, report: { bytes: Buffer.byteLength(xml, 'utf8'), elements, maxObservedDepth } };
}

function elementFromTag(tag: SaxesTag): XmlElement {
  const attributes: Record<string, string> = {};
  for (const [name, attr] of Object.entries(tag.attributes)) {
    const value = typeof attr === 'string' ? attr : String(attr.value ?? '');
    attributes[name] = value;
    const uri = typeof attr === 'string' ? '' : attr.uri;
    if (uri && uri !== DECISION_INTEROP_DMN_NAMESPACE && uri !== 'https://aiwg.io/spec/decision-interop/v1'
      && uri !== 'http://www.w3.org/2000/xmlns/') {
      throw new DecisionInteropError('dmn-namespace', `Unsupported namespace on attribute ${name}`);
    }
  }
  return { local: tag.local ?? tag.name, uri: tag.uri ?? '', attributes, text: '', children: [] };
}

function allowedNamespace(element: XmlElement): boolean {
  return element.uri === DECISION_INTEROP_DMN_NAMESPACE || element.uri === 'https://aiwg.io/spec/decision-interop/v1';
}

function extractDmnTable(root: XmlElement, bounds: DecisionInteropBounds): DmnTable {
  if (root.local !== 'definitions') throw new DecisionInteropError('dmn-root', 'DMN root must be definitions');
  const decisions = root.children.filter(child => child.local === 'decision');
  if (decisions.length !== 1) throw new DecisionInteropError('dmn-decision-count', 'DMN profile supports exactly one decision');
  const decision = decisions[0]!;
  const tables = decision.children.filter(child => child.local === 'decisionTable');
  if (tables.length !== 1) throw new DecisionInteropError('dmn-table-count', 'DMN profile supports exactly one decisionTable');
  const table = tables[0]!;
  const hitPolicy = parseHitPolicy(table.attributes.hitPolicy ?? 'UNIQUE');
  const aggregation = parseAggregation(table.attributes.aggregation, hitPolicy);
  const inputs = table.children.filter(child => child.local === 'input').map(input => {
    const expr = input.children.find(child => child.local === 'inputExpression');
    const text = expr?.children.find(child => child.local === 'text')?.text.trim();
    if (!text || !text.startsWith('/')) throw new DecisionInteropError('dmn-input-expression', 'DMN inputExpression must be a JSON Pointer');
    return { id: input.attributes.id ?? `input-${text}`, pointer: text };
  });
  const outputs = table.children.filter(child => child.local === 'output').map((output, index) => ({
    id: output.attributes.id ?? `output-${index + 1}`,
    name: output.attributes.name ?? `out${index + 1}`,
  }));
  const rules = table.children.filter(child => child.local === 'rule').map((rule, index) => ({
    id: rule.attributes.id ?? `rule-${index + 1}`,
    order: orderOf(rule),
    inputs: rule.children.filter(child => child.local === 'inputEntry').map(entry => ({ text: entry.children.find(child => child.local === 'text')?.text.trim() ?? '' })),
    outputs: rule.children.filter(child => child.local === 'outputEntry').map(entry => ({ text: entry.children.find(child => child.local === 'text')?.text.trim() ?? '' })),
  }));
  if (inputs.length === 0 || inputs.length > bounds.maxInputs) throw new DecisionInteropError('dmn-input-bound', 'DMN input count is outside the supported profile');
  if (outputs.length === 0 || outputs.length > bounds.maxOutputs) throw new DecisionInteropError('dmn-output-bound', 'DMN output count is outside the supported profile');
  if (rules.length === 0 || rules.length > bounds.maxRules) throw new DecisionInteropError('dmn-rule-bound', 'DMN rule count is outside the supported profile');
  for (const rule of rules) {
    if (rule.inputs.length !== inputs.length || rule.outputs.length !== outputs.length) throw new DecisionInteropError('dmn-rule-shape', 'Each DMN rule must have one entry per declared input and output');
  }
  if ((hitPolicy === 'FIRST' || hitPolicy === 'RULE ORDER' || hitPolicy === 'COLLECT') && rules.some(rule => rule.order === null)) {
    throw new DecisionInteropError('dmn-ambiguous-order', `${hitPolicy} requires explicit aiwg:order on every rule`);
  }
  const ordered = rules.slice().sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id));
  if (new Set(ordered.map(rule => rule.order).filter(order => order !== null)).size !== ordered.filter(rule => rule.order !== null).length) {
    throw new DecisionInteropError('dmn-ambiguous-order', 'aiwg:order values must be unique');
  }
  return {
    definitionsId: root.attributes.id ?? 'definitions',
    decisionId: decision.attributes.id ?? 'decision',
    decisionName: decision.attributes.name ?? decision.attributes.id ?? 'decision',
    tableId: table.attributes.id ?? 'decisionTable',
    hitPolicy,
    aggregation,
    inputs,
    outputs,
    rules: ordered,
    deferOnConflict: table.attributes['aiwg:conflict'] === 'defer-on-conflict' || table.attributes.conflict === 'defer-on-conflict',
  };
}

function tableToRuleset(table: DmnTable): DecisionRuleset {
  const outputSchema = outputSchemaFor(table);
  return {
    apiVersion: DECISION_API_VERSION_STRUCTURED,
    kind: 'DecisionRuleset',
    metadata: { id: table.decisionId, version: '1.0.0', description: table.decisionName },
    spec: {
      purpose: `Imported DMN ${table.tableId} via ${DECISION_INTEROP_PROFILE_VERSION}`,
      inputSchema: { type: 'object' },
      evaluations: [{
        alias: 'stored-evidence',
        decision: { id: 'external-evidence', version: '1.0.0', digest: `sha256:${'0'.repeat(64)}` },
        inputPointer: '',
      }],
      rules: table.rules.map((rule, index) => ({
        id: rule.id,
        priority: table.rules.length - index,
        when: predicateForRule(table, rule),
        outcome: outcomeForRule(table, rule),
      })),
      composition: table.hitPolicy === 'RULE ORDER' || table.hitPolicy === 'COLLECT' ? 'collect' : 'first-match',
      conflict: table.deferOnConflict ? 'review' : 'error',
      defaultOutcome: defaultOutcomeFor(table),
      failureOutcome: defaultOutcomeFor(table),
      outputSchema,
    },
  };
}

function predicateForRule(table: DmnTable, rule: DmnRule): DecisionPredicate {
  const predicates = rule.inputs.map((entry, index) => predicateForUnaryTest(table.inputs[index]!.pointer, entry.text));
  return predicates.length === 1 ? predicates[0]! : { all: predicates };
}

function predicateForUnaryTest(pointer: string, text: string): DecisionPredicate {
  if (text === '-' || text === '') return { op: 'exists', left: { source: 'input', pointer: '' } };
  const match = text.match(/^(<=|>=|<|>|=|!=)?\s*(.+)$/u);
  if (!match) throw new DecisionInteropError('dmn-feel-unsupported', `Unsupported unary test '${text}'`);
  const operator = (match[1] ?? '=') as '<' | '<=' | '>' | '>=' | '=' | '!=';
  const op = ({ '<': 'lt', '<=': 'lte', '>': 'gt', '>=': 'gte', '=': 'eq', '!=': 'ne' } as const)[operator];
  return { op, left: { source: 'input', pointer }, right: parseLiteral(match[2]!.trim()) };
}

function outcomeForRule(table: DmnTable, rule: DmnRule): JsonValue {
  if (rule.outputs.length === 1) return parseLiteral(rule.outputs[0]!.text);
  return Object.fromEntries(rule.outputs.map((entry, index) => [table.outputs[index]!.name, parseLiteral(entry.text)]));
}

function parseLiteral(text: string): JsonValue {
  if (/^".*"$|^-?\d+(?:\.\d+)?$|^(?:true|false|null)$/u.test(text)) return JSON.parse(text) as JsonValue;
  if (/^[A-Za-z0-9_.:-]+$/u.test(text)) return text;
  throw new DecisionInteropError('dmn-feel-unsupported', `Unsupported FEEL/data literal '${text}'`);
}

function outputSchemaFor(table: DmnTable): JsonSchema {
  const scalar = table.outputs.length === 1 ? {} : { type: 'object', required: table.outputs.map(output => output.name), additionalProperties: false };
  if (table.hitPolicy === 'RULE ORDER' || (table.hitPolicy === 'COLLECT' && (!table.aggregation || table.aggregation === 'LIST'))) {
    return { type: 'array', items: scalar };
  }
  if (table.hitPolicy === 'COLLECT' && table.aggregation) {
    if (table.aggregation === 'COUNT') return { type: 'integer', minimum: 0 };
    if (table.aggregation === 'SUM') return { type: 'number' };
    return { type: ['number', 'null'] };
  }
  return scalar;
}

function defaultOutcomeFor(table: DmnTable): JsonValue {
  if (table.hitPolicy === 'RULE ORDER' || (table.hitPolicy === 'COLLECT' && (!table.aggregation || table.aggregation === 'LIST'))) return [];
  if (table.hitPolicy === 'COLLECT' && table.aggregation === 'COUNT') return 0;
  if (table.hitPolicy === 'COLLECT' && table.aggregation === 'SUM') return 0;
  return null;
}

function parseHitPolicy(value: string): DmnHitPolicy {
  const normalized = value.trim().toUpperCase().replace(/_/gu, ' ');
  if (['UNIQUE', 'ANY', 'FIRST', 'RULE ORDER', 'COLLECT'].includes(normalized)) return normalized as DmnHitPolicy;
  throw new DecisionInteropError('dmn-hit-policy', `Unsupported DMN hit policy '${value}'`);
}

function parseAggregation(value: string | undefined, hitPolicy: DmnHitPolicy): DmnCollectAggregation | null {
  if (!value) return hitPolicy === 'COLLECT' ? 'LIST' : null;
  if (hitPolicy !== 'COLLECT') throw new DecisionInteropError('dmn-aggregation', 'DMN aggregation is supported only with COLLECT');
  const normalized = value.trim().toUpperCase();
  if (['SUM', 'MIN', 'MAX', 'COUNT'].includes(normalized)) return normalized as DmnCollectAggregation;
  throw new DecisionInteropError('dmn-aggregation', `Unsupported DMN aggregation '${value}'`);
}

function orderOf(rule: XmlElement): number | null {
  const raw = rule.attributes['aiwg:order'] ?? rule.attributes.order;
  if (raw === undefined) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new DecisionInteropError('dmn-ambiguous-order', 'aiwg:order must be a positive integer');
  return parsed;
}

function collectRuleInputs(ruleset: DecisionRuleset): Array<{ id: string; pointer: string; typeRef: string }> {
  const pointers = new Set<string>();
  const visit = (predicate: DecisionPredicate): void => {
    if ('all' in predicate) predicate.all.forEach(visit);
    else if ('any' in predicate) predicate.any.forEach(visit);
    else if ('not' in predicate) visit(predicate.not);
    else if (predicate.left.source === 'input' && predicate.left.pointer) pointers.add(predicate.left.pointer);
  };
  ruleset.spec.rules.forEach(rule => visit(rule.when));
  return [...pointers].sort().map((pointer, index) => ({ id: `input-${index + 1}`, pointer, typeRef: 'Any' }));
}

function outputNamesFor(ruleset: DecisionRuleset): string[] {
  const objectOutcome = ruleset.spec.rules.map(rule => rule.outcome).find(value => value && typeof value === 'object' && !Array.isArray(value));
  return objectOutcome && typeof objectOutcome === 'object' && !Array.isArray(objectOutcome) ? Object.keys(objectOutcome).sort() : ['outcome'];
}

function unaryTestFor(predicate: DecisionPredicate, pointer: string): string {
  if ('all' in predicate) {
    const found = predicate.all.find(item => !('all' in item) && !('any' in item) && !('not' in item) && item.left.pointer === pointer);
    return found ? unaryTestFor(found, pointer) : '-';
  }
  if ('any' in predicate || 'not' in predicate) throw new DecisionInteropError('dmn-export-unsupported', 'DMN export supports conjunctive rule predicates only');
  if (predicate.left.pointer !== pointer) return '-';
  if (predicate.op === 'exists') return '-';
  const op = ({ eq: '=', ne: '!=', lt: '<', lte: '<=', gt: '>', gte: '>=' } as const)[predicate.op];
  return `${op} ${JSON.stringify(predicate.right)}`;
}

function outputEntryFor(outcome: JsonValue, name: string, count: number): string {
  if (count === 1) return JSON.stringify(outcome);
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) throw new DecisionInteropError('dmn-export-output', 'Compound output requires object rule outcomes');
  return JSON.stringify(outcome[name]);
}

function sanitizeJson(value: JsonValue, path: string, redaction: { removed: string[] }): JsonValue {
  if (Array.isArray(value)) return value.map((item, index) => sanitizeJson(item, `${path}[${index}]`, redaction)) as JsonValue;
  if (value && typeof value === 'object') {
    const result: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_LOG_KEY.test(key)) {
        redaction.removed.push(`${path}.${key}`);
        continue;
      }
      result[key] = sanitizeJson(child, `${path}.${key}`, redaction);
    }
    return result;
  }
  return value;
}

function assertNoControlOverride(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoControlOverride(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_CONTROL_FIELDS.has(key)) throw new DecisionInteropError('interop-control-override', `Imported policy cannot set ${path}.${key}`);
    assertNoControlOverride(child, `${path}.${key}`);
  }
}

function sha256(value: unknown): `sha256:${string}` {
  const bytes = typeof value === 'string' ? value : canonicalJson(value);
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function escapeXml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
}
