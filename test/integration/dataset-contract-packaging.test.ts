import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  'test/fixtures/dataset/fortemi-capability/authority-manifest.json',
  'test/fixtures/dataset/fortemi-capability/negotiation-vectors.json',
  'test/fixtures/dataset/fortemi-capability/server-descriptor.json',
  'test/fixtures/dataset/fortemi-capability/wire-vectors.json',
  'schemas/dataset/fortemi-run-receipt/validation-1.0.1/run-receipt.schema.json',
  'schemas/dataset/fortemi-run-receipt/validation-1.0.1/authority.json',
];

const PINNED_RUNTIME = [
  'dist/src/dataset/fortemi-capability.js',
  'dist/src/dataset/fortemi-run-receipt.js',
  'dist/src/dataset/fortemi-schema-path.js',
];

function parsePackResult(stdout: string): Array<{ filename: string; files?: Array<{ path: string; size: number }> }> {
  try {
    return JSON.parse(stdout);
  } catch {
    const arrayStart = stdout.lastIndexOf('\n[');
    if (arrayStart < 0) throw new Error('npm pack output contained no JSON array');
    return JSON.parse(stdout.slice(arrayStart + 1));
  }
}

function packedFiles(): Map<string, number> {
  const pack = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 110_000,
  });
  if (pack.status !== 0) throw new Error(`npm pack --dry-run --json failed with status ${pack.status}: ${pack.stderr}`);
  const result = parsePackResult(pack.stdout);
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

  it('runs every shared capability vector through a clean-installed public entry', () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'aiwg-dataset-installed-'));
    try {
      writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
      const pack = spawnSync('npm', ['pack', '--json', '--pack-destination', scratch], {
        cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000,
      });
      expect(pack.status, pack.stderr).toBe(0);
      const tarball = path.join(scratch, parsePackResult(pack.stdout)[0].filename);
      const install = spawnSync('npm', [
        'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tarball,
      ], { cwd: scratch, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
      expect(install.status, install.stderr).toBe(0);

      const probe = path.join(scratch, 'probe.mjs');
      writeFileSync(probe, `
        import { createHash } from 'node:crypto';
        import { readFileSync } from 'node:fs';
        import {
          compareFortemiCapabilityVersions,
          negotiateFortemiCapabilities,
          validateFortemiCapabilityDescriptor,
          validateFortemiCapabilityRequest,
        } from 'aiwg/dataset';
        const root = new URL('./node_modules/aiwg/', import.meta.url);
        const read = relative => readFileSync(new URL(relative, root), 'utf8');
        const json = relative => JSON.parse(read(relative));
        const digest = value => createHash('sha256').update(value).digest('hex');
        const authority = json('schemas/dataset/fortemi-capability-validation/1.0.1/authority.json');
        const files = {
          'schema.json': read('schemas/dataset/fortemi-capability-validation/1.0.1/capability.schema.json'),
          'negotiation-vectors.json': read('test/fixtures/dataset/fortemi-capability/negotiation-vectors.json'),
          'wire-vectors.json': read('test/fixtures/dataset/fortemi-capability/wire-vectors.json'),
        };
        for (const file of authority.files) {
          if (digest(files[file.authorityPath]) !== file.sha256) throw new Error('authority digest mismatch: ' + file.authorityPath);
        }
        const versions = JSON.parse(files['negotiation-vectors.json']).versions;
        for (const vector of versions) {
          const result = compareFortemiCapabilityVersions(vector.offered, vector.minimum);
          if ((result !== null && result >= 0) !== vector.accepted) throw new Error('version mismatch: ' + vector.id);
        }
        const wire = JSON.parse(files['wire-vectors.json']).cases;
        for (const vector of wire) {
          const diagnostics = [
            ...validateFortemiCapabilityDescriptor(vector.descriptor),
            ...validateFortemiCapabilityRequest(vector.request),
          ];
          if ((diagnostics.length === 0) !== vector.valid) throw new Error('wire validity mismatch: ' + vector.id);
          const decision = negotiateFortemiCapabilities(vector.descriptor, vector.request);
          if (decision.accepted !== (vector.valid === true && vector.accepted === true)) throw new Error('wire decision mismatch: ' + vector.id);
        }
        const descriptor = json('test/fixtures/dataset/fortemi-capability/server-descriptor.json');
        if (validateFortemiCapabilityDescriptor(descriptor).length) throw new Error('retained descriptor rejected');
        console.log(JSON.stringify({ status: 'PASS', versionCases: versions.length, wireCases: wire.length }));
      `);
      const result = spawnSync(process.execPath, [probe], {
        cwd: scratch, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ status: 'PASS', versionCases: 20, wireCases: 11 });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 180_000);
});
