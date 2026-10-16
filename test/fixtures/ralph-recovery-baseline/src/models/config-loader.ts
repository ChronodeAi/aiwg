/**
 * FROZEN REFERENCE FIXTURE -- NOT PRODUCTION CODE.
 * Source: src/models/config-loader.ts at 8c812250d6e8e139eb52f798b92934bab9350021.
 * Only import routing and this pin header differ from the baseline body.
 * Refresh with: node test/fixtures/ralph-recovery-baseline/refresh.mjs --ref=8c812250d6e8e139eb52f798b92934bab9350021
 * Installation ownership and default input loading stay in this fixture graph.
 * Other dependencies use repository source. Never import from production.
 */

/**
 * Model Configuration Loader
 * Loads and merges model configurations from multiple sources with proper precedence
 *
 * @implements @.aiwg/architecture/ADR-015-enhanced-model-selection.md
 * @architecture @.aiwg/architecture/enhanced-model-selection-design.md
 */

import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { workerConfigDigest, validateWorkerGroupReferences, type ParallelismConfig, type WorkerActivation } from '../config/aiwg-config.ts';
import { DEFAULT_WORKER_SELECTION, mergeWorkerSelection, WorkerSelectionPolicySchema, validateUserProjectModelConfig } from './provider-policy.ts';
import type {
  ModelConfig,
  ModelConfigV1,
  UserProjectConfig,
  MergedModelConfig,
  ProviderDefinition,
  AgentOverride,
} from '../../../../../src/models/types.ts';

/**
 * Configuration file locations
 */
export interface ConfigLocations {
  aiwgDefault: string;
  userConfig: string;
  projectConfig: string;
}

/** Options overriding `ConfigLoader`'s default location resolution. */
export interface ConfigLoaderOptions {
  /**
   * Resolved AIWG home to load bundled model defaults from. Takes
   * precedence over `AIWG_HOME` when provided — callers resolve their own
   * explicit-env-vs-fallback precedence and pass the result here rather
   * than ever writing `process.env.AIWG_HOME` themselves.
   */
  aiwgHome?: string;
}

/**
 * Loads and merges model configurations
 */
export class ConfigLoader {
  private cache: MergedModelConfig | null = null;
  private cacheDigest: string | null = null;
  private inputDigests: Pick<WorkerActivation, 'projectModelsDigest' | 'userModelsDigest' | 'builtinModelsDigest'> | null = null;
  private readonly locations: ConfigLocations;

  constructor(projectPath?: string, options?: ConfigLoaderOptions) {
    const aiwgHome = options?.aiwgHome || process.env.AIWG_HOME || resolve(homedir(), '.local/share/ai-writing-guide');
    const userConfigDir = process.env.AIWG_CONFIG || resolve(homedir(), '.config/aiwg');

    this.locations = {
      aiwgDefault: resolve(aiwgHome, 'agentic/code/frameworks/sdlc-complete/config/models-v2.json'),
      userConfig: resolve(userConfigDir, 'models.json'),
      projectConfig: resolve(projectPath || process.cwd(), 'models.json'),
    };
  }

