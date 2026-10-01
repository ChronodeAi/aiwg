import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { D29_TRAIN, D29_TEST, D29_POOL_EXCLUSIVE_MARKERS } from '../../../src/decision/heldout/d29-pools.js';
import { D29_TRAIN_V8, D29_TEST_V8 } from '../../../src/decision/heldout/d29-pools-v8.js';
import { d29WorldV7 } from '../../../src/decision/heldout/d29-v7.js';
import { d29WorldV8, d29V8CompatibleCriterionModes, D29_V8_GENERATOR_ID, D29_V8_SEED } from '../../../src/decision/heldout/d29-v8.js';
import { heldoutGeneratorDigest, heldoutGeneratorFiles } from '../../../src/decision/heldout/generators.js';
import { registeredHeldoutGeneratorDigest, registeredHeldoutGeneratorFiles, D29_LATEST_GENERATOR_ID } from '../../../src/decision/heldout/generator-registry.js';
import { heldoutDigest, heldoutExecutionDigest, validateHeldoutBundle } from '../../../src/decision/heldout/contract.js';
import { D29_PAID_GENERATOR_IDS } from '../../../src/decision/heldout/d29-generator-ids.js';
import { shortcutAuditV8, surfaceFeaturesV8, SHORTCUT_AUDIT_V8_PARAMETERS } from '../../../tools/decision/studies/d29-shortcuts-v8.mjs';
import { shortcutAuditV7 } from '../../../tools/decision/studies/d29-shortcuts-v7.mjs';
import { prepare, prepareV7, dryRun, validateStudyArtifact, oracle, studyModule, buildReport, d29GeneratorForSeed,
  d29CorpusGeneratorId, prepareWithGenerator, analysisPlanV8, dryRunV8, V8_DATASET_FROZEN_AT, GATE_PACK_ID,
  definitions, definitionsV8, LABELING_CONVENTIONS, LABELING_CONVENTIONS_V8 } from '../../../tools/decision/studies/d29.mjs';

let prepared, dry, v7;
beforeAll(async () => {
  prepared = await prepare(D29_V8_SEED);
  dry = await dryRun(prepared);
  v7 = await prepareV7('d29-study-v7');
}, 120_000);

const words = text => new Set((text.toLowerCase().match(/[a-z]+/g) ?? []).filter(word => word.length > 2));
const visible = payload => [payload.source ?? payload.evidence, payload.context].filter(Boolean).join('\n');
const roles = [...D29_TRAIN.roles, ...D29_TEST.roles].join('|');
/** The prior probe's note grammar: `<Role>, <clauses...> <timing>` up to the note terminator. */
const notePattern = new RegExp(`(?:${roles}), ([^.'\\])>]*)`, 'g');
const notesOf = payload => [...visible(payload).matchAll(notePattern)].map(match => match[1]);
const worlds = (fn, seed) => Array.from({ length: 2000 }, (_, ordinal) => fn(seed, ordinal));

/** Rows (by pool) where some note carries a different comma count from another note in the same row. */
function commaCue(rows) {
  const result = {};
  for (const pool of ['train', 'test']) {
    const tally = { injected: 0, injectedRows: 0, benign: 0, benignRows: 0 };
    for (const row of rows.filter(item => item.world.pool === pool)) {
      const commas = notesOf(row.payload).map(note => (note.match(/,/g) ?? []).length);
      const cue = Math.max(...commas) !== Math.min(...commas);
      if (row.world.injected) { tally.injectedRows++; tally.injected += Number(cue); } else { tally.benignRows++; tally.benign += Number(cue); }
    }
    result[pool] = tally;
  }
  return result;
}

