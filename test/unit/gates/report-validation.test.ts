import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateGateFile } from '../../../src/gates/driver.js';
import { assertGateReportDecision } from '../../../src/gates/report.js';
import { GateDecisionUpgradeError } from '../../../src/gates/lattice.js';
import { artifactDigest } from '../../../src/decision/validate.js';
import { evaluateFixture } from '../../conformance/gates-v1/helper.js';

describe('report component validation at the file boundary (#2829)', () => {
  it.each(['gate', 'pack', 'upstream-ceiling', 'binding', 'upstream-record'] as const)('rejects an upgrade over %s', async component => {
    const report = evaluateFixture();
    if (component === 'gate') report.gateEvidence[0]!.outcome = 'ROLLBACK';
    if (component === 'pack') report.ceilings.packOutcome = 'ROLLBACK';
    if (component === 'upstream-ceiling') report.ceilings.upstreamCeiling = 'ROLLBACK';
    if (component === 'binding') report.ceilings.bindingCeiling = 'ROLLBACK';
    if (component === 'upstream-record') report.upstream!.decision = 'ROLLBACK';
    report.decision = 'PROMOTE';
    const { digest: _old, ...fields } = report;
    report.digest = artifactDigest(fields);
    expect(() => assertGateReportDecision(report)).toThrow(GateDecisionUpgradeError);
    const root = await mkdtemp(join(tmpdir(), 'gate-report-lattice-'));
    try {
      const path = join(root, 'report.json');
      await writeFile(path, JSON.stringify(report));
      const result = await validateGateFile('report', path, { cwd: root });
      expect(result.valid).toBe(false);
      expect(result.errors.join(';')).toContain('report-upgrades-component');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
