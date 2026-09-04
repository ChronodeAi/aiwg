import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');

// Force the on-demand rule section past the legacy 19K cap. Old code throws
// (hard cap 19_000); aligned code must accept it (dynamic 0.21 budget, 38K cap).
vi.mock('../../../tools/agents/providers/base.mjs', async (importOriginal) => {
  const orig: Record<string, unknown> = await importOriginal();
  return { ...orig, renderOnDemandRuleSection: () => 'X'.repeat(20_000) };
});

const { generateAgentsMd } = await import('../../../tools/agents/providers/hermes.mjs');

describe('Hermes AGENTS.md cap (0.21 dynamic budget)', () => {
  it('accepts output above the legacy 19K cap', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aiwg-hermes-cap-'));
    try {
      // header + CRITICAL rules (~9K) + mocked on-demand (20K) ≈ 29K:
      // > 19_000 (legacy cap would throw) and < 38_000 (new cap).
      const n = generateAgentsMd(0, 0, dir, { dryRun: true, srcRoot: REPO_ROOT, quiet: true });
      expect(n).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
