import { homedir } from 'node:os';
import * as path from 'node:path';

/**
 * Match DeepSeek Harness's user-level agents-home resolution contract:
 * packages/skill/skill-filesystem resolves its user skills root from
 * `$DSH_AGENTS_HOME`, defaulting to `~/.agents`.
 */
export function resolveDshAgentsHome(userHome = homedir()): string {
  const configured = (process.env.DSH_AGENTS_HOME || '').trim();
  if (configured) return configured;
  return path.join(userHome, '.agents');
}

/** Resolve a path exactly as a DeepSeek Harness process would consume $DSH_AGENTS_HOME. */
export function resolveDshAgentsHomePath(...segments: string[]): string {
  return path.resolve(resolveDshAgentsHome(), ...segments);
}
