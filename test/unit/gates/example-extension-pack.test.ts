import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadGatePackFile } from '../../../src/gates/discovery.js';
import { createCoreProviderRegistry } from '../../../src/gates/providers/index.js';
import { validateResolvedPack } from '../../../src/gates/registry.js';
import { validateGateDocument } from '../../../src/gates/schema.js';
import type { GatePack } from '../../../src/gates/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const packPath = resolve(here, '../../fixtures/gates/example-extension-pack/example-counter.gatepack.yaml');

describe('example extension gate pack', () => {
  it('loads and validates against the closed schema and core providers', () => {
    const pack = loadGatePackFile(packPath);
    expect(pack.metadata.id).toBe('extension:example/counter');
    validateGateDocument<GatePack>(JSON.parse(JSON.stringify(pack)));
    validateResolvedPack(pack, createCoreProviderRegistry());
    expect(pack.spec.gates.map(gate => gate.id).sort()).toEqual(
      ['blocking-false-ready-events', 'false-ready-upper']);
  });

  it('rejects a copy with an invalid failure ceiling (onFail PROMOTE)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-pack-'));
    const copy = join(dir, 'example-counter.gatepack.yaml');
    writeFileSync(copy, readFileSync(packPath, 'utf8').replace('onFail: HOLD', 'onFail: PROMOTE'));
    expect(() => loadGatePackFile(copy)).toThrow(/gate pack invalid/);
  });
});
