/** Balance native Vitest shards using checked-in file durations. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BaseSequencer } from 'vitest/node';

export const durationMapPath = new URL('../../config/test-durations.json', import.meta.url);

export function validateDurations(value) {
  if (!value || !Number.isFinite(value.defaultSeconds) || value.defaultSeconds <= 0
    || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) {
    throw new Error('Duration map requires positive defaultSeconds and a files object');
  }
  for (const [file, seconds] of Object.entries(value.files)) {
    if (!file || path.posix.isAbsolute(file) || file.includes('\\') || file.split('/').includes('..')
      || !Number.isFinite(seconds) || seconds <= 0) {
      throw new Error(`Invalid duration entry: ${file}`);
    }
  }
  return value;
}

export function readDurations(location = durationMapPath) {
  return validateDurations(JSON.parse(readFileSync(location, 'utf8')));
}

export function fileSeconds(file, durations) {
  return durations.files[file] ?? durations.defaultSeconds;
}

export function balanceFiles(files, count, durations) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Shard count must be a positive integer');
  validateDurations(durations);
  if (new Set(files).size !== files.length) throw new Error('Shard files must be unique');
  const shards = Array.from({ length: count }, () => []);
  const seconds = Array(count).fill(0);
  const ordered = [...files].sort((a, b) => fileSeconds(b, durations) - fileSeconds(a, durations)
    || (a < b ? -1 : a > b ? 1 : 0));
  for (const file of ordered) {
    let index = 0;
    for (let candidate = 1; candidate < count; candidate++) {
      if (seconds[candidate] < seconds[index]) index = candidate;
    }
    shards[index].push(file);
    seconds[index] += fileSeconds(file, durations);
  }
  return { shards, seconds };
}

export default class DurationSequencer extends BaseSequencer {
  async sort(specifications) {
    const durations = readDurations();
    const name = spec => path.relative(this.ctx.config.root, spec.moduleId).split(path.sep).join('/');
    // Start the longest files first inside each shard too, so a late heavy file
    // cannot leave the other workers idle on fresh CI checkouts without a cache.
    return [...specifications].sort((a, b) => fileSeconds(name(b), durations) - fileSeconds(name(a), durations)
      || (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0));
  }

  async shard(specifications) {
    const { root, shard: { index, count } } = this.ctx.config;
    const byName = new Map(specifications.map(spec => [
      path.relative(root, spec.moduleId).split(path.sep).join('/'), spec,
    ]));
    if (byName.size !== specifications.length) {
      throw new Error('Duration sharding requires unique file specifications');
    }
    const { shards } = balanceFiles([...byName.keys()], count, readDurations());
    return shards[index - 1].map(file => byName.get(file));
  }
}
