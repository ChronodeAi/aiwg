import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertDecisionEvaluateDispatcherConfig,
  decisionPatternPacks,
  getDecisionPatternPack,
  governedPatternArtifacts,
  listDecisionPatterns,
  patternInputSchema,
  patternOutputSchema,
  planLiveDecisionPattern,
  runOfflineDecisionPattern,
  validateAgainstSchema,
  validateDecisionDocument,
  validateDefinition,
  validateRuleset,
  type DecisionDefinition,
  type DecisionPatternId,
  type DecisionRuleset,
  type JsonValue,
  type LivePatternPlan,
  type PatternReceipt,
  type RulesetResult,
} from './index.js';

type EvaluationStatus = 'success' | 'abstained' | 'denied' | 'unavailable' | 'error' | 'cancelled';
type OutputWriter = Pick<NodeJS.WritableStream, 'write'>;

interface DispatcherModule {
  runDecisionEvaluate(input: { argv: string[]; env: NodeJS.ProcessEnv; runtime: unknown; stdout: OutputWriter; stderr: OutputWriter }): Promise<number>;
}

export interface DecisionDriverEnv {
  AIWG_DECISION_ENABLED?: string;
  AIWG_DECISION_MCP_REQUESTS?: string;
  [key: string]: string | undefined;
}

export interface DecisionDriverOptions {
  cwd?: string;
  frameworkRoot?: string;
  env?: DecisionDriverEnv;
  runtime?: unknown;
  dispatcher?: DispatcherModule;
}

export interface DecisionRequestProfile {
  name: string;
  requestPath: string;
  hostPolicyModulePath?: string;
}

export interface DecisionEvaluateOptions {
  hostPolicyModulePath?: string;
}

const DECISION_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VALIDATION_TARGETS = ['request', 'definition', 'ruleset', 'binding'] as const;
const OFFLINE_ADAPTER = 'agentic/code/addons/decision-engine/examples/fixture-jev-adapter.mjs';

type ValidationTarget = typeof VALIDATION_TARGETS[number];

