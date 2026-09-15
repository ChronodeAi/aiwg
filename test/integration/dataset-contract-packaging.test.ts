import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');

/**
 * Pinned producer contracts the dataset runtime reads from disk at import time.
 * A consumer that installs the package without these files throws before it can
 * validate a Fortemi descriptor or receipt, so packaging is part of the gate.
 */
const PINNED_CONTRACTS = [
  'schemas/dataset/fortemi-capability-validation/1.0.1/capability.schema.json',
  'schemas/dataset/fortemi-capability-validation/1.0.1/authority.json',
  'schemas/dataset/fortemi-run-receipt/validation-1.0.1/run-receipt.schema.json',
  'schemas/dataset/fortemi-run-receipt/validation-1.0.1/authority.json',
];

const PINNED_RUNTIME = [
  'dist/src/dataset/fortemi-capability.js',
  'dist/src/dataset/fortemi-run-receipt.js',
  'dist/src/dataset/fortemi-schema-path.js',
];

function packedFiles(): Map<string, number> {
  const pack = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 110_000,
  });
  if (pack.status !== 0) throw new Error(`npm pack --dry-run --json failed with status ${pack.status}: ${pack.stderr}`);
  let result;
  try {
    result = JSON.parse(pack.stdout);
  } catch {
    const arrayStart = pack.stdout.lastIndexOf('\n[');
    if (arrayStart < 0) throw new Error('npm pack output contained no JSON array');
    result = JSON.parse(pack.stdout.slice(arrayStart + 1));
  }
  const files = result?.[0]?.files;
  if (!Array.isArray(files)) throw new Error('npm pack output did not contain a files array');
  return new Map(files.map((entry: { path: string; size: number }) => [entry.path, entry.size]));
}

const digest = (relative: string) =>
  createHash('sha256').update(readFileSync(path.join(ROOT, relative))).digest('hex');

describe('dataset producer contracts ship with the package (packaging lane)', () => {
  it('publishes every pinned contract and its runtime loader', () => {
    const published = packedFiles();
    for (const file of [...PINNED_CONTRACTS, ...PINNED_RUNTIME]) {
      expect(published.has(file), `${file} is absent from the published package`).toBe(true);
      expect(published.get(file), `${file} is published empty`).toBeGreaterThan(0);
    }
  }, 120_000);

  it('keeps the published capability authority bound to the digests it records', () => {
    const authority = JSON.parse(
      readFileSync(path.join(ROOT, 'schemas/dataset/fortemi-capability-validation/1.0.1/authority.json'), 'utf8'),
    ) as { files: Array<{ path: string; authorityPath: string; sha256: string }> };
    const base = 'schemas/dataset/fortemi-capability-validation/1.0.1';
    for (const file of authority.files) {
      expect(digest(path.normalize(path.join(base, file.path))), file.authorityPath).toBe(file.sha256);
    }
  });

  it('resolves the pinned schema from the built layout the package publishes', async () => {
    const module = await import(path.join(ROOT, 'dist/src/dataset/fortemi-capability.js')) as {
      validateFortemiCapabilityDescriptor(descriptor: unknown): string[];
    };
    const descriptor = JSON.parse(
      readFileSync(path.join(ROOT, 'test/fixtures/dataset/fortemi-capability/server-descriptor.json'), 'utf8'),
    );
    expect(module.validateFortemiCapabilityDescriptor(descriptor)).toEqual([]);
    expect(module.validateFortemiCapabilityDescriptor(null).length).toBeGreaterThan(0);
  });
});
