// Keep doctor on the deployment owner's artifact parser and recursive inventory.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readModelWrapperArtifacts } from '../../../src/models/wrapper-deployment.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('readModelWrapperArtifacts', () => {
  it('reads nested wrappers with deployment suffixes and retains unresolved metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrapper-artifacts-'));
    roots.push(root);
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested/aiwg-model-coding-worker.agent.md'), '---\nmodel: cheap\neffort: low\n---\n');
    await writeFile(join(root, 'aiwg-model-explorer.md'), '---\nmodel: [broken\n---\n');
    await writeFile(join(root, 'aiwg-model-verifier.md'), '# no metadata\n');
    await writeFile(join(root, 'other.md'), '# ignored');
    expect(await readModelWrapperArtifacts(root)).toEqual([
      expect.objectContaining({ wrapper: expect.objectContaining({ name: 'aiwg-model-explorer' }), fields: null }),
      expect.objectContaining({ wrapper: expect.objectContaining({ name: 'aiwg-model-verifier' }), fields: null }),
      expect.objectContaining({ wrapper: expect.objectContaining({ name: 'aiwg-model-coding-worker' }), fields: { model: 'cheap', effort: 'low' } }),
    ]);
  });
  it('returns no artifacts for providers with no native directory', async () => {
    expect(await readModelWrapperArtifacts(null)).toEqual([]);
  });
  it('parses native TOML literal strings, comments and table scopes, retaining malformed artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrapper-artifacts-'));
    roots.push(root);
    await writeFile(join(root, 'aiwg-model-coding-worker.toml'), "model = 'cheap' # pin\n[other]\nmodel = 'expensive'\n");
    await writeFile(join(root, 'aiwg-model-explorer.toml'), 'model = [broken\n');
    expect(await readModelWrapperArtifacts(root)).toEqual([
      expect.objectContaining({ fields: { model: 'cheap', other: { model: 'expensive' } } }),
      expect.objectContaining({ fields: null }),
    ]);
  });
});
