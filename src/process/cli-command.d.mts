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
