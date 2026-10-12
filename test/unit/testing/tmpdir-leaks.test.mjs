import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_ALLOWED_ENTRIES, findLeakedEntries } from '../../../tools/testing/check-tmpdir-leaks.mjs';

const tmpRoots = [];
afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function tmpDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

describe('tmpdir leak gate (#3018)', () => {
  it('reports no leaks for an empty directory', async () => {
    const dir = await tmpDir('aiwg-leak-gate-empty-');
    expect(findLeakedEntries(dir)).toEqual([]);
  });

  it('reports no leaks (not an error) for a directory that does not exist', () => {
    expect(findLeakedEntries('/does/not/exist/aiwg-leak-gate')).toEqual([]);
  });

  it('ignores the default allowlist (process-wide Node/tsx compile caches)', async () => {
    const dir = await tmpDir('aiwg-leak-gate-allowed-');
    await mkdir(join(dir, 'node-compile-cache'));
    await mkdir(join(dir, 'tsx-1000'));
    await mkdir(join(dir, 'tsx-0'));
    expect(findLeakedEntries(dir)).toEqual([]);
  });

  it('flags any other entry a test run left behind', async () => {
    const dir = await tmpDir('aiwg-leak-gate-flagged-');
    await mkdir(join(dir, 'aiwg-skill-usage-abc123'));
    await writeFile(join(dir, 'stray-file.json'), '{}');
    expect(findLeakedEntries(dir)).toEqual(['aiwg-skill-usage-abc123', 'stray-file.json']);
  });

  it('honors caller-supplied allow patterns in addition to the defaults', async () => {
    const dir = await tmpDir('aiwg-leak-gate-custom-allow-');
    await mkdir(join(dir, 'known-fixture-cache'));
    await mkdir(join(dir, 'aiwg-skill-usage-abc123'));
    expect(findLeakedEntries(dir, { allow: [/^known-fixture-cache$/] })).toEqual(['aiwg-skill-usage-abc123']);
  });

  it('exposes the default allowlist as patterns, not hardcoded strings callers must duplicate', () => {
    expect(DEFAULT_ALLOWED_ENTRIES.every(pattern => pattern instanceof RegExp)).toBe(true);
    expect(DEFAULT_ALLOWED_ENTRIES.some(pattern => pattern.test('node-compile-cache'))).toBe(true);
    expect(DEFAULT_ALLOWED_ENTRIES.some(pattern => pattern.test('tsx-12345'))).toBe(true);
  });
});
