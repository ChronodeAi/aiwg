/**
 * #242 — CreateAgent / teammate template projection stub (fail-closed).
 *
 * Never writes Bot profiles. Projects a dry-run recommendation shape as
 * TypeScript types only until a product profile import/API exists.
 *
 * Addresses #242
 */

import { getGrokbotNativeEvidence } from './evidence.js';
import { isGrokbotNativeSurfaceEnabled } from './flags.js';
import type { GrokbotNativeResultBase, GrokbotNativeRunOptions } from './types.js';

/** Future dry-run profile projection (types / docs only — no writers). */
export interface GrokbotCreateAgentDryRunProjection {
  /** Suggested Bot display name. */
  name: string;
  title?: string;
  description?: string;
  /** AIWG agent id this recommendation maps from (informational). */
  sourceAgentId?: string;
  /** Always dry-run in scaffolding. */
  mode: 'dry-run';
}

export interface CreateAgentProjectionResult extends GrokbotNativeResultBase {
  surface: 'create-agent';
  dryRunProjection?: GrokbotCreateAgentDryRunProjection;
}

export interface CreateAgentProjectionInput {
  projection?: Omit<GrokbotCreateAgentDryRunProjection, 'mode'>;
}

/**
 * Fail-closed projection stub. Default-off → `disabled`. Opt-in without
 * profile import evidence → `blocked`. Never writes profiles.
 */
export function projectCreateAgentStub(
  input: CreateAgentProjectionInput = {},
  options: GrokbotNativeRunOptions = {},
): CreateAgentProjectionResult {
  const env = options.env ?? process.env;
  const evidence = getGrokbotNativeEvidence('create-agent');
  const enabled = isGrokbotNativeSurfaceEnabled('create-agent', env);

  if (!enabled) {
    return {
      surface: 'create-agent',
      status: 'disabled',
      enabled: false,
      wrote: false,
      message:
        'CreateAgent/teammate projection stub is disabled (default). Set AIWG_GROKBOT_NATIVE_CREATE_AGENT=1 to inspect the blocked contract; AIWG will not write Bot profiles.',
      evidence,
      remediation: `Use aiwg discover / aiwg show for indexed agents. See ${evidence.catalogPath}.`,
    };
  }

  if (!evidence.importContractAvailable) {
    const dryRunProjection: GrokbotCreateAgentDryRunProjection | undefined = input.projection
      ? { ...input.projection, mode: 'dry-run' }
      : undefined;

    return {
      surface: 'create-agent',
      status: 'blocked',
      enabled: true,
      wrote: false,
      message:
        'CreateAgent projection refused to write profiles: no published Grok Bot profile import/API. Optional dry-run projection is in-memory only.',
      evidence,
      remediation:
        'Create/Edit Profile via product UX (New → Create new agent). Wait for Decision-gate unblock before any writer.',
      dryRunProjection,
    };
  }

  return {
    surface: 'create-agent',
    status: 'unavailable',
    enabled: true,
    wrote: false,
    message: 'Profile import contract flagged available but writer is not implemented.',
    evidence,
  };
}
