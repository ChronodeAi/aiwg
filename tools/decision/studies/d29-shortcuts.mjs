import { D29_BENIGN_ANNOTATIONS } from '../../../src/decision/heldout/generators.js';

const LIMITS = { injection: 0.75, readiness: 0.75, supports: 0.80, contradicts: 0.80, unclear: 0.80, 'does-not-support': 0.80 };
const VIEWS = ['passage', 'passage-and-context', 'context'];
const PAIR_FEATURE_LIMIT = 200;
const tokenize = text => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
const sentencePattern = /[.!?](?=\s|$|[)\]]|-->)/g;
const formats = [['colon', /:/g], ['quotes', /['"“”‘’]/g], ['brackets', /[\[\](){}<>]/g],
  ['html-comments', /<!--/g], ['quote-markers', /(?:^|\s)>(?=\s)/g], ['parentheses', /\(/g], ['square-brackets', /\[/g], ['semicolons', /;/g]];
const claimRelative = feature => feature.startsWith('claim:');
const structural = feature => /^(?:annotations|sentences|residual-sentences|module-mentions|format:|punctuation:|claim:entity:first-)/.test(feature);
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

/** Shallow visible-text accounting only; no world, variant or gold fields enter these probes. */
export function visibleFeatureCounts(payload, view = 'passage-and-context') {
  const text = viewText(payload, view), lower = text.toLowerCase();
  const annotations = D29_BENIGN_ANNOTATIONS.map(annotation => lower.split(annotation.toLowerCase()).length - 1);
  const counts = { annotations: annotations.reduce((sum, count) => sum + count, 0),
    'annotations:distinct': annotations.filter(Boolean).length,
    sentences: (text.match(sentencePattern) ?? []).length,
    'module-mentions': (text.match(/\bModule\s+[a-z0-9]+(?:-[a-z0-9]+)*\b/gi) ?? []).length };
  counts['residual-sentences'] = counts.sentences - counts.annotations - counts['module-mentions'];
  annotations.forEach((count, i) => { counts[`annotations:template-${i}`] = count; });
  for (const [name, pattern] of formats) counts[`format:${name}`] = (text.match(pattern) ?? []).length;
  const claim = (payload.claim ?? payload.criterion ?? '').toLowerCase();
  const entity = /\bmodule\s+([a-z0-9]+(?:-[a-z0-9]+)*)\b/.exec(claim)?.[1];
  const attribute = /\b(port|protocol|region|owner team|owned by team|major version|rollback coverage|security review sign-off|migration test coverage)\b/.exec(claim)?.[1];
  const value = attribute && !payload.criterion ? new RegExp(`\\b${attribute} recorded for Module ${entity} is ([a-z0-9-]+)\\b`, 'i').exec(claim)?.[1]
    ?? new RegExp(`\\b${attribute}\\s+([a-z0-9-]+)\\b`).exec(claim)?.[1] : undefined;
  const occurrences = term => term ? [...lower.matchAll(new RegExp(`(?<![a-z0-9-])${term}(?![a-z0-9-])`, 'g'))] : [];
  const entities = occurrences(entity), values = occurrences(value), first = entities[0]?.index ?? -1;
  counts['claim:entity:present'] = Number(entities.length > 0); counts['claim:entity:count'] = entities.length;
  counts['claim:entity:first-sentence'] = first < 0 ? -1 : (text.slice(0, first).match(sentencePattern) ?? []).length;
  counts['claim:entity:first-position-bin-10'] = first < 0 ? -1 : Math.floor(10 * first / Math.max(1, text.length));
  counts['claim:value:present'] = Number(values.length > 0); counts['claim:value:count'] = values.length;
  counts['claim:entity-value:same-sentence'] = Number(Boolean(entity && value && text.split(sentencePattern)
    .some(sentence => occurrencesIn(sentence, entity) && occurrencesIn(sentence, value))));
  counts['claim:attribute:present'] = Number(Boolean(attribute && new RegExp(`\\b${['owner team', 'owned by team'].includes(attribute)
    ? '(?:owner team|owned by team)' : attribute}\\b`, 'i').test(text)));
  return counts;
}

function occurrencesIn(text, term) {
  return new RegExp(`(?<![a-z0-9-])${term}(?![a-z0-9-])`, 'i').test(text);
}

function features(payloads, view) {
  const texts = payloads.map(payload => viewText(payload, view)), counts = payloads.map(payload => visibleFeatureCounts(payload, view));
  const words = texts.map(tokenize), sets = words.map(tokens => new Set([
    ...tokens.map(token => `token:${token}`), ...tokens.slice(1).map((token, i) => `bigram:${tokens[i]} ${token}`),
  ]));
  const addCounts = (name, counts) => {
    for (const count of [...new Set(counts)].sort((a, b) => a - b)) for (let i = 0; i < texts.length; i++) {
      if (counts[i] === count) sets[i].add(`${name}=${count}`);
      if (counts[i] <= count) sets[i].add(`${name}<=${count}`);
    }
  };
  for (const name of Object.keys(counts[0])) addCounts(name, counts.map(row => row[name]));
  for (const [name] of formats) counts.forEach((row, i) => { if (row[`format:${name}`]) sets[i].add(`punctuation:${name}`); });
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

/** Development is the default; an explicit split selection permits a separately reported public-test audit. */
export function shortcutAudit(corpus, gold, { splits = ['tuning', 'calibration'] } = {}) {
  if (!Array.isArray(splits) || !splits.length || new Set(splits).size !== splits.length
    || splits.some(split => !['tuning', 'calibration', 'test'].includes(split))) throw new Error('shortcut-audit-splits');
  const development = corpus.rows.filter(row => splits.includes(row.split));
  const ids = new Set(development.map(row => row.id));
  const labels = new Map(gold.rows.filter(row => ids.has(row.id)).map(row => [row.id, row]));
  const rows = development.map(row => {
    const label = labels.get(row.id);
    if (!label?.gold || typeof label.world?.injected !== 'boolean' || typeof label.gold.ready !== 'boolean'
      || ![null, 'supports', 'contradicts', 'unclear', 'does-not-support'].includes(label.gold.support)) throw new Error('shortcut-audit-gold');
    return { payload: row.input.payload, world: label.world, gold: label.gold };
  });
  const targets = [], models = [], vocabularies = new Map();
  for (const [target, limit] of Object.entries(LIMITS)) {
    const support = !['injection', 'readiness'].includes(target);
    const members = rows.filter(row => !support || row.gold.support !== null);
    const truth = members.map(row => target === 'injection' ? row.world.injected : target === 'readiness' ? row.gold.ready : row.gold.support === target);
    const positives = truth.filter(Boolean).length, negatives = members.length - positives;
    if (!positives || !negatives) throw new Error('shortcut-audit-support');
    const trueBits = new Uint32Array(Math.ceil(members.length / 32));
    truth.forEach((positive, i) => { if (positive) trueBits[i >>> 5] |= 1 << (i & 31); });
    const singles = [], pairs = [], pairFeatureCounts = [];
    let pairRuleCount = 0, maximumStructuralBalancedAccuracy = 0.5, maximumClaimRelativeBalancedAccuracy = 0.5;
    for (const view of VIEWS) {
      const key = `${support}:${view}`, candidates = [];
      if (!vocabularies.has(key)) vocabularies.set(key, features(members.map(row => row.payload), view));
      const vocabulary = vocabularies.get(key);
      for (const [feature, bits] of vocabulary) {
        let tp = 0, fp = 0;
        for (let i = 0; i < bits.length; i++) { tp += popcount(bits[i] & trueBits[i]); fp += popcount(bits[i] & ~trueBits[i]); }
        const score = (tp / positives + (negatives - fp) / negatives) / 2;
        const rule = { target, view, feature, operator: 'single', polarity: score >= 0.5 ? 'present' : 'absent', balancedAccuracy: Math.max(score, 1 - score) };
        if (structural(feature)) maximumStructuralBalancedAccuracy = Math.max(maximumStructuralBalancedAccuracy, rule.balancedAccuracy);
        if (claimRelative(feature)) maximumClaimRelativeBalancedAccuracy = Math.max(maximumClaimRelativeBalancedAccuracy, rule.balancedAccuracy);
        singles.push(rule);
        if (tp + fp && tp + fp < members.length) candidates.push({ ...rule, bits, tp, fp, structural: structural(feature), claimRelative: claimRelative(feature) });
      }
      candidates.sort(compare);
      const seen = new Map(), selected = [];
      const select = candidate => {
        const signature = candidate.bits.join(',');
        if (seen.has(signature)) {
          const previous = seen.get(signature);
          previous.structural ||= candidate.structural; previous.claimRelative ||= candidate.claimRelative;
          return false;
        }
        seen.set(signature, candidate); selected.push(candidate); return true;
      };
      for (const candidate of candidates) if (candidate.structural || candidate.claimRelative) select(candidate);
      let lexicalCount = 0;
      for (const candidate of candidates) {
        if (candidate.structural || candidate.claimRelative) continue;
        if (select(candidate) && ++lexicalCount === PAIR_FEATURE_LIMIT) break;
      }
      pairFeatureCounts.push({ view, count: selected.length });
      const keep = rule => {
        if (pairs.length === 10 && compare(rule, pairs[9]) >= 0) return;
        pairs.push(rule); pairs.sort(compare); if (pairs.length > 10) pairs.pop();
      };
      for (let a = 0; a < selected.length; a++) for (let b = a + 1; b < selected.length; b++) {
        let bothTp = 0, bothFp = 0;
        for (let i = 0; i < trueBits.length; i++) {
          const bits = selected[a].bits[i] & selected[b].bits[i];
          bothTp += popcount(bits & trueBits[i]); bothFp += popcount(bits & ~trueBits[i]);
        }
        for (let polarity = 0; polarity < 4; polarity++) {
          const invertA = Boolean(polarity & 1), invertB = Boolean(polarity & 2);
          const tp = invertA && invertB ? positives - selected[a].tp - selected[b].tp + bothTp
            : invertA ? selected[b].tp - bothTp : invertB ? selected[a].tp - bothTp : bothTp;
          const fp = invertA && invertB ? negatives - selected[a].fp - selected[b].fp + bothFp
            : invertA ? selected[b].fp - bothFp : invertB ? selected[a].fp - bothFp : bothFp;
          const score = (tp / positives + (negatives - fp) / negatives) / 2;
          const balancedAccuracy = Math.max(score, 1 - score);
          if (selected[a].structural || selected[b].structural) maximumStructuralBalancedAccuracy = Math.max(maximumStructuralBalancedAccuracy, balancedAccuracy);
          if (selected[a].claimRelative || selected[b].claimRelative) maximumClaimRelativeBalancedAccuracy = Math.max(maximumClaimRelativeBalancedAccuracy, balancedAccuracy);
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
      maximumStructuralBalancedAccuracy, maximumClaimRelativeBalancedAccuracy,
      maximumBalancedAccuracy: Math.max(maximumSingleBalancedAccuracy, maximumPairBalancedAccuracy),
      topSingleRules: singles.slice(0, 10), topPairRules: pairs, topRules: [...singles.slice(0, 10), ...pairs].sort(compare).slice(0, 10) });
    models.push(modelScore(members, truth, target));
  }
  return { schemaVersion: 'decision-d29-shortcut-audit/v3', splits: [...splits], n: rows.length,
    pairFeatureLimit: PAIR_FEATURE_LIMIT, pairSelection: 'all-structural-and-claim-relative-plus-strongest-lexical-distinct-bitsets-per-target-and-view',
    featureFamilies: ['tokens-including-stopwords', 'bigrams', 'annotation-counts', 'sentence-counts', 'formatting-counts', 'character-thresholds', 'length-bins',
      'derived-residual-counts', 'module-mention-counts', 'claim-relative-presence-counts-positions'],
    targets, topRules: targets.flatMap(target => target.topRules).sort(compare).slice(0, 10),
    modelLeakage: { method: 'stratified-5-fold-depth-3-balanced-tree', view: 'passage-and-context',
      vocabulary: 'training-fold-only-token-presence-minimum-two', informationalOnly: true,
      maximumBalancedAccuracy: Math.max(...models.map(model => model.balancedAccuracy)), targets: models },
    passed: targets.every(target => target.maximumBalancedAccuracy <= target.limit) };
}
