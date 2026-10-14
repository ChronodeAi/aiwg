export function resolveExecutable(
  command: string,
  platform?: NodeJS.Platform,
  searchPath?: string,
  pathExt?: string,
): string;

export function cliCommand(
  command: string,
  args: string[],
  platform?: NodeJS.Platform,
  searchPath?: string,
  pathExt?: string,
): [string, string[]];
