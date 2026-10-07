/**
 * Provider-aware model policy registry, validation, and compilation.
 * @implements #1802
 * @implements #1805
 */
import { z } from 'zod';
import { createRequire } from 'node:module';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { satisfies, validRange } from 'semver';
import type {
  CanonicalModelPolicy, ModelCompilationOutcome, ModelEffort, ModelRole, Provider,
} from './types.js';

const require = createRequire(import.meta.url);
function requireModelResource(filename: string): unknown {
  const candidates = [
    `./${filename}`,
    `../../agentic/code/providers/${filename}`,
    `../../../agentic/code/providers/${filename}`,
    `../../schemas/models/${filename}`,
    `../../../schemas/models/${filename}`,
  ];
  for (const candidate of candidates) {
    try { return require(candidate); } catch (error: any) {
      if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error(`Model policy resource is missing: ${filename}`);
}
const capabilityData = requireModelResource('model-capabilities.v1.json');
const catalogData = requireModelResource('model-catalog.v1.json');

const ProviderSchema = z.enum([
  'antigravity', 'claude', 'codex', 'copilot', 'cursor', 'deepseek-harness', 'factory', 'grokbot', 'grok-build', 'hermes',
  'muse', 'opencode', 'openclaw', 'openhuman', 'omp', 'pi', 'warp', 'windsurf',
]);
const OutcomeSchema = z.enum([
  'native', 'compiled', 'inherited', 'global-only', 'informational', 'unsupported',
]);

export interface WorkerInvocationProfile {
  transport: 'shell' | 'mcp';
  supportedVersions: string;
  controls: Record<string, { support: 'native' | 'external' | 'not-applicable' | 'unqualified'; mapping: string; evidence: string }>;
  envAllowlist: string[];
  pitfalls: string[];
  mcp?: { serverRef: string; tool: string; inputSchemaDigest: string; outputSchemaDigest: string;
    sessionIsolation: 'per-call' | 'per-instance' | 'serialized'; cancel: 'confirmed' | 'uncertain' };
  health?: Record<string, unknown>;
}
export interface WorkerAdapterMetadata {
  version: 1;
  id: string;
  provider: string;
  adapterVersion: string;
  supportedVersions: string;
  runtimeDriver: string;
  catalogAdapter: { kind: 'command' | 'file' | 'http' | 'module'; locator: string; parser: string;
    argv?: string[]; timeoutSeconds?: number; maxBytes?: number };
  invocation: { kind: 'process'; executable: string; argv: string[]; stdin: 'closed' | 'brief-json' | 'brief-text';
    cwd: '${workspace}'; envAllowlist: string[]; versionArgv: string[]; maxOutputBytes?: number }
    | { kind: 'http'; protocol: 'ollama' | 'llama-cpp' | 'openai-compatible'; healthPath: string;
      modelsPath: string; generatePath: string; timeoutSeconds?: number; maxOutputBytes?: number };
  capabilities: { output: 'native-schema' | 'validated-file' | 'text'; modelPin: 'observed' | 'requested' | 'unsupported';
    effort: 'explicit' | 'not-applicable' | 'unsupported'; cancel: 'process-group' | 'session' | 'none';
    resume: boolean; sandboxModes: string[]; nestedAgentsControllable: boolean; nativeFallbackControllable: boolean; hardBudget: string[] };
  qualification: { status: 'unqualified' | 'qualified'; fixtureDigest?: string; verifiedAt?: string; evidenceRef?: string };
  invocationProfiles?: Record<string, WorkerInvocationProfile>;
}

// Use the bundled owner for nested controls, including forward-compatible optional
// health records. Zod must validate and preserve them, never silently strip them.
const capabilitySchema = requireModelResource('provider-model-capabilities.v1.schema.json') as any;
const capabilityAjv = addFormats(new Ajv2020({ strict: false, allErrors: true }));
capabilityAjv.addSchema(capabilitySchema);
const validateAdapter = capabilityAjv.compile({ $ref: `${capabilitySchema.$id}#/$defs/workerAdapter` });
export const WorkerAdapterSchema = z.custom<WorkerAdapterMetadata>(value => validateAdapter(value),
  () => ({ message: `Invalid worker adapter: ${capabilityAjv.errorsText(validateAdapter.errors)}` }));
const CapabilityEntrySchema = z.object({
  agent: OutcomeSchema,
  skill: OutcomeSchema,
  globalChild: OutcomeSchema,
  identifierSyntax: z.string().min(1),
  effortValues: z.array(z.string().min(1)).optional(),
  inheritance: z.string().min(1),
  invalidPinFallback: z.string().min(1),
  configTarget: z.string().min(1),
  artifactFormat: z.string().min(1),
  verification: z.string().min(1),
  sourceUrl: z.string().url(),
  verifiedAt: z.string().date(),
  workerAdapter: WorkerAdapterSchema.optional(),
}).strict();
const CapabilityRegistrySchema = z.object({
  $schema: z.enum([
    '../../../schemas/models/provider-model-capabilities.v1.schema.json',
    'https://aiwg.io/schemas/models/provider-model-capabilities.v1.schema.json',
  ]).optional(),
  version: z.literal('1.0.0'),
  verifiedAt: z.string().date(),
  providers: z.record(ProviderSchema, CapabilityEntrySchema),
  workerAdapters: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,62}$/), WorkerAdapterSchema)
    .refine(value => Object.keys(value).length <= 128, 'At most 128 worker adapters').optional(),
}).strict();
const CatalogModelSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['active', 'deprecated', 'unverified']),
  fallback: z.string().min(1).optional(),
  observed: z.boolean().optional(),
});
const CatalogProviderSchema = z.object({
  roles: z.object({
    reasoning: CatalogModelSchema,
    coding: CatalogModelSchema,
    efficiency: CatalogModelSchema,
  }),
  sourceUrl: z.string().url(),
  verifiedAt: z.string().date(),
});
const CatalogSchema = z.object({
  version: z.literal('1.0.0'),
  refreshedAt: z.string().date(),
  staleAfterDays: z.number().int().positive(),
  providers: z.record(ProviderSchema, CatalogProviderSchema),
});
const PolicySchema = z.object({
  role: z.enum(['reasoning', 'coding', 'efficiency']),
  tier: z.enum(['economy', 'standard', 'premium']),
  effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
  override: z.string().min(1).optional(),
}).strict();
const UserProjectModelConfigSchema = z.object({
  defaults: z.object({
    tier: z.enum(['economy', 'standard', 'premium', 'max-quality']).optional(),
    provider: ProviderSchema.optional(),
  }).strict().optional(),
  agentOverrides: z.record(z.string(), z.object({
    'model-tier': z.enum(['economy', 'standard', 'premium', 'max-quality']).optional(),
    'model-override': z.string().min(1).optional(),
    rationale: z.string().min(1).optional(),
  }).strict()).optional(),
  customTiers: z.record(z.string(), z.object({
    description: z.string().min(1),
    costMultiplier: z.number().nonnegative(),
    roleMapping: z.object({
      reasoning: z.enum(['reasoning', 'coding', 'efficiency']),
      coding: z.enum(['reasoning', 'coding', 'efficiency']),
      efficiency: z.enum(['reasoning', 'coding', 'efficiency']),
    }).strict(),
  }).strict()).optional(),
  rationale: z.string().optional(),
}).passthrough();

