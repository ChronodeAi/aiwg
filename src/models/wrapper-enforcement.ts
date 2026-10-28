// Describes controls on deployed wrapper artifacts, distinct from headless CLI controls.
import { compileModelPolicy, loadProviderModelCatalog, type ProviderModelCatalog, type ModelPolicyProvider } from './catalog-policy.js';
import { MODEL_WRAPPER_DEFINITIONS, type ModelWrapperDefinition } from './wrapper-definitions.js';
import type { ModelEffort, ModelTier } from './types.js';

export type WrapperTierEnforcement = 'pinned' | 'inherited' | 'global-only';
export interface WrapperControls { model?: string; effort?: string }
const NATIVE_CONTROLS: Record<string, WrapperControls> = {
  claude: { model: 'model', effort: 'effort' },
  codex: { model: 'model', effort: 'model_reasoning_effort' },
  copilot: { model: 'model' }, cursor: { model: 'model' },
  factory: { model: 'model', effort: 'reasoningEffort' },
  opencode: { model: 'model' }, omp: { model: 'model', effort: 'thinkingLevel' },
};
const GLOBAL_ONLY = new Set(['warp', 'hermes', 'grokbot', 'muse']);

export function wrapperControls(provider: string): WrapperControls {
  return NATIVE_CONTROLS[provider] ?? {};
}

export function isConcreteWrapperModel(model: string | undefined): model is string {
  return Boolean(model && !/^(?:configured\/|Hint\(|auto$|inherit(?:ed)?$|default$|profile-selected$|global-delegation-model$)/i.test(model));
}

export function resolveWrapperPin(provider: ModelPolicyProvider, wrapper: ModelWrapperDefinition,
  options: { catalog?: ProviderModelCatalog; override?: string; effort?: ModelEffort } = {}) {
  const controls = wrapperControls(provider);
  const catalog = options.catalog ?? loadProviderModelCatalog();
  let tier: ModelTier = wrapper.tier;
  let role = wrapper.role;
  const compile = () => compileModelPolicy({ provider, artifact: 'agent', catalog,
    policy: { role, tier, effort: options.effort ?? wrapper.effort,
      ...(options.override ? { override: options.override } : {}) } });
  let policy = compile();
  // Auto can select a flagship; every economy wrapper needs the concrete fallback.
  if (controls.model && policy.effectiveModel === 'auto' && !options.override) {
    tier = 'standard';
    role = 'coding';
    policy = compile();
  }
  if (controls.model && options.override && !isConcreteWrapperModel(options.override)) {
    throw new Error(`${provider}: wrapper override must be a concrete model pin`);
  }
  const model = controls.model && isConcreteWrapperModel(policy.effectiveModel) ? policy.effectiveModel : undefined;
  const effort = model && controls.effort ? policy.fields[controls.effort] : undefined;
  if (model && controls.effort && !effort) throw new Error(`${provider}: unsupported wrapper effort`);
  return { tier, role, model, effort, controls,
    enforcement: (GLOBAL_ONLY.has(provider) ? 'global-only' : model ? 'pinned' : 'inherited') as WrapperTierEnforcement };
}

/** Static artifact defaults; this does not inspect live sessions or assert runtime enforcement. */
export function wrapperEnforcementReport(provider: string): string {
  const catalog = loadProviderModelCatalog();
  const controls = wrapperControls(provider);
  const known = provider in catalog.providers;
  const states = known ? MODEL_WRAPPER_DEFINITIONS.map(wrapper =>
    resolveWrapperPin(provider as ModelPolicyProvider, wrapper, { catalog }).enforcement) : [];
  const state: WrapperTierEnforcement = GLOBAL_ONLY.has(provider) ? 'global-only'
    : states.length > 0 && states.every(value => value === 'pinned') ? 'pinned' : 'inherited';
  const effort = state === 'pinned' && controls.effort
    ? `pinned via ${controls.effort} (high/medium/low by wrapper)` : 'not enforced per wrapper';
  const details: Record<string, string> = {
    claude: 'Use AIWG wrappers or an explicit invocation model. Unpinned general-purpose agents inherit; CLAUDE_CODE_SUBAGENT_MODEL supplies a fallback and CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1 can override pins.',
    omp: 'Native model and thinkingLevel fields can pin exact operator role models; configured/* catalog entries are placeholders.',
    'grok-build': 'Not enforced: native-agent model translation remains gated by #2577; configured selectors do not establish tier enforcement.',
    openclaw: 'Markdown wrapper mirrors do not set native subagents.model or per-spawn overrides.',
    openhuman: 'User harness wrappers carry semantic model hints; project wrappers omit model. Neither is an exact pin.',
    antigravity: 'Wrapper mirrors do not project native CLI model/effort flags.',
    windsurf: 'Portable wrapper model selection is unsupported; the main UI session controls selection.',
    pi: 'Agents are reference skills; CLI model/thinking flags are separate from deployed wrappers.',
    'deepseek-harness': 'Agent references do not pin the configured Harness route.',
    hermes: 'All delegated workers share the provider delegation configuration.',
    warp: 'Model selection follows the Warp run/profile.',
    grokbot: 'No verified AIWG-owned per-worker model setting is available.',
    muse: 'Session --model or settings.json model controls selection; per-agent pins are unverified.',
  };
  return `Tier enforcement (generated wrapper defaults): ${state}; effort: ${effort}. `
    + `${details[provider] ?? (known ? 'Native custom subagents carry explicit catalog model selectors.' : 'Provider wrapper controls are unverified.')} `
    + 'Explicit operator pins are preserved where supported. This is not a live resolved-model audit; provider/account policy may substitute models.';
}
