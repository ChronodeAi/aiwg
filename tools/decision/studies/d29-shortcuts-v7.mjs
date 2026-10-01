import { D29_TRAIN, D29_TEST } from '../../../src/decision/heldout/d29-pools.js';

const LIMITS = { injection: 0.75, readiness: 0.75, supports: 0.80, contradicts: 0.80, unclear: 0.80, 'does-not-support': 0.80 };
const MODEL_LIMITS = { injection: 0.80, readiness: 0.80, supports: 0.85, contradicts: 0.85, unclear: 0.85, 'does-not-support': 0.85 };
const VIEWS = ['passage', 'passage-and-context', 'context'];
const PAIR_FEATURE_LIMIT = 200;
const LEXICON_CANDIDATES = 40;
const LOGISTIC_FEATURES = 120;
const LOGISTIC_ITERS = 40;
const tokenize = text => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
const sentencePattern = /[.!?](?=\s|$|[)\]]|-->)/g;
const formats = [['colon', /:/g], ['quotes', /['"“”‘’]/g], ['brackets', /[\[\](){}<>]/g],
  ['html-comments', /<!--/g], ['quote-markers', /(?:^|\s)>(?=\s)/g], ['parentheses', /\(/g], ['square-brackets', /\[/g], ['semicolons', /;/g]];
/** Note-grammar phrases repointed at the actual v6/v7 operator-note pools (R2). */
const NOTE_PHRASES = [...new Set([...D29_TRAIN.roles, ...D29_TEST.roles, ...D29_TRAIN.tasks, ...D29_TEST.tasks,
  ...D29_TRAIN.timings, ...D29_TEST.timings].map(phrase => phrase.toLowerCase()))].sort((a, b) => b.length - a.length);
const NOTE_PATTERN = new RegExp(NOTE_PHRASES.map(phrase => phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
function noteMatches(lower) {
  const hits = lower.match(NOTE_PATTERN) ?? [];
  return { total: hits.length, distinct: new Set(hits).size };
}
const claimRelative = feature => feature.startsWith('claim:');
const structural = feature => /^(?:annotations|note-sentences|residual-sentences|module-mentions|note-length|format:|punctuation:|claim:entity:first-)/.test(feature);
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

/** Visible-text accounting over v6/v7 note grammar; no world, variant or gold fields enter. */
export function visibleFeatureCountsV7(payload, view = 'passage-and-context') {
  const text = viewText(payload, view), lower = text.toLowerCase();
  const sentences = text.split(sentencePattern).map(part => part.trim()).filter(Boolean);
  const notes = sentences.filter(sentence => !/Module\s+[a-z0-9]+(?:-[a-z0-9]+)*/i.test(sentence));
  const noteLengths = notes.map(sentence => sentence.length);
  const grammar = noteMatches(lower);
  const counts = { annotations: grammar.total,
    'annotations:distinct': grammar.distinct,
    'note-sentences': notes.length,
    sentences: (text.match(sentencePattern) ?? []).length,
    'module-mentions': (text.match(/\bModule\s+[a-z0-9]+(?:-[a-z0-9]+)*\b/gi) ?? []).length };
  counts['residual-sentences'] = counts.sentences - counts['note-sentences'] - counts['module-mentions'];
  counts['note-length:min'] = noteLengths.length ? Math.min(...noteLengths) : -1;
  counts['note-length:max'] = noteLengths.length ? Math.max(...noteLengths) : -1;
  counts['note-length:mean'] = noteLengths.length ? Math.round(noteLengths.reduce((a, b) => a + b, 0) / noteLengths.length) : -1;
  for (const [name, pattern] of formats) counts[`format:${name}`] = (text.match(pattern) ?? []).length;
  const claim = (payload.claim ?? payload.criterion ?? '').toLowerCase();
  const entity = /\bmodule\s+([a-z0-9]+(?:-[a-z0-9]+)*)\b/.exec(claim)?.[1];
  const attribute = /\b(port|protocol|region|owner team|owned by team|major version|rollback coverage|security review sign-off|migration test coverage)\b/.exec(claim)?.[1];
  const value = attribute && !payload.criterion ? new RegExp(`\\b${attribute} recorded for Module ${entity} is ([a-z0-9-]+)\\b`, 'i').exec(claim)?.[1]
    ?? new RegExp(`\\b${attribute}\\s+([a-z0-9-]+)\\b`, 'i').exec(claim)?.[1]
    ?? new RegExp(`\\blogged for Module ${entity} is ([a-z0-9-]+)\\b`, 'i').exec(claim)?.[1]
    ?? new RegExp(`\\b(?:bound to|limited to|admits only) (?:port|protocol|region|team|major version) ([a-z0-9-]+)\\b`, 'i').exec(claim)?.[1] : undefined;
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
  const texts = payloads.map(payload => viewText(payload, view)), counts = payloads.map(payload => visibleFeatureCountsV7(payload, view));
  const words = texts.map(tokenize), sets = words.map(tokens => new Set([
    ...tokens.map(token => `token:${token}`), ...tokens.slice(1).map((token, i) => `bigram:${tokens[i]} ${token}`),
  ]));
  const addCounts = (name, values) => {
    for (const count of [...new Set(values)].sort((a, b) => a - b)) for (let i = 0; i < texts.length; i++) {
      if (values[i] === count) sets[i].add(`${name}=${count}`);
      if (values[i] <= count) sets[i].add(`${name}<=${count}`);
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

function foldAssignments(truth) {
  let positiveFold = 0, negativeFold = 0;
  return truth.map(positive => (positive ? positiveFold++ : negativeFold++) % 5);
}

function treeFor(tokens, truth, positives, negatives, training) {
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
  return { tree: build(training, 0), vocabularyCount: candidates.length };
}

function predictTree(tree, tokens) {
  let node = tree;
  while (node.token !== undefined) node = tokens.has(node.token) ? node.yes : node.no;
  return node.prediction;
}

/** Deterministic L2 logistic regression over binary token presence. */
function logisticFor(matrix, truth, training, features) {
  const weights = new Float64Array(features + 1);
  for (let iter = 0; iter < LOGISTIC_ITERS; iter++) {
    const gradient = new Float64Array(features + 1);
    for (const i of training) {
      let score = weights[features];
      for (const f of matrix[i]) score += weights[f];
      const error = 1 / (1 + Math.exp(score)) - (truth[i] ? 0 : 1);
      for (const f of matrix[i]) gradient[f] += error;
      gradient[features] += error;
    }
    for (let f = 0; f <= features; f++) weights[f] -= 0.5 * (gradient[f] / training.length + 1e-4 * weights[f]);
  }
  return weights;
}

function predictLogistic(weights, present) {
  let score = weights[weights.length - 1];
  for (const f of present) score += weights[f];
  return score >= 0;
}

function balancedAccuracy(truth, predictions) {
  const positives = truth.filter(Boolean).length, negatives = truth.length - positives;
  const tp = truth.filter((positive, i) => positive && predictions[i]).length;
  const tn = truth.filter((positive, i) => !positive && !predictions[i]).length;
  return (tp / positives + tn / negatives) / 2;
}

/** Gated cross-validated model scores: depth-3 tree plus logistic bag-of-words (R7b). */
function modelScores(members, truth, target, testMembers = [], testTruth = []) {
  const tokens = members.map(row => new Set(tokenize(viewText(row.payload, 'passage-and-context'))));
  const assignments = foldAssignments(truth);
  const treePredictions = Array(truth.length).fill(false), logisticPredictions = Array(truth.length).fill(false);
  const folds = [];
  for (let fold = 0; fold < 5; fold++) {
    const training = truth.flatMap((_, i) => assignments[i] !== fold ? [i] : []);
    const validation = truth.flatMap((_, i) => assignments[i] === fold ? [i] : []);
    const positives = training.filter(i => truth[i]).length, negatives = training.length - positives;
    if (!positives || !negatives) throw new Error('shortcut-audit-model-support');
    const { tree, vocabularyCount } = treeFor(tokens, truth, positives, negatives, training);
    for (const i of validation) treePredictions[i] = predictTree(tree, tokens[i]);
    const counts = new Map();
    for (const i of training) for (const token of tokens[i]) counts.set(token, (counts.get(token) ?? 0) + 1);
    const vocab = [...counts].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, LOGISTIC_FEATURES).map(([token]) => token);
    const index = new Map(vocab.map((token, f) => [token, f]));
    const matrix = tokens.map(set => [...set].flatMap(token => index.has(token) ? [index.get(token)] : []));
    const weights = logisticFor(matrix, truth, training, vocab.length);
    for (const i of validation) logisticPredictions[i] = predictLogistic(weights, matrix[i]);
    folds.push({ fold, trainingCount: training.length, validationCount: validation.length, vocabularyCount });
  }
  const scored = { target, limit: MODEL_LIMITS[target], treeBalancedAccuracy: balancedAccuracy(truth, treePredictions),
    logisticBalancedAccuracy: balancedAccuracy(truth, logisticPredictions), validationCount: truth.length, folds };
  if (testMembers.length) {
    const testTokens = testMembers.map(row => new Set(tokenize(viewText(row.payload, 'passage-and-context'))));
    const positives = truth.filter(Boolean).length, negatives = truth.length - positives;
    const { tree } = treeFor(tokens, truth, positives, negatives, truth.map((_, i) => i));
    const counts = new Map();
    truth.forEach((_, i) => { for (const token of tokens[i]) counts.set(token, (counts.get(token) ?? 0) + 1); });
    const vocab = [...counts].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, LOGISTIC_FEATURES).map(([token]) => token);
    const index = new Map(vocab.map((token, f) => [token, f]));
    const weights = logisticFor(tokens.map(set => [...set].flatMap(token => index.has(token) ? [index.get(token)] : [])),
      truth, truth.map((_, i) => i), vocab.length);
    scored.treeTestBalancedAccuracy = balancedAccuracy(testTruth, testTokens.map(set => predictTree(tree, set)));
    scored.logisticTestBalancedAccuracy = balancedAccuracy(testTruth,
      testTokens.map(set => predictLogistic(weights, [...set].flatMap(token => index.has(token) ? [index.get(token)] : []))));
  }
  return scored;
}

/** Greedy OR-of-k (k up to 5) over supported tokens, learned on training folds (R7a). */
function lexiconScores(members, truth, target, testMembers = [], testTruth = []) {
  const tokens = members.map(row => new Set(tokenize(viewText(row.payload, 'passage-and-context'))));
  const assignments = foldAssignments(truth);
  const learn = training => {
    const trainPositives = training.filter(i => truth[i]).length;
    const counts = new Map();
    for (const i of training) for (const token of tokens[i]) counts.set(token, (counts.get(token) ?? 0) + 1);
    const candidates = [...counts].filter(([, count]) => count > 1 && count < training.length)
      .map(([token]) => {
        let tp = 0, fp = 0;
        for (const i of training) if (tokens[i].has(token)) { if (truth[i]) tp++; else fp++; }
        const score = (tp / trainPositives + (training.length - trainPositives - fp) / (training.length - trainPositives)) / 2;
        return { token, score: Math.max(score, 1 - score) };
      }).sort((a, b) => b.score - a.score || a.token.localeCompare(b.token)).slice(0, LEXICON_CANDIDATES);
    const selected = [];
    for (let k = 0; k < 5; k++) {
      let best = null;
      for (const { token } of candidates) {
        if (selected.includes(token)) continue;
        const trial = [...selected, token];
        let tp = 0, fp = 0;
        for (const i of training) if (trial.some(word => tokens[i].has(word))) { if (truth[i]) tp++; else fp++; }
        const score = (tp / trainPositives + (training.length - trainPositives - fp) / (training.length - trainPositives)) / 2;
        const rule = { token, balancedAccuracy: Math.max(score, 1 - score) };
        if (!best || compare({ ...rule, target, view: '', operator: 'OR', feature: '' },
          { ...best, target, view: '', operator: 'OR', feature: '' }) < 0) best = rule;
      }
      if (!best) break;
      selected.push(best.token);
    }
    return selected;
  };
  const predict = (selected, set) => selected.some(token => set.has(token));
  const foldPredictions = Array(truth.length).fill(false);
  const foldRules = [];
  for (let fold = 0; fold < 5; fold++) {
    const training = truth.flatMap((_, i) => assignments[i] !== fold ? [i] : []);
    const validation = truth.flatMap((_, i) => assignments[i] === fold ? [i] : []);
    const selected = learn(training);
    for (const i of validation) foldPredictions[i] = predict(selected, tokens[i]);
    foldRules.push({ fold, selected });
  }
  const full = learn(truth.map((_, i) => i));
  const scored = { target, limit: LIMITS[target], balancedAccuracy: balancedAccuracy(truth, foldPredictions),
    rule: full.length ? `OR(${full.join(' OR ')})` : 'OR()', validationCount: truth.length, foldRules };
  if (testMembers.length) {
    const testTokens = testMembers.map(row => new Set(tokenize(viewText(row.payload, 'passage-and-context'))));
    scored.testBalancedAccuracy = balancedAccuracy(testTruth, testTokens.map(set => predict(full, set)));
  }
  return scored;
}

/** V7 audit: dev singles/pairs plus CV lexicon, gated models and train-to-test transfer (R7). */
export function shortcutAuditV7(corpus, gold) {
  const byId = new Map(gold.rows.map(row => [row.id, row]));
  const select = splits => corpus.rows.filter(row => splits.includes(row.split)).map(row => {
    const label = byId.get(row.id);
    if (!label?.gold || typeof label.world?.injected !== 'boolean' || typeof label.gold.ready !== 'boolean'
      || ![null, 'supports', 'contradicts', 'unclear', 'does-not-support'].includes(label.gold.support)) throw new Error('shortcut-audit-gold');
    return { payload: row.input.payload, world: label.world, gold: label.gold };
  });
  const dev = select(['tuning', 'calibration']);
  const heldout = select(['test']);
  if (!dev.length || !heldout.length) throw new Error('shortcut-audit-splits');
  const targets = [], models = [], lexicons = [], heldoutTest = [];
  for (const [target, limit] of Object.entries(LIMITS)) {
    const support = !['injection', 'readiness'].includes(target);
    const members = dev.filter(row => !support || row.gold.support !== null);
    const truth = members.map(row => target === 'injection' ? row.world.injected : target === 'readiness' ? row.gold.ready : row.gold.support === target);
    const testMembers = heldout.filter(row => !support || row.gold.support !== null);
    const testTruth = testMembers.map(row => target === 'injection' ? row.world.injected : target === 'readiness' ? row.gold.ready : row.gold.support === target);
    const positives = truth.filter(Boolean).length, negatives = members.length - positives;
    if (!positives || !negatives) throw new Error('shortcut-audit-support');
    const trueBits = new Uint32Array(Math.ceil(members.length / 32));
    truth.forEach((positive, i) => { if (positive) trueBits[i >>> 5] |= 1 << (i & 31); });
    const singles = [], pairs = [], pairFeatureCounts = [];
    let pairRuleCount = 0, maximumStructuralBalancedAccuracy = 0.5, maximumClaimRelativeBalancedAccuracy = 0.5;
    const vocabularies = new Map();
    for (const view of VIEWS) {
      const key = `${support}:${view}`;
      if (!vocabularies.has(key)) vocabularies.set(key, features(members.map(row => row.payload), view));
      const vocabulary = vocabularies.get(key);
      const candidates = [];
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
      const selectCandidate = candidate => {
        const signature = candidate.bits.join(',');
        if (seen.has(signature)) {
          const previous = seen.get(signature);
          previous.structural ||= candidate.structural; previous.claimRelative ||= candidate.claimRelative;
          return false;
        }
        seen.set(signature, candidate); selected.push(candidate); return true;
      };
      for (const candidate of candidates) if (candidate.structural || candidate.claimRelative) selectCandidate(candidate);
      let lexicalCount = 0;
      for (const candidate of candidates) {
        if (candidate.structural || candidate.claimRelative) continue;
        if (selectCandidate(candidate) && ++lexicalCount === PAIR_FEATURE_LIMIT) break;
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
    // Train-to-test transfer: dev-selected rules evaluated on held-out test rows.
    const topSingles = singles.slice(0, 10), topPairs = pairs.slice(0, 10);
    const testCache = new Map();
    const testScore = rule => {
      if (!testCache.has(rule.view)) {
        testCache.set(rule.view, testMembers.map(row => {
          const toks = tokenize(viewText(row.payload, rule.view));
          return { tokens: new Set([...toks.map(token => `token:${token}`),
            ...toks.slice(1).map((token, i) => `bigram:${toks[i]} ${token}`)]),
          counts: visibleFeatureCountsV7(row.payload, rule.view) };
        }));
      }
      const cached = testCache.get(rule.view);
      const lits = rule.feature.split(` ${rule.operator} `).map(literal => {
        const inverted = literal.startsWith('NOT '), feature = inverted ? literal.slice(4) : literal;
        return { inverted, lexical: /^(?:token|bigram):/.test(feature), feature };
      });
      return balancedAccuracy(testTruth, cached.map(({ tokens, counts }) => {
        const present = lit => {
          if (lit.lexical) return tokens.has(lit.feature);
          const [name, op, raw] = lit.feature.split(/(=|<=)/);
          const actual = counts[name];
          if (typeof actual !== 'number') return false;
          return op === '=' ? actual === Number(raw) : actual <= Number(raw);
        };
        const values = lits.map(lit => lit.inverted ? !present(lit) : present(lit));
        const hit = rule.operator === 'AND' ? values.every(Boolean) : values.some(Boolean);
        return rule.polarity === 'present' ? hit : !hit;
      }));
    };
    const maximumSingleTestBalancedAccuracy = Math.max(...topSingles.map(testScore));
    const maximumPairTestBalancedAccuracy = topPairs.length ? Math.max(...topPairs.map(testScore)) : 0.5;
    targets.push({ target, positives, negatives, limit, featureCount: singles.length, pairFeatureCounts, pairRuleCount,
      maximumSingleBalancedAccuracy, maximumPairBalancedAccuracy,
      maximumStructuralBalancedAccuracy, maximumClaimRelativeBalancedAccuracy,
      maximumBalancedAccuracy: Math.max(maximumSingleBalancedAccuracy, maximumPairBalancedAccuracy),
      maximumSingleTestBalancedAccuracy, maximumPairTestBalancedAccuracy,
      topSingleRules: topSingles, topPairRules: topPairs, topRules: [...topSingles, ...topPairs].sort(compare).slice(0, 10) });
    const lexicon = lexiconScores(members, truth, target, testMembers, testTruth);
    lexicons.push(lexicon);
    heldoutTest.push({ target, limit, single: maximumSingleTestBalancedAccuracy, pair: maximumPairTestBalancedAccuracy,
      lexicon: lexicon.testBalancedAccuracy ?? null });
    models.push(modelScores(members, truth, target, testMembers, testTruth));
  }
  const gated = targets.every(target => target.maximumBalancedAccuracy <= target.limit
    && target.maximumSingleTestBalancedAccuracy <= target.limit && target.maximumPairTestBalancedAccuracy <= target.limit)
    && lexicons.every(lexicon => lexicon.balancedAccuracy <= lexicon.limit && (lexicon.testBalancedAccuracy ?? 0) <= lexicon.limit)
    && models.every(model => Math.max(model.treeBalancedAccuracy, model.logisticBalancedAccuracy) <= model.limit
      && Math.max(model.treeTestBalancedAccuracy ?? 0, model.logisticTestBalancedAccuracy ?? 0) <= model.limit);
  return { schemaVersion: 'decision-d29-shortcut-audit/v4', splits: ['tuning', 'calibration'], n: dev.length,
    testSplits: ['test'], testN: heldout.length,
    pairFeatureLimit: PAIR_FEATURE_LIMIT, pairSelection: 'all-structural-and-claim-relative-plus-strongest-lexical-distinct-bitsets-per-target-and-view',
    lexiconSelection: 'greedy-or-up-to-5-over-supported-tokens-learned-on-training-folds',
    featureFamilies: ['tokens-including-stopwords', 'bigrams', 'note-grammar-counts', 'note-sentence-counts', 'per-note-lengths',
      'formatting-counts', 'character-thresholds', 'length-bins', 'derived-residual-counts', 'module-mention-counts',
      'claim-relative-presence-counts-positions'],
    targets, topRules: targets.flatMap(target => target.topRules).sort(compare).slice(0, 10),
    lexicon: lexicons, heldoutTest,
    modelLeakage: { method: 'stratified-5-fold-depth-3-balanced-tree-plus-logistic', view: 'passage-and-context',
      vocabulary: 'training-fold-only-token-presence-minimum-two', informationalOnly: false,
      maximumBalancedAccuracy: Math.max(...models.map(model => Math.max(model.treeBalancedAccuracy, model.logisticBalancedAccuracy))),
      maximumTestBalancedAccuracy: Math.max(...models.map(model => Math.max(model.treeTestBalancedAccuracy ?? 0, model.logisticTestBalancedAccuracy ?? 0))),
      targets: models },
    passed: gated };
}
