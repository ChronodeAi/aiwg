import { describe, expect, inject, it } from 'vitest';
import { boundedSpawnSync } from '../../src/process/bounded-child-process.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
describe('shipped relationship tables', () => {
  it('packs the versioned schema, manifest, relationships and resolved bindings', () => {
    const packed = inject('basePackageManifest') as { files: Array<{ path: string }> };
    const files = new Set(packed.files.map(file => file.path));
    for (const file of ['relations.json', 'bindings.json', 'manifest.json']) expect(files.has(`prebuilt/framework-relations/${file}`), file).toBe(true);
    expect(files.has('schemas/artifacts/relations.v1.schema.json')).toBe(true);
  });
  it('shows bound rules from an installed layout with a fresh HOME and no source index build', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-relations-packed-'));
    try {
      const installed = path.join(tmp, 'package');
      const pack = boundedSpawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', tmp], 'long', {
        cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      });
      expect(pack.error?.message).toBeUndefined();
      expect(pack.status, pack.stderr).toBe(0);
      const filename = JSON.parse(pack.stdout)[0].filename;
      const unpack = boundedSpawnSync('tar', ['-xzf', path.join(tmp, filename), '-C', tmp], 'long', { encoding: 'utf8' });
      expect(unpack.status, unpack.stderr).toBe(0);
      // Offline runtime dependencies; package contents come from the packed manifest above.
      fs.symlinkSync(path.join(root, 'node_modules'), path.join(installed, 'node_modules'), 'dir');
      const data = path.join(tmp, 'data');
      const result = boundedSpawnSync(process.execPath, [path.join(installed, 'bin/aiwg.mjs'), 'show', 'skill', 'address-issues', '--json'], 'long', {
        cwd: tmp, encoding: 'utf8', maxBuffer: 1024 * 1024,
        env: { ...process.env, HOME: path.join(tmp, 'home'), XDG_DATA_HOME: data, XDG_CONFIG_HOME: path.join(tmp, 'config'), XDG_CACHE_HOME: path.join(tmp, 'cache'), AIWG_ROOT: installed },
      });
      expect(result.error?.message).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).bound_rules.length).toBeGreaterThan(0);
      expect(result.stderr).not.toContain('source digest differs');
      const files = fs.readdirSync(data, { recursive: true }).map(String);
      expect(files.some(file => file.endsWith('metadata.json'))).toBe(false);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }, 60_000);
});
