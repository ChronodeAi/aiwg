/**
 * #243 — Connector / MCP install profile (declarative recommendation only).
 *
 * Emits a typed recommendation / install-profile *shape* and a blocked runner.
 * No Plugin installs, no secret storage, no OAuth token writes.
 *
 * Addresses #243
 */

import { getGrokbotNativeEvidence } from './evidence.js';
import { isGrokbotNativeSurfaceEnabled } from './flags.js';
import type { GrokbotNativeResultBase, GrokbotNativeRunOptions } from './types.js';

/** One recommended connector/Plugin step for the operator. */
export interface GrokbotConnectorRecommendation {
  /** Human label (e.g. "GitHub"). */
  name: string;
  /** Why AIWG suggests it (non-secret). */
  rationale: string;
  /** Operator steps (Settings → Plugins → Add …). */
  operatorSteps: readonly string[];
  /** Optional docs URL — never a credential. */
  docsUrl?: string;
}

/**
 * Declarative install profile shape (types + in-memory object only).
 * Must never include tokens, cookies, or scraped secrets.
 */
export interface GrokbotConnectorInstallProfile {
  /** Profile id for documentation / future import. */
  id: string;
  recommendations: readonly GrokbotConnectorRecommendation[];
  /** Explicit: scaffolding never applies this profile. */
  applyMode: 'recommend-only';
}

export interface ConnectorInstallProfileResult extends GrokbotNativeResultBase {
  surface: 'connector-install-profile';
  profile?: GrokbotConnectorInstallProfile;
}

export interface ConnectorInstallProfileInput {
  /** Optional recommendation list to echo when blocked (still not installed). */
  recommendations?: readonly GrokbotConnectorRecommendation[];
  profileId?: string;
}

/**
 * Blocked runner. Default-off → `disabled`. Opt-in without connector install
 * API → `blocked` with optional in-memory recommendation profile (never applied).
 */
export function buildConnectorInstallProfileStub(
  input: ConnectorInstallProfileInput = {},
  options: GrokbotNativeRunOptions = {},
): ConnectorInstallProfileResult {
  const env = options.env ?? process.env;
  const evidence = getGrokbotNativeEvidence('connector-install-profile');
  const enabled = isGrokbotNativeSurfaceEnabled('connector-install-profile', env);

  if (!enabled) {
    return {
      surface: 'connector-install-profile',
      status: 'disabled',
      enabled: false,
      wrote: false,
      message:
        'Connector/MCP install profile stub is disabled (default). Set AIWG_GROKBOT_NATIVE_CONNECTORS=1 to inspect recommendations; AIWG will not install Plugins or store secrets.',
      evidence,
      remediation: `Use Settings → Plugins in Grok Bot. See ${evidence.catalogPath}.`,
    };
  }

  const profile: GrokbotConnectorInstallProfile | undefined =
    input.recommendations && input.recommendations.length > 0
      ? {
          id: input.profileId?.trim() || 'aiwg-grokbot-connectors-recommend',
          recommendations: input.recommendations,
          applyMode: 'recommend-only',
        }
      : undefined;

  if (!evidence.importContractAvailable) {
    return {
      surface: 'connector-install-profile',
      status: 'blocked',
      enabled: true,
      wrote: false,
      message:
        'Connector install profile runner refused to install Plugins: no published MCP/connector import/API. Recommendation object (if any) is declarative only — no secrets stored.',
      evidence,
      remediation:
        'Operator adds connectors via Settings → Plugins → Add. Decision-gate must cite product install/reload evidence before any non-recommend apply path.',
      profile,
    };
  }

  return {
    surface: 'connector-install-profile',
    status: 'unavailable',
    enabled: true,
    wrote: false,
    message: 'Connector install contract flagged available but apply path is not implemented.',
    evidence,
    profile,
  };
}
