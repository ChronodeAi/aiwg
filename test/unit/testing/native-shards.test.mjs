import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { globSync } from 'glob';
import { afterEach, describe, expect, it } from 'vitest';
import base from '../../../config/vitest.config.js';
import { assertPartition, inspectNativeShards } from '../../../tools/testing/check-native-shards.mjs';
import DurationSequencer, { balanceFiles, fileSeconds, readDurations, validateDurations } from '../../../tools/testing/duration-sequencer.mjs';
import FileDurationReporter, { refreshDurations } from '../../../tools/testing/refresh-test-durations.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const executable = path.join(root, 'tools/testing/check-native-shards.mjs');
const temporaryDirectories = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

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
    expect(base.test.sequence.sequencer).toBe(DurationSequencer);
    const expectedShards = balanceFiles(expected, count, readDurations()).shards.map(shard => shard.sort());
    expect(first.shards).toEqual(expectedShards);
    expect(first.prediction.configuredSeconds).toHaveLength(count);
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

describe('duration-balanced native sequencing', () => {
  const durations = { defaultSeconds: 2, files: { a: 10, b: 9, c: 8, d: 7 } };

  it('assigns longest files first to the lightest shard with stable ties', () => {
    expect(balanceFiles(['d', 'c', 'b', 'a'], 2, durations)).toEqual({
      shards: [['a', 'd'], ['b', 'c']], seconds: [17, 17],
    });
  });

  it('includes unmeasured files with the default weight and uses lexical ties', () => {
    const result = balanceFiles(['new-b', 'a', 'new-a'], 2, durations);
    expect(result).toEqual({ shards: [['a'], ['new-a', 'new-b']], seconds: [10, 4] });
    expect(balanceFiles(['new-a', 'new-b', 'a'], 2, durations)).toEqual(result);
    assertPartition(['new-a', 'new-b', 'a'], result.shards);
  });

  it('starts longer measured files first within a shard, including unknown files exactly once', async () => {
    const durations = readDurations();
    const files = [...Object.keys(durations.files), 'test/new-sort-unknown.test.ts'];
    const specs = files.map(file => ({ moduleId: path.join(root, file) }));
    const sequencer = new DurationSequencer({ config: { root } });
    const sorted = await sequencer.sort(specs);
    expect(sorted).not.toBe(specs);
    expect(specs.map(spec => path.relative(root, spec.moduleId))).toEqual(files);
    expect(new Set(sorted).size).toBe(specs.length);
    const weights = sorted.map(spec => fileSeconds(path.relative(root, spec.moduleId), durations));
    expect(weights).toEqual([...weights].sort((a, b) => b - a));
    expect(await sequencer.sort([...specs].reverse())).toEqual(sorted);
  });

  it('supports more shards than files and rejects invalid counts or duplicates', () => {
    expect(balanceFiles(['a'], 4, durations).shards).toEqual([['a'], [], [], []]);
    expect(() => balanceFiles(['a'], 0, durations)).toThrow('Shard count');
    expect(() => balanceFiles(['a'], 2.5, durations)).toThrow('Shard count');
    expect(() => balanceFiles(['a', 'a'], 2, durations)).toThrow('unique');
  });

  it('uses the identical assignment when Vitest calls its configured sequencer', async () => {
    const inventory = ['test/new-b.test.ts', 'test/new-a.test.ts', 'test/other.test.ts'];
    const specs = inventory.map(file => ({ moduleId: path.join(root, file) }));
    const expected = balanceFiles(inventory, 2, readDurations()).shards;
    for (let index = 1; index <= 2; index++) {
      const sequencer = new DurationSequencer({ config: { root, shard: { index, count: 2 } } });
      expect((await sequencer.shard(specs)).map(spec => path.relative(root, spec.moduleId)))
        .toEqual(expected[index - 1]);
      await expect(sequencer.shard([specs[0], specs[0]]))
        .rejects.toThrow('unique file specifications');
    }
  });

  it.each([
    { defaultSeconds: 0, files: {} },
    { defaultSeconds: 1, files: [] },
    { defaultSeconds: 1, files: { a: -1 } },
    { defaultSeconds: 1, files: { a: Infinity } },
    { defaultSeconds: 1, files: { '../outside.test.ts': 1 } },
    { defaultSeconds: 1, files: { '/absolute.test.ts': 1 } },
  ])('rejects malformed checked-in durations: %j', value => {
    expect(() => validateDurations(value)).toThrow();
  });

  it('refreshes file elapsed intervals and merges reports without losing other shards', () => {
    const report = (file, startTime, endTime) => ({ testResults: [{
      name: path.join(root, file), startTime, endTime,
      assertionResults: [{ duration: 1, status: 'passed' }],
    }] });
    expect(refreshDurations([
      report('test/z.test.ts', 1000, 11000), report('test/a.test.ts', 1000, 1000),
    ], { root, previous: { defaultSeconds: 3, files: { 'test/retained.test.ts': 4, 'test/z.test.ts': 99 } } }))
      .toEqual({ defaultSeconds: 3, files: {
        'test/a.test.ts': 0.001, 'test/retained.test.ts': 4, 'test/z.test.ts': 10,
      } });
  });

  it('records imports, setup and tests with all hooks and prefers them over stock JSON', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'aiwg-file-durations-'));
    temporaryDirectories.push(directory);
    const reporter = new FileDurationReporter();
    reporter.onInit({ config: { root: directory } });
    reporter.onTestRunEnd([{
      moduleId: path.join(directory, 'test/a.test.ts'),
      diagnostic: () => ({ duration: 12000, collectDuration: 2000, setupDuration: 500,
        prepareDuration: 9000, environmentSetupDuration: 9000 }),
    }, {
      moduleId: path.join(directory, 'test/b.test.ts'),
      diagnostic: () => ({ duration: 1000 }),
    }]);
    const report = JSON.parse(readFileSync(path.join(directory, 'test-results/file-durations.json'), 'utf8'));
    expect(report.testResults[0].name).toBe('test/a.test.ts');
    expect(report.testResults[0].durationSeconds).toBe(14.5);
    expect(report.testResults[1].durationSeconds).toBe(1);
    report.testResults[0].startTime = 1000;
    report.testResults[0].endTime = 1001;
    expect(refreshDurations([report], { root: directory }).files)
      .toEqual({ 'test/a.test.ts': 14.5, 'test/b.test.ts': 1 });
  });

  it.each([
    {},
    { testResults: [] },
    { testResults: [{ name: 'test/a.test.ts', startTime: 10, endTime: 1 }] },
    { testResults: [{ name: '../outside.test.ts', startTime: 1, endTime: 2 }] },
    { testResults: [{ name: 'test/a.test.ts', startTime: 1 }] },
    { testResults: [{ name: 'test/a.test.ts', durationSeconds: -1 }] },
  ])('rejects reports without trustworthy elapsed file times: %j', report => {
    expect(() => refreshDurations([report], { root })).toThrow();
  });
});
