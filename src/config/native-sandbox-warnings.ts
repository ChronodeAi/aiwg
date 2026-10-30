import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getConfigPath, readAiwgConfig, type AiwgConfig } from './aiwg-config.js';
import { projectAiwgPath } from './project-artifacts.js';

/** Advisory only: native-sandbox bypasses the systemd launcher boundary. */
export function nativeSandboxWarnings(config: AiwgConfig | null | undefined, projectDir: string) {
  const groups = Object.entries(config?.parallelism?.groups ?? {})
    .filter(([, group]) => group.execution?.launchMode === 'native-sandbox')
    .map(([id]) => id);
  if (groups.length === 0) return [];

  // Match readAiwgConfig's repository-control-plane-first compatibility lookup.
  const localPath = getConfigPath(projectDir);
  const configPath = resolve(existsSync(localPath) ? localPath : projectAiwgPath(projectDir, 'aiwg.config'));
  return groups.map(group => ({
    code: 'NATIVE_SANDBOX_ISOLATION',
    group,
    configPath,
    message: `Group "${group}" selects launchMode: native-sandbox in ${configPath}; systemd-unit isolation and its memory limit do not apply; only the worker CLI's own sandbox applies.`,
  }));
}

export async function readNativeSandboxWarnings(projectDir: string) {
  return nativeSandboxWarnings(await readAiwgConfig(projectDir), projectDir);
}
