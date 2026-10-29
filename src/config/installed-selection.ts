// Keep automatic redeployment from changing the explicitly installed selection.
import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';
import type { AiwgConfig } from './aiwg-config.js';

interface Selection {
  project: string;
  installed: AiwgConfig['installed'] | undefined;
}
const selection = new AsyncLocalStorage<Selection>();

export function withInstalledSelection<T>(
  project: string,
  installed: AiwgConfig['installed'] | undefined,
  deploy: () => Promise<T>,
): Promise<T> {
  return selection.run({ project: resolve(project), installed: structuredClone(installed) }, deploy);
}

export function preserveInstalledSelection(project: string, config: AiwgConfig): AiwgConfig {
  const current = selection.getStore();
  if (!current || current.project !== resolve(project)) return config;
  const guarded = { ...config };
  if (current.installed === undefined) delete (guarded as Partial<AiwgConfig>).installed;
  else guarded.installed = Object.fromEntries(Object.entries(current.installed).map(([id, entry]) => [
    id, structuredClone(config.installed[id] ?? entry),
  ]));
  return guarded;
}
