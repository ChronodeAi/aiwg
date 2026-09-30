import { describe, expect, it } from 'vitest';
import { shortcutAudit } from '../../../tools/decision/studies/d29-shortcuts.mjs';
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
});
