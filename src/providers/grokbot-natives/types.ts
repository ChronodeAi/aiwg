/**
 * Shared contracts for optional Grok Bot native adapter scaffolding.
 *
 * These types describe *future* adapter inputs/outputs and the product
 * evidence fields required before any writer may exist. Until Decision-gate
 * criteria in docs/integrations/grokbot-native-surfaces-evidence.md are met,
 * every entry function fail-closes with status blocked | disabled | unavailable.
 *
 * Hard gates:
 * - No invented writers (routines, profiles, connectors, machines, memory)
 * - No secret scrape (clipboard, cookies, tokens, full bodies)
 * - Capability matrix must not claim AIWG installs these natives
 *
 * @see docs/integrations/grokbot-native-surfaces-evidence.md
 * @see docs/integrations/grokbot-native-adapters-scaffolding.md
 * Addresses #241 #242 #243 #244 #245 (children of #209)
 */

/** One optional surface from the #209 child decomposition. */
export type GrokbotNativeSurfaceId =
  | 'registered-machine-health'
  | 'memory-reference-helper'
  | 'routines'
  | 'create-agent'
  | 'connector-install-profile';

/**
 * Fail-closed result statuses.
 *
 * - `disabled` — env kill-switch off (default)
 * - `blocked` — enabled but product import/API/reload evidence is missing
 * - `unavailable` — reserved for when evidence exists but the product surface
 *   cannot be reached (scaffolding never reaches a live call yet)
 * - `proposed` — dry-run / operator handoff payload only; never writes
 */
export type GrokbotNativeStatus = 'blocked' | 'disabled' | 'unavailable' | 'proposed';

/** Required product-evidence fields cited by every surface result. */
export interface GrokbotNativeProductEvidence {
  /** Repo-relative catalog path. */
  catalogPath: string;
  /** Public product doc URLs (operator-reproducible UX). */
  productDocUrls: readonly string[];
  /** Tracking child issue number. */
  childIssue: number;
  /**
   * True only when public docs (or maintainer-attested evidence) publish an
   * AIWG-consumable import/API/reload contract. Always false in this scaffolding.
   */
  importContractAvailable: boolean;
  /** Human-readable gaps that keep the surface blocked. */
  missingContractNotes: readonly string[];
}

/**
 * Common result envelope. `wrote` is literally always false in scaffolding —
 * TypeScript encodes the hard gate so tests can assert no mutation path.
 */
export interface GrokbotNativeResultBase {
  surface: GrokbotNativeSurfaceId;
  status: GrokbotNativeStatus;
  /** Whether the per-surface env kill-switch is currently on. */
  enabled: boolean;
  /** Scaffolding never writes; kept as the literal false for callers/tests. */
  wrote: false;
  message: string;
  evidence: GrokbotNativeProductEvidence;
  remediation?: string;
}

/** Options shared by every entry function. */
export interface GrokbotNativeRunOptions {
  /** Injectable env (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
}

/** Catalog path constant shared by all surfaces. */
export const GROKBOT_NATIVE_EVIDENCE_CATALOG =
  'docs/integrations/grokbot-native-surfaces-evidence.md' as const;
