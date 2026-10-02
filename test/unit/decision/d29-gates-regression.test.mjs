import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { prepare, prepareV7, dryRun, dryRunV7 } from '../../../tools/decision/studies/d29.mjs';
import { heldoutDigest } from '../../../src/decision/heldout/contract.js';
import { evaluateSdlcScreeningPreregistration } from '../../../src/decision/sdlc-screening.js';
import { preregistration, heldoutRecords, anchored, HELDOUT_NOW } from './sdlc-screening-fixtures.ts';
import { freezeAdmissionClock } from './d29-test-support.mjs';

freezeAdmissionClock();

const header = async version => JSON.parse(await readFile(new URL(
  `../../fixtures/decision/d29-synthetic-${version}/corpus.json`, import.meta.url), 'utf8'));

/**
 * The gates adoption is opt-in: planning (prepare/dry-run) never evaluates gates,
 * row generation is byte-identical, and non-D29 native gating is untouched.
 */
describe('D29 gates adoption stays disabled outside the study score path', () => {
  it('planning outputs carry gate digest pins but no gate evaluation', async () => {
    for (const [prepareFn, dryFn, seed] of [[prepare, dryRun, 'd29-study-v6'], [prepareV7, dryRunV7, 'd29-study-v7']]) {
      const prepared = await prepareFn(seed);
      expect(Object.keys(prepared).sort()).toEqual(['analysis', 'approval', 'corpus', 'gold', 'preregistration', 'reviews']);
      expect(JSON.stringify(prepared)).not.toContain('gateEvidence');
      const dry = await dryFn(prepared);
      expect(dry).toMatchObject({ providerCalls: 0 });
      expect(typeof dry.gateBindingDigest).toBe('string');
      expect(dry.gatePackDigests).toHaveLength(2);
      expect(typeof dry.gateProviderDigest).toBe('string');
      expect(dry).not.toHaveProperty('gateReport');
      expect(dry).not.toHaveProperty('decision');
    }
  }, 120_000);

  it('row, gold and definition bytes regenerate identically with gates adopted', async () => {
    const v6 = await prepare('d29-study-v6');
    const v6header = await header('v6');
    expect(heldoutDigest(v6.corpus.rows)).toBe(v6header.pins.rowsDigest);
    expect(heldoutDigest(v6.gold.rows)).toBe(v6header.pins.goldRowsDigest);
    expect(heldoutDigest(v6.corpus.definitions)).toBe(v6header.pins.definitionsDigest);
    expect(heldoutDigest(v6.gold)).toBe(v6header.pins.fullGoldDigest);
    const v7 = await prepareV7('d29-study-v7');
    const dry = await dryRunV7(v7);
    expect(heldoutDigest(v7.gold)).toBe(dry.goldDigest);
  }, 120_000);

  it('v1 native non-inferiority still gates other consumers', () => {
    const plan = preregistration();
    let flipped = 0;
    const regressed = heldoutRecords().samples.map(sample => sample.gold.ready && flipped < 20 && ++flipped
      ? { ...sample, candidate: { ...sample.candidate, route: 'REVIEW', readyProbability: 0.1 } } : sample);
    const result = evaluateSdlcScreeningPreregistration(plan, anchored(plan),
      { ...heldoutRecords(), samples: regressed }, HELDOUT_NOW);
    expect(result).toMatchObject({ decision: 'fail', reasons: ['quality-not-non-inferior'] });
  });
});
