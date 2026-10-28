import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as upstream from '../../../tools/eval/src/integrity.js';
import { runAnalysis } from '../../../tools/experiments/conformal/run.v2.mjs';
import { extendIntegrity } from '../../../tools/experiments/conformal/prototype.mjs';
import { verifiedIntegrity } from '../decision/sdlc-screening-fixtures.js';

describe('conformal HOLD ceilings (#2829)', () => {
  it.each(['PROMOTE', 'HOLD', 'ROLLBACK'] as const)('prototype preserves %s and upstream reasons', decision => {
    const integrity = verifiedIntegrity({ release_gate: { decision, reasons: ['fixture'] } });
    const result = extendIntegrity(integrity, { outcome: 'INSUFFICIENT EVIDENCE' });
    expect(result.release_gate).toEqual({ decision: decision === 'ROLLBACK' ? 'ROLLBACK' : 'HOLD', reasons: ['fixture'] });
    expect(integrity.release_gate.decision).toBe(decision);
  });
  it.each(['PROMOTE', 'HOLD', 'ROLLBACK'] as const)('v2 analysis preserves %s through its report ceiling', decision => {
    const output = mkdtempSync(join(tmpdir(), 'conformal-lattice-'));
    const metadata = verifiedIntegrity({ release_gate: { decision, reasons: ['fixture'] } });
    const spy = vi.spyOn(upstream, 'buildIntegrityMetadata').mockReturnValue(metadata as ReturnType<typeof upstream.buildIntegrityMetadata>);
    try {
      runAnalysis({ output });
      const report = JSON.parse(readFileSync(join(output, 'report.v2.json'), 'utf8'));
      expect(spy).toHaveBeenCalledOnce();
      expect(report.integrity.release_gate).toEqual({ decision: decision === 'ROLLBACK' ? 'ROLLBACK' : 'HOLD', reasons: ['fixture'] });
    } finally { spy.mockRestore(); rmSync(output, { recursive: true, force: true }); }
  });
});
