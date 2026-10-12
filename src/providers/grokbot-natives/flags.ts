/**
 * Opt-in / kill-switch flags for Grok Bot optional native adapters.
 *
 * Default OFF. Unset, empty, `0`, `false`, `no`, `off` → disabled.
 * Only explicit truthy values (`1`, `true`, `yes`, `on`) enable a surface.
 *
 * Enabling a flag does **not** unlock writers — entry functions still
 * fail-close when product import/API evidence is missing.
 *
 * @see docs/integrations/grokbot-native-adapters-scaffolding.md
 * Addresses #241 #242 #243 #244 #245
 */

import type { GrokbotNativeSurfaceId } from './types.js';

/** #244 — registered-machine health probe (read-only). */
export const GROKBOT_NATIVE_MACHINE_PROBE_ENV = 'AIWG_GROKBOT_NATIVE_MACHINE_PROBE';

/** #245 — memory reference helper (proposals only; no secret scrape). */
export const GROKBOT_NATIVE_MEMORY_REF_ENV = 'AIWG_GROKBOT_NATIVE_MEMORY_REF';

/** #241 — routines/cron generator stub (refuse to write). */
export const GROKBOT_NATIVE_ROUTINES_ENV = 'AIWG_GROKBOT_NATIVE_ROUTINES';

/** #242 — CreateAgent/teammate projection stub (refuse to write profiles). */
export const GROKBOT_NATIVE_CREATE_AGENT_ENV = 'AIWG_GROKBOT_NATIVE_CREATE_AGENT';

/** #243 — connector/MCP install profile recommendation (no Plugin installs). */
export const GROKBOT_NATIVE_CONNECTORS_ENV = 'AIWG_GROKBOT_NATIVE_CONNECTORS';

export const GROKBOT_NATIVE_FLAG_BY_SURFACE: Record<GrokbotNativeSurfaceId, string> = {
  'registered-machine-health': GROKBOT_NATIVE_MACHINE_PROBE_ENV,
  'memory-reference-helper': GROKBOT_NATIVE_MEMORY_REF_ENV,
  routines: GROKBOT_NATIVE_ROUTINES_ENV,
  'create-agent': GROKBOT_NATIVE_CREATE_AGENT_ENV,
  'connector-install-profile': GROKBOT_NATIVE_CONNECTORS_ENV,
};

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['', '0', 'false', 'no', 'off']);

/** Parse an env kill-switch. Default (unset/empty) is OFF. */
export function isGrokbotNativeFlagEnabled(
  flagName: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = (env[flagName] ?? '').trim().toLowerCase();
  if (FALSY.has(raw)) return false;
  return TRUTHY.has(raw);
}

/** Whether the kill-switch for a named surface is on. */
export function isGrokbotNativeSurfaceEnabled(
  surface: GrokbotNativeSurfaceId,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isGrokbotNativeFlagEnabled(GROKBOT_NATIVE_FLAG_BY_SURFACE[surface], env);
}

/** Documented flag names for docs / doctor / status. */
export function listGrokbotNativeFlagNames(): readonly string[] {
  return Object.values(GROKBOT_NATIVE_FLAG_BY_SURFACE);
}
