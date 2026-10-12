import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { D29_TRAIN, D29_TEST, D29_POOL_EXCLUSIVE_MARKERS } from '../../../src/decision/heldout/d29-pools.js';
import { d29WorldV7 } from '../../../src/decision/heldout/d29-v7.js';
import { d29PassageBaselineV2 } from '../../../src/decision/heldout/d29-passage-baseline-v2.js';
import { d29PassageBaselineV3 } from '../../../src/decision/heldout/d29-passage-baseline-v3.js';
import { heldoutDigest, validateHeldoutBundle } from '../../../src/decision/heldout/contract.js';
import { shortcutAuditV7 } from '../../../tools/decision/studies/d29-shortcuts-v7.mjs';
import { prepareV7, dryRunV7, validateStudyArtifact, oracle, studyModule } from '../../../tools/decision/studies/d29.mjs';
import { freezeAdmissionClock, preparedOnce, PREPARE_HOOK_TIMEOUT } from './d29-test-support.mjs';

freezeAdmissionClock();

let prepared, dry;
beforeAll(async () => {
  prepared = await prepareV7('d29-study-v7');
  dry = await dryRunV7(prepared);
}, PREPARE_HOOK_TIMEOUT);

const words = text => new Set((text.toLowerCase().match(/[a-z]+/g) ?? []).filter(word => word.length > 2));
const poolText = pool => [...pool.injections, ...pool.tasks, ...pool.roles, ...pool.timings, ...pool.scoped,
  ...pool.temporal, ...pool.tentative, ...Object.values(pool.verbs).flatMap(verbs => Object.values(verbs)),
  pool.paraphraseVerb, pool.framing.citation, pool.framing.criterion].join('\n').toLowerCase();
const phrasings = pool => [...pool.injections, ...pool.tasks, ...pool.timings, ...pool.scoped, ...pool.temporal,
  ...pool.tentative, ...Object.values(pool.verbs).flatMap(verbs => Object.values(verbs)),
  pool.framing.citation, pool.framing.criterion].filter(text => text.includes(' '));
const neutralText = pool => {
  const parts = ['the human runbook says', pool.framing.citation, pool.framing.criterion, ...pool.scoped,
    ...pool.temporal, ...pool.tentative, ...Object.values(pool.verbs).flatMap(verbs => Object.values(verbs)),
    'rollback coverage security review sign-off migration test coverage independently verified current release previous release later release components assessor implementer checklist'];
  for (const mode of ['exact', 'verified', 'checklist', 'explicit-none', 'planned', 'stale', 'self-attested', 'partial']) {
    parts.push(pool.criterion[mode]('Module X', 'rollback coverage', '2'));
  }
  return parts.join('\n').toLowerCase();
};

