import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ file: '' }));
vi.mock('../../../src/rules/pin-state.js', () => ({
  ruleFiles: () => [],
  rulePinState: () => ({ installed: ['demo'], warnings: [], rules: [], inventory: [{
    id: 'demo-rule', name: 'demo-rule', path: fixture.file, capability: 'demo', activation: 'on-demand', enforcement: 'low',
  }] }),
}));
vi.mock('../../../src/artifacts/relations.js', () => ({ loadRelations: () => null }));
vi.mock('../../../src/config/user-registry.js', () => ({ readUserRegistry: async () => ({ installed: {} }) }));
vi.mock('../../../src/rules/pins.mjs', async importOriginal => ({
  ...await importOriginal<object>(),
  loadRulePinConfigs: () => ({ user: {}, project: { rules: { always_load: [{ enforcement: ['critical'] }] } } }),
}));
import { ruleInventory } from '../../../src/rules/inventory.js';

it('uses source activation and enforcement for filtering and tier pins when index metadata is stale', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aiwg-inventory-stale-'));
  try {
    fixture.file = join(dir, 'rule.md');
    writeFileSync(fixture.file, '---\nname: demo-rule\nactivation: bound\nenforcement: critical\nsummary: Read the current rule.\nbound_to:\n  skills: [demo]\n---\n\n# Rule\n');
    const report = await ruleInventory(dir, dir, { scope: 'workspace', activation: ['kernel'], enforcement: ['critical'] });
    expect(report.rules).toHaveLength(1);
    expect(report.rules[0]).toMatchObject({ canonical_activation: 'bound', effective_activation: 'kernel', enforcement: 'critical' });
    expect(report.warnings.join('\n')).toContain('Stale enforcement metadata');
    expect(report.warnings.join('\n')).toContain('Stale activation metadata');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