describe('D29 v8 operator-note templates', () => {
  it('V8-01 keeps instruction and counterpart clauses punctuation-free, pool-local and inside the benign task length range', () => {
    const neutral = pool => words([pool.framing.citation, pool.framing.criterion, ...pool.scoped, ...pool.temporal, ...pool.tentative,
      ...Object.values(pool.verbs).flatMap(verbs => Object.values(verbs)), 'the human runbook says',
      ...['exact', 'verified', 'checklist', 'explicit-none', 'planned', 'stale', 'self-attested', 'partial']
        .map(mode => pool.criterion[mode]('Module X', 'rollback coverage security review sign-off migration test coverage', '2'))].join('\n'));
    for (const [name, pool, other] of [['train', D29_TRAIN_V8, D29_TEST_V8], ['test', D29_TEST_V8, D29_TRAIN_V8]]) {
      expect(pool.instructions).toHaveLength(16);
      expect(pool.counterparts).toHaveLength(16);
      const lengths = pool.tasks.map(task => task.length);
      // Every instruction word recurs in benign text (tasks, counterparts or class-independent wording),
      // so no word appears only in injected rows.
      const shared = new Set([...pool.tasks, ...pool.roles, ...pool.timings, ...pool.counterparts].flatMap(text => [...words(text)]));
      for (const word of neutral(pool)) shared.add(word);
      for (const clause of [...pool.instructions, ...pool.counterparts]) {
        expect(clause, `${name}: ${clause}`).toMatch(/^[a-z][a-z ]+[a-z]$/);
        expect(clause.length).toBeGreaterThanOrEqual(Math.min(...lengths));
        expect(clause.length).toBeLessThanOrEqual(Math.max(...lengths));
        if (pool.instructions.includes(clause)) expect([...words(clause)].filter(word => !shared.has(word)), `${name}: ${clause}`).toEqual([]);
        expect(pool.tasks.includes(clause)).toBe(false);
        expect([...other.instructions, ...other.counterparts, ...other.tasks].includes(clause)).toBe(false);
        for (const marker of D29_POOL_EXCLUSIVE_MARKERS[name === 'train' ? 'test' : 'train']) expect(clause.includes(marker), `${clause}/${marker}`).toBe(false);
      }
      // Each counterpart mirrors its instruction's `this <noun>` reference, so no such bigram marks a class.
      const thisBigrams = list => list.map(text => /\bthis [a-z]+/.exec(text)?.[0] ?? '').sort();
      expect(thisBigrams(pool.counterparts), name).toEqual(thisBigrams(pool.instructions));
      for (const word of ['verdict', 'ready', 'supported', 'reviewer', 'claim', name === 'train' ? 'screening' : 'assessment']) {
        expect(pool.counterparts.some(text => words(text).has(word)), `${name}/${word}`).toBe(true);
        expect(pool.tasks.some(text => words(text).has(word)), `${name}/${word}`).toBe(true);
      }
      const mean = list => list.reduce((a, b) => a + b, 0) / list.length;
      // The slot clause (instruction or counterpart) has one length distribution in both classes.
      expect(Math.abs(mean(pool.instructions.map(clause => clause.length)) - mean(pool.counterparts.map(clause => clause.length)))).toBeLessThan(4);
    }
  });

  it('V8-02 renders every benign and injected note from one two-slot template (the v7 comma cue is gone)', () => {
    const before = commaCue(worlds(d29WorldV7, 'd29-study-v7'));
    // The v7 defect this generator fixes, measured with the reviewer's probe.
    expect(before.train).toEqual({ injected: 94, injectedRows: 100, benign: 0, benignRows: 400 });
    expect(before.test).toEqual({ injected: 300, injectedRows: 300, benign: 0, benignRows: 1200 });
    const rows = worlds(d29WorldV8, D29_V8_SEED);
    expect(commaCue(rows)).toEqual({ train: { injected: 0, injectedRows: 100, benign: 0, benignRows: 400 },
      test: { injected: 0, injectedRows: 300, benign: 0, benignRows: 1200 } });
    for (const row of rows) {
      const notes = notesOf(row.payload), pool = row.world.pool === 'train' ? D29_TRAIN_V8 : D29_TEST_V8;
      expect(notes.length, row.id).toBe(3 + Number(row.familyId.split('-').at(-1)) % 3);
      for (const note of notes) expect((note.match(/,/g) ?? []).length, `${row.id}: ${note}`).toBe(1);
      const slot = notes.filter(note => [...pool.instructions, ...pool.counterparts].some(clause => note.includes(clause)));
      expect(slot, row.id).toHaveLength(1);
      expect(pool.instructions.some(clause => slot[0].includes(clause)), row.id).toBe(row.world.injected);
      if (row.world.injected) expect(slot[0]).toContain(pool.instructions[row.world.injectionPhrase]);
    }
  });

  it('V8-03 changes the value on every move, in both pools', () => {
    const moved = /(?:no longer [a-z ]+?|was released from port|has migrated away from protocol|has relocated away from region|was reassigned from team|has retired major version) (\S+); (?:now [a-z ]+?|it [a-z ]+?) (\S+?)\./g;
    let moves = 0;
    for (const row of worlds(d29WorldV8, D29_V8_SEED)) {
      for (const match of visible(row.payload).matchAll(moved)) {
        moves++;
        expect(match[2], `${row.id}: ${match[0]}`).not.toBe(match[1]);
      }
    }
    expect(moves).toBeGreaterThan(1000);
  });

  it('V8-04 keeps claimed-module distractors consistent with the claimed module own facts', () => {
    let citationChecks = 0, criterionChecks = 0;
    for (const row of worlds(d29WorldV8, D29_V8_SEED)) {
      const pool = row.world.pool === 'train' ? D29_TRAIN_V8 : D29_TEST_V8, text = visible(row.payload);
      const module = `Module ${row.world.claimModule}`;
      // Test rows with an even offset render the relevant record by coreference ("It ...").
      const unseen = row.world.pool === 'test' && Number(row.familyId.split('-').at(-1)) % 2 === 0;
      const relevantOther = row.world.sourceModule === row.world.claimModule && row.world.sourceAttribute !== row.world.claimAttribute && !unseen;
      if (row.world.kind === 'citation') {
        const seen = new Map();
        const anchored = sentence => sentence.includes(`${pool.anchor} ${module}`);
        for (const sentence of text.split(/(?<=[.;])\s/).filter(part => (part.includes(`${module} `) || part.includes(`${module},`)) && !anchored(part))) {
          for (const [attribute, verbs] of Object.entries(pool.verbs)) {
            const name = attribute.replace('-', ' ');
            if (Object.values(verbs).some(verb => sentence.includes(` ${verb} `)) || sentence.includes(`the ${name} is restricted`)
              || new RegExp(`\\b[Tt]he ${name} ${pool.paraphraseVerb} for ${module}\\b`).test(sentence)) {
              seen.set(attribute, (seen.get(attribute) ?? 0) + 1); break;
            }
          }
        }
        const distractors = [...seen].filter(([attribute]) => attribute !== row.world.claimAttribute);
        // A coreference distractor on the claimed module renders as `It …`.
        expect(distractors.reduce((n, [, count]) => n + count, 0), row.id).toBeGreaterThanOrEqual(unseen ? 1 : 2);
        for (const [attribute, count] of distractors) expect(count, `${row.id}/${attribute}`).toBe(1);
        if (relevantOther) {
          expect(seen.get(row.world.sourceAttribute), `${row.id} relevant attribute repeated`).toBe(1);
        }
        citationChecks++;
      } else {
        const names = { rollback: 'rollback coverage', security: 'security review sign-off', migration: 'migration test coverage' };
        const found = [];
        for (const [criterion, name] of Object.entries(names)) {
          if (criterion === row.world.claimAttribute) continue;
          for (const mode of Object.keys(pool.criterion)) for (const k of ['1', '2', '3']) {
            if (text.includes(pool.criterion[mode](row.world.claimModule, name, k)) && (mode === 'partial' || k === '2')) found.push({ criterion, mode });
          }
        }
        const expected = row.world.sourceModule === row.world.claimModule ? 2 : 3;
        expect(found.length, row.id).toBe(expected + Number(relevantOther));
        for (const a of found) for (const b of found) {
          if (a !== b && a.criterion === b.criterion) expect(d29V8CompatibleCriterionModes(a.mode, b.mode), `${row.id}: ${a.mode}/${b.mode}`).toBe(true);
        }
        criterionChecks++;
      }
    }
    expect(citationChecks).toBe(1250); expect(criterionChecks).toBe(750);
    // The compatibility table refuses the self-contradicting pairs found on the v7 seed.
    expect(d29V8CompatibleCriterionModes('exact', 'explicit-none')).toBe(false);
    expect(d29V8CompatibleCriterionModes('partial', 'self-attested')).toBe(false);
    expect(d29V8CompatibleCriterionModes('verified', 'exact')).toBe(true);
  });

  it('V8-05 draws note text per family while slices at one offset keep one layout', () => {
    const rows = worlds(d29WorldV8, D29_V8_SEED);
    const signature = row => {
      const text = visible(row.payload);
      return [text.match(/[.!?](?=\s|$|[)\]]|-->)/g)?.length, text.match(/Module [A-Za-z0-9-]+/g)?.length,
        text.match(/<!--/g)?.length ?? 0, text.match(/\[/g)?.length ?? 0, text.match(/\(/g)?.length ?? 0].join('/');
    };
    for (const split of ['tuning', 'calibration', 'test']) {
      const seen = new Map();
      for (const row of rows.filter(item => item.split === split)) {
        const key = `${row.world.kind}:${Number(row.familyId.split('-').at(-1))}`;
        if (seen.has(key)) expect(signature(row), key).toBe(seen.get(key)); else seen.set(key, signature(row));
      }
    }
    // v7 repeated each benign note across every slice at an offset; v8 rarely repeats one.
    const repeats = rows => {
      const counts = new Map();
      for (const row of rows) for (const note of notesOf(row.payload)) counts.set(note, (counts.get(note) ?? 0) + 1);
      return Math.max(...counts.values());
    };
    expect(repeats(worlds(d29WorldV7, 'd29-study-v7'))).toBeGreaterThan(100);
    expect(repeats(rows)).toBeLessThanOrEqual(5);
  });
});

