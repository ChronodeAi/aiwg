import { D29_BENIGN_ANNOTATIONS } from '../../../src/decision/heldout/generators.js';

const LIMITS = { injection: 0.75, readiness: 0.75, supports: 0.80, contradicts: 0.80, unclear: 0.80, 'does-not-support': 0.80 };
const VIEWS = ['passage', 'passage-and-context', 'context'];
const PAIR_FEATURE_LIMIT = 200;
const tokenize = text => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
const compare = (a, b) => b.balancedAccuracy - a.balancedAccuracy || a.target.localeCompare(b.target)
  || a.view.localeCompare(b.view) || (a.operator === 'single' ? 0 : 1) - (b.operator === 'single' ? 0 : 1)
  || (a.operator === 'OR' ? 0 : 1) - (b.operator === 'OR' ? 0 : 1)
  || (a.feature.match(/NOT /g) ?? []).length - (b.feature.match(/NOT /g) ?? []).length
  || (a.feature.startsWith('token:') ? 0 : 1) - (b.feature.startsWith('token:') ? 0 : 1)
  || a.feature.localeCompare(b.feature);
const popcount = value => {
  value -= (value >>> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

function features(texts) {
  const words = texts.map(tokenize), sets = words.map(tokens => new Set([
    ...tokens.map(token => `token:${token}`), ...tokens.slice(1).map((token, i) => `bigram:${tokens[i]} ${token}`),
  ]));
  const addCounts = (name, counts) => {
    for (const count of [...new Set(counts)].sort((a, b) => a - b)) for (let i = 0; i < texts.length; i++) {
      if (counts[i] === count) sets[i].add(`${name}=${count}`);
      if (counts[i] <= count) sets[i].add(`${name}<=${count}`);
    }
  };
  const annotations = texts.map(text => D29_BENIGN_ANNOTATIONS.map(annotation => text.toLowerCase().split(annotation.toLowerCase()).length - 1));
  addCounts('annotations', annotations.map(counts => counts.reduce((sum, count) => sum + count, 0)));
  addCounts('annotations:distinct', annotations.map(counts => counts.filter(Boolean).length));
  for (let i = 0; i < D29_BENIGN_ANNOTATIONS.length; i++) addCounts(`annotations:template-${i}`, annotations.map(counts => counts[i]));
  for (const [name, pattern] of [['colon', /:/g], ['quotes', /['"“”‘’]/g], ['brackets', /[\[\](){}<>]/g],
    ['html-comments', /<!--/g], ['quote-markers', /(?:^|\s)>(?=\s)/g], ['parentheses', /\(/g], ['square-brackets', /\[/g], ['semicolons', /;/g]]) {
    const counts = texts.map(text => (text.match(pattern) ?? []).length);
    addCounts(`format:${name}`, counts);
    counts.forEach((count, i) => { if (count) sets[i].add(`punctuation:${name}`); });
  }
  addCounts('sentences', texts.map(text => (text.match(/[.!?](?=\s|$|[)\]]|-->)/g) ?? []).length));
  addCounts('characters', texts.map(text => text.length));
  addCounts('length-bin-80', texts.map(text => Math.floor(text.length / 80)));
  addCounts('word-bin-10', words.map(tokens => Math.floor(tokens.length / 10)));
  const vocabulary = new Map();
  sets.forEach((set, i) => {
    for (const feature of set) {
      if (!vocabulary.has(feature)) vocabulary.set(feature, new Uint32Array(Math.ceil(texts.length / 32)));
      vocabulary.get(feature)[i >>> 5] |= 1 << (i & 31);
    }
  });
  return vocabulary;
}

function viewText(payload, view) {
  const passage = payload.source ?? payload.evidence ?? '';
  return view === 'context' ? payload.context ?? '' : `${passage}${view === 'passage-and-context' ? ` ${payload.context ?? ''}` : ''}`;
}

function modelScore(members, truth, target) {
  const tokens = members.map(row => new Set(tokenize(viewText(row.payload, 'passage-and-context'))));
  let positiveFold = 0, negativeFold = 0;
  const assignments = truth.map(positive => (positive ? positiveFold++ : negativeFold++) % 5);
  const predictions = Array(truth.length).fill(false), folds = [];
  for (let fold = 0; fold < 5; fold++) {
    const training = truth.flatMap((_, i) => assignments[i] !== fold ? [i] : []);
    const validation = truth.flatMap((_, i) => assignments[i] === fold ? [i] : []);
    const positives = training.filter(i => truth[i]).length, negatives = training.length - positives;
    if (!positives || !negatives) throw new Error('shortcut-audit-model-support');
    const vocabulary = new Map();
    for (const i of training) for (const token of tokens[i]) vocabulary.set(token, (vocabulary.get(token) ?? 0) + 1);
    const candidates = [...vocabulary].filter(([, count]) => count > 1 && count < training.length)
      .sort(([a, an], [b, bn]) => bn - an || a.localeCompare(b)).map(([token]) => token);
    const impurity = (p, n) => p + n ? 2 * p * n / (p + n) : 0;
    const build = (indices, depth) => {
      const p = indices.filter(i => truth[i]).length / positives, n = indices.filter(i => !truth[i]).length / negatives;
      const prediction = p >= n;
      if (depth === 3 || !p || !n) return { prediction };
      let best = null, gain = 1e-12;
      for (const token of candidates) {
        let yesP = 0, yesN = 0;
        for (const i of indices) if (tokens[i].has(token)) { if (truth[i]) yesP++; else yesN++; }
        yesP /= positives; yesN /= negatives;
        const improvement = impurity(p, n) - impurity(yesP, yesN) - impurity(p - yesP, n - yesN);
        if (improvement > gain) { best = token; gain = improvement; }
      }
      return best === null ? { prediction } : { token: best,
        yes: build(indices.filter(i => tokens[i].has(best)), depth + 1),
        no: build(indices.filter(i => !tokens[i].has(best)), depth + 1) };
    };
    const tree = build(training, 0);
    for (const i of validation) {
      let node = tree;
      while (node.token !== undefined) node = tokens[i].has(node.token) ? node.yes : node.no;
      predictions[i] = node.prediction;
    }
    folds.push({ fold, trainingCount: training.length, validationCount: validation.length, vocabularyCount: candidates.length });
  }
  const positives = truth.filter(Boolean).length, negatives = truth.length - positives;
  const tp = truth.filter((positive, i) => positive && predictions[i]).length;
  const tn = truth.filter((positive, i) => !positive && !predictions[i]).length;
  return { target, balancedAccuracy: (tp / positives + tn / negatives) / 2, validationCount: truth.length, folds };
}

/** Development-only singles and pair rules gate the corpus; cross-validated trees are informational. */
export function shortcutAudit(corpus, gold) {
  const development = corpus.rows.filter(row => row.split === 'tuning' || row.split === 'calibration');
  const ids = new Set(development.map(row => row.id));
  const labels = new Map(gold.rows.filter(row => ids.has(row.id)).map(row => [row.id, row]));
  const rows = development.map(row => {
    const label = labels.get(row.id);
    if (!label?.gold || typeof label.world?.injected !== 'boolean' || typeof label.gold.ready !== 'boolean'
      || ![null, 'supports', 'contradicts', 'unclear', 'does-not-support'].includes(label.gold.support)) throw new Error('shortcut-audit-gold');
    return { payload: row.input.payload, world: label.world, gold: label.gold };
  });
  const targets = [], models = [];
  for (const [target, limit] of Object.entries(LIMITS)) {
    const support = !['injection', 'readiness'].includes(target);
    const members = rows.filter(row => !support || row.gold.support !== null);
    const truth = members.map(row => target === 'injection' ? row.world.injected : target === 'readiness' ? row.gold.ready : row.gold.support === target);
    const positives = truth.filter(Boolean).length, negatives = members.length - positives;
    if (!positives || !negatives) throw new Error('shortcut-audit-support');
    const trueBits = new Uint32Array(Math.ceil(members.length / 32)), masks = new Uint32Array(trueBits.length).fill(0xffffffff);
    truth.forEach((positive, i) => { if (positive) trueBits[i >>> 5] |= 1 << (i & 31); });
    if (members.length % 32) masks[masks.length - 1] = 0xffffffff >>> (32 - members.length % 32);
    const singles = [], pairs = [], pairFeatureCounts = [];
    let pairRuleCount = 0;
    for (const view of VIEWS) {
      const vocabulary = features(members.map(row => viewText(row.payload, view))), candidates = [];
      for (const [feature, bits] of vocabulary) {
        let tp = 0, fp = 0;
        for (let i = 0; i < bits.length; i++) { tp += popcount(bits[i] & trueBits[i]); fp += popcount(bits[i] & ~trueBits[i]); }
        const score = (tp / positives + (negatives - fp) / negatives) / 2;
        const rule = { target, view, feature, operator: 'single', polarity: score >= 0.5 ? 'present' : 'absent', balancedAccuracy: Math.max(score, 1 - score) };
        singles.push(rule);
        if (tp + fp && tp + fp < members.length) candidates.push({ ...rule, bits });
      }
      candidates.sort(compare);
      const seen = new Set(), selected = [];
      for (const candidate of candidates) {
        const signature = candidate.bits.join(',');
        if (seen.has(signature)) continue;
        seen.add(signature); selected.push(candidate);
        if (selected.length === PAIR_FEATURE_LIMIT) break;
      }
      pairFeatureCounts.push({ view, count: selected.length });
      const keep = rule => {
        if (pairs.length === 10 && compare(rule, pairs[9]) >= 0) return;
        pairs.push(rule); pairs.sort(compare); if (pairs.length > 10) pairs.pop();
      };
      for (let a = 0; a < selected.length; a++) for (let b = a + 1; b < selected.length; b++) {
        for (let polarity = 0; polarity < 4; polarity++) {
          const invertA = Boolean(polarity & 1), invertB = Boolean(polarity & 2);
          let tp = 0, fp = 0;
          for (let i = 0; i < masks.length; i++) {
            const bits = (invertA ? ~selected[a].bits[i] : selected[a].bits[i])
              & (invertB ? ~selected[b].bits[i] : selected[b].bits[i]) & masks[i];
            tp += popcount(bits & trueBits[i]); fp += popcount(bits & ~trueBits[i]);
          }
          const score = (tp / positives + (negatives - fp) / negatives) / 2;
          const balancedAccuracy = Math.max(score, 1 - score);
          pairRuleCount += 2;
          if (pairs.length === 10 && balancedAccuracy < pairs[9].balancedAccuracy) continue;
          const literals = [selected[a].feature, selected[b].feature];
          keep({ target, view, feature: `${invertA ? 'NOT ' : ''}${literals[0]} AND ${invertB ? 'NOT ' : ''}${literals[1]}`,
            operator: 'AND', polarity: score >= 0.5 ? 'present' : 'absent', balancedAccuracy });
          keep({ target, view, feature: `${!invertA ? 'NOT ' : ''}${literals[0]} OR ${!invertB ? 'NOT ' : ''}${literals[1]}`,
            operator: 'OR', polarity: score <= 0.5 ? 'present' : 'absent', balancedAccuracy });
        }
      }
    }
    singles.sort(compare); pairs.sort(compare);
    const maximumSingleBalancedAccuracy = singles[0].balancedAccuracy, maximumPairBalancedAccuracy = pairs[0]?.balancedAccuracy ?? 0.5;
    targets.push({ target, positives, negatives, limit, featureCount: singles.length, pairFeatureCounts, pairRuleCount,
      maximumSingleBalancedAccuracy, maximumPairBalancedAccuracy,
      maximumBalancedAccuracy: Math.max(maximumSingleBalancedAccuracy, maximumPairBalancedAccuracy),
      topSingleRules: singles.slice(0, 10), topPairRules: pairs, topRules: [...singles.slice(0, 10), ...pairs].sort(compare).slice(0, 10) });
    models.push(modelScore(members, truth, target));
  }
  return { schemaVersion: 'decision-d29-shortcut-audit/v2', splits: ['tuning', 'calibration'], n: rows.length,
    pairFeatureLimit: PAIR_FEATURE_LIMIT, pairSelection: 'strongest-single-distinct-bitsets-per-target-and-view',
    featureFamilies: ['tokens-including-stopwords', 'bigrams', 'annotation-counts', 'sentence-counts', 'formatting-counts', 'character-thresholds', 'length-bins'],
    targets, topRules: targets.flatMap(target => target.topRules).sort(compare).slice(0, 10),
    modelLeakage: { method: 'stratified-5-fold-depth-3-balanced-tree', view: 'passage-and-context',
      vocabulary: 'training-fold-only-token-presence-minimum-two', informationalOnly: true,
      maximumBalancedAccuracy: Math.max(...models.map(model => model.balancedAccuracy)), targets: models },
    passed: targets.every(target => target.maximumBalancedAccuracy <= target.limit) };
}
