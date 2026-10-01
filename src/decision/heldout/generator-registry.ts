import { readFileSync } from 'node:fs';
import { sha256 } from '../compile-cache/identity.js';
import { generateHeldoutRow, heldoutGeneratorDigest, heldoutGeneratorFiles, reproducibleHeldoutRow } from './generators.js';
import { D29_V8_GENERATOR_ID } from './d29-generator-ids.js';
import { generateD29V8 } from './d29-v8.js';
import type { HeldoutRow } from './types.js';

/**
 * Held-out generator registry for generators added after the frozen
 * `generators.ts` registry (D29 v8 onward).
 *
 * `generators.ts` is part of the D29 v1–v7 family digest, so editing it would
 * move the generator pin recorded in every committed v6/v7 corpus. New
 * generator versions therefore register here: this module answers for its
 * own ids and delegates every other id to the frozen registry unchanged. Each
 * new id hashes its own source list, so the v6/v7 family pin stays
 * byte-identical while v8 pins exactly the files that produce its rows.
 * Source-controlled only: corpus data cannot register code or supply a path.
 */
const D29_V8_GENERATOR_SOURCES = ['src/decision/heldout/generator-registry.ts', 'src/decision/heldout/d29-generator-ids.ts',
  'src/decision/heldout/generators.ts', 'src/decision/compile-cache/identity.ts',
  'src/decision/heldout/d29-v8.ts', 'src/decision/heldout/d29-pools.ts', 'src/decision/heldout/d29-pools-v8.ts',
  'src/decision/heldout/d29-passage-baseline.ts', 'src/decision/heldout/d29-passage-baseline-v2.ts',
  'src/decision/heldout/d29-passage-baseline-v3.ts'] as const;

export { D29_LATEST_GENERATOR_ID, D29_PAID_GENERATOR_IDS } from './d29-generator-ids.js';

function generateV8(seed: string): Omit<HeldoutRow, 'provenance'> {
  const match = /^([a-z0-9][a-z0-9-]{0,31}):([0-9]{1,5}):(example|single|local)$/.exec(seed);
  if (!match) throw new Error('generator-seed');
  const [, worldSeed, index, layout] = match;
  return generateD29V8(worldSeed, Number(index), layout);
}

/** Generates one row for any registered generator id, including ids frozen in generators.ts. */
export function generateRegisteredHeldoutRow(generatorId: string, seed: string): HeldoutRow {
  if (generatorId !== D29_V8_GENERATOR_ID) return generateHeldoutRow(generatorId, seed);
  const output = generateV8(seed);
  return { ...output, provenance: { generatorId, seed, outputDigest: sha256(output) } };
}

/** True when the row regenerates byte-identically from its own provenance. */
export function reproducibleRegisteredHeldoutRow(row: HeldoutRow): boolean {
  if (row?.provenance?.generatorId !== D29_V8_GENERATOR_ID) return reproducibleHeldoutRow(row);
  const { provenance, ...output } = row;
  try {
    const regenerated = generateV8(provenance.seed);
    return sha256(regenerated) === provenance.outputDigest && sha256(output) === provenance.outputDigest;
  } catch { return false; }
}

/** Package-root-relative TypeScript sources hashed for one generator id; unknown ids refuse. */
export function registeredHeldoutGeneratorFiles(generatorId: string): string[] {
  if (generatorId === D29_V8_GENERATOR_ID) return [...D29_V8_GENERATOR_SOURCES];
  return heldoutGeneratorFiles(generatorId);
}

/** Generator family digest; ids frozen in generators.ts keep their historical digest. */
export function registeredHeldoutGeneratorDigest(generatorId: string): `sha256:${string}` {
  if (generatorId !== D29_V8_GENERATOR_ID) return heldoutGeneratorDigest(generatorId);
  const sources: Record<string, string> = {};
  for (const file of D29_V8_GENERATOR_SOURCES) {
    sources[file] = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
  }
  return sha256(sources);
}