export type ProviderModelCapability = z.infer<typeof CapabilityEntrySchema>;
export type ProviderModelCapabilityRegistry = z.infer<typeof CapabilityRegistrySchema>;
export type ProviderModelCatalog = z.infer<typeof CatalogSchema>;
export type ModelPolicyProvider = Exclude<Provider, 'openai'>;
export type ModelDiagnosticSeverity = 'error' | 'warning' | 'info';
export interface ModelDiagnostic {
  code:
    | 'MODEL_POLICY_INVALID' | 'MODEL_PROVIDER_UNKNOWN'
    | 'MODEL_SURFACE_UNSUPPORTED' | 'MODEL_SURFACE_DEGRADED'
    | 'MODEL_EFFORT_UNSUPPORTED' | 'MODEL_CATALOG_DEPRECATED'
    | 'MODEL_CATALOG_UNVERIFIED' | 'MODEL_CATALOG_STALE'
    | 'MODEL_OVERRIDE_UNVERIFIED';
  severity: ModelDiagnosticSeverity;
  message: string;
  provider?: Provider;
}
export interface CompileModelPolicyInput {
  provider: ModelPolicyProvider;
  artifact: 'agent' | 'skill';
  policy: CanonicalModelPolicy;
  catalog?: ProviderModelCatalog;
  now?: Date;
}
export interface CompiledModelPolicy {
  provider: ModelPolicyProvider;
  artifact: 'agent' | 'skill';
  outcome: ModelCompilationOutcome;
  effectiveModel?: string;
  effectiveEffort?: ModelEffort;
  fields: Record<string, string>;
  target: string;
  source: 'override' | 'catalog' | 'inheritance';
  diagnostics: ModelDiagnostic[];
}

