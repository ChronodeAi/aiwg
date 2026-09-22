/**
 * #244 — Registered-machine health probe (read-only, fail-closed).
 *
 * Reports that there is no AIWG machine bridge / missing product status API.
 * Never registers machines, never flips local-execution policy, never writes
 * credentials. Failures must not fail baseline `aiwg use` / doctor when wired
 * as a skippable optional check (default OFF).
 *
 * Addresses #244
 */

import { getGrokbotNativeEvidence } from './evidence.js';
import { isGrokbotNativeSurfaceEnabled } from './flags.js';
import type { GrokbotNativeResultBase, GrokbotNativeRunOptions } from './types.js';

export interface RegisteredMachineHealthProbeResult extends GrokbotNativeResultBase {
  surface: 'registered-machine-health';
  /** Always empty in scaffolding — no product status payload exists. */
  probe: {
    readonly machineBridgePresent: false;
    readonly localExecutionMutated: false;
    readonly credentialsWritten: false;
    readonly machinesRegistered: false;
  };
}

/**
 * Skippable read-only probe. Default-off → `disabled`. Enabled without a
 * product status contract → `blocked`. Never mutates anything.
 */
export function registeredMachineHealthProbe(
  options: GrokbotNativeRunOptions = {},
): RegisteredMachineHealthProbeResult {
  const env = options.env ?? process.env;
  const evidence = getGrokbotNativeEvidence('registered-machine-health');
  const enabled = isGrokbotNativeSurfaceEnabled('registered-machine-health', env);

  const probe = {
    machineBridgePresent: false as const,
    localExecutionMutated: false as const,
    credentialsWritten: false as const,
    machinesRegistered: false as const,
  };

  if (!enabled) {
    return {
      surface: 'registered-machine-health',
      status: 'disabled',
      enabled: false,
      wrote: false,
      message:
        'Registered-machine health probe is disabled (default). Set AIWG_GROKBOT_NATIVE_MACHINE_PROBE=1 to opt in; probe remains read-only and evidence-gated.',
      evidence,
      remediation:
        'Leave unset for baseline deploy. Optional probe never fails aiwg use when skipped.',
      probe,
    };
  }

  // Enabled but no product status API — fail closed (blocked), still no writes.
  return {
    surface: 'registered-machine-health',
    status: 'blocked',
    enabled: true,
    wrote: false,
    message:
      'No AIWG machine bridge and no published Grok Bot product status/API for registered-machine health. Probe reports Grok-owned cloud/local computer policy only; nothing was mutated.',
    evidence,
    remediation: `See ${evidence.catalogPath} Decision gate; cite product status evidence before implementing a live probe.`,
    probe,
  };
}
