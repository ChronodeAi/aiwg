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

/**
 * Match DeepSeek Harness's harness-home resolution contract (sibling of the
 * agents home): `packages/skill/skill-filesystem` and
 * `packages/preset/agent-presets` resolve the harness config root from
 * `$DSH_HOME`, defaulting to `~/.dsh`. Agent presets deploy to
 * `<harnessHome>/.agent-presets/` (dsh-agent-presets USER_PRESET_DIR).
 */
export function resolveDshHarnessHome(userHome = homedir()): string {
  const configured = (process.env.DSH_HOME || '').trim();
  if (configured) return path.resolve(configured);
  return path.join(userHome, '.dsh');
}

/** Resolve a path exactly as a DeepSeek Harness process would consume $DSH_HOME. */
export function resolveDshHarnessHomePath(...segments: string[]): string {
  return path.resolve(resolveDshHarnessHome(), ...segments);
}