  /**
   * Load and merge all configurations
   * Precedence: project > user > AIWG default
   */
  async load(parallelism?: ParallelismConfig): Promise<MergedModelConfig> {
    // Load all configs
    const aiwgDefault = await this.loadAiwgDefault();
    const userConfig = await this.loadUserConfig();
    const projectConfig = await this.loadProjectConfig();

    const digest = workerConfigDigest([aiwgDefault, userConfig, projectConfig, parallelism]);
    if (this.cache && this.cacheDigest === digest) return this.cache;

    // Merge with precedence
    const merged = this.merge(aiwgDefault, userConfig, projectConfig);

    // A group-bound wrapper's inherited exact pin survives a higher-precedence
    // tier-only preference. Preserve the legacy unbound merge otherwise.
    if (parallelism?.worker_dispatch) {
      for (const [agent, override] of Object.entries(projectConfig?.agentOverrides ?? {})) {
        merged.agentOverrides[agent] = { ...userConfig?.agentOverrides?.[agent], ...override };
      }
    }

    if (parallelism?.worker_dispatch || [aiwgDefault, userConfig, projectConfig].some(config => config?.defaults?.workerSelection !== undefined)) {
      const result = mergeWorkerSelection([
        { source: this.locations.aiwgDefault, authority: 'builtin', digest: workerConfigDigest(aiwgDefault), policy: DEFAULT_WORKER_SELECTION },
        { source: this.locations.aiwgDefault, authority: 'builtin', digest: workerConfigDigest(aiwgDefault), policy: aiwgDefault.defaults.workerSelection },
        { source: this.locations.userConfig, authority: 'user', digest: workerConfigDigest(userConfig), policy: userConfig?.defaults?.workerSelection },
        { source: this.locations.projectConfig, authority: 'project', digest: workerConfigDigest(projectConfig), policy: projectConfig?.defaults?.workerSelection },
      ]);
      if (result.diagnostics.length) throw new Error(result.diagnostics.map(d => `${d.code}: ${d.pointer}: ${d.message}; origins=${JSON.stringify(d.origins ?? [])}`).join('; '));
      merged.defaults.workerSelection = result.policy;
      merged.workerPolicyOrigins = result.origins;
    }
    if (parallelism?.worker_dispatch) {
      // Exact wrapper pins remain explainable alongside worker restrictions.
      for (const layer of [
        { config: userConfig, source: this.locations.userConfig, authority: 'user' as const },
        { config: projectConfig, source: this.locations.projectConfig, authority: 'project' as const },
      ]) {
        for (const [agent, override] of Object.entries(layer.config?.agentOverrides ?? {})) {
          if (override['model-override'] === undefined) continue;
          const pointer = `/agentOverrides/${agent.replace(/~/g, '~0').replace(/\//g, '~1')}/model-override`;
          merged.workerPolicyOrigins![pointer] ??= [];
          merged.workerPolicyOrigins![pointer].push({
            source: layer.source, authority: layer.authority, digest: workerConfigDigest(layer.config),
            pointer, contribution: override['model-override'],
          });
        }
      }
      const errors = validateWorkerGroupReferences(parallelism, merged.defaults.workerSelection!);
      if (errors.length) throw new Error(errors.join('; '));
    }
    // Publish only a fully validated candidate. A failed merge must not become
    // a cache hit on the next read, nor replace the prior inspectable value.
    this.cache = merged;
    this.cacheDigest = digest;
    this.inputDigests = {
      builtinModelsDigest: workerConfigDigest(aiwgDefault),
      userModelsDigest: workerConfigDigest(userConfig),
      projectModelsDigest: workerConfigDigest(projectConfig),
    };
    return merged;
  }

  /**
   * Load AIWG default configuration
   */
  private async loadAiwgDefault(): Promise<ModelConfig> {
    try {
      const content = await readFile(this.locations.aiwgDefault, 'utf-8');
      const config = JSON.parse(content) as ModelConfig;

      // Validate it's v2 schema
      if (!config.version || !config.tiers || !config.providers) {
        throw new Error('Invalid AIWG default config: missing required v2 fields');
      }

      if (config.defaults?.workerSelection !== undefined) WorkerSelectionPolicySchema.parse(config.defaults.workerSelection);
      return config;
    } catch (error) {
      throw new Error(`Failed to load AIWG default config: ${error}`);
    }
  }

  /**
   * Load user configuration (optional)
   */
  private async loadUserConfig(): Promise<UserProjectConfig | null> {
    try {
      const content = await readFile(this.locations.userConfig, 'utf-8');
      const parsed: unknown = JSON.parse(content);
      const validation = validateUserProjectModelConfig(parsed);
      if (!validation.valid) {
        throw new Error(validation.diagnostics.map(item => `${item.code}: ${item.message}`).join('; '));
      }
      return parsed as UserProjectConfig;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(`Invalid user model config ${this.locations.userConfig}: ${error}`);
    }
  }

  /**
   * Load project configuration (optional)
   */
  private async loadProjectConfig(): Promise<UserProjectConfig | null> {
    try {
      const content = await readFile(this.locations.projectConfig, 'utf-8');
      const parsed: unknown = JSON.parse(content);
      const validation = validateUserProjectModelConfig(parsed);
      if (!validation.valid) {
        throw new Error(validation.diagnostics.map(item => `${item.code}: ${item.message}`).join('; '));
      }
      return parsed as UserProjectConfig;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(`Invalid project model config ${this.locations.projectConfig}: ${error}`);
    }
  }

