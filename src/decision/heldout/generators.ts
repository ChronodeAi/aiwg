import { sha256 } from '../compile-cache/identity.js';
import type { HeldoutRow } from './types.js';

type GeneratedRow = Omit<HeldoutRow, 'provenance'>;
/** Source-controlled registry only: corpus data cannot register code or supply a module path. */
function generate(generatorId: string, seed: string): GeneratedRow {
  if (generatorId !== 'heldout-lamp/v1') throw new Error('unregistered-generator');
  const match = /^([A-Za-z0-9_-]{1,64}):([0-9]{1,5}):(example|single|local)$/.exec(seed);
  if (!match) throw new Error('generator-seed');
  const [, world, index, layout] = match, i = Number(index);
  return { id: `${layout === 'example' ? 'example' : 'row'}_${i}`, familyId: `family_${i}`, split: 'test', slice: 'direct',
    input: { payload: `In fictional world ${world}, lamp 💡 ${i} is ${i % 2 === 0 ? 'on' : 'off'}.` },
    requests: layout === 'local' ? [] : [{ id: 'champion', arm: 'baseline', definitionId: 'heldout-example' },
      ...(layout === 'example' ? [1, 2, 3].map(n => ({ id: `member_${n}`, arm: 'candidate', definitionId: 'heldout-example' })) : [])],
    localOutcome: layout === 'local' ? { route: 'FAIL', reason: 'required-test-failed' } : null };
}
export function generateHeldoutRow(generatorId: string, seed: string): HeldoutRow {
  const output = generate(generatorId, seed);
  return { ...output, provenance: { generatorId, seed, outputDigest: sha256(output) } };
}
export function reproducibleHeldoutRow(row: HeldoutRow): boolean {
  const { provenance, ...output } = row;
  try {
    const regenerated = generate(provenance.generatorId, provenance.seed);
    return sha256(regenerated) === provenance.outputDigest && sha256(output) === provenance.outputDigest;
  } catch { return false; }
}