let registryCache: ProviderModelCapabilityRegistry | null = null;
let catalogCache: ProviderModelCatalog | null = null;

export function loadProviderModelCapabilities(): ProviderModelCapabilityRegistry {
  if (!registryCache) {
    registryCache = parseProviderModelCapabilities(capabilityData);
  }
  return registryCache;
}

export function parseProviderModelCapabilities(input: unknown): ProviderModelCapabilityRegistry {
  const registry = CapabilityRegistrySchema.parse(input);
  const expected = new Set(ProviderSchema.options);
  const actual = new Set(Object.keys(registry.providers));
  if (actual.size !== expected.size || [...expected].some(id => !actual.has(id))) {
    throw new Error('Provider model capability registry must cover all registered providers');
  }
  const ids = new Set<string>();
  for (const adapter of [...Object.values(registry.providers).flatMap(p => p.workerAdapter ? [p.workerAdapter] : []),
    ...Object.values(registry.workerAdapters ?? {})]) {
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(adapter.id) || ids.has(adapter.id)) throw new Error(`Duplicate or invalid worker adapter ID: ${adapter.id}`);
    ids.add(adapter.id);
  }
  return registry;
}

/** Exact, case-sensitive references; deployment and inference provider identities differ. */
export function resolveWorkerAdapter(registry: ProviderModelCapabilityRegistry, reference: string): WorkerAdapterMetadata {
  const match = /^(providers|workerAdapters):([a-z][a-z0-9-]{0,62})$/.exec(reference);
  if (!match) throw new Error(`Invalid worker adapter reference: ${reference}`);
  const [, namespace, id] = match;
  const adapter = namespace === 'providers'
    ? registry.providers[id as keyof typeof registry.providers]?.workerAdapter
    : registry.workerAdapters?.[id];
  if (!adapter) throw new Error(`Unknown worker adapter reference: ${reference}`);
  return WorkerAdapterSchema.parse(adapter);
}

/** Pure direct/shared mapping: no admission store, Mission or activation marker. */
export function resolveWorkerInstallation(registry: ProviderModelCapabilityRegistry,
  installation: { adapter: string; executable?: string; endpoint?: string }) {
  const adapter = resolveWorkerAdapter(registry, installation.adapter);
  if (adapter.invocation.kind === 'process') {
    if (installation.endpoint !== undefined) throw new Error('Process adapter forbids endpoint');
    const executable = installation.executable ?? adapter.invocation.executable;
    if (!executable.trim() || executable.includes('\0')) throw new Error('Process adapter requires executable');
    return { adapter, executable };
  }
  if (installation.executable !== undefined) throw new Error('HTTP adapter forbids executable');
  if (!installation.endpoint) throw new Error('HTTP adapter requires endpoint');
  const endpoint = new URL(installation.endpoint);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error('Invalid HTTP adapter endpoint');
  }
  return { adapter, endpoint: installation.endpoint };
}

