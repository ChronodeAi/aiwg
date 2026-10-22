import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { globSync } from 'glob';
import { describe, expect, it } from 'vitest';
import base from '../../../config/vitest.config.js';
import { assertPartition, inspectNativeShards } from '../../../tools/testing/check-native-shards.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const executable = path.join(root, 'tools/testing/check-native-shards.mjs');

describe('native Vitest shard inventory', () => {
  it.each([2, 4])('covers the complete inventory exactly once in %i deterministic shards', count => {
    const discover = () => {
      const result = spawnSync(process.execPath, [executable, String(count)], {
        cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    };
    const first = discover();
    expect(discover()).toEqual(first);
    const expected = globSync(base.test.include, { cwd: root, ignore: base.test.exclude }).sort();
    expect(first.inventory).toEqual(expected);
    expect(first.shards).toHaveLength(count);
    expect(first.shards.every(shard => shard.length > 0)).toBe(true);
    expect(first.shards.flat().sort()).toEqual(expected);
    expect(new Set(first.shards.flat()).size).toBe(expected.length);
    expect(first.shards.flat().filter(file => file === 'test/unit/cli/doctor-worker-qualification.test.ts')).toHaveLength(1);
    expect(base.test.testTimeout).toBe(30000);
    expect(base.test.hookTimeout).toBe(30000);
  });

  it('discovers test files without executing their bodies or setup', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'aiwg-native-inventory-'));
    try {
      mkdirSync(path.join(directory, 'test'));
      writeFileSync(path.join(directory, 'test/synthetic.test.js'), "throw new Error('test body executed');\n");
      writeFileSync(path.join(directory, 'setup.mjs'), "throw new Error('setup executed');\n");
      writeFileSync(path.join(directory, 'vitest.config.mjs'),
        "export default { test: { include: ['test/*.test.js'], globalSetup: ['./setup.mjs'] } };\n");
      expect(await inspectNativeShards(2, { root: directory, config: 'vitest.config.mjs' }))
        .toMatchObject({ inventory: ['test/synthetic.test.js'] });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    [['a'], ['a', 'b']],
    [['a'], []],
    [['a'], ['other']],
  ])('rejects overlapping, missing or foreign membership: %j', (...shards) => {
    expect(() => assertPartition(['a', 'b'], shards)).toThrow();
  });

  it('rejects an empty or duplicate native inventory and invalid shard counts', async () => {
    expect(() => assertPartition([], [[], []])).toThrow();
    expect(() => assertPartition(['a', 'a'], [['a'], ['a']])).toThrow();
    await expect(inspectNativeShards(1)).rejects.toThrow('Shard count');
    await expect(inspectNativeShards(2.5)).rejects.toThrow('Shard count');
  });
});