  /**
   * Merge configurations with proper precedence
   */
  private merge(
    aiwgDefault: ModelConfig,
    userConfig: UserProjectConfig | null,
    projectConfig: UserProjectConfig | null
  ): MergedModelConfig {
    // Start with AIWG defaults
    const merged: MergedModelConfig = {
      defaults: { ...aiwgDefault.defaults },
      tiers: { ...aiwgDefault.tiers },
      providers: this.deepCloneProviders(aiwgDefault.providers),
      agentRoleAssignments: { ...(aiwgDefault.agentRoleAssignments || {}) },
      shorthand: { ...(aiwgDefault.shorthand || {}) },
      agentOverrides: {},
    };

    // Apply user config
    if (userConfig) {
      if (userConfig.defaults) {
        merged.defaults = { ...merged.defaults, ...userConfig.defaults };
      }
      if (userConfig.customTiers) {
        merged.tiers = { ...merged.tiers, ...userConfig.customTiers };
      }
      if (userConfig.agentOverrides) {
        merged.agentOverrides = { ...userConfig.agentOverrides };
      }
    }

    // Apply project config (highest precedence)
    if (projectConfig) {
      if (projectConfig.defaults) {
        merged.defaults = { ...merged.defaults, ...projectConfig.defaults };
      }
      if (projectConfig.customTiers) {
        merged.tiers = { ...merged.tiers, ...projectConfig.customTiers };
      }
      if (projectConfig.agentOverrides) {
        merged.agentOverrides = { ...merged.agentOverrides, ...projectConfig.agentOverrides };
      }
    }

    return merged;
  }

  /**
   * Deep clone providers to avoid mutation
   */
  private deepCloneProviders(providers: {
    [provider: string]: ProviderDefinition;
  }): { [provider: string]: ProviderDefinition } {
    const cloned: { [provider: string]: ProviderDefinition } = {};

    for (const [name, provider] of Object.entries(providers)) {
      cloned[name] = {
        ...provider,
        models: provider.models
          ? {
              reasoning: provider.models.reasoning ? { ...provider.models.reasoning } : undefined,
              coding: provider.models.coding ? { ...provider.models.coding } : undefined,
              efficiency: provider.models.efficiency ? { ...provider.models.efficiency } : undefined,
            }
          : undefined,
        tierOverrides: provider.tierOverrides ? { ...provider.tierOverrides } : undefined,
      };
    }

    return cloned;
  }

  /**
   * Load v1 config for backwards compatibility
   */
  async loadV1Config(path: string): Promise<ModelConfigV1 | null> {
    if (!existsSync(path)) {
      return null;
    }

    try {
      const content = await readFile(path, 'utf-8');
      const config = JSON.parse(content) as ModelConfigV1;

      // Simple heuristic: v1 has provider keys with role objects
      // v2 has version, tiers, providers structure
      if ('version' in config && 'tiers' in config) {
        return null; // This is v2
      }

      return config;
    } catch {
      return null;
    }
  }

  /**
   * Convert v1 config to v2 compatible structure
   */
  convertV1ToV2(_v1Config: ModelConfigV1): UserProjectConfig {
    const agentOverrides: { [agentName: string]: AgentOverride } = {};

    // V1 doesn't have agent overrides, so we just create empty structure
    // The actual v1 role mappings will be used as defaults in the resolver
    // _v1Config preserved for future v1 field migration

    return {
      agentOverrides,
    };
  }

  /**
   * Resolve provider inheritance
   */
  resolveProviderInheritance(
    provider: ProviderDefinition,
    providers: { [provider: string]: ProviderDefinition }
  ): ProviderDefinition {
    if (!provider.inherits) {
      return provider;
    }

    const parent = providers[provider.inherits];
    if (!parent) {
      throw new Error(`Provider ${provider.inherits} not found for inheritance`);
    }

    // Recursively resolve parent
    const resolvedParent = this.resolveProviderInheritance(parent, providers);

    // Merge parent into child (child overrides parent)
    return {
      ...resolvedParent,
      ...provider,
      models: provider.models || resolvedParent.models,
      tierOverrides: provider.tierOverrides || resolvedParent.tierOverrides,
    };
  }

  /**
   * Clear cache (useful for testing)
   */
  clearCache(): void {
    this.cache = null;
    this.cacheDigest = null;
    this.inputDigests = null;
  }

  /** Digests of the last successful read; no marker or snapshot writes. */
  getInputDigests(): typeof this.inputDigests {
    return this.inputDigests ? { ...this.inputDigests } : null;
  }

  /**
   * Get configuration file locations
   */
  getLocations(): ConfigLocations {
    return { ...this.locations };
  }
}
