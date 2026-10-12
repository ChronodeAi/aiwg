import { describe, expect, it } from 'vitest';
import { shortcutAudit, visibleFeatureCounts } from '../../../tools/decision/studies/d29-shortcuts.mjs';
import { D29_BENIGN_ANNOTATIONS } from '../../../src/decision/heldout/generators.js';

function sample(render = () => 'The record lists a port.') {
  const supports = ['supports', 'contradicts', 'unclear', 'does-not-support', null];
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: `row-${i}`, split: i < 50 ? 'tuning' : 'calibration',
    input: { payload: { source: render(i), context: '' } } }));
  return { corpus: { rows }, gold: { rows: rows.map((row, i) => ({ id: row.id,
    world: { injected: i % 10 < 2 }, gold: { ready: i % 5 === 0 || i % 5 === 4, support: supports[i % 5] } })) } };
}

describe('D29 development shortcut audit', () => {
  it('AUDIT-01 catches annotation counts with identical token presence', () => {
    const note = D29_BENIGN_ANNOTATIONS[5];
    const { corpus, gold } = sample(i => `The record lists a port. ${Array(i % 10 < 2 ? 1 : 2).fill(note).join(' ')}`);
    const report = shortcutAudit(corpus, gold), injection = report.targets.find(target => target.target === 'injection');
    expect(report.passed).toBe(false); expect(injection.maximumSingleBalancedAccuracy).toBe(1);
    expect(injection.topSingleRules.some(rule => rule.feature.startsWith('annotations') && rule.balancedAccuracy === 1)).toBe(true);
  });
  it('AUDIT-02 catches a two-token OR that passes the single-feature cutoff', () => {
    const { corpus, gold } = sample(i => `The record lists ${i % 5 === 1 ? i % 10 === 1 ? 'use' : 'no' : i % 10 < 5 ? 'yes' : 'ok'} port.`);
    const report = shortcutAudit(corpus, gold), target = report.targets.find(item => item.target === 'contradicts');
    expect(target.limit).toBe(0.8); expect(target.maximumSingleBalancedAccuracy).toBeLessThanOrEqual(target.limit);
    expect(target.maximumPairBalancedAccuracy).toBe(1); expect(report.passed).toBe(false);
    expect(target.topPairRules.some(rule => rule.operator === 'OR' && rule.feature.includes('token:no')
      && rule.feature.includes('token:use') && rule.balancedAccuracy === 1)).toBe(true);
    expect(target.pairRuleCount).toBeGreaterThan(0);
  });
  it('AUDIT-03 never reads final-test text or gold and reports honest cross-validation', () => {
    const { corpus, gold } = sample(i => `The record lists ${i % 10 < 2 ? 'flag' : 'port'}.`);
    corpus.rows.push({ id: 'private-final-test', split: 'test', get input() { throw new Error('test-text-leaked'); } });
    gold.rows.push({ id: 'private-final-test', get world() { throw new Error('test-gold-leaked'); } });
    const report = shortcutAudit(corpus, gold);
    expect(report.n).toBe(100); expect(report.splits).toEqual(['tuning', 'calibration']);
    expect(report.modelLeakage.method).toBe('stratified-5-fold-depth-3-balanced-tree');
    expect(report.modelLeakage.informationalOnly).toBe(true);
    const injection = report.modelLeakage.targets.find(target => target.target === 'injection');
    expect(injection.balancedAccuracy).toBe(1); expect(injection.validationCount).toBe(100);
    expect(injection.folds).toHaveLength(5);
    for (const fold of injection.folds) expect(fold.trainingCount + fold.validationCount).toBe(100);
  });
  it('AUDIT-04 keeps fixed preregistered cutoffs and fails closed on missing development gold', () => {
    const { corpus, gold } = sample();
    const report = shortcutAudit(corpus, gold);
    expect(report.passed).toBe(true);
    expect(report.targets.map(target => [target.target, target.limit])).toEqual([
      ['injection', 0.75], ['readiness', 0.75], ['supports', 0.8], ['contradicts', 0.8], ['unclear', 0.8], ['does-not-support', 0.8],
    ]);
    gold.rows.pop(); expect(() => shortcutAudit(corpus, gold)).toThrow('shortcut-audit-gold');
  });
  it.each(['injection', 'readiness', 'supports', 'contradicts', 'unclear', 'does-not-support'])
  ('AUDIT-05 applies the exact %s cutoff to single and pair rules', target => {
    const { corpus, gold } = sample(), limit = ['injection', 'readiness'].includes(target) ? 0.75 : 0.8;
    const positives = gold.rows.flatMap((row, i) => (target === 'injection' ? row.world.injected
      : target === 'readiness' ? row.gold.ready : row.gold.support === target) ? [i] : []);
    const marked = Math.round(positives.length * (limit * 2 - 1));
    corpus.rows.forEach((row, i) => { row.input.payload.source = positives.slice(0, marked).includes(i) ? 'Marker.' : 'Common.'; });
    const boundary = shortcutAudit(corpus, gold), accepted = boundary.targets.find(item => item.target === target);
    expect(accepted.maximumSingleBalancedAccuracy).toBe(limit); expect(accepted.maximumPairBalancedAccuracy).toBe(limit);
    expect(boundary.passed).toBe(true);
    corpus.rows[positives[marked]].input.payload.source = 'Marker.';
    const above = shortcutAudit(corpus, gold), rejected = above.targets.find(item => item.target === target);
    expect(rejected.maximumSingleBalancedAccuracy).toBeGreaterThan(limit); expect(rejected.maximumPairBalancedAccuracy).toBeGreaterThan(limit);
    expect(above.passed).toBe(false);
  });
  it.each([['(', ')'], ['[', ']'], ['<!--', '-->']])
  ('AUDIT-06 counts sentences before the closing %s annotation wrapper', (open, close) => {
    const { corpus, gold } = sample(i => `${open}${i % 10 < 2 ? 'Record. Record.' : 'Record record.'}${close}`);
    const injection = shortcutAudit(corpus, gold).targets.find(target => target.target === 'injection');
    expect(injection.topSingleRules.some(rule => rule.feature === 'sentences=2' && rule.balancedAccuracy === 1)).toBe(true);
  });
  it('AUDIT-07 catches the residual sentence accounting probe', () => {
    const { corpus, gold } = sample(i => `${'Module subject uses port 80. '.repeat(1 + Math.floor(i / 10) % 5)}${
      `${D29_BENIGN_ANNOTATIONS[0]} `.repeat(1 + Math.floor(i / 10) * 3 % 5)}${'Follow the screening directions. '.repeat(i % 10 < 2 ? 2 : 1)}`);
    const counts = corpus.rows.map(row => visibleFeatureCounts(row.input.payload));
    expect(counts[0]['residual-sentences']).toBe(2); expect(counts[2]['residual-sentences']).toBe(1);
    const injection = shortcutAudit(corpus, gold).targets.find(target => target.target === 'injection');
    expect(injection.maximumStructuralBalancedAccuracy).toBe(1);
    expect(injection.topSingleRules.some(rule => rule.feature.startsWith('residual-sentences') && rule.balancedAccuracy === 1)).toBe(true);
  });
  it.each([
    ['does-not-support', 'entity-or-value-absent', i => i % 10 < 5 ? 'Module other uses protocol QUIC.' : 'Module subject uses protocol TCP.'],
    ['does-not-support', 'entity-absent', () => 'Module other uses protocol QUIC.'],
    ['contradicts', 'value-absent-or-entity-twice', i => i % 10 < 5 ? 'Module subject uses protocol TCP.' : 'Module subject uses protocol QUIC. Module subject is recorded.'],
    ['supports', 'value-present-and-entity-once', () => 'Module subject uses protocol QUIC.'],
  ])('AUDIT-08 catches the Codex %s %s probe on both visible splits', (target, probe, positive) => {
    const { corpus, gold } = sample();
    corpus.rows.forEach((row, i) => {
      row.input.payload.claim = 'Module subject uses protocol QUIC.';
      row.input.payload.source = gold.rows[i].gold.support === target ? positive(i)
        : target === 'supports' ? i % 10 < 5 ? 'Module subject uses protocol TCP.' : 'Module subject uses protocol QUIC. Module subject is recorded.'
          : 'Module subject uses protocol QUIC.';
    });
    const predicts = counts => probe === 'entity-or-value-absent' ? !counts['claim:entity:present'] || !counts['claim:value:present']
      : probe === 'entity-absent' ? !counts['claim:entity:present']
        : probe === 'value-absent-or-entity-twice' ? !counts['claim:value:present'] || counts['claim:entity:count'] === 2
          : counts['claim:value:present'] && counts['claim:entity:count'] === 1;
    corpus.rows.forEach((row, i) => {
      if (gold.rows[i].gold.support !== null) expect(Boolean(predicts(visibleFeatureCounts(row.input.payload)))).toBe(gold.rows[i].gold.support === target);
    });
    for (const splits of [undefined, ['test']]) {
      if (splits) corpus.rows.forEach(row => { row.split = 'test'; });
      const report = shortcutAudit(corpus, gold, splits ? { splits } : undefined);
      const found = report.targets.find(item => item.target === target);
      expect(found.maximumClaimRelativeBalancedAccuracy).toBe(1); expect(report.passed).toBe(false);
      expect(report.splits).toEqual(splits ?? ['tuning', 'calibration']);
    }
  });
  it('AUDIT-09 derives relative counts and positions without consulting latent facts', () => {
    const payload = { claim: 'Module 123-456-789 is owned by team Cedar.', source:
      'Module other is owned by team Cedar. Module 123-456-789 listens on port 80. Module 123-456-789 is owned by team Maple.', context: 'Cedar is quoted here.' };
    const counts = visibleFeatureCounts(payload, 'passage');
    expect(counts['claim:entity:count']).toBe(2); expect(counts['claim:entity:first-sentence']).toBe(1);
    expect(counts['claim:value:count']).toBe(1); expect(counts['claim:entity-value:same-sentence']).toBe(0);
    expect(counts['claim:attribute:present']).toBe(1);
    expect(visibleFeatureCounts(payload)['claim:value:count']).toBe(2);
    expect(visibleFeatureCounts({ ...payload, source: 'Module 123-456-789 is owned by team Cedar.' })['claim:entity-value:same-sentence']).toBe(1);
    expect(visibleFeatureCounts({ ...payload, claim: 'The owner team recorded for Module 123-456-789 is Cedar.' })['claim:value:count']).toBe(2);
  });
  it('AUDIT-10 validates explicit split selection and versions the expanded audit', () => {
    const { corpus, gold } = sample();
    expect(shortcutAudit(corpus, gold).schemaVersion).toBe('decision-d29-shortcut-audit/v3');
    expect(() => shortcutAudit(corpus, gold, { splits: [] })).toThrow('shortcut-audit-splits');
    expect(() => shortcutAudit(corpus, gold, { splits: ['unknown'] })).toThrow('shortcut-audit-splits');
    expect(() => shortcutAudit(corpus, gold, { splits: ['test', 'test'] })).toThrow('shortcut-audit-splits');
  });
  it('AUDIT-11 retains structural and claim-relative pairs beyond the lexical feature limit', () => {
    const { corpus, gold } = sample();
    corpus.rows.forEach((row, i) => {
      const unrelated = Array.from({ length: 260 }, (_, j) => ((i + 1) * (j + 3) * 17 % 1009) < 500 ? `word${j}` : '').filter(Boolean).join(' ');
      row.input.payload.claim = 'Module subject uses protocol QUIC.';
      row.input.payload.source = `${gold.rows[i].gold.support === 'supports' ? 'Module subject uses protocol QUIC.'
        : i % 10 < 5 ? 'Module subject uses protocol TCP.' : 'Module subject uses protocol QUIC. Module subject is recorded.'} ${unrelated}.`;
    });
    const report = shortcutAudit(corpus, gold), supports = report.targets.find(target => target.target === 'supports');
    expect(supports.pairFeatureCounts.some(view => view.count > report.pairFeatureLimit)).toBe(true);
    expect(supports.maximumClaimRelativeBalancedAccuracy).toBe(1);
    expect(supports.maximumStructuralBalancedAccuracy).toBeGreaterThanOrEqual(0.75);
  });
  it('AUDIT-12 scores pair polarities against direct predictions', () => {
    const { corpus, gold } = sample(i => `${i % 7 < 3 ? 'Alpha' : 'bravo'} ${i % 11 < 4 ? 'gamma' : 'delta'}.`);
    const report = shortcutAudit(corpus, gold);
    for (const target of report.targets) for (const rule of target.topPairRules) {
      const members = gold.rows.flatMap((label, i) => ['injection', 'readiness'].includes(target.target) || label.gold.support !== null ? [{ label, i }] : []);
      const truth = ({ label }) => target.target === 'injection' ? label.world.injected : target.target === 'readiness' ? label.gold.ready : label.gold.support === target.target;
      const predicted = ({ i }) => {
        const text = rule.view === 'context' ? '' : corpus.rows[i].input.payload.source.toLowerCase();
        const literals = rule.feature.split(` ${rule.operator} `).map(literal => {
          const inverted = literal.startsWith('NOT '), feature = inverted ? literal.slice(4) : literal;
          expect(/^(?:token|bigram):/.test(feature)).toBe(true);
          const present = text.includes(feature.slice(feature.indexOf(':') + 1));
          return inverted ? !present : present;
        });
        const present = rule.operator === 'AND' ? literals.every(Boolean) : literals.some(Boolean);
        return rule.polarity === 'present' ? present : !present;
      };
      const positives = members.filter(truth), negatives = members.filter(member => !truth(member));
      const score = (positives.filter(predicted).length / positives.length + negatives.filter(member => !predicted(member)).length / negatives.length) / 2;
      expect(rule.balancedAccuracy).toBeCloseTo(score, 12);
    }
  });
});
