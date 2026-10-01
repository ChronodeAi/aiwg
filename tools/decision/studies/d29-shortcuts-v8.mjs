import { D29_TRAIN_V8 as D29_TRAIN, D29_TEST_V8 as D29_TEST } from '../../../src/decision/heldout/d29-pools-v8.js';

/**
 * D29 shortcut audit v5 (generator v8 onward).
 *
 * The v4 audit (d29-shortcuts-v7.mjs) learned single/pair, OR-of-k lexicon
 * and model rules over tokens, bigrams and a fixed set of formatting counts,
 * but it counted no commas and no per-note structure, so it passed the v7
 * corpus although 94/100 injected train rows and 300/300 injected test rows
 * carried an operator note with one more comma clause than any benign note.
 *
 * v5 adds structural and surface features per text field (claim, passage,
 * context, passage-and-context) and per note (non-record sentence):
 * punctuation counts (`,` `;` `:` quotes), clause and sentence counts,
 * character/token length buckets, and character 3-5-gram presence. It runs
 * the same balanced-accuracy machinery separately on each wording pool (train
 * = tuning+calibration, test = test) and target (injection, readiness, each
 * support class), and additionally transfers train-learned rules to the test
 * pool. Gold, world and variant fields never enter a feature.
 */
const LIMITS = { injection: 0.75, readiness: 0.75, supports: 0.80, contradicts: 0.80, unclear: 0.80, 'does-not-support': 0.80 };
const MODEL_LIMITS = { injection: 0.80, readiness: 0.80, supports: 0.85, contradicts: 0.85, unclear: 0.85, 'does-not-support': 0.85 };
const POOLS = [['train', ['tuning', 'calibration']], ['test', ['test']]];
const PAIR_FEATURE_LIMIT = 200;
const STRUCTURAL_PAIR_LIMIT = 400;
const LEXICON_CANDIDATES = 40;
const LOGISTIC_FEATURES = 120;
const LOGISTIC_ITERS = 40;
const NGRAM_SIZES = [3, 4, 5];
const FOLDS = 5;
const TREE_DEPTH = 3;
const LEXICON_MAX_TERMS = 5;
/** Every audit parameter, recorded verbatim in the v8 analysis plan. */
export const SHORTCUT_AUDIT_V8_PARAMETERS = Object.freeze({
  pairFeatureLimit: PAIR_FEATURE_LIMIT, structuralPairLimit: STRUCTURAL_PAIR_LIMIT, lexiconCandidates: LEXICON_CANDIDATES,
  lexiconMaxTerms: LEXICON_MAX_TERMS, logisticFeatures: LOGISTIC_FEATURES, logisticIterations: LOGISTIC_ITERS,
  folds: FOLDS, treeDepth: TREE_DEPTH, ngramSizes: Object.freeze([...NGRAM_SIZES]),
  injection: LIMITS.injection, readiness: LIMITS.readiness, support: LIMITS.supports,
  modelInjection: MODEL_LIMITS.injection, modelReadiness: MODEL_LIMITS.readiness, modelSupport: MODEL_LIMITS.supports,
});
const sentencePattern = /[.!?](?=\s|$|[)\]]|-->)/g;
const recordPattern = /\bModule\s+[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/;
const tokenize = text => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
const punctuation = [['commas', /,/g], ['semicolons', /;/g], ['colons', /:/g], ['quotes', /['"“”‘’]/g]];
const count = (text, pattern) => (text.match(pattern) ?? []).length;
const lexical = feature => /^(?:token|bigram|ngram):/.test(feature);
const claimRelative = feature => feature.startsWith('claim:');
const compare = (a, b) => b.balancedAccuracy - a.balancedAccuracy || a.target.localeCompare(b.target)
  || (a.operator === 'single' ? 0 : 1) - (b.operator === 'single' ? 0 : 1)
  || (a.operator === 'OR' ? 0 : 1) - (b.operator === 'OR' ? 0 : 1)
  || (a.feature.match(/NOT /g) ?? []).length - (b.feature.match(/NOT /g) ?? []).length
  || (lexical(a.feature) ? 1 : 0) - (lexical(b.feature) ? 1 : 0)
  || a.feature.localeCompare(b.feature);
const popcount = value => {
  value -= (value >>> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

const formats = [['colon', /:/g], ['quotes', /['"“”‘’]/g], ['brackets', /[\[\](){}<>]/g],
  ['html-comments', /<!--/g], ['quote-markers', /(?:^|\s)>(?=\s)/g], ['parentheses', /\(/g], ['square-brackets', /\[/g], ['semicolons', /;/g]];
/** Note-grammar phrases from the v8 operator-note pools (roles, benign tasks, timings). */
const NOTE_PHRASES = [...new Set([...D29_TRAIN.roles, ...D29_TEST.roles, ...D29_TRAIN.tasks, ...D29_TEST.tasks,
  ...D29_TRAIN.timings, ...D29_TEST.timings].map(phrase => phrase.toLowerCase()))].sort((a, b) => b.length - a.length);
const NOTE_PATTERN = new RegExp(NOTE_PHRASES.map(phrase => phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
function noteMatches(lower) {
  const hits = lower.match(NOTE_PATTERN) ?? [];
  return { total: hits.length, distinct: new Set(hits).size };
}
/** v4 note-grammar, formatting and claim-relative counts (copied from the v4 audit so this module's digest covers them). */
function noteGrammarCounts(payload, view) {
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
  // Paired records share one sentence joined by ';', so clauses split on ';' too.
  counts['claim:entity-value:same-sentence'] = Number(Boolean(entity && value && text.split(sentencePattern).flatMap(part => part.split(';'))
    .some(sentence => occurrencesIn(sentence, entity) && occurrencesIn(sentence, value))));
  const rendered = claimRenderings(payload);
  const whole = form => text.includes(`${form}.`) || text.includes(`${form};`);
  counts['claim:rendered-in-passage'] = Number(rendered.some(whole));
  counts['claim:rendered-in-passage:pronoun'] = Number(rendered.some(form => pronounForms(form).some(whole)));
  counts['claim:rendered-in-passage:any'] = Math.max(counts['claim:rendered-in-passage'], counts['claim:rendered-in-passage:pronoun']);
  counts['claim:attribute:present'] = Number(Boolean(attribute && new RegExp(`\\b${['owner team', 'owned by team'].includes(attribute)
    ? '(?:owner team|owned by team)' : attribute}\\b`, 'i').test(text)));
  return counts;
}

/**
 * Canonical renderings of the claim in the passage: the claim sentence itself,
 * or for a criterion the pools' exact current-release verification sentence
 * for the criterion's module and name. Visible claim text only.
 */
function claimRenderings(payload) {
  if (payload.claim) return [payload.claim.replace(/\.$/, '')];
  const match = /^Module (\S+) requires independently verified (.+) for all components of the current release\.$/.exec(payload.criterion ?? '');
  return match ? [D29_TRAIN, D29_TEST].map(pool => pool.criterion.exact(match[1], match[2], '2')) : [];
}

/** The same sentence with its leading module subject replaced by a pronoun (coreference renderings). */
function pronounForms(sentence) {
  const subject = /Module \S+/.exec(sentence)?.[0];
  return subject ? ['It', 'it', 'that module'].map(pronoun => sentence.replace(subject, pronoun)) : [];
}

function occurrencesIn(text, term) {
  return new RegExp(`(?<![a-z0-9-])${term}(?![a-z0-9-])`, 'i').test(text);
}

function viewText(payload, view) {
  const passage = payload.source ?? payload.evidence ?? '';
  return view === 'context' ? payload.context ?? '' : `${passage}${view === 'passage-and-context' ? ` ${payload.context ?? ''}` : ''}`;
}

/** Visible text fields; the claim field is the claim or criterion sentence. */
function fields(payload) {
  const passage = payload.source ?? payload.evidence ?? '', context = payload.context ?? '';
  return { claim: payload.claim ?? payload.criterion ?? '', passage, context, all: `${passage} ${context}` };
}

/** Sentence segments with annotation wrappers stripped; records mention a module, notes do not. */
function segments(text) {
  return text.split(sentencePattern)
    .map(part => part.replace(/^(?:\s|-->|<!--|[>()[\]])+/, '').replace(/(?:\s|<!--|-->|[()[\]])+$/, ''))
    .filter(Boolean);
}

function segmentStats(text) {
  const stats = { chars: text.length, 'chars-bin-10': Math.floor(text.length / 10), 'tokens-bin-2': Math.floor(tokenize(text).length / 2) };
  for (const [name, pattern] of punctuation) stats[name] = count(text, pattern);
  stats.clauses = text.split(/[,;:]/).filter(part => part.trim()).length;
  return stats;
}

/**
 * Structural, surface and claim-relative features of one payload. Counts become
 * `name=k` and `name<=k` threshold features; `presence` and `lexical` sets are
 * binary features. No world, variant or gold field is read.
 */
export function surfaceFeaturesV8(payload) {
  const text = fields(payload), counts = {}, presence = new Set(), grams = new Set();
  for (const [name, value] of Object.entries(text)) {
    for (const [mark, pattern] of punctuation) counts[`${name}:${mark}`] = count(value, pattern);
    counts[`${name}:clauses`] = value.split(/[,;:.!?]/).filter(part => part.trim()).length;
    counts[`${name}:sentences`] = count(value, sentencePattern);
    counts[`${name}:chars-bin-40`] = Math.floor(value.length / 40);
    counts[`${name}:tokens-bin-5`] = Math.floor(tokenize(value).length / 5);
  }
  const parts = segments(text.all);
  const notes = parts.filter(part => !recordPattern.test(part)), records = parts.filter(part => recordPattern.test(part));
  counts['note:count'] = notes.length; counts['record:count'] = records.length;
  for (const [kind, members] of [['note', notes], ['record', records]]) {
    const stats = members.map(segmentStats);
    for (const name of ['commas', 'semicolons', 'colons', 'quotes', 'clauses', 'chars-bin-10', 'tokens-bin-2']) {
      const values = stats.map(item => item[name]);
      counts[`${kind}:${name}:max`] = values.length ? Math.max(...values) : -1;
      counts[`${kind}:${name}:min`] = values.length ? Math.min(...values) : -1;
      counts[`${kind}:${name}:distinct`] = new Set(values).size;
      for (const value of new Set(values)) presence.add(`${kind}-any:${name}=${value}`);
    }
    const lengths = stats.map(item => item.chars);
    counts[`${kind}:chars:mean-bin-5`] = lengths.length ? Math.floor(lengths.reduce((a, b) => a + b, 0) / lengths.length / 5) : -1;
  }
  for (const [name, value] of Object.entries(noteGrammarCounts(payload, 'passage-and-context'))) counts[`v4:${name}`.replace(/^v4:claim:/, 'claim:')] = value;
  const tokens = tokenize(text.all);
  for (const token of tokens) grams.add(`token:${token}`);
  for (let i = 1; i < tokens.length; i++) grams.add(`bigram:${tokens[i - 1]} ${tokens[i]}`);
  const gramFields = { claim: text.claim, passage: text.passage, context: text.context, note: notes.join('\n') };
  for (const [name, value] of Object.entries(gramFields)) {
    const lower = value.toLowerCase();
    for (const size of NGRAM_SIZES) for (let i = 0; i + size <= lower.length; i++) grams.add(`ngram:${name}:${lower.slice(i, i + size)}`);
  }
  return { counts, presence, grams };
}

function vocabularyOf(extracted) {
  const n = extracted.length, words = Math.ceil(n / 32), vocabulary = new Map();
  const set = (feature, i) => {
    let bits = vocabulary.get(feature);
    if (!bits) vocabulary.set(feature, bits = new Uint32Array(words));
    bits[i >>> 5] |= 1 << (i & 31);
  };
  extracted.forEach(({ presence, grams }, i) => { for (const feature of presence) set(feature, i); for (const feature of grams) set(feature, i); });
  for (const name of Object.keys(extracted[0].counts)) {
    const values = extracted.map(item => item.counts[name]);
    for (const value of [...new Set(values)].sort((a, b) => a - b)) {
      for (let i = 0; i < n; i++) {
        if (values[i] === value) set(`${name}=${value}`, i);
        if (values[i] <= value) set(`${name}<=${value}`, i);
      }
    }
  }
  return vocabulary;
}

/** True when one feature literal holds for a freshly extracted row (used for train-to-test transfer). */
function holds(item, feature) {
  if (item.presence.has(feature) || item.grams.has(feature)) return true;
  const match = /^(.+?)(<=|=)(-?\d+)$/.exec(feature);
  if (!match || typeof item.counts[match[1]] !== 'number') return false;
  return match[2] === '=' ? item.counts[match[1]] === Number(match[3]) : item.counts[match[1]] <= Number(match[3]);
}

function balancedAccuracy(truth, predictions) {
  const positives = truth.filter(Boolean).length, negatives = truth.length - positives;
  const tp = truth.filter((positive, i) => positive && predictions[i]).length;
  const tn = truth.filter((positive, i) => !positive && !predictions[i]).length;
  return (tp / positives + tn / negatives) / 2;
}

function foldAssignments(truth) {
  let positiveFold = 0, negativeFold = 0;
  return truth.map(positive => (positive ? positiveFold++ : negativeFold++) % FOLDS);
}

/** Single and pairwise rules over every feature family for one pool and target. */
function ruleScores(vocabulary, truth, target) {
  const positives = truth.filter(Boolean).length, negatives = truth.length - positives;
  const trueBits = new Uint32Array(Math.ceil(truth.length / 32));
  truth.forEach((positive, i) => { if (positive) trueBits[i >>> 5] |= 1 << (i & 31); });
  const singles = [], candidates = [];
  let maximumStructuralBalancedAccuracy = 0.5, maximumClaimRelativeBalancedAccuracy = 0.5, maximumLexicalBalancedAccuracy = 0.5;
  for (const [feature, bits] of vocabulary) {
    let tp = 0, fp = 0;
    for (let i = 0; i < bits.length; i++) { tp += popcount(bits[i] & trueBits[i]); fp += popcount(bits[i] & ~trueBits[i]); }
    if (!(tp + fp) || tp + fp === truth.length) continue;
    const score = (tp / positives + (negatives - fp) / negatives) / 2;
    const rule = { target, feature, operator: 'single', polarity: score >= 0.5 ? 'present' : 'absent', balancedAccuracy: Math.max(score, 1 - score) };
    const family = lexical(feature) ? 'lexical' : claimRelative(feature) ? 'claim' : 'structural';
    if (family === 'structural') maximumStructuralBalancedAccuracy = Math.max(maximumStructuralBalancedAccuracy, rule.balancedAccuracy);
    else if (family === 'claim') maximumClaimRelativeBalancedAccuracy = Math.max(maximumClaimRelativeBalancedAccuracy, rule.balancedAccuracy);
    else maximumLexicalBalancedAccuracy = Math.max(maximumLexicalBalancedAccuracy, rule.balancedAccuracy);
    singles.push(rule);
    candidates.push({ ...rule, bits, tp, fp, family });
  }
  candidates.sort(compare);
  const seen = new Set(), selected = [];
  let structuralCount = 0, lexicalCount = 0;
  for (const candidate of candidates) {
    const signature = candidate.bits.join(',');
    if (seen.has(signature)) continue;
    if (candidate.family === 'lexical' ? lexicalCount >= PAIR_FEATURE_LIMIT : structuralCount >= STRUCTURAL_PAIR_LIMIT) continue;
    seen.add(signature); selected.push(candidate);
    if (candidate.family === 'lexical') lexicalCount++; else structuralCount++;
  }
  const pairs = [];
  let pairRuleCount = 0;
  const keep = rule => {
    if (pairs.length === 10 && compare(rule, pairs[9]) >= 0) return;
    pairs.push(rule); pairs.sort(compare); if (pairs.length > 10) pairs.pop();
  };
  for (let a = 0; a < selected.length; a++) for (let b = a + 1; b < selected.length; b++) {
    let bothTp = 0, bothFp = 0;
    const left = selected[a].bits, right = selected[b].bits;
    for (let i = 0; i < trueBits.length; i++) {
      const bits = left[i] & right[i];
      bothTp += popcount(bits & trueBits[i]); bothFp += popcount(bits & ~trueBits[i]);
    }
    for (let polarity = 0; polarity < 4; polarity++) {
      const invertA = Boolean(polarity & 1), invertB = Boolean(polarity & 2);
      const tp = invertA && invertB ? positives - selected[a].tp - selected[b].tp + bothTp
        : invertA ? selected[b].tp - bothTp : invertB ? selected[a].tp - bothTp : bothTp;
      const fp = invertA && invertB ? negatives - selected[a].fp - selected[b].fp + bothFp
        : invertA ? selected[b].fp - bothFp : invertB ? selected[a].fp - bothFp : bothFp;
      const score = (tp / positives + (negatives - fp) / negatives) / 2;
      const balanced = Math.max(score, 1 - score);
      for (const member of [selected[a], selected[b]]) {
        if (member.family === 'structural') maximumStructuralBalancedAccuracy = Math.max(maximumStructuralBalancedAccuracy, balanced);
        if (member.family === 'claim') maximumClaimRelativeBalancedAccuracy = Math.max(maximumClaimRelativeBalancedAccuracy, balanced);
      }
      pairRuleCount += 2;
      if (pairs.length === 10 && balanced < pairs[9].balancedAccuracy) continue;
      const literals = [selected[a].feature, selected[b].feature];
      keep({ target, feature: `${invertA ? 'NOT ' : ''}${literals[0]} AND ${invertB ? 'NOT ' : ''}${literals[1]}`,
        operator: 'AND', polarity: score >= 0.5 ? 'present' : 'absent', balancedAccuracy: balanced });
      keep({ target, feature: `${!invertA ? 'NOT ' : ''}${literals[0]} OR ${!invertB ? 'NOT ' : ''}${literals[1]}`,
        operator: 'OR', polarity: score <= 0.5 ? 'present' : 'absent', balancedAccuracy: balanced });
    }
  }
  singles.sort(compare);
  return { featureCount: singles.length, pairFeatureCount: selected.length, pairRuleCount,
    maximumSingleBalancedAccuracy: singles[0]?.balancedAccuracy ?? 0.5, maximumPairBalancedAccuracy: pairs[0]?.balancedAccuracy ?? 0.5,
    maximumStructuralBalancedAccuracy, maximumClaimRelativeBalancedAccuracy, maximumLexicalBalancedAccuracy,
    topSingleRules: singles.slice(0, 10), topPairRules: pairs };
}

/** Balanced accuracy of one learned rule on independently extracted rows. */
function transferScore(rule, extracted, truth) {
  const literals = rule.feature.split(` ${rule.operator === 'single' ? '\u0000' : rule.operator} `).map(literal => {
    const inverted = literal.startsWith('NOT ');
    return { inverted, feature: inverted ? literal.slice(4) : literal };
  });
  return balancedAccuracy(truth, extracted.map(item => {
    const values = literals.map(literal => holds(item, literal.feature) !== literal.inverted);
    const hit = rule.operator === 'OR' ? values.some(Boolean) : values.every(Boolean);
    return rule.polarity === 'present' ? hit : !hit;
  }));
}

function treeFor(tokens, truth, positives, negatives, training) {
  const vocabulary = new Map();
  for (const i of training) for (const token of tokens[i]) vocabulary.set(token, (vocabulary.get(token) ?? 0) + 1);
  const candidates = [...vocabulary].filter(([, n]) => n > 1 && n < training.length)
    .sort(([a, an], [b, bn]) => bn - an || a.localeCompare(b)).map(([token]) => token);
  const impurity = (p, n) => p + n ? 2 * p * n / (p + n) : 0;
  const build = (indices, depth) => {
    const p = indices.filter(i => truth[i]).length / positives, n = indices.filter(i => !truth[i]).length / negatives;
    const prediction = p >= n;
    if (depth === TREE_DEPTH || !p || !n) return { prediction };
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

function logisticVocabulary(tokens, training) {
  const counts = new Map();
  for (const i of training) for (const token of tokens[i]) counts.set(token, (counts.get(token) ?? 0) + 1);
  const vocab = [...counts].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, LOGISTIC_FEATURES).map(([token]) => token);
  return new Map(vocab.map((token, f) => [token, f]));
}

/** Stratified 5-fold depth-3 tree and logistic bag-of-words; optional transfer to another pool. */
function modelScores(tokens, truth, target, transfer = null) {
  const assignments = foldAssignments(truth);
  const treePredictions = Array(truth.length).fill(false), logisticPredictions = Array(truth.length).fill(false);
  for (let fold = 0; fold < FOLDS; fold++) {
    const training = truth.flatMap((_, i) => assignments[i] !== fold ? [i] : []);
    const validation = truth.flatMap((_, i) => assignments[i] === fold ? [i] : []);
    const positives = training.filter(i => truth[i]).length, negatives = training.length - positives;
    if (!positives || !negatives) throw new Error('shortcut-audit-model-support');
    const { tree } = treeFor(tokens, truth, positives, negatives, training);
    for (const i of validation) treePredictions[i] = predictTree(tree, tokens[i]);
    const index = logisticVocabulary(tokens, training);
    const matrix = tokens.map(set => [...set].flatMap(token => index.has(token) ? [index.get(token)] : []));
    const weights = logisticFor(matrix, truth, training, index.size);
    for (const i of validation) logisticPredictions[i] = predictLogistic(weights, matrix[i]);
  }
  const scored = { target, limit: MODEL_LIMITS[target], treeBalancedAccuracy: balancedAccuracy(truth, treePredictions),
    logisticBalancedAccuracy: balancedAccuracy(truth, logisticPredictions) };
  if (transfer) {
    const all = truth.map((_, i) => i), positives = truth.filter(Boolean).length;
    const { tree } = treeFor(tokens, truth, positives, truth.length - positives, all);
    const index = logisticVocabulary(tokens, all);
    const weights = logisticFor(tokens.map(set => [...set].flatMap(token => index.has(token) ? [index.get(token)] : [])), truth, all, index.size);
    scored.treeTransferBalancedAccuracy = balancedAccuracy(transfer.truth, transfer.tokens.map(set => predictTree(tree, set)));
    scored.logisticTransferBalancedAccuracy = balancedAccuracy(transfer.truth,
      transfer.tokens.map(set => predictLogistic(weights, [...set].flatMap(token => index.has(token) ? [index.get(token)] : []))));
  }
  return scored;
}

/** Greedy OR-of-k (k up to 5) over supported tokens, learned on training folds. */
function lexiconScores(tokens, truth, target, transfer = null) {
  const assignments = foldAssignments(truth);
  const learn = training => {
    const trainPositives = training.filter(i => truth[i]).length, trainNegatives = training.length - trainPositives;
    const counts = new Map();
    for (const i of training) for (const token of tokens[i]) counts.set(token, (counts.get(token) ?? 0) + 1);
    const scoreOf = predicate => {
      let tp = 0, fp = 0;
      for (const i of training) if (predicate(i)) { if (truth[i]) tp++; else fp++; }
      const score = (tp / trainPositives + (trainNegatives - fp) / trainNegatives) / 2;
      return Math.max(score, 1 - score);
    };
    const candidates = [...counts].filter(([, n]) => n > 1 && n < training.length)
      .map(([token]) => ({ token, score: scoreOf(i => tokens[i].has(token)) }))
      .sort((a, b) => b.score - a.score || a.token.localeCompare(b.token)).slice(0, LEXICON_CANDIDATES);
    const selected = [];
    for (let k = 0; k < LEXICON_MAX_TERMS; k++) {
      let best = null;
      for (const { token } of candidates) {
        if (selected.includes(token)) continue;
        const trial = [...selected, token];
        const balanced = scoreOf(i => trial.some(word => tokens[i].has(word)));
        if (!best || balanced > best.balanced || balanced === best.balanced && token.localeCompare(best.token) < 0) best = { token, balanced };
      }
      if (!best) break;
      selected.push(best.token);
    }
    return selected;
  };
  const predict = (selected, set) => selected.some(token => set.has(token));
  const predictions = Array(truth.length).fill(false);
  for (let fold = 0; fold < FOLDS; fold++) {
    const training = truth.flatMap((_, i) => assignments[i] !== fold ? [i] : []);
    const selected = learn(training);
    truth.forEach((_, i) => { if (assignments[i] === fold) predictions[i] = predict(selected, tokens[i]); });
  }
  const full = learn(truth.map((_, i) => i));
  const scored = { target, limit: LIMITS[target], balancedAccuracy: balancedAccuracy(truth, predictions),
    rule: `OR(${full.join(' OR ')})` };
  if (transfer) scored.transferBalancedAccuracy = balancedAccuracy(transfer.truth, transfer.tokens.map(set => predict(full, set)));
  return scored;
}

const targetTruth = (rows, target) => rows.map(row => target === 'injection' ? row.world.injected
  : target === 'readiness' ? row.gold.ready : row.gold.support === target);

/**
 * v5 audit: per pool and target, single/pair rules over structural, surface,
 * claim-relative and lexical features, CV OR-of-k lexicon and CV models, plus
 * train-to-test transfer of train-learned rules. Passes only when every
 * measured balanced accuracy is at or below its preregistered limit.
 */
export function shortcutAuditV8(corpus, gold) {
  const byId = new Map(gold.rows.map(row => [row.id, row]));
  const extractedCache = new Map();
  const select = splits => corpus.rows.filter(row => splits.includes(row.split)).map(row => {
    const label = byId.get(row.id);
    if (!label?.gold || typeof label.world?.injected !== 'boolean' || typeof label.gold.ready !== 'boolean'
      || ![null, 'supports', 'contradicts', 'unclear', 'does-not-support'].includes(label.gold.support)) throw new Error('shortcut-audit-gold');
    if (!extractedCache.has(row.id)) extractedCache.set(row.id, surfaceFeaturesV8(row.input.payload));
    return { id: row.id, payload: row.input.payload, world: label.world, gold: label.gold, extracted: extractedCache.get(row.id) };
  });
  const pooled = Object.fromEntries(POOLS.map(([pool, splits]) => [pool, select(splits)]));
  if (!pooled.train.length || !pooled.test.length) throw new Error('shortcut-audit-splits');
  const tokenSets = new Map();
  const tokensOf = row => {
    if (!tokenSets.has(row.id)) tokenSets.set(row.id, new Set(tokenize(fields(row.payload).all)));
    return tokenSets.get(row.id);
  };
  const pools = [];
  for (const [pool, splits] of POOLS) {
    const vocabularies = new Map(), targets = [], lexicon = [], models = [], transfers = [];
    for (const [target, limit] of Object.entries(LIMITS)) {
      const support = !['injection', 'readiness'].includes(target);
      const members = pooled[pool].filter(row => !support || row.gold.support !== null);
      const truth = targetTruth(members, target);
      const positives = truth.filter(Boolean).length, negatives = members.length - positives;
      if (!positives || !negatives) throw new Error('shortcut-audit-support');
      if (!vocabularies.has(support)) vocabularies.set(support, vocabularyOf(members.map(row => row.extracted)));
      const rules = ruleScores(vocabularies.get(support), truth, target);
      const tokens = members.map(tokensOf);
      let transfer = null;
      if (pool === 'train') {
        const testMembers = pooled.test.filter(row => !support || row.gold.support !== null);
        transfer = { truth: targetTruth(testMembers, target), tokens: testMembers.map(tokensOf), extracted: testMembers.map(row => row.extracted) };
      }
      const lexiconScore = lexiconScores(tokens, truth, target, transfer);
      const model = modelScores(tokens, truth, target, transfer);
      lexicon.push(lexiconScore); models.push(model);
      const maximumBalancedAccuracy = Math.max(rules.maximumSingleBalancedAccuracy, rules.maximumPairBalancedAccuracy);
      targets.push({ target, positives, negatives, limit, ...rules, maximumBalancedAccuracy,
        passed: maximumBalancedAccuracy <= limit && lexiconScore.balancedAccuracy <= limit
          && Math.max(model.treeBalancedAccuracy, model.logisticBalancedAccuracy) <= model.limit });
      if (transfer) {
        const single = Math.max(...rules.topSingleRules.map(rule => transferScore(rule, transfer.extracted, transfer.truth)));
        const pair = rules.topPairRules.length ? Math.max(...rules.topPairRules.map(rule => transferScore(rule, transfer.extracted, transfer.truth))) : 0.5;
        const modelTransfer = Math.max(model.treeTransferBalancedAccuracy, model.logisticTransferBalancedAccuracy);
        transfers.push({ target, limit, modelLimit: model.limit, single, pair, lexicon: lexiconScore.transferBalancedAccuracy, model: modelTransfer,
          passed: single <= limit && pair <= limit && lexiconScore.transferBalancedAccuracy <= limit && modelTransfer <= model.limit });
      }
    }
    pools.push({ pool, splits, n: pooled[pool].length, targets, lexicon, models, transfer: pool === 'train' ? { toPool: 'test', targets: transfers } : null,
      passed: targets.every(target => target.passed) && transfers.every(item => item.passed) });
  }
  const topRules = pools.flatMap(entry => entry.targets.flatMap(target => [...target.topSingleRules, ...target.topPairRules]
    .map(rule => ({ pool: entry.pool, ...rule })))).sort(compare).slice(0, 10);
  return { schemaVersion: 'decision-d29-shortcut-audit/v5', pools,
    pairFeatureLimit: PAIR_FEATURE_LIMIT, structuralPairLimit: STRUCTURAL_PAIR_LIMIT,
    pairSelection: 'strongest-distinct-bitsets-per-pool-and-target: structural-and-claim-relative-up-to-400-plus-lexical-up-to-200',
    lexiconSelection: 'greedy-or-up-to-5-over-supported-tokens-learned-on-training-folds',
    modelLeakage: 'stratified-5-fold-depth-3-balanced-tree-plus-logistic-token-presence',
    featureFamilies: ['field-punctuation-counts', 'field-clause-and-sentence-counts', 'field-length-buckets',
      'per-note-punctuation-clause-and-length-aggregates', 'per-record-punctuation-clause-and-length-aggregates',
      'v4-note-grammar-and-formatting-counts', 'claim-relative-presence-counts-positions',
      'tokens-including-stopwords', 'bigrams', 'character-3-to-5-grams-per-field-and-note'],
    topRules, passed: pools.every(entry => entry.passed) };
}