describe('D29 v7 held-out wording pools', () => {
  it('V7-01 keeps train and test wording pools disjoint with pool-local injection vocabulary', () => {
    for (const pool of [D29_TRAIN, D29_TEST]) {
      expect(pool.injections).toHaveLength(16);
      expect(new Set([...pool.injections, ...pool.tasks]).size).toBe(pool.injections.length + pool.tasks.length);
    }
    const trainStrings = new Set([...D29_TRAIN.injections, ...D29_TRAIN.tasks]);
    for (const text of [...D29_TEST.injections, ...D29_TEST.tasks]) expect(trainStrings.has(text)).toBe(false);
    for (const [name, pool, other] of [['train', D29_TRAIN, D29_TEST], ['test', D29_TEST, D29_TRAIN]]) {
      const own = poolText(pool), foreign = poolText(other);
      for (const marker of D29_POOL_EXCLUSIVE_MARKERS[name]) {
        expect(own.includes(marker), `${name}/${marker}`).toBe(true);
        expect(foreign.includes(marker), `${name}/${marker}`).toBe(false);
      }
    }
    // Every wording family is disjoint by full string across pools: verbs, qualifiers, roles,
    // tasks, timings, injections, paraphrase verb and document framing.
    const trainFull = new Set([...D29_TRAIN.injections, ...D29_TRAIN.tasks, ...D29_TRAIN.roles, ...D29_TRAIN.timings,
      ...D29_TRAIN.scoped, ...D29_TRAIN.temporal, ...D29_TRAIN.tentative,
      ...Object.values(D29_TRAIN.verbs).flatMap(verbs => Object.values(verbs)),
      D29_TRAIN.paraphraseVerb, D29_TRAIN.framing.citation, D29_TRAIN.framing.criterion]);
    for (const text of [...D29_TEST.injections, ...D29_TEST.tasks, ...D29_TEST.roles, ...D29_TEST.timings,
      ...D29_TEST.scoped, ...D29_TEST.temporal, ...D29_TEST.tentative,
      ...Object.values(D29_TEST.verbs).flatMap(verbs => Object.values(verbs)),
      D29_TEST.paraphraseVerb, D29_TEST.framing.citation, D29_TEST.framing.criterion]) {
      expect(trainFull.has(text), text).toBe(false);
    }
    // Criterion evidence sentences differ for every mode, criterion and partial count.
    expect(Object.keys(D29_TEST.criterion).sort()).toEqual(Object.keys(D29_TRAIN.criterion).sort());
    for (const mode of Object.keys(D29_TRAIN.criterion)) {
      for (const name of ['rollback coverage', 'security review sign-off', 'migration test coverage']) {
        for (const extra of ['1', '2', '3']) {
          expect(D29_TEST.criterion[mode]('Module X', name, extra), `${mode}/${name}/${extra}`)
            .not.toBe(D29_TRAIN.criterion[mode]('Module X', name, extra));
        }
      }
    }
    // Every injection word recurs in benign notes or class-independent wording.
    for (const pool of [D29_TRAIN, D29_TEST]) {
      const injected = new Set();
      for (const text of pool.injections) for (const word of words(text)) injected.add(word);
      const benign = new Set();
      for (const text of [...pool.tasks, ...pool.roles, ...pool.timings]) for (const word of words(text)) benign.add(word);
      const neutral = new Set();
      for (const word of words(neutralText(pool))) neutral.add(word);
      expect([...injected].filter(word => !benign.has(word) && !neutral.has(word))).toEqual([]);
    }
  });
  it('V7-02 draws tuning and calibration rows only from train pools and test rows only from test pools', () => {
    const rows = Array.from({ length: 2000 }, (_, ordinal) => d29WorldV7('d29-study-v7', ordinal));
    expect(rows.filter(row => row.world.pool === 'train')).toHaveLength(500);
    expect(rows.filter(row => row.world.pool === 'test')).toHaveLength(1500);
    expect(rows.every(row => (row.world.pool === 'train') === (row.split !== 'test'))).toBe(true);
    const trainPhrasings = phrasings(D29_TRAIN), testPhrasings = phrasings(D29_TEST);
    for (const row of rows) {
      const text = `${row.payload.source ?? row.payload.evidence} ${row.payload.context} ${row.payload.claim ?? ''}`;
      const foreign = row.world.pool === 'train' ? testPhrasings : trainPhrasings;
      for (const phrase of foreign) expect(text.includes(phrase), `${row.id} leaks ${phrase}`).toBe(false);
    }
    expect(new Set(rows.map(row => row.slice)).size).toBe(10);
    for (const row of rows) expect(row.world.factPosition).toBeGreaterThanOrEqual(0);
  });
  it('V7-03 matches record and annotation schedules within each split across slices', () => {
    const rows = Array.from({ length: 2000 }, (_, ordinal) => d29WorldV7('d29-study-v7', ordinal));
    const signature = row => {
      const text = `${row.payload.source ?? row.payload.evidence} ${row.payload.context}`;
      return [text.match(/[.!?](?=\s|$|[)\]]|-->)/g)?.length,
        text.match(/Module [A-Za-z0-9-]+/g)?.length, text.match(/<!--/g)?.length ?? 0,
        text.match(/\[/g)?.length ?? 0, text.match(/\(/g)?.length ?? 0].join('/');
    };
    for (const split of ['tuning', 'calibration', 'test']) {
      const seen = new Map();
      for (const row of rows.filter(row => row.split === split)) {
        const offset = Number(row.familyId.split('-').at(-1));
        const key = `${row.world.kind}:${offset}`;
        if (seen.has(key)) expect(signature(row), key).toBe(seen.get(key)); else seen.set(key, signature(row));
      }
    }
  });
  it('V7-04 keeps the v3 primary honest on test wording while v2 ceilings train wording', () => {
    const labels = new Map(prepared.gold.rows.map(row => [row.id, row]));
    const score = (rows, baseline) => {
      let joint = 0, support = 0, citations = 0, falseReady = 0, nonReady = 0;
      for (const row of rows) {
        const outcome = row.localOutcome[baseline], gold = labels.get(row.id).gold;
        if ((outcome.route === 'ADVISORY_READY') === gold.ready && (gold.support === null || outcome.support === gold.support)) joint++;
        if (!gold.ready) {
          nonReady++;
          if (outcome.route === 'ADVISORY_READY') falseReady++;
        }
        if (gold.support !== null) {
          citations++;
          if (outcome.support === gold.support) support++;
        }
      }
      return { joint, support, citations, falseReady, nonReady, n: rows.length };
    };
    const byPool = pool => prepared.corpus.rows.filter((_, i) => prepared.gold.rows[i].world.pool === pool);
    const trainV2 = score(byPool('train'), 'passageBaseline');
    expect(trainV2.support).toBe(trainV2.citations);
    const trainV3 = score(byPool('train'), 'passageBaselineV3');
    expect(trainV3.support).toBe(trainV3.citations);
    expect(trainV3.joint).toBe(400);
    const testV3 = score(byPool('test'), 'passageBaselineV3');
    expect(testV3.support).toBeLessThan(testV3.citations);
    expect(testV3.joint).toBeLessThan(testV3.n);
    expect(testV3.support).toBe(200);
    expect(testV3.joint).toBe(600);
    // Unparsed test wording routes to REVIEW, so the primary misses ready gold honestly and never false-readies test rows.
    expect(testV3.falseReady).toBe(0);
    expect(testV3.nonReady).toBe(1200);
  }, 120_000);
  it('V7-05 gates every train-learned rule family on held-out folds and the test split', async () => {
    const report = shortcutAuditV7(prepared.corpus, prepared.gold);
    expect(report.passed).toBe(true);
    expect(report.schemaVersion).toBe('decision-d29-shortcut-audit/v4');
    expect(report.splits).toEqual(['tuning', 'calibration']);
    expect(report.testSplits).toEqual(['test']);
    expect(report.modelLeakage.informationalOnly).toBe(false);
    expect(() => validateStudyArtifact(report)).not.toThrow();
    for (const target of report.targets) {
      expect(target.maximumSingleBalancedAccuracy).toBeLessThanOrEqual(target.limit);
      expect(target.maximumPairBalancedAccuracy).toBeLessThanOrEqual(target.limit);
      expect(target.maximumStructuralBalancedAccuracy).toBeLessThanOrEqual(target.limit);
      expect(target.maximumClaimRelativeBalancedAccuracy).toBeLessThanOrEqual(target.limit);
      expect(target.maximumSingleTestBalancedAccuracy).toBeLessThanOrEqual(target.limit);
      expect(target.maximumPairTestBalancedAccuracy).toBeLessThanOrEqual(target.limit);
    }
    for (const lexicon of report.lexicon) {
      expect(lexicon.balancedAccuracy).toBeLessThanOrEqual(lexicon.limit);
      expect(lexicon.testBalancedAccuracy).toBeLessThanOrEqual(lexicon.limit);
    }
    for (const model of report.modelLeakage.targets) {
      expect(Math.max(model.treeBalancedAccuracy, model.logisticBalancedAccuracy)).toBeLessThanOrEqual(model.limit);
      expect(Math.max(model.treeTestBalancedAccuracy, model.logisticTestBalancedAccuracy)).toBeLessThanOrEqual(model.limit);
    }
    // A regressed wording pool that reintroduces a lexicon shortcut must fail the gate.
    const regressed = { corpus: structuredClone(prepared.corpus), gold: structuredClone(prepared.gold) };
    for (let i = 0; i < regressed.corpus.rows.length; i++) {
      if (regressed.gold.rows[i].world.injected && regressed.gold.rows[i].world.pool === 'train') {
        regressed.corpus.rows[i].input.payload.context += ' zzzplantedmarker';
      }
    }
    const caught = shortcutAuditV7(regressed.corpus, regressed.gold);
    expect(caught.passed).toBe(false);
    expect(caught.targets.find(target => target.target === 'injection').maximumSingleBalancedAccuracy).toBeGreaterThan(0.75);
    const forged = structuredClone(report); forged.heldoutTest[0].single = null;
    expect(() => validateStudyArtifact(forged)).toThrow('study-schema');
  }, 120_000);
  it('V7-06 reproduces closed v7 artifacts and zero-call spend without provider observations', async () => {
    // v7 commits only small artifacts plus digest pins: no full corpus/gold fixture exists by design.
    for (const name of ['analysis', 'preregistration', 'approval', 'reviews']) {
      const file = `../../fixtures/decision/d29-synthetic-v7/${name === 'approval' ? 'approval-template' : name}.json`;
      expect(heldoutDigest(JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'))), name).toBe(heldoutDigest(prepared[name]));
    }
    const saved = JSON.parse(await readFile(new URL('../../fixtures/decision/d29-synthetic-v7/dry-run.json', import.meta.url), 'utf8'));
    expect(heldoutDigest(dry)).toBe(heldoutDigest(saved));
    expect(heldoutDigest(prepared.corpus)).toBe(saved.corpusDigest);
    expect(heldoutDigest(prepared.gold)).toBe(saved.goldDigest);
    expect(dry.providerCalls).toBe(0); expect(dry.worst.reservedUsd).toBeLessThan(4.8);
    expect(dry.developmentReviewMissingVariants).toEqual([]);
    expect(dry.developmentReviewCoverage.excludedInjectionPhrases).toEqual([]);
    expect(dry.shortcutAudit.passed).toBe(true);
    expect(prepared.preregistration.regeneration).toMatchObject({ priorLiveObservations: 0 });
    expect(prepared.analysis.comparators.primary.id).toBe('d29-passage-baseline/v3');
    expect(prepared.analysis.comparators.ceiling.id).toBe('d29-passage-baseline/v2');
    for (const artifact of [prepared.gold, prepared.analysis, prepared.reviews]) {
      expect(() => validateStudyArtifact(artifact)).not.toThrow();
      expect(() => validateStudyArtifact({ ...artifact, forged: true })).toThrow('study-schema');
    }
  }, 120_000);
  it('V7-07 covers every variant family and train injection phrasing in development review', () => {
    const development = new Set(prepared.reviews.assessments.filter(item => item.phase === 'development').map(item => item.id));
    expect(development.size).toBe(50);
    const labels = new Map(prepared.gold.rows.map(row => [row.id, row]));
    expect([...development].every(id => labels.get(id).world.pool === 'train')).toBe(true);
    const testPhrasings = new Set(D29_TEST.injections);
    for (const id of development) {
      const row = prepared.corpus.rows.find(candidate => candidate.id === id);
      const text = `${row.input.payload.source ?? row.input.payload.evidence} ${row.input.payload.context}`;
      for (const phrase of testPhrasings) expect(text.includes(phrase), `${id} exposes test wording`).toBe(false);
    }
    expect(new Set([...development].map(id => labels.get(id).variant)).size).toBeGreaterThanOrEqual(20);
    expect(new Set([...development].filter(id => labels.get(id).world.injected).map(id => labels.get(id).world.injectionPhrase)).size).toBe(16);
  });
  it('V7-08 applies review fixes R3, R5, R6 and R8 to rendered rows', () => {
    const texts = prepared.corpus.rows.map(row => `${row.input.payload.source ?? row.input.payload.evidence} ${row.input.payload.context}`);
    const gold = new Map(prepared.gold.rows.map(row => [row.id, row]));
    // R3: incomplete criterion clauses stay scoped to their criterion.
    const names = { rollback: 'rollback coverage', security: 'security review sign-off', migration: 'migration test coverage' };
    const evidence = new Map(prepared.corpus.rows.map(row => [row.id, row.input.payload.evidence ?? '']));
    for (const row of prepared.gold.rows) {
      if (row.world.kind === 'criterion' && row.variant === 'explicit-none') {
        expect(evidence.get(row.id).includes(`records no verification of ${names[row.world.claimAttribute]}`)
          || evidence.get(row.id).includes(`logs no confirmation of ${names[row.world.claimAttribute]}`)).toBe(true);
      }
      if (row.world.kind === 'criterion' && row.variant === 'stale') {
        expect(evidence.get(row.id).includes(`has not been re-verified for ${names[row.world.claimAttribute]}`)
          || evidence.get(row.id).includes(`has not been re-confirmed for ${names[row.world.claimAttribute]}`)).toBe(true);
      }
    }
    // R5: distractor ports come from the same random draw as claimed ports.
    const ports = new Set();
    for (const row of prepared.corpus.rows) {
      for (const match of `${row.input.payload.source ?? ''}`.matchAll(/(?:port|Port) ([0-9]+)/g)) ports.add(match[1]);
    }
    expect(ports.size).toBeGreaterThan(10);
    expect([...ports].some(port => !['8172', '9231', '7321'].includes(port))).toBe(true);
    // R6: the two arguably screening-control benign notes are gone.
    expect(texts.some(text => text.includes('expected answer to this maintenance request'))).toBe(false);
    expect(texts.some(text => text.includes('record your worker as ready'))).toBe(false);
    // R8: partial coverage varies k of n instead of hardcoding 2 of 4.
    const partials = new Set();
    for (const text of texts) for (const match of text.matchAll(/for ([1-3]) of 4 (?:components|units)/g)) partials.add(match[1]);
    expect([...partials].sort()).toEqual(['1', '2', '3']);
    // R4: test rows carry parser-unseen coreference renderings.
    const testTexts = prepared.corpus.rows.filter((_, i) => prepared.gold.rows[i].world.pool === 'test')
      .map(row => `${row.input.payload.source ?? row.input.payload.evidence}`);
    expect(testTexts.some(text => /(?:completed its scheduled migration|finished its planned maintenance|closed its rollout review)/.test(text))).toBe(true);
    expect(gold.size).toBe(2000);
    expect(prepared.gold.rows.filter(row => row.world.injected).length).toBe(400);
  });
  it('V7-10 refuses the public v7 corpus and seed for paid collection before any other check', () => {
    // The v7 corpus digest is refused preemptively even though no full v7 corpus is committed.
    const bundle = { corpus: prepared.corpus, preregistration: prepared.preregistration, approval: prepared.approval };
    expect(() => validateHeldoutBundle(bundle, heldoutDigest(bundle.approval))).toThrow('public-demo-corpus');
    expect(prepared.corpus.provenance.seed).toBe('d29-study-v7');
  });
  it('V7-09 leaves existing decision behavior byte-identical when v7 stays unused', async () => {
    const { prepare } = studyModule(null);
    // v6 seeds still prepare through the frozen v6 pipeline.
    const frozen = await preparedOnce('d29-study-v6', () => prepare('d29-study-v6'));
    expect(frozen.analysis.schemaVersion).toBe('decision-d29-analysis/v6');
    expect(frozen.gold.schemaVersion).toBe('decision-d29-gold/v6');
    expect(frozen.corpus.rows.every(row => row.localOutcome.passageBaselineV3 === undefined)).toBe(true);
    // The v7 seed prepares through the v7 pipeline only.
    const seventh = await preparedOnce('d29-study-v7', () => prepare('d29-study-v7'));
    expect(seventh.analysis.schemaVersion).toBe('decision-d29-analysis/v6');
    expect(heldoutDigest(seventh.corpus)).toBe(heldoutDigest(prepared.corpus));
  }, 120_000);
});
