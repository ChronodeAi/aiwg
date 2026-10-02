/**
 * Fast single-seed D29 v8 coverage for the default `test:ci` lane: generator
 * determinism and pool coverage, the passing audit (with lexicon transfer),
 * refusals, routing and one structure-scan smoke test on the public seed. The
 * full single-seed suite, every multi-seed scan and every positive control
 * run in the `test:d29-slow` lane (config/test-lanes.mjs `d29SlowFiles`), on
 * every PR.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { D29_TRAIN_V8, D29_TEST_V8 } from '../../../src/decision/heldout/d29-pools-v8.js';
import { d29WorldV8, D29_V8_GENERATOR_ID, D29_V8_SEED } from '../../../src/decision/heldout/d29-v8.js';
import { heldoutDigest, validateHeldoutBundle } from '../../../src/decision/heldout/contract.js';
import { injectionPopulationV8 } from '../../../tools/decision/studies/d29-shortcuts-v8.mjs';
import { prepare, oracle, d29GeneratorForSeed, d29CorpusGeneratorId, analysisPlanV8, shortcutAuditV8Cached,
  assertD29RequestBounds } from '../../../tools/decision/studies/d29.mjs';
import { recordUnits, blindFeatures, blindTree } from './d29-structure-scan.mjs';
import { freezeAdmissionClock, PREPARE_HOOK_TIMEOUT } from './d29-test-support.mjs';

freezeAdmissionClock();

let prepared;
beforeAll(async () => { prepared = await prepare(D29_V8_SEED); }, PREPARE_HOOK_TIMEOUT);

const tokens = text => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
const bigrams = text => { const t = tokens(text); return t.slice(1).map((word, i) => `${t[i]} ${word}`); };

describe('D29 v8 fast smoke (default lane)', () => {
  it('SMOKE-01 generates deterministic rows whose instruction bigrams all have benign uses', () => {
    for (const ordinal of [0, 777, 1999]) expect(JSON.stringify(d29WorldV8(D29_V8_SEED, ordinal))).toBe(JSON.stringify(d29WorldV8(D29_V8_SEED, ordinal)));
    for (const pool of [D29_TRAIN_V8, D29_TEST_V8]) {
      const benign = new Set([...pool.tasks, ...pool.counterparts, ...pool.timings, ...pool.roles].flatMap(bigrams));
      for (const clause of pool.instructions) expect(bigrams(clause).filter(gram => !benign.has(gram)), clause).toEqual([]);
    }
    const rows = Array.from({ length: 2000 }, (_, ordinal) => d29WorldV8(D29_V8_SEED, ordinal));
    expect(new Set(rows.map(row => row.id)).size).toBe(2000);
    expect(rows.filter(row => row.world.injected).length).toBe(400);
  });

  it('SMOKE-02 passes the v5 audit, including the pool-transfer lexicon check, and records its digest', () => {
    const audit = shortcutAuditV8Cached(prepared.corpus, prepared.gold);
    expect(audit.passed).toBe(true);
    expect(audit.injectionLexiconTransfer.map(entry => entry.passed)).toEqual([true, true]);
    expect(prepared.analysis.shortcutAudit).toMatchObject({ reportDigest: heldoutDigest(audit), passed: true });
    expect(() => analysisPlanV8(prepared.corpus, { ...audit, passed: false })).toThrow('shortcut-audit');
  });

  it('SMOKE-03 refuses the public corpus for paid collection and any oversized request, naming only the row index', async () => {
    const bundle = { corpus: prepared.corpus, preregistration: prepared.preregistration, approval: prepared.approval };
    expect(() => validateHeldoutBundle(bundle, heldoutDigest(bundle.approval))).toThrow('public-demo-corpus');
    await expect(assertD29RequestBounds(prepared)).resolves.toBeUndefined();
    const shrunk = structuredClone(prepared);
    shrunk.preregistration.perRequestTokenBound = 1000;
    const refusal = String(await assertD29RequestBounds(shrunk).catch(error => error));
    expect(refusal).toMatch(/D29 study refused \(payload-bound at row \d+\)/);
    expect(refusal).not.toContain('Module');
  }, 120_000);

  it('SMOKE-04 routes fresh seeds to d29-synthetic/v8 and public seeds to their own generator', () => {
    for (const seed of ['fresh-private-seed', 'd29-study-v9', 'constructor']) expect(d29GeneratorForSeed(seed)).toBe(D29_V8_GENERATOR_ID);
    expect(d29GeneratorForSeed('d29-study-v6')).toBe('d29-synthetic/v6');
    expect(d29GeneratorForSeed('d29-study-v7')).toBe('d29-synthetic/v7');
    expect(d29CorpusGeneratorId(prepared.corpus)).toBe(D29_V8_GENERATOR_ID);
  });

  it('SMOKE-05 structure scan on one seed: one relevant unit per row, no blind tree reaches 0.75', () => {
    const pools = { train: D29_TRAIN_V8, test: D29_TEST_V8 };
    const rows = Array.from({ length: 2000 }, (_, ordinal) => d29WorldV8(D29_V8_SEED, ordinal));
    const parsed = new Map(rows.map(row => [row, recordUnits(row, pools)]));
    for (const row of rows) expect(parsed.get(row).units.filter(unit => unit.role === 'relevant'), row.id).toHaveLength(1);
    const sets = new Map(rows.map(row => [row, blindFeatures(parsed.get(row))]));
    for (const kind of ['citation', 'phase-criterion']) {
      const targets = { label: row => kind === 'citation' ? oracle(row.world).support : String(oracle(row.world).ready),
        injected: row => injectionPopulationV8(row.world, oracle(row.world)) ? String(row.world.injected) : undefined };
      const train = rows.filter(row => row.world.kind === kind && row.world.pool === 'train');
      const test = rows.filter(row => row.world.kind === kind && row.world.pool === 'test');
      for (const result of blindTree(train, train.map(row => sets.get(row)), test, test.map(row => sets.get(row)), targets)) {
        expect(Math.max(result.stump, result.tree), `${kind} ${result.target}:${result.label}`).toBeLessThan(0.75);
      }
    }
  }, 120_000);
});
