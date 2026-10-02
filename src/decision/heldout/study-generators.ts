import { readFileSync } from 'node:fs';
import { sha256 } from '../compile-cache/identity.js';
import { generateRegisteredHeldoutRow, registeredHeldoutGeneratorDigest, registeredHeldoutGeneratorFiles,
  reproducibleRegisteredHeldoutRow } from './generator-registry.js';
import { d17MfGenerateCase } from '../ensemble-study/multifact.js';
import type { HeldoutRow } from './types.js';

/**
 * Outer held-out generator registry for study generators added after D29 v8 (#2850).
 *
 * `generators.ts` and `generator-registry.ts` are themselves hashed into the D29 v1-v8 generator pins, so editing either
 * would move committed corpus pins. New study generators register here instead: this module answers for its own ids and
 * delegates every other id to the existing registries unchanged. Each id hashes only its own sources. Source-controlled
 * only: corpus data cannot register code or supply a module path.
 */
export const D17_MULTIFACT_GENERATOR_ID = 'd17-multifact/v1';
// The generator and the hash it imports for draws and record digests.
const D17_MULTIFACT_SOURCES = ['src/decision/ensemble-study/multifact.ts', 'src/decision/compile-cache/identity.ts'] as const;

export function generateStudyHeldoutRow(generatorId: string, seed: string): HeldoutRow {
  if (generatorId !== D17_MULTIFACT_GENERATOR_ID) return generateRegisteredHeldoutRow(generatorId, seed);
  const output = d17MfGenerateCase(seed).row;
  return { ...output, provenance: { generatorId, seed, outputDigest: sha256(output) } };
}

export function reproducibleStudyHeldoutRow(row: HeldoutRow): boolean {
  if (row?.provenance?.generatorId !== D17_MULTIFACT_GENERATOR_ID) return reproducibleRegisteredHeldoutRow(row);
  const { provenance, ...output } = row;
  try {
    const regenerated = d17MfGenerateCase(provenance.seed).row;
    return sha256(regenerated) === provenance.outputDigest && sha256(output) === provenance.outputDigest;
  } catch { return false; }
}

export function studyHeldoutGeneratorFiles(generatorId: string): string[] {
  return generatorId === D17_MULTIFACT_GENERATOR_ID ? [...D17_MULTIFACT_SOURCES] : registeredHeldoutGeneratorFiles(generatorId);
}

export function studyHeldoutGeneratorDigest(generatorId: string): `sha256:${string}` {
  if (generatorId !== D17_MULTIFACT_GENERATOR_ID) return registeredHeldoutGeneratorDigest(generatorId);
  const sources: Record<string, string> = {};
  for (const file of D17_MULTIFACT_SOURCES) sources[file] = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
  return sha256(sources);
}

/**
 * D17-MF collector-boundary policy, keyed on the generator id the way D29's paid-generator rule is (#2850). It is enforced
 * by `validateHeldoutBundle` and the collector, so a hand-built bundle cannot skip the CLI's checks.
 *
 * - Public seeds: committed or review seeds regenerate gold from source. A private seed must also carry at least 24
 *   lowercase hex characters of fresh randomness, so memorable or committed near-variants are refused too.
 * - Calibration window: the probe is scored only through the registered D17 member calibrator, which expires at its
 *   `effectiveAt` (2026-10-02T10:02:34.263Z) plus the D17 profile's 30 days. No session may dispatch past it.
 */
export const D17_MULTIFACT_CALIBRATION_NOT_AFTER = '2026-11-01T10:02:34.263Z';
export const D17_MULTIFACT_PUBLIC_SEEDS: readonly string[] = Object.freeze(['d17mf-offline', 'd17mf-public-demo', 'd17mf-smoke',
  'd17mf-7f3a9c2e1b', 'review-throwaway-a1', 'review-throwaway-b2']);
export function d17MultifactPublicSeed(seed: unknown): boolean {
  return typeof seed !== 'string' || D17_MULTIFACT_PUBLIC_SEEDS.includes(seed)
    || /^(review-|d17mf-(offline|public|smoke|sweep|demo))/.test(seed) || !/[0-9a-f]{24}/.test(seed);
}
export function usesD17MultifactGenerator(rows: unknown): boolean {
  return Array.isArray(rows) && rows.some(row => (row as HeldoutRow)?.provenance?.generatorId === D17_MULTIFACT_GENERATOR_ID);
}
