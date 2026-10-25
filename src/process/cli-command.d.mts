export function resolveExecutable(
  command: string,
  platform?: NodeJS.Platform,
  searchPath?: string,
  pathExt?: string,
  cwd?: string,
): string;

export function cliCommand(
  command: string,
  args: string[],
  platform?: NodeJS.Platform,
  searchPath?: string,
  pathExt?: string,
  cwd?: string,
): [string, string[]];

export const HELPER_ENV_ALLOWLIST: readonly string[];
export const DESKTOP_HELPER_ENV_ALLOWLIST: readonly string[];
export const DEPLOYMENT_HELPER_ENV_ALLOWLIST: readonly string[];
export function helperEnvironment(source?: NodeJS.ProcessEnv, names?: readonly string[]): Record<string, string>;