/** Qualification is transport/version scoped; deployment support is insufficient. */
export function qualifyWorkerInvocationProfile(adapter: WorkerAdapterMetadata, selection: {
  profile: string; transport: 'shell' | 'mcp'; cliVersion: string; requiredControls?: string[];
  mcp?: WorkerInvocationProfile['mcp'];
}): WorkerInvocationProfile {
  WorkerAdapterSchema.parse(adapter);
  const profile = adapter.invocationProfiles?.[selection.profile];
  if (adapter.qualification.status !== 'qualified' || !profile || profile.transport !== selection.transport) {
    throw new Error('Worker transport/profile is unqualified');
  }
  if (![adapter.supportedVersions, profile.supportedVersions].every(range => validRange(range) && satisfies(selection.cliVersion, range))) {
    throw new Error('Worker CLI version is outside qualified profile');
  }
  for (const name of selection.requiredControls ?? []) {
    const control = profile.controls[name];
    if (!control || !['native', 'external'].includes(control.support) || !control.mapping || !control.evidence) {
      throw new Error(`Required worker control is unqualified: ${name}`);
    }
  }
  if (selection.transport === 'mcp' && (!selection.mcp || !profile.mcp
    || Object.keys(profile.mcp).some(key => profile.mcp![key as keyof NonNullable<typeof profile.mcp>]
      !== selection.mcp![key as keyof NonNullable<typeof selection.mcp>]))) {
    throw new Error('MCP server/tool/schema/session qualification changed');
  }
  return profile;
}
export function loadProviderModelCatalog(): ProviderModelCatalog {
  if (!catalogCache) catalogCache = CatalogSchema.parse(catalogData);
  return catalogCache;
}
export function validateCanonicalModelPolicy(
  input: unknown,
): { valid: true; policy: CanonicalModelPolicy; diagnostics: ModelDiagnostic[] }
  | { valid: false; diagnostics: ModelDiagnostic[] } {
  const parsed = PolicySchema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      diagnostics: parsed.error.issues.map(issue => ({
        code: 'MODEL_POLICY_INVALID',
        severity: 'error',
        message: `${issue.path.join('.') || 'policy'}: ${issue.message}`,
      })),
    };
  }
  return { valid: true, policy: parsed.data, diagnostics: [] };
}
export function validateUserProjectModelConfig(input: unknown): {
  valid: boolean;
  diagnostics: ModelDiagnostic[];
} {
  const parsed = UserProjectModelConfigSchema.safeParse(input);
  if (parsed.success) return { valid: true, diagnostics: [] };
  return {
    valid: false,
    diagnostics: parsed.error.issues.map(issue => ({
      code: 'MODEL_POLICY_INVALID',
      severity: 'error',
      message: `${issue.path.join('.') || 'config'}: ${issue.message}`,
    })),
  };
}
function catalogRole(policy: CanonicalModelPolicy): ModelRole {
  if (policy.tier === 'economy') return 'efficiency';
  if (policy.tier === 'premium') return 'reasoning';
  return policy.role;
}
function fieldNames(provider: Provider): { model?: string; effort?: string } {
  switch (provider) {
    case 'antigravity': return { model: 'model', effort: 'effort' };
    case 'codex': return { model: 'model', effort: 'model_reasoning_effort' };
    case 'factory': return { model: 'model', effort: 'reasoningEffort' };
    case 'claude': return { model: 'model', effort: 'effort' };
    case 'copilot':
    case 'cursor':
    case 'opencode': return { model: 'model' };
    case 'grok-build': return { model: 'model', effort: 'effort' };
    case 'omp': return { model: 'model', effort: 'thinkingLevel' };
    case 'pi': return { model: 'model', effort: 'thinking' };
    case 'openhuman': return { model: 'model_hint' };
    case 'openclaw': return { model: 'subagents.model' };
    default: return {};
  }
}
export function compileModelPolicy(input: CompileModelPolicyInput): CompiledModelPolicy {
  const registry = loadProviderModelCapabilities();
  const catalog = input.catalog ?? loadProviderModelCatalog();
  const capability = registry.providers[input.provider];
  if (!capability) throw new Error(`Unknown provider model capability: ${input.provider}`);
  const surface = capability[input.artifact];
  const diagnostics: ModelDiagnostic[] = [];
  const fields: Record<string, string> = {};
  const names = fieldNames(input.provider);
  const catalogProvider = catalog.providers[input.provider];
  if (!catalogProvider) throw new Error(`Unknown provider model catalog: ${input.provider}`);
  const catalogEntry = catalogProvider.roles[catalogRole(input.policy)];
  const effectiveModel = input.policy.override ?? catalogEntry.id;

  if (surface === 'unsupported' || surface === 'informational') {
    diagnostics.push({
      code: surface === 'unsupported' ? 'MODEL_SURFACE_UNSUPPORTED' : 'MODEL_SURFACE_DEGRADED',
      severity: surface === 'unsupported' ? 'warning' : 'info',
      provider: input.provider,
      message: `${input.provider} cannot enforce ${input.artifact}-scoped model policy (${surface})`,
    });
  } else if (surface === 'global-only' || surface === 'inherited') {
    diagnostics.push({
      code: 'MODEL_SURFACE_DEGRADED', severity: 'warning', provider: input.provider,
      message: `${input.provider} compiles ${input.artifact} policy as ${surface}`,
    });
  } else if (names.model) {
    fields[names.model] = effectiveModel;
  }
  if (input.policy.effort) {
    if (names.effort && capability.effortValues?.includes(input.policy.effort)
      && surface !== 'unsupported' && surface !== 'informational') {
      fields[names.effort] = input.policy.effort;
    } else {
      diagnostics.push({
        code: 'MODEL_EFFORT_UNSUPPORTED', severity: 'warning', provider: input.provider,
        message: `${input.provider} does not enforce effort=${input.policy.effort} on ${input.artifact} artifacts`,
      });
    }
  }
  if (input.policy.override) {
    diagnostics.push({
      code: 'MODEL_OVERRIDE_UNVERIFIED', severity: 'warning', provider: input.provider,
      message: `Exact override ${input.policy.override} requires provider validation`,
    });
  } else if (catalogEntry.status === 'deprecated') {
    diagnostics.push({
      code: 'MODEL_CATALOG_DEPRECATED', severity: 'error', provider: input.provider,
      message: `${catalogEntry.id} is deprecated`,
    });
  } else if (catalogEntry.status === 'unverified') {
    diagnostics.push({
      code: 'MODEL_CATALOG_UNVERIFIED', severity: 'warning', provider: input.provider,
      message: `${catalogEntry.id} has not been observed on ${input.provider}`,
    });
  }
  const now = input.now ?? new Date();
  const refreshedAt = new Date(`${catalog.refreshedAt}T00:00:00Z`);
  const ageDays = Math.floor((now.getTime() - refreshedAt.getTime()) / 86_400_000);
  if (ageDays > catalog.staleAfterDays) {
    diagnostics.push({
      code: 'MODEL_CATALOG_STALE', severity: 'warning', provider: input.provider,
      message: `Model catalog is ${ageDays} days old (limit ${catalog.staleAfterDays})`,
    });
  }
  return {
    provider: input.provider,
    artifact: input.artifact,
    outcome: surface,
    effectiveModel: surface === 'unsupported' || surface === 'informational' ? undefined : effectiveModel,
    effectiveEffort: fields[names.effort ?? ''] ? input.policy.effort : undefined,
    fields,
    target: capability.configTarget,
    source: input.policy.override ? 'override' : (surface === 'inherited' ? 'inheritance' : 'catalog'),
    diagnostics,
  };
}
function tomlString(value: string): string { return JSON.stringify(value); }
export interface CodexAgentDefinition {
  name: string;
  description: string;
  developerInstructions: string;
  model?: string;
  modelReasoningEffort?: ModelEffort;
}
export function renderCodexAgentToml(definition: CodexAgentDefinition): string {
  const required = [
    ['name', definition.name],
    ['description', definition.description],
    ['developer_instructions', definition.developerInstructions],
  ] as const;
  for (const [field, value] of required) {
    if (!value.trim()) throw new Error(`Codex custom agent requires ${field}`);
  }
  const lines: string[] = required.map(([field, value]) => `${field} = ${tomlString(value)}`);
  if (definition.model) lines.push(`model = ${tomlString(definition.model)}`);
  if (definition.modelReasoningEffort) {
    lines.push(`model_reasoning_effort = ${tomlString(definition.modelReasoningEffort)}`);
  }
  return `${lines.join('\n')}\n`;
}
export function resetModelPolicyCachesForTests(): void {
  registryCache = null;
  catalogCache = null;
}
