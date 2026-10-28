// Covers missing and malformed local policy resources without external acquisition.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { requireModelResource } from '../../../src/models/policy-resources.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
describe('T-OG-01 policy resource failures', () => {
  it('names a resource that is absent from every supported layout', () => {
    expect(() => requireModelResource('missing-diff-coverage-resource.json'))
      .toThrow('Model policy resource is missing: missing-diff-coverage-resource.json');
  });
  it('preserves a parse failure instead of treating malformed JSON as an absent resource', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiwg-policy-resource-')); directories.push(dir);
    const file = join(dir, 'malformed.json');
    await writeFile(file, '{ invalid JSON');
    const filename = relative(fileURLToPath(new URL('../../../src/models/', import.meta.url)), file);
    expect(() => requireModelResource(filename)).toThrow(SyntaxError);
  });
});
