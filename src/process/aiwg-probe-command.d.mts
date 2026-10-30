export interface AiwgProbeCommand {
  file: string;
  prefix: string[];
  via: 'aiwg-bin' | 'entrypoint' | 'package' | 'path';
}

export function resolveAiwgProbeCommand(options?: {
  env?: NodeJS.ProcessEnv;
  argv1?: string | undefined;
  execPath?: string;
  cwd?: string;
  packageRoot?: string | null;
}): AiwgProbeCommand;

export function probeNotOnPathDetail(): string;
