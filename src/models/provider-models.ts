import { readAiwgConfig } from '../config/aiwg-config.js';
import { normalizeProviderDefinitionId } from '../providers/provider-definitions.js';
import { collectProviderInventory } from '../providers/provider-inventory.js';
import { resolveDynamicModelCatalog } from './model-discovery.js';

import { MODEL_WRAPPER_DEFINITIONS, type ModelRole } from './wrapper-definitions.js';
export { MODEL_WRAPPERS, MODEL_WRAPPER_DEFINITIONS, type ModelRole } from './wrapper-definitions.js';

interface CatalogRole {
  id: string;
  status?: string;
  observed?: boolean;
}

interface ModelCatalog {
  version: string;
  refreshedAt?: string;
  providers: Record<string, {
    roles: Partial<Record<ModelRole, CatalogRole>>;
  }>;
}

export interface ProviderModelHint {
  provider: string;
  role: ModelRole;
  model: string;
  wrapper: string;
  status: string;
  observed: boolean;
  source: 'native' | 'remote' | 'cache' | 'static';
}

export interface ProviderModelMetadata {
  catalogVersion: string;
  refreshedAt: string | null;
  providers: Record<string, ProviderModelHint[]>;
}

async function configuredProviders(cwd: string): Promise<string[]> {
  try {
    const config = await readAiwgConfig(cwd);
    const candidates = [
      ...(config?.providers ?? []),
      ...Object.values(config?.installed ?? {}).flatMap(entry => Object.keys(entry.deployedTo ?? {})),
    ];
    return [...new Set(candidates
      .map(provider => normalizeProviderDefinitionId(provider))
      .filter((provider): provider is NonNullable<typeof provider> => provider !== null))];
  } catch {
    return [];
  }
}

export async function loadProviderModelMetadata(
  cwd: string,
  aiwgRoot: string | null,
): Promise<ProviderModelMetadata | null> {
  if (!aiwgRoot) return null;
  let catalog: ModelCatalog & {
    discovery?: {
      source: 'native' | 'remote' | 'cache' | 'static';
      providers?: Record<string, { source?: 'native' | 'remote' | 'cache' | 'static' }>;
    };
  };
  let inventory;
  try {
    inventory = await collectProviderInventory(cwd, { detectProcess: false });
    catalog = await resolveDynamicModelCatalog({
      aiwgRoot,
      inventory,
      allowNetwork: false,
    }) as typeof catalog;
  } catch {
    return null;
  }

  const configured = await configuredProviders(cwd);
  const installed = inventory.providers
    .filter(provider => provider.available || provider.deployed)
    .map(provider => provider.id)
    .filter(provider => configured.includes(provider));
  const providers: Record<string, ProviderModelHint[]> = {};

  for (const provider of installed) {
    const roles = catalog.providers[provider]?.roles;
    if (!roles) continue;
    providers[provider] = MODEL_WRAPPER_DEFINITIONS
      .flatMap(({ role, name }) => {
        const model = roles[role];
        return model ? [{
          provider,
          role,
          model: model.id,
          wrapper: name,
          status: model.status ?? 'unknown',
          observed: model.observed ?? false,
          source: catalog.discovery?.providers?.[provider]?.source
            ?? catalog.discovery?.source
            ?? 'static',
        }] : [];
      });
  }

  return {
    catalogVersion: catalog.version,
    refreshedAt: catalog.refreshedAt ?? null,
    providers,
  };
}