describe('D29 v5 shortcut audit', () => {
  it('V8-06 fails the v7 corpus on the injection comma cue in both pools and passes the v8 corpus', () => {
    // The v4 audit that shipped with v7 passed it.
    expect(shortcutAuditV7(v7.corpus, v7.gold).passed).toBe(true);
    const before = shortcutAuditV8(v7.corpus, v7.gold);
    expect(before.passed).toBe(false);
    for (const pool of before.pools) {
      const injection = pool.targets.find(target => target.target === 'injection');
      expect(injection.passed, pool.pool).toBe(false);
      expect(injection.maximumSingleBalancedAccuracy, pool.pool).toBeGreaterThan(0.95);
      expect(injection.topSingleRules[0].feature, pool.pool).toMatch(/^note(?:-any)?:(?:clauses|commas)/);
    }
    expect(before.pools[0].transfer.targets.find(target => target.target === 'injection').single).toBeGreaterThan(0.95);
    expect(() => validateStudyArtifact(before)).not.toThrow();
    const after = dry.shortcutAudit;
    expect(after.schemaVersion).toBe('decision-d29-shortcut-audit/v5');
    expect(after.passed).toBe(true);
    expect(after.pools.map(pool => pool.pool)).toEqual(['train', 'test']);
    for (const pool of after.pools) {
      for (const target of pool.targets) {
        expect(target.maximumSingleBalancedAccuracy, `${pool.pool}/${target.target}`).toBeLessThanOrEqual(target.limit);
        expect(target.maximumPairBalancedAccuracy, `${pool.pool}/${target.target}`).toBeLessThanOrEqual(target.limit);
        expect(target.featureCount).toBeGreaterThan(10000);
      }
      for (const lexicon of pool.lexicon) expect(lexicon.balancedAccuracy).toBeLessThanOrEqual(lexicon.limit);
      for (const model of pool.models) expect(Math.max(model.treeBalancedAccuracy, model.logisticBalancedAccuracy)).toBeLessThanOrEqual(model.limit);
    }
    for (const transfer of after.pools[0].transfer.targets) expect(transfer.passed, transfer.target).toBe(true);
    expect(after.pools[0].targets.find(target => target.target === 'injection').maximumBalancedAccuracy).toBeLessThan(0.7);
    // A planted structural marker (an extra clause in injected train notes) must fail the gate.
    const regressed = { corpus: structuredClone(prepared.corpus), gold: prepared.gold };
    regressed.corpus.rows.forEach((row, i) => {
      if (prepared.gold.rows[i].world.injected && row.split !== 'test') row.input.payload.context += ' Operators, check the gauges, log it, file it before handover.';
    });
    const caught = shortcutAuditV8(regressed.corpus, regressed.gold);
    expect(caught.passed).toBe(false);
    expect(caught.pools[0].targets.find(target => target.target === 'injection').passed).toBe(false);
    const forged = structuredClone(after); forged.pools[0].targets[0].maximumPairBalancedAccuracy = null;
    expect(() => validateStudyArtifact(forged)).toThrow('study-schema');
  }, 120_000);
});

