import { createHash } from 'node:crypto';
import { SaxesParser, type SaxesTag } from 'saxes';
import { canonicalJson } from '../security/artifact-trust.js';
import { composeRuleset, type CompositionResult } from './compose.js';
import { DECISION_API_VERSION_STRUCTURED, type ArtifactPin, type DecisionPredicate, type DecisionResult, type DecisionRuleset, type JsonSchema, type JsonValue, type RulesetResult } from './types.js';
import { artifactDigest, resolveJsonPointer } from './validate.js';

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
  maxParseMs: number;
}

export interface DecisionInteropBoundsReport extends DecisionInteropBounds {
  bytes: number;
  elements: number;
  maxObservedDepth: number;
  rules: number;
  inputs: number;
  outputs: number;
  parseTimeMs: number;
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
  bundles: Record<string, { revision: string; digest?: `sha256:${string}` }>;
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
  result?: JsonValue;
  bundle: { name: string; revision: string; digest?: `sha256:${string}` };
  decisionId: string;
  traceId?: string;
  spanId?: string;
  metrics?: Record<string, number>;
  policyPath: string;
  inputProjectionAllowlist?: string[];
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
  maxParseMs: 1_000,
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
const SENSITIVE_LOG_VALUE = /(?:bearer\s+\S+|secret|token|file:\/\/|\/home\/|private|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/iu;
const SUPPORTED_DMN_ELEMENTS = new Set(['definitions', 'decision', 'informationRequirement', 'requiredDecision', 'decisionTable', 'input', 'inputExpression', 'output', 'rule', 'inputEntry', 'outputEntry', 'text']);

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
  dependencies: Array<{ alias: string; decision: ArtifactPin }>;
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
  signatureState?: 'not-provided' | 'verified' | 'untrusted';
  signatureKeyId?: string;
  bounds?: Partial<DecisionInteropBounds>;
  externalDecisionPins?: Record<string, ArtifactPin>;
} = {}): DecisionInteropMapping {
  const bounds = decisionInteropDefaultBounds(options.bounds);
  const bytes = Buffer.byteLength(xml, 'utf8');
  if (bytes > bounds.maxBytes) throw new DecisionInteropError('dmn-input-too-large', `DMN input exceeds ${bounds.maxBytes} bytes`);
  for (const forbidden of FORBIDDEN_XML) {
    if (forbidden.pattern.test(xml)) throw new DecisionInteropError(forbidden.code, `DMN import rejected by ${forbidden.code}`);
  }
  const parsed = parseBoundedXml(xml, bounds);
  const table = extractDmnTable(parsed.root, bounds, options.externalDecisionPins ?? {});
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
    signature: { state: options.signatureState ?? (options.trustedSource ? 'untrusted' : 'not-provided'), ...(options.signatureKeyId ? { keyId: options.signatureKeyId } : {}) },
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
      warnings: options.signatureState === 'verified' ? [] : ['source signature was not verified; activation requires ordinary review/publish authorization'],
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
  const baseId = ncName(ruleset.metadata.id);
  const dependencyPins = Object.fromEntries(ruleset.spec.evaluations.map(evaluation => [evaluation.alias, evaluation.decision]));
  const dependencyDecisions = ruleset.spec.evaluations
    .map(evaluation => `  <decision id="${escapeXml(ncName(evaluation.alias))}" name="${escapeXml(evaluation.alias)}" />`)
    .join('\n');
  const dependencyRequirements = ruleset.spec.evaluations
    .map(evaluation => `    <informationRequirement><requiredDecision href="#${escapeXml(ncName(evaluation.alias))}" /></informationRequirement>`)
    .join('\n');
  const rendered = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="${DECISION_INTEROP_DMN_NAMESPACE}" xmlns:aiwg="https://aiwg.io/spec/decision-interop/v1" id="${escapeXml(`${baseId}-definitions`)}" name="${escapeXml(ruleset.metadata.description)}" namespace="https://aiwg.io/decision/interop" expressionLanguage="https://aiwg.io/spec/decision-interop/v1/json-pointer">
${dependencyDecisions ? `${dependencyDecisions}\n` : ''}  <decision id="${escapeXml(baseId)}" name="${escapeXml(ruleset.metadata.description)}">
${dependencyRequirements ? `${dependencyRequirements}\n` : ''}    <decisionTable id="${escapeXml(`${baseId}-table`)}" ${hitPolicyAttrs}>
${inputs.map(input => `      <input id="${escapeXml(input.id)}"><inputExpression typeRef="${escapeXml(input.typeRef)}"><text>${escapeXml(input.pointer)}</text></inputExpression></input>`).join('\n')}
${outputNames.map(name => `      <output id="${escapeXml(`out-${name}`)}" name="${escapeXml(name)}" />`).join('\n')}
${rows}
    </decisionTable>
  </decision>
</definitions>
`;
  importDmnDecisionTable(rendered, { origin: 'round-trip-export', trustedSource: true, externalDecisionPins: dependencyPins });
  return rendered;
}

export function evaluateDmnProfile(mapping: Pick<DecisionInteropMapping, 'spec'>, input: unknown, evaluations: Record<string, DecisionResult> = {}): CompositionResult {
  return composeRuleset(mapping.spec.normalizedRuleset, input, evaluations);
}

export function exportOpaDecisionLog(result: RulesetResult, envelope: OpaInteropEnvelope): OpaDecisionLogExport {
  validateOpaInteropEnvelope(envelope);
  const redaction = { removed: [] as string[] };
  const sanitizedInput = projectOpaInput(envelope.input, envelope.inputProjectionAllowlist ?? [], redaction);
  const actualResult = (Object.hasOwn(result.spec, 'outcome') ? result.spec.outcome : result.spec.status) as JsonValue;
  if (envelope.result !== undefined && canonicalJson(envelope.result) !== canonicalJson(actualResult)) {
    throw new DecisionInteropError('opa-result-mismatch', 'OPA decision log result must match the AIWG RulesetResult outcome');
  }
  const sanitizedResult = sanitizeJson(actualResult, '$.result', redaction);
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
    bundles: { [envelope.bundle.name]: { revision: envelope.bundle.revision, ...(envelope.bundle.digest ? { digest: envelope.bundle.digest } : {}) } },
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

function parseBoundedXml(xml: string, bounds: DecisionInteropBounds): { root: XmlElement; report: Pick<DecisionInteropBoundsReport, 'bytes' | 'elements' | 'maxObservedDepth' | 'parseTimeMs'> } {
  const started = performance.now();
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let elements = 0;
  let maxObservedDepth = 0;
  let textBytes = 0;
  const parser = new SaxesParser({ xmlns: true, fragment: false, resolvePrefix: (prefix: string) => prefix === 'xml' ? 'http://www.w3.org/XML/1998/namespace' : undefined });
  parser.on('opentag', tag => {
    assertParseTime();
    elements += 1;
    if (elements > bounds.maxElements) throw new DecisionInteropError('dmn-element-bound', `DMN XML exceeds ${bounds.maxElements} elements`);
    maxObservedDepth = Math.max(maxObservedDepth, stack.length + 1);
    if (maxObservedDepth > bounds.maxDepth) throw new DecisionInteropError('dmn-depth-bound', `DMN XML exceeds depth ${bounds.maxDepth}`);
    const element = elementFromTag(tag);
    if (!allowedNamespace(element)) throw new DecisionInteropError('dmn-namespace', `Unsupported DMN namespace for ${element.local}`);
    if (!SUPPORTED_DMN_ELEMENTS.has(element.local)) throw new DecisionInteropError('dmn-unsupported-element', `Unsupported DMN element ${element.local}`);
    stack.at(-1)?.children.push(element);
    stack.push(element);
  });
  parser.on('text', text => {
    assertParseTime();
    appendText(text);
  });
  parser.on('cdata', text => {
    assertParseTime();
    appendText(text);
  });
  parser.on('closetag', () => {
    assertParseTime();
    const closed = stack.pop();
    if (!stack.length && closed) root = closed;
  });
  parser.on('error', error => {
    throw new DecisionInteropError('dmn-xml-parse', error.message);
  });
  const chunkSize = 8192;
  for (let offset = 0; offset < xml.length; offset += chunkSize) {
    assertParseTime();
    parser.write(xml.slice(offset, offset + chunkSize));
  }
  assertParseTime();
  parser.close();
  assertParseTime();
  if (!root) throw new DecisionInteropError('dmn-empty', 'DMN XML has no root element');
  const parseTimeMs = performance.now() - started;
  return { root, report: { bytes: Buffer.byteLength(xml, 'utf8'), elements, maxObservedDepth, parseTimeMs } };

  function assertParseTime(): void {
    if (performance.now() - started > bounds.maxParseMs) throw new DecisionInteropError('dmn-parse-time-bound', `DMN XML parse exceeded ${bounds.maxParseMs}ms`);
  }

  function appendText(text: string): void {
    if (!stack.length) return;
    textBytes += Buffer.byteLength(text, 'utf8');
    if (textBytes > bounds.maxTextBytes) throw new DecisionInteropError('dmn-text-bound', `DMN XML text exceeds ${bounds.maxTextBytes} bytes`);
    stack[stack.length - 1]!.text += text;
  }
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
  return element.uri === DECISION_INTEROP_DMN_NAMESPACE;
}

function extractDmnTable(root: XmlElement, bounds: DecisionInteropBounds, externalDecisionPins: Record<string, ArtifactPin>): DmnTable {
  if (root.local !== 'definitions') throw new DecisionInteropError('dmn-root', 'DMN root must be definitions');
  const decisions = root.children.filter(child => child.local === 'decision');
  if (decisions.length === 0) throw new DecisionInteropError('dmn-decision-count', 'DMN profile requires at least one decision');
  assertUnique(decisions.map(decision => decision.attributes.id ?? ''), 'DMN decision IDs');
  const tableDecisions = decisions.filter(decision => decision.children.some(child => child.local === 'decisionTable'));
  if (tableDecisions.length !== 1) throw new DecisionInteropError('dmn-table-count', 'DMN profile supports exactly one decisionTable');
  const decision = tableDecisions[0]!;
  const tables = decision.children.filter(child => child.local === 'decisionTable');
  if (tables.length !== 1) throw new DecisionInteropError('dmn-table-count', 'DMN profile supports exactly one decisionTable');
  const table = tables[0]!;
  const hitPolicy = parseHitPolicy(table.attributes.hitPolicy ?? 'UNIQUE');
  const aggregation = parseAggregation(table.attributes.aggregation, hitPolicy);
  const inputs = table.children.filter(child => child.local === 'input').map(input => {
    const expr = input.children.find(child => child.local === 'inputExpression');
    const text = expr?.children.find(child => child.local === 'text')?.text.trim();
    if (text === undefined || (text !== '' && !text.startsWith('/'))) throw new DecisionInteropError('dmn-input-expression', 'DMN inputExpression must be a JSON Pointer');
    return { id: input.attributes.id ?? `input-${text || 'root'}`, pointer: text };
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
  const dependencies = dependenciesFor(decision, decisions, externalDecisionPins);
  assertUnique(inputs.map(input => input.id), 'DMN input IDs');
  assertUnique(outputs.map(output => output.id), 'DMN output IDs');
  assertUnique(outputs.map(output => output.name), 'DMN output names');
  assertUnique(rules.map(rule => rule.id), 'DMN rule IDs');
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
    dependencies,
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
      purpose: `Imported DMN ${table.tableId} via ${DECISION_INTEROP_PROFILE_VERSION}; dmn-hit-policy=${table.hitPolicy}`,
      inputSchema: { type: 'object' },
      evaluations: table.dependencies.map(dependency => ({
        alias: dependency.alias,
        decision: dependency.decision,
        inputPointer: '',
      })),
      rules: table.rules.map((rule, index) => ({
        id: rule.id,
        priority: table.rules.length - index,
        when: predicateForRule(table, rule),
        outcome: outcomeForRule(table, rule),
      })),
      composition: compositionFor(table),
      conflict: table.deferOnConflict ? 'review' : 'error',
      defaultOutcome: defaultOutcomeFor(table),
      failureOutcome: defaultOutcomeFor(table),
      outputSchema,
    },
  };
}

function predicateForRule(table: DmnTable, rule: DmnRule): DecisionPredicate {
  const predicates = [
    ...table.dependencies.map(dependency => ({ op: 'exists', left: { source: 'decision', alias: dependency.alias, pointer: '' } } as DecisionPredicate)),
    ...rule.inputs.map((entry, index) => predicateForUnaryTest(table.inputs[index]!.pointer, entry.text)),
  ];
  return predicates.length === 1 ? predicates[0]! : { all: predicates };
}

function predicateForUnaryTest(pointer: string, text: string): DecisionPredicate {
  if (text === '-' || text === '') return { op: 'exists', left: { source: 'input', pointer: '' } };
  const match = text.match(/^(<=|>=|<|>|=|!=)?\s*(.+)$/u);
  if (!match) throw new DecisionInteropError('dmn-feel-unsupported', 'Unsupported unary test');
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
  throw new DecisionInteropError('dmn-feel-unsupported', 'Unsupported FEEL/data literal');
}

function outputSchemaFor(table: DmnTable): JsonSchema {
  const scalar = table.outputs.length === 1 ? {} : {
    type: 'object',
    properties: Object.fromEntries(table.outputs.map(output => [output.name, {}])),
    required: table.outputs.map(output => output.name),
    additionalProperties: false,
  };
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

function compositionFor(table: DmnTable): DecisionRuleset['spec']['composition'] {
  if (table.hitPolicy === 'UNIQUE') return 'unique';
  if (table.hitPolicy === 'ANY') return 'any';
  if (table.hitPolicy === 'RULE ORDER') return 'collect';
  if (table.hitPolicy === 'COLLECT') {
    if (!table.aggregation || table.aggregation === 'LIST') return 'collect';
    return `collect-${table.aggregation.toLowerCase()}` as DecisionRuleset['spec']['composition'];
  }
  return 'first-match';
}

function dependenciesFor(decision: XmlElement, decisions: XmlElement[], externalDecisionPins: Record<string, ArtifactPin>): Array<{ alias: string; decision: ArtifactPin }> {
  const byId = new Map<string, XmlElement>();
  for (const item of decisions) {
    const id = item.attributes.id;
    if (id) byId.set(id, item);
  }
  const tableId = decision.attributes.id;
  if (!tableId) throw new DecisionInteropError('dmn-dependency-reference', 'DMN table decision must have an id when dependencies are present');
  const direct = requiredDecisionIds(decision, byId, tableId);
  const ordered: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>([tableId]);
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new DecisionInteropError('dmn-cyclic-dependency', 'DMN decision dependencies must be acyclic');
    if (visited.has(id)) return;
    const node = byId.get(id);
    if (!node) throw new DecisionInteropError('dmn-dependency-reference', 'DMN requiredDecision target is not declared');
    if (node.children.some(child => child.local === 'decisionTable')) {
      throw new DecisionInteropError('dmn-dependency-executable', 'DMN profile supports dependency decisions as external evidence only');
    }
    visiting.add(id);
    for (const child of requiredDecisionIds(node, byId, id)) visit(child);
    visiting.delete(id);
    visited.add(id);
    ordered.push(id);
  };
  for (const id of direct) visit(id);
  assertUnique(ordered, 'DMN decision dependencies');
  return ordered.map(alias => {
    const pin = externalDecisionPins[alias];
    if (!pin) throw new DecisionInteropError('dmn-dependency-pin-required', `DMN dependency '${alias}' requires a caller-supplied external decision pin`);
    if (pin.id !== alias) throw new DecisionInteropError('dmn-dependency-pin-mismatch', `DMN dependency '${alias}' pin id must match the decision id`);
    return { alias, decision: structuredClone(pin) };
  });
}

function requiredDecisionIds(decision: XmlElement, decisions: Map<string, XmlElement>, ownId: string): string[] {
  const refs = decision.children
    .filter(child => child.local === 'informationRequirement')
    .flatMap(requirement => requirement.children.filter(child => child.local === 'requiredDecision'))
    .map(required => required.attributes.href ?? '');
  const dependencies = refs.map(ref => {
    if (!ref.startsWith('#') || ref.length <= 1 || ref.includes('/') || ref.includes(':')) {
      throw new DecisionInteropError('dmn-dependency-reference', 'DMN requiredDecision must use a local decision href');
    }
    const id = ref.slice(1);
    if (id === ownId) throw new DecisionInteropError('dmn-cyclic-dependency', 'DMN decision cannot require itself');
    if (!decisions.has(id)) throw new DecisionInteropError('dmn-dependency-reference', 'DMN requiredDecision target is not declared');
    return id;
  });
  assertUnique(dependencies, 'DMN decision dependencies');
  return dependencies;
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
  let hasRootWildcard = false;
  const visit = (predicate: DecisionPredicate): void => {
    if ('all' in predicate) predicate.all.forEach(visit);
    else if ('any' in predicate) predicate.any.forEach(visit);
    else if ('not' in predicate) visit(predicate.not);
    else if (predicate.left.source === 'input') {
      if (predicate.left.pointer === '') hasRootWildcard = true;
      else pointers.add(predicate.left.pointer);
    }
  };
  ruleset.spec.rules.forEach(rule => visit(rule.when));
  if (pointers.size === 0 && hasRootWildcard) pointers.add('');
  return [...pointers].sort().map((pointer, index) => ({ id: `input-${index + 1}`, pointer, typeRef: 'Any' }));
}

function outputNamesFor(ruleset: DecisionRuleset): string[] {
  const objectOutcome = ruleset.spec.rules.map(rule => rule.outcome).find(value => value && typeof value === 'object' && !Array.isArray(value));
  return objectOutcome && typeof objectOutcome === 'object' && !Array.isArray(objectOutcome) ? Object.keys(objectOutcome).sort() : ['outcome'];
}

function unaryTestFor(predicate: DecisionPredicate, pointer: string): string {
  if ('all' in predicate) {
    const found = predicate.all.find(item => !('all' in item) && !('any' in item) && !('not' in item) && item.left.source === 'input' && item.left.pointer === pointer);
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
  if (isSensitiveValue(value)) {
    redaction.removed.push(path);
    return '[redacted]';
  }
  if (Array.isArray(value)) return value.map((item, index) => sanitizeJson(item, `${path}[${index}]`, redaction)) as JsonValue;
  if (value && typeof value === 'object') {
    const result: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_LOG_KEY.test(key) || isSensitiveValue(child)) {
        redaction.removed.push(`${path}.${key}`);
        continue;
      }
      result[key] = sanitizeJson(child, `${path}.${key}`, redaction);
    }
    return result;
  }
  return value;
}

function projectOpaInput(input: JsonValue, allowlist: string[], redaction: { removed: string[] }): JsonValue {
  if (allowlist.length === 0) {
    redaction.removed.push('$.input');
    return {};
  }
  const output: Record<string, JsonValue> = {};
  for (const pointer of allowlist) {
    if (!pointer.startsWith('/')) throw new DecisionInteropError('opa-input-projection', 'OPA input projection allowlist entries must be JSON Pointers');
    const resolved = resolveJsonPointer(input, pointer);
    if (!resolved.found) continue;
    setProjectedValue(output, pointer.slice(1).split('/').map(part => part.replace(/~1/gu, '/').replace(/~0/gu, '~')), sanitizeJson(resolved.value as JsonValue, `$.input${pointer}`, redaction));
  }
  return output;
}

function setProjectedValue(target: Record<string, JsonValue>, path: string[], value: JsonValue): void {
  let cursor: Record<string, JsonValue> = target;
  path.forEach((segment, index) => {
    if (index === path.length - 1) {
      cursor[segment] = value;
      return;
    }
    const existing = cursor[segment];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) cursor[segment] = {};
    cursor = cursor[segment] as Record<string, JsonValue>;
  });
}

function isSensitiveValue(value: unknown): boolean {
  return typeof value === 'string' && SENSITIVE_LOG_VALUE.test(value);
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new DecisionInteropError('dmn-duplicate-id', `${label} must be unique`);
    seen.add(value);
  }
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

function ncName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_.-]/gu, '-').replace(/^[^A-Za-z_]+/u, '');
  return cleaned || 'decision';
}