function getPackageRoot(start = DECISION_ROOT): string {
  let current = start;
  while (true) {
    if (existsSync(path.join(current, 'package.json')) && existsSync(path.join(current, 'agentic/code/addons/decision-engine'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return path.dirname(DECISION_ROOT);
    current = parent;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function driverEnv(options: DecisionDriverOptions): DecisionDriverEnv {
  return { ...process.env, ...(options.env ?? {}) };
}

function frameworkRoot(options: DecisionDriverOptions): string {
  return path.resolve(options.frameworkRoot ?? getPackageRoot());
}

function resolvePath(candidate: string, base: string): string {
  if (!candidate) throw new Error('Path is required');
  return path.resolve(base, candidate);
}

function isSafeHostReference(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value) && value !== '.' && value !== '..' && !value.includes('..');
}

function isEnvironmentReference(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function validateHostReferenceMap(value: unknown, field: string, valueLabel: string, validateValue: (candidate: string) => boolean): string[] {
  if (!isRecord(value)) return [`${field} must be an object of safe logical references to ${valueLabel}`];
  const errors: string[] = [];
  for (const [key, candidate] of Object.entries(value)) {
    if (!isSafeHostReference(key)) errors.push(`${field} keys must be safe logical references`);
    if (typeof candidate !== 'string' || !candidate || !validateValue(candidate)) errors.push(`${field} values must be ${valueLabel}`);
  }
  return [...new Set(errors)];
}

async function readJson(filePath: string): Promise<{ value?: unknown; error?: string }> {
  try {
    return { value: JSON.parse(await readFile(filePath, 'utf8')) };
  } catch (error) {
    if (error instanceof SyntaxError) return { error: 'invalid-json' };
    throw error;
  }
}

function requestSchemaErrors(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ['request must be an object'];
  try { assertDecisionEvaluateDispatcherConfig(value); }
  catch (error) { errors.push(error instanceof Error ? error.message : 'invalid-request-config'); }
  for (const key of ['rulesetPath', 'bindingPath', 'inputPath']) {
    if (typeof value[key] !== 'string' || !value[key]) errors.push(`${key} must be a non-empty string`);
  }
  if (value.definitionPaths !== undefined
    && (!Array.isArray(value.definitionPaths) || value.definitionPaths.some(item => typeof item !== 'string' || !item))) {
    errors.push('definitionPaths must be an array of non-empty strings');
  }
  if (value.adapterModules !== undefined) errors.push(...validateHostReferenceMap(value.adapterModules,
    'adapterModules', 'non-empty module paths', candidate => Boolean(candidate)));
  if (value.credentials !== undefined) errors.push(...validateHostReferenceMap(value.credentials,
    'credentials', 'environment variable names', isEnvironmentReference));
  if (value.receiptIntegrityKeyRef !== undefined
    && (typeof value.receiptIntegrityKeyRef !== 'string' || !isSafeHostReference(value.receiptIntegrityKeyRef))) {
    errors.push('receiptIntegrityKeyRef must be a safe logical reference');
  }
  if (value.receiptIntegrityKeyRef !== undefined && isRecord(value.credentials)
    && typeof value.receiptIntegrityKeyRef === 'string' && !Object.hasOwn(value.credentials, value.receiptIntegrityKeyRef)) {
    errors.push('receiptIntegrityKeyRef must refer to a configured credential logical reference');
  }
  return errors;
}

function normalizeDecisionStatus(status: string, reason: string): EvaluationStatus {
  if (status === 'success') return 'success';
  if (status === 'abstained') return 'abstained';
  if (status === 'cancelled') return 'cancelled';
  if (reason === 'data-boundary-denied' || reason === 'unauthorized' || reason === 'authentication') return 'denied';
  if (reason === 'executor-unavailable' || reason === 'unsupported-capability' || status === 'unsupported') return 'unavailable';
  return 'error';
}

function normalizeRulesetStatus(status: RulesetResult['spec']['status'], reason: string, evaluations: EvaluationStatus[] = []): EvaluationStatus {
  if (status === 'completed' || status === 'defaulted') {
    if (evaluations.some(value => value === 'success')) return 'success';
    if (evaluations.some(value => value === 'denied')) return 'denied';
    if (evaluations.some(value => value === 'unavailable')) return 'unavailable';
    if (evaluations.some(value => value === 'abstained')) return 'abstained';
    if (evaluations.length > 0) return 'error';
    return 'success';
  }
  if (status === 'review') return 'abstained';
  if (status === 'cancelled') return 'cancelled';
  if (reason === 'data-boundary-denied' || reason === 'unauthorized' || reason === 'authentication') return 'denied';
  if (reason === 'executor-unavailable' || reason === 'unsupported-capability') return 'unavailable';
  return 'error';
}

function compactRulesetResult(result: RulesetResult) {
  const evaluationStatuses: EvaluationStatus[] = [];
  const evaluations = Object.fromEntries(Object.entries(result.spec.evaluations).map(([alias, evaluation]) => [
    alias,
    (() => {
      const status = normalizeDecisionStatus(evaluation.spec.status, evaluation.spec.reason);
      evaluationStatuses.push(status);
      return {
        status,
        reason: evaluation.spec.reason,
        attempts: evaluation.spec.attempts.length,
        value: evaluation.spec.value ?? null,
      };
    })(),
  ]));
  return {
    status: normalizeRulesetStatus(result.spec.status, result.spec.reason, evaluationStatuses),
    rulesetStatus: result.spec.status,
    reason: result.spec.reason,
    matchedRules: [...result.spec.matchedRules],
    evaluations,
    outcome: result.spec.outcome ?? null,
  };
}

function compactPatternReceipt(receipt: PatternReceipt) {
  return {
    status: receipt.route === 'accept' ? 'success' : receipt.route === 'review' ? 'abstained' : 'denied',
    route: receipt.route,
    reason: receipt.reason,
    pattern: receipt.pattern,
    fixtureId: receipt.fixtureId,
    attempts: receipt.attempts,
    transportCalls: receipt.runtime.transportCalls,
    usage: receipt.usage,
    checks: receipt.checks,
    evaluations: receipt.evaluations.map(item => ({
      alias: item.alias,
      primitive: item.primitive,
      status: item.status,
      reason: item.reason,
      attempts: item.attempts,
      value: item.value,
    })),
  };
}

function parseMcpRequestProfiles(raw: string | undefined, cwd: string): DecisionRequestProfile[] {
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = Object.fromEntries(raw.split(',').filter(Boolean).map(entry => {
      const index = entry.indexOf('=');
      if (index < 1) throw new Error('AIWG_DECISION_MCP_REQUESTS must be JSON or comma-separated name=path entries');
      return [entry.slice(0, index).trim(), entry.slice(index + 1).trim()];
    }));
  }
  if (!isRecord(parsed)) throw new Error('AIWG_DECISION_MCP_REQUESTS must resolve to an object');
  return Object.entries(parsed).map(([name, value]) => {
    const requestPath = typeof value === 'string' ? value : isRecord(value) && typeof value.requestPath === 'string' ? value.requestPath : null;
    const hostPolicyModulePath = isRecord(value) && typeof value.hostPolicyModulePath === 'string' ? value.hostPolicyModulePath : undefined;
    if (!requestPath || !/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error('Invalid decision MCP request profile');
    if (isRecord(value) && 'hostPolicyModulePath' in value && !hostPolicyModulePath) throw new Error('Invalid decision MCP request profile');
    return {
      name,
      requestPath: resolvePath(requestPath, cwd),
      ...(hostPolicyModulePath ? { hostPolicyModulePath: resolvePath(hostPolicyModulePath, cwd) } : {}),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

async function loadDispatcher(options: DecisionDriverOptions): Promise<DispatcherModule> {
  if (options.dispatcher) return options.dispatcher;
  const moduleUrl = pathToFileURL(path.join(getPackageRoot(), 'agentic/code/addons/decision-engine/skills/decision-evaluate/scripts/decision-evaluate-core.mjs'));
  return await import(moduleUrl.href) as DispatcherModule;
}

async function loadRuntime(options: DecisionDriverOptions): Promise<unknown> {
  if (options.runtime) return options.runtime;
  return await import('./index.js');
}

export function decisionCapabilities(options: DecisionDriverOptions = {}) {
  const env = driverEnv(options);
  const profiles = parseMcpRequestProfiles(env.AIWG_DECISION_MCP_REQUESTS, options.cwd ?? process.cwd());
  const packs = decisionPatternPacks;
  return {
    schema: 'aiwg-decision-driver-capabilities/v1',
    enabled: env.AIWG_DECISION_ENABLED === '1',
    offlineReady: true,
    primitives: [...new Set(packs.map(pack => pack.primitive))].sort(),
    patterns: {
      total: packs.length,
      supported: packs.filter(pack => pack.status === 'supported').length,
      experimental: packs.filter(pack => pack.status === 'experimental').length,
      unavailable: packs.filter(pack => pack.status === 'unavailable').length,
    },
    features: {
      patterns: ['list', 'show', 'offline-run', 'live-plan'],
      validation: [...VALIDATION_TARGETS],
      evaluate: { requiresEnv: 'AIWG_DECISION_ENABLED=1', mcpRequiresOptIn: true, mcpProfiles: profiles.map(profile => profile.name) },
      setup: ['synthetic-classification'],
      experimental: packs.filter(pack => pack.status === 'experimental').map(pack => pack.id),
    },
    backend: {
      configured: env.AIWG_DECISION_ENABLED === '1',
      probed: false,
      status: 'not-probed',
      note: 'Capabilities do not infer credential, network, dispatcher, or backend readiness.',
    },
    configuration: {
      env: {
        AIWG_DECISION_ENABLED: env.AIWG_DECISION_ENABLED === '1' ? 'set' : 'unset',
        AIWG_DECISION_MCP_REQUESTS: profiles.length ? 'configured' : 'unset',
      },
    },
  };
}

export function listPatterns() {
  return { schema: 'aiwg-decision-pattern-list/v1', patterns: listDecisionPatterns() };
}

export function showPattern(id: DecisionPatternId) {
  const pack = getDecisionPatternPack(id);
  return {
    schema: 'aiwg-decision-pattern-show/v1',
    pack,
    inputSchema: patternInputSchema(id),
    outputSchema: patternOutputSchema(id),
    livePlan: planLiveDecisionPattern(id, { explicitOptIn: false, credentialResolved: false, egressApproved: false }),
  };
}

export async function runOfflinePattern(id: DecisionPatternId, fixtureId?: string) {
  const receipt = await runOfflineDecisionPattern(id, fixtureId);
  return { schema: 'aiwg-decision-offline-run/v1', ...compactPatternReceipt(receipt), receipt };
}

export function livePlan(id: DecisionPatternId, options: { explicitOptIn?: boolean; credentialResolved?: boolean; egressApproved?: boolean } = {}): LivePatternPlan {
  return planLiveDecisionPattern(id, {
    explicitOptIn: options.explicitOptIn === true,
    credentialResolved: options.credentialResolved === true,
    egressApproved: options.egressApproved === true,
  });
}

function documentSummary(value: unknown) {
  if (!isRecord(value)) return {};
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  return {
    kind: typeof value.kind === 'string' ? value.kind : null,
    apiVersion: typeof value.apiVersion === 'string' ? value.apiVersion : null,
    id: typeof metadata.id === 'string' ? metadata.id : null,
    version: typeof metadata.version === 'string' ? metadata.version : null,
  };
}

export function validateDecisionValue(target: ValidationTarget, value: unknown, source = 'inline') {
  const errors: string[] = [];
  try {
    if (target === 'request') errors.push(...requestSchemaErrors(value));
    else if (target === 'definition') validateDefinition(value as DecisionDefinition);
    else if (target === 'ruleset') validateRuleset(value as DecisionRuleset);
    else if (target === 'binding') {
      if (!isRecord(value) || value.kind !== 'DecisionBinding') errors.push('binding kind must be DecisionBinding');
      else validateDecisionDocument(value);
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message.replace(/:\s*["'`].*$/s, '') : 'validation-failed');
  }
  return { schema: 'aiwg-decision-validation/v1', target, source, valid: errors.length === 0, summary: documentSummary(value), errors };
}

export async function validateDecisionInput(target: ValidationTarget, filePath: string, options: DecisionDriverOptions = {}) {
  const resolved = resolvePath(filePath, options.cwd ?? process.cwd());
  const loaded = await readJson(resolved);
  if (loaded.error) {
    return { schema: 'aiwg-decision-validation/v1', target, source: 'path', valid: false, summary: {}, errors: [loaded.error] };
  }
  return validateDecisionValue(target, loaded.value, 'path');
}

export async function evaluateRequestPath(requestPath: string, options: DecisionDriverOptions = {}, evaluateOptions: DecisionEvaluateOptions = {}) {
  const env = driverEnv(options);
  const resolved = resolvePath(requestPath, options.cwd ?? process.cwd());
  if (env.AIWG_DECISION_ENABLED !== '1') {
    return { schema: 'aiwg-decision-evaluate/v1', status: 'denied' as EvaluationStatus, reason: 'explicit-enable-required', exitCode: 2, result: null };
  }
  const validation = await validateDecisionInput('request', resolved, options);
  if (!validation.valid) return { schema: 'aiwg-decision-evaluate/v1', status: 'error' as EvaluationStatus, reason: 'invalid-request', exitCode: 2, validation, result: null };
  const dispatcher = await loadDispatcher(options);
  const runtime = await loadRuntime(options);
  let stdout = '';
  let stderr = '';
  const argv = ['--request', resolved];
  if (evaluateOptions.hostPolicyModulePath) argv.push('--host-policy-module', resolvePath(evaluateOptions.hostPolicyModulePath, options.cwd ?? process.cwd()));
  const exitCode = await dispatcher.runDecisionEvaluate({
    argv,
    env,
    runtime,
    stdout: { write(chunk: string | Uint8Array) { stdout += String(chunk); return true; } },
    stderr: { write(chunk: string | Uint8Array) { stderr += String(chunk); return true; } },
  });
  let parsed: RulesetResult | null = null;
  try {
    parsed = JSON.parse(stdout) as RulesetResult;
    if (!isRecord(parsed) || parsed.kind !== 'RulesetResult') throw new Error('dispatcher output must be a RulesetResult');
    validateDecisionDocument(parsed);
  } catch {
    parsed = null;
  }
  const compact = parsed ? compactRulesetResult(parsed) : null;
  return {
    schema: 'aiwg-decision-evaluate/v1',
    status: compact?.status ?? (exitCode === 2 ? 'denied' as const : 'error' as const),
    reason: parsed?.spec.reason ?? (stderr.trim() || 'dispatcher-output-unavailable'),
    exitCode,
    stderr: stderr.trim(),
    compact,
    result: parsed,
  };
}

export async function evaluateMcpProfile(profileName: string, optIn: boolean, options: DecisionDriverOptions = {}) {
  if (!optIn) return { schema: 'aiwg-decision-evaluate/v1', status: 'denied' as EvaluationStatus, reason: 'per-call-opt-in-required', exitCode: 2, result: null };
  const profiles = parseMcpRequestProfiles(driverEnv(options).AIWG_DECISION_MCP_REQUESTS, options.cwd ?? process.cwd());
  const profile = profiles.find(candidate => candidate.name === profileName);
  if (!profile) return { schema: 'aiwg-decision-evaluate/v1', status: 'unavailable' as EvaluationStatus, reason: 'unknown-request-profile', exitCode: 2, result: null };
  return evaluateRequestPath(profile.requestPath, options, { hostPolicyModulePath: profile.hostPolicyModulePath });
}

export function syntheticClassificationSetup(options: { allowedOptions?: string[]; text?: string } = {}, driverOptions: DecisionDriverOptions = {}) {
  const id: DecisionPatternId = 'bounded-classification';
  const artifacts = governedPatternArtifacts(id, '1.0.0');
  const definition = artifacts.definitions['pattern.bounded-classification.category'];
  const answer = definition?.spec.answer;
  const pinnedOptions = answer?.kind === 'choice' ? answer.options.map(option => option.id) : [];
  const allowedOptions = options.allowedOptions === undefined ? ['bug', 'feature', 'none'] : options.allowedOptions;
  if (allowedOptions.length === 0) throw new Error('allowedOptions must not be empty');
  if (new Set(allowedOptions).size !== allowedOptions.length) throw new Error('allowedOptions must not contain duplicates');
  if (allowedOptions.some(option => !option.trim())) throw new Error('allowedOptions must not contain blank values');
  const unknown = allowedOptions.filter(option => !pinnedOptions.includes(option));
  if (unknown.length) throw new Error(`allowedOptions must be selected from the pinned definition options: ${pinnedOptions.join(', ')}`);
  const text = options.text ?? 'Synthetic ticket: app crashes after saving settings.';
  if (!text.trim()) throw new Error('text must not be blank');
  const input = { allowedOptions, text };
  validateAgainstSchema(patternInputSchema(id), input, 'synthetic classification input');
  const root = frameworkRoot(driverOptions);
  const files: Record<string, JsonValue> = {
    'definition-category.json': artifacts.definitions['pattern.bounded-classification.category'] as unknown as JsonValue,
    'ruleset.json': artifacts.ruleset as unknown as JsonValue,
    'binding.json': artifacts.offlineBinding as unknown as JsonValue,
    'input.json': input,
    'dispatcher-request.json': {
      rulesetPath: 'ruleset.json',
      bindingPath: 'binding.json',
      inputPath: 'input.json',
      definitionPaths: ['definition-category.json'],
      adapterModules: { jev: path.join(root, OFFLINE_ADAPTER) },
      runId: 'synthetic-classification',
      invocationId: 'synthetic-classification-1',
    },
  };
  return { schema: 'aiwg-decision-synthetic-setup/v1', pattern: { id, version: '1.0.0' }, files };
}

export async function materializeSyntheticClassificationSetup(outputDir: string, options: { allowedOptions?: string[]; text?: string } = {}, driverOptions: DecisionDriverOptions = {}) {
  const resolved = resolvePath(outputDir, driverOptions.cwd ?? process.cwd());
  const setup = syntheticClassificationSetup(options, driverOptions);
  await mkdir(resolved, { recursive: true });
  const written: Record<string, string> = {};
  for (const [filename, content] of Object.entries(setup.files)) {
    const destination = path.join(resolved, filename);
    try {
      await writeFile(destination, `${JSON.stringify(content, null, 2)}\n`, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Refusing to overwrite ${destination}`);
      throw error;
    }
    written[filename] = destination;
  }
  return { schema: 'aiwg-decision-synthetic-setup-materialized/v1', outputDir: resolved, files: written };
}
