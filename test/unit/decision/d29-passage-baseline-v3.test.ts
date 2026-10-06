import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { sha256 } from '../../../src/decision/compile-cache/identity.js';
import { heldoutDigest } from '../../../src/decision/heldout/contract.js';
import { d29PassageBaselineV2 } from '../../../src/decision/heldout/d29-passage-baseline-v2.js';
import { d29PassageBaselineV3, d29PassageBaselineV3Digest } from '../../../src/decision/heldout/d29-passage-baseline-v3.js';
import { d29WorldV3, generateHeldoutRow } from '../../../src/decision/heldout/generators.js';
import { d29WorldV7 } from '../../../src/decision/heldout/d29-v7.js';
import { oracle } from '../../../tools/decision/studies/d29.mjs';

describe('D29 train-only passage baseline v3', () => {
  it('D29-PBV3-01 is built from the train pools only and binds its source by digest', () => {
    const source = readFileSync(new URL('../../../src/decision/heldout/d29-passage-baseline-v3.ts', import.meta.url), 'utf8');
    expect(source).toContain('D29_TRAIN');
    expect(source).not.toContain('D29_TEST');
    expect(d29PassageBaselineV3Digest()).toBe(sha256(source));
    expect(d29PassageBaselineV3Digest()).not.toBe(sha256(`${source}\nchanged`));
  });
  it('D29-PBV3-02 reaches the v2 ceiling on train wording and stays review-only on test wording', () => {
    const worlds = Array.from({ length: 2000 }, (_, ordinal) => d29WorldV7('d29-study-v7', ordinal));
    expect(worlds.filter(row => row.world.pool === 'train')).toHaveLength(500);
    for (const row of worlds) {
      const hardPass = row.world.artifactPresent && row.world.testPassed;
      const third = d29PassageBaselineV3(row.payload, hardPass);
      if (row.world.pool === 'train') {
        // Same decision logic as v2, train-pool vocabulary: identical verdicts on known wording.
        expect(third, row.id).toEqual(d29PassageBaselineV2(row.payload, hardPass));
      } else {
        // Test-pool wording is parser-unseen: never ready, support stays at the defaults.
        expect(third.route, row.id).toBe('REVIEW');
        expect(['unclear', null].includes(third.support), row.id).toBe(true);
      }
    }
  });
  it('D29-PBV3-03 records the v3 historical gold drift instead of regenerating it away', async () => {
    // v3 rows reproduce the recorded pin (see D29-PB-11); v3 gold no longer matches the current
    // oracle on 38 rows, so the historical pin is kept as a recorded constant and current behavior
    // is pinned separately. Either digest changing means history or the oracle moved again.
    const header = JSON.parse(await readFile(
      new URL('../../fixtures/decision/d29-synthetic-v3/gold.json', import.meta.url), 'utf8'));
    expect(header.schemaVersion).toBe('decision-d29-gold-header/v1');
    expect(header.pins.fullGoldDigest).toBe('sha256:75a57db59be18ba28b544e84eb4b8e639f11523ce7ac82e5ec62dfe4c0597954');
    const rows = [];
    for (let ordinal = 0; ordinal < 2000; ordinal++) {
      const { world } = d29WorldV3('d29-study-v4', ordinal);
      rows.push(generateHeldoutRow('d29-synthetic/v3', `d29-study-v4:${ordinal}:${world.artifactPresent && world.testPassed ? 'single' : 'local'}`));
    }
    const gold = { schemaVersion: 'decision-d29-gold/v3', syntheticOnly: true,
      rows: rows.map((row, ordinal) => {
        const { world } = d29WorldV3('d29-study-v4', ordinal);
        return { id: row.id, variant: world.variant, world, gold: oracle(world) };
      }) };
    expect(heldoutDigest(gold)).toBe('sha256:84374a22c06e4f73e165b436083608c740620c6620bdaef7c52a9950dbdb9e55');
    expect(heldoutDigest(gold)).not.toBe(header.pins.fullGoldDigest);
  });
});
