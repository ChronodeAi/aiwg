// Registry-derived native-discovery capability for `sessions sources` (never probes disk).
import type { SessionProviderId } from './contracts.js';

export interface ProviderDiscoveryCapability {
  disposition: 'discoverable' | 'manual-export' | 'unsupported';
  authorization: 'explicit-root' | 'explicit-file' | 'none';
  requiredFlags: string[];
  liveDetection: 'supported' | 'unsupported';
}

const REQUIRED_FLAGS: Partial<Record<SessionProviderId, string[]>> = {
  claude: [],
  codex: ['--codex-root'],
  cursor: [],
  factory: [],
  pi: [],
  omp: ['--omp-root'],
  'deepseek-harness': ['--dsh-root'],
  muse: ['--muse-root'],
  grokbot: ['--grokbot-root'],
  'grok-build': ['--grok-root'],
  hermes: ['--hermes-root'],
};

const LIVE_DETECTION: Partial<Record<SessionProviderId, 'supported'>> = {
  'grok-build': 'supported',
};

/**
 * `discoverable` requires a wired `discover` operation on the loaded adapter,
 * not merely an implemented ingest path; otherwise the provider stays
 * `manual-export` (or `unsupported` when it has no ingest path at all).
 */
export function providerDiscoveryCapability(
  provider: SessionProviderId,
  supportedOperations: readonly string[],
): ProviderDiscoveryCapability {
  if (supportedOperations.includes('discover')) {
    return {
      disposition: 'discoverable',
      authorization: 'explicit-root',
      requiredFlags: REQUIRED_FLAGS[provider] ?? [],
      liveDetection: LIVE_DETECTION[provider] ?? 'unsupported',
    };
  }
  return {
    disposition: 'manual-export',
    authorization: 'none',
    requiredFlags: [],
    liveDetection: 'unsupported',
  };
}
