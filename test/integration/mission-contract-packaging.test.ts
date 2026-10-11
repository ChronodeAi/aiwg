import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildCliPackage } from '../../tools/release/build-cli-package.mjs';
import { workerDefinitionBundleDigest } from '../../src/mission-protocol/codecs.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
// The mission.aiwg.io/v1 owner carries the worker definitions in both packages.
const SCHEMA = 'schemas/mission-v1.schema.json';
const vectors = JSON.parse(readFileSync(path.join(ROOT,
  'test/conformance/mission-v1/fixtures/worker-contracts/mission-vectors.json'), 'utf8')) as
  Array<{ id: string; definition: string; valid: boolean; value: unknown }>;

// Copy only the validator's installed dependency graph. The probe never falls
// back to checkout modules or downloads anything from a registry.
function copyValidatorDependencies(scratch: string): void {
  const copied = new Set<string>();
  function copy(name: string, requireFrom: ReturnType<typeof createRequire>): void {
    if (copied.has(name)) return;
    copied.add(name);
    const manifest = requireFrom.resolve(`${name}/package.json`);
    const target = path.join(scratch, 'node_modules', name);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.dirname(manifest), target, { recursive: true });
    const metadata = JSON.parse(readFileSync(manifest, 'utf8')) as { dependencies?: Record<string, string> };
    const dependencyRequire = createRequire(manifest);
    for (const dependency of Object.keys(metadata.dependencies ?? {})) copy(dependency, dependencyRequire);
  }
  const rootRequire = createRequire(path.join(ROOT, 'package.json'));
  for (const name of ['ajv', 'ajv-formats']) copy(name, rootRequire);
}

describe('installed Mission worker contract packaging', () => {
  it.each(['aiwg', '@aiwg/cli'])('loads validation and digest APIs from unpacked %s outside the checkout', async (name) => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'aiwg-mission-installed-'));
    try {
      expect(path.relative(ROOT, scratch).startsWith('..')).toBe(true);
      const stage = name === 'aiwg' ? ROOT : path.join(scratch, 'stage');
      if (name === '@aiwg/cli') await buildCliPackage({ outputDir: stage });
      const pack = spawnSync('npm', ['pack', stage, '--offline', '--ignore-scripts', '--json',
        '--cache', path.join(scratch, 'npm-cache'), '--pack-destination', scratch], {
        cwd: scratch, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000,
      });
      expect(pack.status, pack.stderr).toBe(0);
      const packed = JSON.parse(pack.stdout)[0] as { name: string; filename: string; files: Array<{ path: string }> };
      expect(packed.name).toBe(name);
      expect(packed.files.map(file => file.path)).toContain(SCHEMA);
      expect(packed.files.map(file => file.path)).toContain('dist/src/mission-protocol/codecs.js');
      const installed = path.join(scratch, 'node_modules', name);
      mkdirSync(installed, { recursive: true });
      const unpack = spawnSync('tar', ['-xzf', path.join(scratch, packed.filename), '-C', installed,
        '--strip-components=1'], { cwd: scratch, encoding: 'utf8', timeout: 30_000 });
      expect(unpack.status, unpack.stderr).toBe(0);
      expect(readFileSync(path.join(installed, SCHEMA))).toEqual(readFileSync(path.join(ROOT, SCHEMA)));
      copyValidatorDependencies(scratch);
      const intent = vectors.find(vector => vector.id === 'intent-unresolved')!;
      writeFileSync(path.join(scratch, 'intent.json'), JSON.stringify(intent.value));
      const schemaId = JSON.parse(readFileSync(path.join(installed, SCHEMA), 'utf8')).$id;
      const probe = path.join(scratch, 'probe.mjs');
      writeFileSync(probe, `
        import assert from 'node:assert/strict';
        import { readFileSync } from 'node:fs';
        import {
          encodeWorkerPayload, decodeWorkerPayload, validateWorkerPayload,
          workerDefinitionBundleDigest, workerContractSchemaId,
        } from ${JSON.stringify(pathToFileURL(path.join(installed, 'dist/src/mission-protocol/codecs.js')).href)};
        const intent = JSON.parse(readFileSync(new URL('./intent.json', import.meta.url), 'utf8'));
        assert.equal(workerContractSchemaId(), ${JSON.stringify(schemaId)});
        assert.equal(workerDefinitionBundleDigest(), ${JSON.stringify(workerDefinitionBundleDigest())});
        assert.equal(validateWorkerPayload('workerSelectionIntent', intent).valid, true);
        const invalid = { ...intent, version: 999 };
        assert.equal(validateWorkerPayload('workerSelectionIntent', invalid).valid, false);
        assert.throws(() => encodeWorkerPayload('workerSelectionIntent', invalid), /OG_CONTRACT_INVALID|Invalid/);
        assert.deepEqual(decodeWorkerPayload('workerSelectionIntent', encodeWorkerPayload('workerSelectionIntent', intent)), intent);
        console.log(JSON.stringify({ package: ${JSON.stringify(name)}, validated: true }));
      `);
      const result = spawnSync(process.execPath, [probe], {
        cwd: scratch, encoding: 'utf8', timeout: 30_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ package: name, validated: true });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 120_000);
});
