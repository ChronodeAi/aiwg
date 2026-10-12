/**
 * #241 — Routines / cron import generator stub (fail-closed; refuse to write).
 *
 * Dry-run payload shapes exist only as TypeScript types / documentation —
 * never as filesystem writers. Entry function always returns blocked|disabled
 * until product import evidence lands.
 *
 * Addresses #241
 */

import { getGrokbotNativeEvidence } from './evidence.js';
import { isGrokbotNativeSurfaceEnabled } from './flags.js';
import type { GrokbotNativeResultBase, GrokbotNativeRunOptions } from './types.js';

/**
 * Future dry-run import payload (documentation / typing only).
 * Not serialized to disk by this scaffolding.
 */
export interface GrokbotRoutineDryRunProposal {
  /** Operator-facing routine title. */
  title: string;
  /** Natural-language schedule description (product UX today). */
  scheduleDescription: string;
  /** Optional timezone hint (product uses Settings timezone). */
  timezoneHint?: string;
  /** Approval / failure policy notes for the operator to ask the Bot. */
  approvalBoundary?: string;
  failurePolicy?: string;
  /** Always dry-run in scaffolding. */
  mode: 'dry-run';
}

export interface RoutinesGeneratorResult extends GrokbotNativeResultBase {
  surface: 'routines';
  /** Never populated with a write path — reserved for future dry-run echo. */
  dryRunProposal?: GrokbotRoutineDryRunProposal;
}

export interface RoutinesGeneratorInput {
  /** Optional shape the operator *would* want once import exists. */
  proposal?: Omit<GrokbotRoutineDryRunProposal, 'mode'>;
}

/**
 * Generator stub. Refuses to write routines. Returns `disabled` by default,
 * `blocked` when opted in without product import contract. May echo a
 * dry-run proposal object in-memory only (never filesystem).
 */
export function generateRoutinesImportStub(
  input: RoutinesGeneratorInput = {},
  options: GrokbotNativeRunOptions = {},
): RoutinesGeneratorResult {
  const env = options.env ?? process.env;
  const evidence = getGrokbotNativeEvidence('routines');
  const enabled = isGrokbotNativeSurfaceEnabled('routines', env);

  if (!enabled) {
    return {
      surface: 'routines',
      status: 'disabled',
      enabled: false,
      wrote: false,
      message:
        'Routines/cron generator stub is disabled (default). Set AIWG_GROKBOT_NATIVE_ROUTINES=1 to inspect the blocked dry-run contract; AIWG will not write routines.',
      evidence,
      remediation: `Baseline aiwg use --provider grokbot is unchanged. See ${evidence.catalogPath}.`,
    };
  }

  if (!evidence.importContractAvailable) {
    const dryRunProposal: GrokbotRoutineDryRunProposal | undefined = input.proposal
      ? { ...input.proposal, mode: 'dry-run' }
      : undefined;

    return {
      surface: 'routines',
      status: 'blocked',
      enabled: true,
      wrote: false,
      message:
        'Routines import generator refused to write: no published Grok Bot routine import/API/reload contract. Optional dry-run proposal (if provided) is in-memory types only.',
      evidence,
      remediation:
        'Ask the owning Bot to create routines via product UX, or wait for Decision-gate unblock with cited import evidence.',
      dryRunProposal,
    };
  }

  // Unreachable while importContractAvailable is false.
  return {
    surface: 'routines',
    status: 'unavailable',
    enabled: true,
    wrote: false,
    message: 'Routine import contract flagged available but writer is not implemented.',
    evidence,
  };
}
