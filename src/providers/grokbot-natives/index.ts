/**
 * Grok Bot optional native adapter scaffolding (#241–#245).
 *
 * Fail-closed, opt-in (default OFF), evidence-gated. Does not change baseline
 * `aiwg use --provider grokbot`. Does not invent writers. Capability matrix
 * must not claim AIWG installs these natives.
 *
 * Prefer safest surfaces structurally: #244 machine probe, #245 memory refs,
 * then #241–#243 writer stubs.
 *
 * @see docs/integrations/grokbot-native-adapters-scaffolding.md
 * @see docs/integrations/grokbot-native-surfaces-evidence.md
 * Addresses #241 #242 #243 #244 #245
 */

export * from './types.js';
export * from './flags.js';
export * from './evidence.js';
export {
  registeredMachineHealthProbe,
  type RegisteredMachineHealthProbeResult,
} from './registered-machine-health.js';
export {
  memoryReferenceHelper,
  type MemoryReferenceHelperResult,
  type MemoryReferenceInput,
  type MemoryReferenceProposal,
} from './memory-reference-helper.js';
export {
  generateRoutinesImportStub,
  type GrokbotRoutineDryRunProposal,
  type RoutinesGeneratorInput,
  type RoutinesGeneratorResult,
} from './routines.js';
export {
  projectCreateAgentStub,
  type CreateAgentProjectionInput,
  type CreateAgentProjectionResult,
  type GrokbotCreateAgentDryRunProjection,
} from './create-agent.js';
export {
  buildConnectorInstallProfileStub,
  type ConnectorInstallProfileInput,
  type ConnectorInstallProfileResult,
  type GrokbotConnectorInstallProfile,
  type GrokbotConnectorRecommendation,
} from './connector-install-profile.js';

import { registeredMachineHealthProbe } from './registered-machine-health.js';
import { GROKBOT_NATIVE_FLAG_BY_SURFACE, isGrokbotNativeFlagEnabled } from './flags.js';
import { getGrokbotNativeEvidence } from './evidence.js';
import type {
  GrokbotNativeResultBase,
  GrokbotNativeRunOptions,
  GrokbotNativeSurfaceId,
} from './types.js';

/** Ordered list — safest read-only surfaces first, then writer stubs. */
export const GROKBOT_NATIVE_SURFACE_ORDER: readonly GrokbotNativeSurfaceId[] = [
  'registered-machine-health',
  'memory-reference-helper',
  'routines',
  'create-agent',
  'connector-install-profile',
];

export interface GrokbotNativeOptionalStatusSummary {
  /** Always informational — never a deploy failure signal. */
  skippable: true;
  /** Results for surfaces that are currently enabled; empty when all default-off. */
  enabledResults: GrokbotNativeResultBase[];
  /** Flag map for operator visibility. */
  flags: Record<GrokbotNativeSurfaceId, { env: string; enabled: boolean }>;
}

/**
 * Skippable optional status helper for future doctor/status wiring.
 *
 * Default OFF → empty `enabledResults` (no-op). When the machine probe flag
 * is on, runs the read-only probe only. Does **not** invoke writer stubs
 * automatically — callers that want those must opt in per surface.
 *
 * Never throws; never fails baseline deploy.
 */
export function collectGrokbotNativeOptionalStatus(
  options: GrokbotNativeRunOptions = {},
): GrokbotNativeOptionalStatusSummary {
  const env = options.env ?? process.env;
  const flags = {} as GrokbotNativeOptionalStatusSummary['flags'];
  for (const surface of GROKBOT_NATIVE_SURFACE_ORDER) {
    const name = GROKBOT_NATIVE_FLAG_BY_SURFACE[surface];
    flags[surface] = {
      env: name,
      enabled: isGrokbotNativeFlagEnabled(name, env),
    };
  }

  const enabledResults: GrokbotNativeResultBase[] = [];
  if (flags['registered-machine-health'].enabled) {
    enabledResults.push(registeredMachineHealthProbe({ env }));
  }

  return { skippable: true, enabledResults, flags };
}

/** Convenience: evidence + flag metadata for docs/tests. */
export function describeGrokbotNativeSurface(surface: GrokbotNativeSurfaceId) {
  return {
    surface,
    flag: GROKBOT_NATIVE_FLAG_BY_SURFACE[surface],
    evidence: getGrokbotNativeEvidence(surface),
  };
}
