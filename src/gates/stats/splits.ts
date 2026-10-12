import { canonicalSha256 } from './digest.js';

/** Frozen dataset memberships. Threshold selection may read tuning/calibration, never test. */
export interface QualificationSplit {
  name: 'tuning' | 'calibration' | 'test';
  ids: readonly string[];
  digest: `sha256:${string}`;
}

function digestIds(ids: readonly string[]): `sha256:${string}` {
  return canonicalSha256([...ids].sort());
}

/** Hash the exact membership set; duplicate, empty and overlapping IDs fail closed. */
export function freezeQualificationSplit(name: QualificationSplit['name'], ids: readonly string[]): QualificationSplit {
  if (!ids.length || ids.some(id => !id.trim()) || new Set(ids).size !== ids.length) {
    throw new Error('qualification split requires unique nonempty IDs');
  }
  return { name, ids: [...ids].sort(), digest: digestIds(ids) };
}

export function verifyQualificationSplits(splits: readonly QualificationSplit[]): void {
  if (splits.length !== 3 || new Set(splits.map(split => split.name)).size !== 3
    || splits.some(split => !['tuning', 'calibration', 'test'].includes(split.name))) {
    throw new Error('qualification requires tuning, calibration and test splits');
  }
  const all = new Set<string>();
  for (const split of splits) {
    if (!split.ids.length || split.ids.some(id => typeof id !== 'string' || !id.trim())
      || new Set(split.ids).size !== split.ids.length || split.digest !== digestIds(split.ids)) {
      throw new Error('qualification split digest or membership mismatch');
    }
    for (const id of split.ids) {
      if (all.has(id)) throw new Error('qualification splits overlap');
      all.add(id);
    }
  }
}