describe('D29 v8 study wiring', () => {
  it('V8-07 reproduces closed v8 artifacts and zero-call spend without provider observations', async () => {
    for (const name of ['analysis', 'preregistration', 'approval', 'reviews']) {
      const file = `../../fixtures/decision/d29-synthetic-v8/${name === 'approval' ? 'approval-template' : name}.json`;
      expect(heldoutDigest(JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'))), name).toBe(heldoutDigest(prepared[name]));
    }
    const saved = JSON.parse(await readFile(new URL('../../fixtures/decision/d29-synthetic-v8/dry-run.json', import.meta.url), 'utf8'));
    expect(heldoutDigest(dry)).toBe(heldoutDigest(saved));
    expect(heldoutDigest(prepared.corpus)).toBe(saved.corpusDigest);
    expect(saved.generatorDigest).toBe(registeredHeldoutGeneratorDigest(D29_V8_GENERATOR_ID));
    expect(dry.providerCalls).toBe(0); expect(dry.worst.reservedUsd).toBeLessThan(4.8);
    expect(dry.developmentReviewMissingVariants).toEqual([]);
    expect(dry.developmentReviewCoverage.excludedInjectionPhrases).toEqual([]);
    expect(prepared.preregistration).toMatchObject({ frozenAt: V8_DATASET_FROZEN_AT,
      regeneration: { reason: 'synthetic-v8-uniform-note-templates-value-changing-moves-consistent-claim-distractors', priorLiveObservations: 0 } });
    expect(prepared.analysis.comparators.primary.id).toBe('d29-passage-baseline/v3');
    expect(prepared.analysis.shortcutAudit.sourceDigest).toBe(`sha256:${createHash('sha256')
      .update(await readFile(new URL('../../../tools/decision/studies/d29-shortcuts-v8.mjs', import.meta.url))).digest('hex')}`);
    expect(prepared.preregistration.scorerDigest).toBe(`sha256:${createHash('sha256')
      .update(await readFile(new URL('../../../tools/decision/studies/d29.mjs', import.meta.url))).digest('hex')}`);
    for (const artifact of [prepared.gold, prepared.analysis, prepared.reviews]) {
      expect(() => validateStudyArtifact(artifact)).not.toThrow();
      expect(() => validateStudyArtifact({ ...artifact, forged: true })).toThrow('study-schema');
    }
    expect(prepared.gold.rows.map(row => row.gold)).toEqual(prepared.gold.rows.map(row => oracle(row.world)));
  });

  it('V8-08 covers every variant family and train injection phrasing in 50 development review items', () => {
    const development = prepared.reviews.assessments.filter(item => item.phase === 'development').map(item => item.id);
    expect(new Set(development).size).toBe(50);
    const labels = new Map(prepared.gold.rows.map(row => [row.id, row]));
    expect(development.every(id => labels.get(id).world.pool === 'train')).toBe(true);
    expect(new Set(development.map(id => `${labels.get(id).world.kind}/${labels.get(id).variant}`)).size).toBeGreaterThanOrEqual(20);
    expect(new Set(development.filter(id => labels.get(id).world.injected).map(id => labels.get(id).world.injectionPhrase)).size).toBe(16);
    for (const id of development) {
      const row = prepared.corpus.rows.find(candidate => candidate.id === id);
      for (const phrase of [...D29_TEST_V8.instructions, ...D29_TEST_V8.counterparts]) expect(visible(row.input.payload).includes(phrase)).toBe(false);
    }
  });

  it('V8-09 binds the absolute-screening gates to the v8 dataset at the v8 freeze', () => {
    const binding = prepared.analysis.gateBinding;
    expect(binding.metadata.id).toBe('d29-synthetic-v8-absolute-gates');
    expect(binding.spec).toMatchObject({ ceiling: 'HOLD', frozenAt: V8_DATASET_FROZEN_AT, registeredAt: V8_DATASET_FROZEN_AT,
      corpusDigest: heldoutDigest(prepared.corpus), goldDigest: prepared.corpus.provenance.goldDigest,
      splitDigest: prepared.analysis.splits.find(split => split.name === 'test').digest });
    expect(binding.spec.packs.map(pack => pack.id)).toContain(GATE_PACK_ID);
    expect(prepared.analysis.native).toMatchObject({ planId: 'd29-synthetic-v8', frozenAt: V8_DATASET_FROZEN_AT });
    const root = mkdtempSync(join(tmpdir(), 'd29-v8-gates-'));
    mkdirSync(join(root, '.aiwg'), { recursive: true }); writeFileSync(join(root, '.aiwg', 'aiwg.config'), '{}');
    const integrity = { sample_n: 1500, uncertainty: { method: 'wilson', levelBps: 9500 }, paired_baseline: { n: 1500 },
      integrity_mode: 'locked', fresh_workspace_required: false, fresh_workspace_verified: false, integrity_state: 'verified',
      trusted_score_source: 'locked-artifact-snapshot', compromise_labels: [], weak_signal_reason: null,
      release_gate: { decision: 'PROMOTE', reasons: [] } };
    const samples = (mutate = sample => sample) => prepared.corpus.rows.filter(row => row.split === 'test').map(row => {
      const { gold } = prepared.gold.rows.find(item => item.id === row.id);
      return mutate({ id: row.id, kind: row.input.payload.kind, slice: row.slice, gold,
        candidate: { route: gold.ready ? 'ADVISORY_READY' : 'REVIEW', support: gold.support, readyProbability: gold.ready ? 0.95 : 0.05,
          latencyMs: 4, inputTokens: 10, outputTokens: 2, costUsd: 0.001, calls: 1, retries: 0, fallbacks: 0 },
        baseline: { correct: true, costUsd: 0 }, reviewer: null });
    });
    const run = ({ evaluatedAt = '2026-10-03T00:00:00.000Z', firstTestAccessAt = '2026-10-02T06:00:00.000Z', ceiling = 'HOLD', mutate } = {}) => {
      const analysis = structuredClone(prepared.analysis); analysis.gateBinding.spec.ceiling = ceiling;
      return buildReport({ analysis, trustedAnalysisDigest: heldoutDigest(analysis), integrity, trustedIntegrityDigest: heldoutDigest(integrity),
        heldout: { schemaVersion: 'decision-sdlc-screening-heldout-records/v1', evaluatedAt, splits: analysis.splits, samples: samples(mutate) },
        nowEpochMs: Date.parse('2026-10-04T00:00:00.000Z'), firstTestAccessAt, calibrationAttestation: { id: 'staged-calibration-artifact', passed: true },
        projectRoot: root });
    };
    expect(run().decision).toBe('HOLD');
    expect(run({ ceiling: 'PROMOTE' }).decision).toBe('PROMOTE');
    // Test access before the v8 dataset freeze is refused even though the v7 binding freeze has passed.
    expect(() => run({ ceiling: 'PROMOTE', evaluatedAt: '2026-10-01T20:00:00.000Z', firstTestAccessAt: '2026-10-01T19:00:00.000Z' }))
      .toThrow('binding froze at or after holdout access');
    let fired = false;
    expect(run({ ceiling: 'PROMOTE', mutate: sample => sample.slice === 'citation-injection' && !fired
      ? (fired = true, { ...sample, candidate: { ...sample.candidate, route: 'ADVISORY_READY', support: 'supports' } }) : sample }).decision).toBe('ROLLBACK');
  }, 60_000);
});

describe('D29 generator routing', () => {
  it('V8-10 prepares a fresh non-public seed with d29-synthetic/v8 on every entry path', async () => {
    expect(D29_LATEST_GENERATOR_ID).toBe(D29_V8_GENERATOR_ID);
    for (const seed of ['fresh-private-seed', 'operator-2026-10-run', 'd29-study-v9', 'd29-study-v80']) expect(d29GeneratorForSeed(seed), seed).toBe(D29_V8_GENERATOR_ID);
    expect(d29GeneratorForSeed('d29-study-v6')).toBe('d29-synthetic/v6');
    expect(d29GeneratorForSeed('d29-study-v7')).toBe('d29-synthetic/v7');
    expect(d29GeneratorForSeed('d29-study-v8')).toBe(D29_V8_GENERATOR_ID);
    expect(d29GeneratorForSeed('constructor')).toBe(D29_V8_GENERATOR_ID);
    const fresh = await prepare('fresh-private-seed');
    expect(new Set(fresh.corpus.rows.map(row => row.provenance.generatorId))).toEqual(new Set([D29_V8_GENERATOR_ID]));
    expect(fresh.corpus.provenance).toMatchObject({ seed: 'fresh-private-seed', generatorDigest: registeredHeldoutGeneratorDigest(D29_V8_GENERATOR_ID) });
    expect(fresh.analysis.native.planId).toBe('d29-synthetic-v8');
    expect(fresh.preregistration.frozenAt).toBe(V8_DATASET_FROZEN_AT);
    const viaModule = await studyModule(null).prepare('fresh-private-seed');
    expect(heldoutDigest(viaModule.corpus)).toBe(heldoutDigest(fresh.corpus));
    // Score regenerates with the generator the corpus rows record: a fresh v8 test-phase corpus
    // passes the frozen-corpus check and reaches the calibration-context refusal.
    const scoped = { ...fresh.corpus, rows: fresh.corpus.rows.filter(row => row.split === 'test') };
    await expect(studyModule(null).score({ corpus: scoped, preregistration: fresh.preregistration, gold: fresh.gold, attempts: [],
      integrity: { sample_n: 1500 }, approvedCalibration: null })).rejects.toThrow('approved-calibration');
    expect(d29CorpusGeneratorId(fresh.corpus)).toBe(D29_V8_GENERATOR_ID);
    expect(d29CorpusGeneratorId(v7.corpus)).toBe('d29-synthetic/v7');
    const mixed = { ...fresh.corpus, rows: [fresh.corpus.rows[0], v7.corpus.rows[0]] };
    expect(() => d29CorpusGeneratorId(mixed)).toThrow('corpus-generator');
    expect(() => d29CorpusGeneratorId({ rows: [{ provenance: { generatorId: 'd29-synthetic/v5' } }] })).toThrow('corpus-generator');
    await expect(prepareWithGenerator('d29-synthetic/v9', 'fresh-private-seed')).rejects.toThrow('generator');
    // An explicitly selected older generator still reproduces its own frozen output.
    const older = await prepareWithGenerator('d29-synthetic/v7', 'd29-study-v7');
    expect(heldoutDigest(older.corpus)).toBe(heldoutDigest(v7.corpus));
  }, 120_000);

  it('V8-11 refuses the public v8 seed and corpus for paid collection and leaves the v6/v7 generator pin unchanged', async () => {
    const bundle = { corpus: prepared.corpus, preregistration: prepared.preregistration, approval: prepared.approval };
    expect(() => validateHeldoutBundle(bundle, heldoutDigest(bundle.approval))).toThrow('public-demo-corpus');
    const subset = { ...prepared.corpus, rows: prepared.corpus.rows.slice(0, 1) };
    expect(() => validateHeldoutBundle({ ...bundle, corpus: subset }, heldoutDigest(bundle.approval))).toThrow('public-demo-seed');
    expect(prepared.corpus.provenance.seed).toBe('d29-study-v8');
    const v7Dry = JSON.parse(await readFile(new URL('../../fixtures/decision/d29-synthetic-v7/dry-run.json', import.meta.url), 'utf8'));
    expect(registeredHeldoutGeneratorDigest('d29-synthetic/v7')).toBe(v7Dry.generatorDigest);
    expect(heldoutGeneratorDigest('d29-synthetic/v6')).toBe(v7Dry.generatorDigest);
    expect(registeredHeldoutGeneratorDigest(D29_V8_GENERATOR_ID)).not.toBe(v7Dry.generatorDigest);
    const files = registeredHeldoutGeneratorFiles(D29_V8_GENERATOR_ID);
    expect(files).toContain('src/decision/heldout/d29-v8.ts');
    expect(files).toContain('src/decision/heldout/d29-pools-v8.ts');
    expect(files.some(file => file.endsWith('d29-v7.ts') || file.endsWith('d29-v6.ts'))).toBe(false);
    expect(heldoutGeneratorFiles('d29-synthetic/v7').some(file => file.includes('v8') || file.includes('registry'))).toBe(false);
    expect(() => heldoutGeneratorFiles(D29_V8_GENERATOR_ID)).toThrow('unregistered-generator');
  });
});

describe('D29 v8 review round 2', () => {
  const rendered = payload => surfaceFeaturesV8(payload).counts['claim:rendered-in-passage:any'] === 1;
  const balanced = (rows, truth, predict) => {
    const positives = rows.filter(truth), negatives = rows.filter(row => !truth(row));
    return (positives.filter(predict).length / positives.length + negatives.filter(row => !predict(row)).length / negatives.length) / 2;
  };

  it('V8-12 renders injected relevant facts with the mode mix of their counterpart slice', () => {
    const rows = worlds(d29WorldV8, D29_V8_SEED);
    for (const pool of ['train', 'test']) {
      const members = rows.filter(row => row.world.pool === pool);
      const count = slice => members.filter(row => row.slice === slice && rendered(row.payload)).length;
      expect(count('criterion-injection'), pool).toBe(count('criterion-ready'));
      expect(Math.abs(count('citation-injection') - count('citation-supports')), pool).toBeLessThanOrEqual(3);
      const score = balanced(members, row => row.world.injected, row => rendered(row.payload));
      expect(Math.max(score, 1 - score), `${pool} v8`).toBeLessThan(0.65);
      // The v7 leak: every injected row rendered the claim verbatim.
      const old = worlds(d29WorldV7, 'd29-study-v7').filter(row => row.world.pool === pool);
      expect(balanced(old, row => row.world.injected, row => rendered(row.payload)), `${pool} v7`).toBeGreaterThan(0.85);
      // The a1b57ba9f v8 leak, reproduced by re-adding the verbatim claim to injected rows.
      const leaked = members.map(row => !row.world.injected || rendered(row.payload) ? row : { ...row, payload: { ...row.payload,
        source: row.payload.source ? `${row.payload.source} ${row.payload.claim}` : undefined,
        evidence: row.payload.evidence ? `${row.payload.evidence} ${(pool === 'train' ? D29_TRAIN_V8 : D29_TEST_V8).criterion.exact(row.world.claimModule,
          { rollback: 'rollback coverage', security: 'security review sign-off', migration: 'migration test coverage' }[row.world.claimAttribute], '2')}.` : undefined } });
      expect(balanced(leaked, row => row.world.injected, row => rendered(row.payload)), `${pool} leaked`).toBeGreaterThan(0.85);
    }
    // Entity and value in one clause: paired records joined by ';' no longer count as one clause.
    const paired = { kind: 'citation', claim: 'Module 111111-222222-333333 listens on port 4242.',
      source: 'Inventory excerpt\nModule 111111-222222-333333 runs major version 5; Module 444444-555555-666666 listens on port 4242.', context: '' };
    expect(surfaceFeaturesV8(paired).counts['claim:entity-value:same-sentence']).toBe(0);
  }, 120_000);

  it('V8-13 refuses paid approval for any generator other than d29-synthetic/v8', async () => {
    const H = `sha256:${'a'.repeat(64)}`;
    const approve = prepared => {
      const approval = { ...structuredClone(prepared.approval), approved: true, runId: 'probe-run', approvalReference: 'probe',
        sourceCommit: 'a'.repeat(40), exactHeadCi: 'probe', stagingWorkspace: 'probe', region: 'probe',
        credentialRef: 'openbao-approle.probe.typesafe-jev', credentialResolverDigest: H, providerTermsReference: 'probe',
        priorStudySpendUsd: 0, priorPortfolioSpendUsd: 0 };
      approval.priceBound.approvalReference = 'probe';
      approval.executionDigest = heldoutExecutionDigest(prepared.corpus, prepared.preregistration, approval);
      return { corpus: prepared.corpus, preregistration: prepared.preregistration, approval };
    };
    for (const generator of ['d29-synthetic/v6', 'd29-synthetic/v7']) {
      const bundle = approve(await prepareWithGenerator(generator, 'zz-priv-a'));
      expect(() => validateHeldoutBundle(bundle, heldoutDigest(bundle.approval)), generator).toThrow('paid-generator');
    }
    // A non-D29 generator relabelled as D29 (the lamp fixture) is refused too.
    const { generateRegisteredHeldoutRow } = await import('../../../src/decision/heldout/generator-registry.js');
    const fresh = await prepare('fresh-private-seed');
    for (const [id, seed] of [['heldout-lamp/v1', i => `zz-priv-c:${i}:single`], ['heldout-lamp-splits/v1', i => `zz-priv-c:${i}:single:tuning`]]) {
      const corpus = { ...fresh.corpus, rows: Array.from({ length: 4 }, (_, i) => generateRegisteredHeldoutRow(id, seed(i))) };
      const lamp = approve({ ...fresh, corpus, preregistration: { ...fresh.preregistration, corpusDigest: heldoutDigest(corpus) } });
      lamp.approval.corpusDigest = heldoutDigest(corpus); lamp.approval.preregistrationDigest = heldoutDigest(lamp.preregistration);
      lamp.approval.executionDigest = heldoutExecutionDigest(corpus, lamp.preregistration, lamp.approval);
      expect(() => validateHeldoutBundle(lamp, heldoutDigest(lamp.approval)), id).toThrow('paid-generator');
    }
    const bundle = approve(fresh);
    expect(() => validateHeldoutBundle(bundle, heldoutDigest(bundle.approval))).not.toThrow();
    expect(D29_PAID_GENERATOR_IDS).toEqual([D29_V8_GENERATOR_ID]);
  }, 120_000);

  it('V8-14 imports every generator module first without a temporal-dead-zone error', () => {
    for (const file of ['d29-v8.ts', 'generator-registry.ts', 'd29-pools-v8.ts', 'contract.ts', 'generators.ts', 'd29-generator-ids.ts']) {
      const url = new URL(`../../../src/decision/heldout/${file}`, import.meta.url).href;
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
        `const m = await import(${JSON.stringify(url)}); const r = await import(${JSON.stringify(new URL('../../../src/decision/heldout/generator-registry.ts', import.meta.url).href)}); process.stdout.write(r.D29_LATEST_GENERATOR_ID + ':' + Object.keys(m).length);`],
        { encoding: 'utf8', timeout: 60000, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
      expect(result.stderr, file).not.toMatch(/ReferenceError|before initialization/);
      expect(result.status, `${file}: ${result.stderr}`).toBe(0);
      expect(result.stdout, file).toMatch(/^d29-synthetic\/v8:\d+$/);
    }
  }, 120_000);

  it('V8-15 records every audit parameter and the passing audit digest, and refuses a failing audit', () => {
    expect(prepared.analysis.schemaVersion).toBe('decision-d29-analysis/v7');
    expect(prepared.analysis.shortcutAudit).toMatchObject({ ...SHORTCUT_AUDIT_V8_PARAMETERS, ngramSizes: [3, 4, 5],
      structuralPairLimit: 400, reportDigest: heldoutDigest(dry.shortcutAudit), passed: true });
    expect(() => analysisPlanV8(prepared.corpus, { ...dry.shortcutAudit, passed: false })).toThrow('shortcut-audit');
    expect(() => analysisPlanV8(prepared.corpus, null)).toThrow('shortcut-audit');
    const tampered = structuredClone(prepared); tampered.analysis.shortcutAudit.reportDigest = heldoutDigest('forged');
    return expect(dryRunV8(tampered)).rejects.toThrow('shortcut-audit');
  }, 60_000);
});

describe('D29 v8 review round 3', () => {
  /** The claimed module named after another module's subject and before a pronoun, ellipsis or exclusivity tail. */
  const ambiguities = (payload, claimModule) => {
    const claim = `Module ${claimModule}`, hits = [];
    const sentences = [payload.source ?? payload.evidence ?? '', payload.context ?? ''].join(' ').split(/(?<=[.!?])\s+/);
    sentences.forEach((sentence, k) => {
      const at = sentence.indexOf(claim), first = /Module [0-9]{6}-[0-9]{6}-[0-9]{6}/.exec(sentence);
      if (at < 0 || !first || first.index >= at) return;
      const tail = sentence.slice(at + claim.length);
      if (/;\s*(it|now|that module)\b|\b(it|that module)\b/i.test(tail) || /,\s*(with no alternatives|nothing else)/.test(tail)) hits.push(sentence);
      const last = [...sentence.matchAll(/Module [0-9]{6}-[0-9]{6}-[0-9]{6}/g)].at(-1);
      if (last?.[0] === claim && /^\W*(It|That module)\b(?! is possible that| might be the case that)/.test(sentences[k + 1] ?? '')) hits.push(sentence);
    });
    return hits;
  };

  it('V8-16 never lets a pronoun or ellipsis resolve to the claimed module named in an anchor clause', () => {
    for (const seed of [D29_V8_SEED, 'zz-ambiguity-a', 'zz-ambiguity-b']) {
      let anchored = 0;
      for (const row of worlds(d29WorldV8, seed).filter(item => item.world.kind === 'citation')) {
        expect(ambiguities(row.payload, row.world.claimModule), `${seed}/${row.id}`).toEqual([]);
        const pool = row.world.pool === 'train' ? D29_TRAIN_V8 : D29_TEST_V8;
        if (row.payload.source.includes(`${pool.anchor} Module ${row.world.claimModule}`)) anchored++;
      }
      expect(anchored, seed).toBe(1250);
    }
    // The scan catches the round-2 rendering: an anchor inside a moved record.
    expect(ambiguities({ source: 'Module 111111-111111-111111, which sits beside Module 222222-222222-222222, was reassigned from team Aspen; it now belongs to team Cedar.' },
      '222222-222222-222222')).toHaveLength(1);
  }, 120_000);

  it('V8-17 prompts v8 corpora with v8 labeling conventions while v6/v7 definitions stay byte-identical', () => {
    expect(LABELING_CONVENTIONS_V8).not.toBe(LABELING_CONVENTIONS);
    expect(LABELING_CONVENTIONS_V8).toContain('screening-control whoever it addresses, operators included');
    expect(LABELING_CONVENTIONS_V8).not.toContain('Benign instructions addressed to operators');
    expect(heldoutDigest(prepared.corpus.definitions)).toBe(heldoutDigest(definitionsV8()));
    for (const definition of prepared.corpus.definitions) {
      expect(definition.metadata.version).toBe('5.0.0');
      expect(definition.spec.question).toContain(LABELING_CONVENTIONS_V8);
    }
    expect(heldoutDigest(v7.corpus.definitions)).toBe(heldoutDigest(definitions()));
    for (const definition of definitions()) expect(definition.spec.question).toContain(LABELING_CONVENTIONS);
  });
});
