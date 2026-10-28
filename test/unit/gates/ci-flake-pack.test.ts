import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createCoreProviderRegistry } from '../../../src/gates/providers/index.js';
import { discoverShippedGatePacks, loadGatePackFile } from '../../../src/gates/discovery.js';
import { GateRegistry } from '../../../src/gates/registry.js';
import { validateResolvedPack } from '../../../src/gates/registry.js';
import { validateGateDocument } from '../../../src/gates/schema.js';
import type { GatePack } from '../../../src/gates/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const packPath = resolve(here, '../../../agentic/code/extensions/dev/gate-packs/ci-flake.gatepack.yaml');
const repoRoot = resolve(here, '../../..');

describe('ci-flake gate pack', () => {
  it('loads and validates against the closed schema and core providers', () => {
    const pack = loadGatePackFile(packPath);
    expect(pack.metadata.id).toBe('aiwg:dev/ci-flake');
    validateGateDocument<GatePack>(JSON.parse(JSON.stringify(pack)));
    validateResolvedPack(pack, createCoreProviderRegistry());
    expect(pack.spec.parameters?.requiredRuns?.default).toBe(50);
    expect(pack.spec.parameters?.maxFailedRuns?.default).toBe(0);
    const failures = pack.spec.gates.find((gate) => gate.id === 'flake-failures');
    expect(failures?.kind).toBe('count-max');
    expect(failures?.onFail).toBe('ROLLBACK');
  });

  it('is discovered as a shipped pack from the dev extension bundle', () => {
    const registry = new GateRegistry(createCoreProviderRegistry());
    const loaded = discoverShippedGatePacks(repoRoot, registry);
    expect(loaded).toContain('aiwg:dev/ci-flake');
    expect(registry.getPack('aiwg:dev/ci-flake').metadata.version).toBe('1.0.0');
  });

  it('rejects a copy that allows a failed run (negative count default)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-pack-'));
    const copy = join(dir, 'ci-flake.gatepack.yaml');
    writeFileSync(copy, readFileSync(packPath, 'utf8').replace('default: 0', 'default: -1'));
    const pack = loadGatePackFile(copy);
    expect(() => validateResolvedPack(pack, createCoreProviderRegistry()))
      .toThrow(/count default must be a non-negative integer/);
  });
});
