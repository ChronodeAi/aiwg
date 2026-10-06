/**
 * Record-unit structure scans for D29 v8 rows (test helper, visible text only).
 *
 * Every record unit in the passage is parsed into its role relative to the
 * claim, its attribute and value class, its surface form and its place:
 *
 * - role: `relevant` (the record carrying the row's latent fact: same module
 *   and attribute as the world's source), and for every other record
 *   `claimed-fact` (claimed module, claim attribute or required criterion),
 *   `claimed-other` (claimed module, other attribute), `other-claim` (another
 *   module, claim attribute), `other-other` (another module, other attribute)
 *   or `near` (a module differing from the claimed module in one digit group);
 * - attr / value: claim attribute or not; for citations, whether a
 *   claim-attribute record names the claimed value;
 * - form: `plain`, `paraphrase`, `two-value`, `coreference`, `anchor`,
 *   `qualified`, plus the mode family (`negated`, `moved`, `exclusive`, and
 *   each criterion mode);
 * - place: logical sentence index and slot (`single`, or `left`/`right` in the
 *   one paired sentence), plus the row layout (operator notes per place and
 *   format, the paired sentence's index).
 *
 * Two scans use these units:
 *
 * - The blind-mode scan (`blindFeatures`, `blindExclusive`, `blindTree`)
 *   reads ONLY records about modules that are neither the claimed module nor
 *   a near-miss of it (`other-claim`, `other-other`), plus layout. It never
 *   reads a label-defining record, so any precision-1.0 group or any
 *   train-to-test rule that separates a label or variant is a cue by
 *   construction. It has no allowlist.
 * - The non-blind scan (`unitFeatures`, `exclusiveFeatures`) reads every
 *   non-relevant role, with the explicit allowlist `NON_BLIND_ALLOWED`.
 */
const ESCAPE = /[.*+?^${}()|[\]\\]/g;
const esc = text => text.replace(ESCAPE, '\\$&');
const ATTRIBUTES = { port: 'port', protocol: 'protocol', region: 'region', 'owner-team': 'owner team', 'major-version': 'major version' };
const CRITERIA = { rollback: 'rollback coverage', security: 'security review sign-off', migration: 'migration test coverage' };
const SUBJECT = '(?:Module (?<m>\\d{6}-\\d{6}-\\d{6})|(?<p>It|it|that module|That module))';
const LEAD = /^Module (\d{6}-\d{6}-\d{6}) (?:completed its scheduled migration last week|finished its planned maintenance window yesterday|closed its rollout review this morning)$/;

/**
 * Non-blind allowlist: the feature names, by exact name, that the non-blind
 * scan may find exclusive, each with its justification. The relevant record's
 * own forms are not features at all (they are the variant). Nothing else is
 * allowed: since the round-8 generator draws every non-relevant record from
 * one label-independent distribution, no role count or role-form feature is
 * label-defining, and the list is empty.
 */
export const NON_BLIND_ALLOWED = Object.freeze([]);
export const ROLES = Object.freeze(['relevant', 'claimed-fact', 'claimed-other', 'other-claim', 'other-other', 'near']);

function matchers(pool, train) {
  const out = [];
  for (const [mode, template] of Object.entries(pool.criterion)) {
    const text = template('\u0001', '\u0002', '\u0003');
    const re = esc(text).replace('Module \u0001', SUBJECT).replace('\u0001', SUBJECT)
      .replace('\u0002', `(?<a>${Object.values(CRITERIA).map(esc).join('|')})`).replace(/\u0002/g, '\\k<a>').replace('\u0003', '\\d');
    out.push({ kind: 'phase-criterion', mode, re: new RegExp(`^${re}$`) });
  }
  for (const [attribute, verbs] of Object.entries(pool.verbs)) {
    const name = ATTRIBUTES[attribute], value = '(?<v>[A-Za-z0-9]+(?: (?:and|as well as) [A-Za-z0-9]+)?)';
    const forms = [['exact', `${SUBJECT} ${esc(verbs.direct)} ${value}`], ['negated', `${SUBJECT} ${esc(verbs.negated)} ${value}`],
      ['paraphrase', `[Tt]he ${esc(name)} ${esc(pool.paraphraseVerb)} for ${SUBJECT} is ${value}`],
      ['moved', train ? `${SUBJECT} ${esc(verbs.movedOut)} ${value}; now ${esc(verbs.direct)} [A-Za-z0-9]+`
        : `${SUBJECT} ${esc(verbs.movedOut)} ${value}; it ${esc(verbs.movedIn)} [A-Za-z0-9]+`],
      ['exclusive', train ? `${SUBJECT} ${esc(verbs.direct)} ${value}, with no alternatives` : `${SUBJECT} ${esc(verbs.exclusiveOnly)} ${value}, nothing else`],
      ['exclusive', train ? `For ${SUBJECT}, the ${esc(name)} is restricted to ${value}` : `${SUBJECT} ${esc(verbs.exclusiveLimited)} ${value}`]];
    for (const [mode, body] of forms) {
      out.push({ kind: 'citation', attribute, mode, re: new RegExp(`^${body}$`) });
      for (const tail of pool.scoped) out.push({ kind: 'citation', attribute, mode, qualified: true, re: new RegExp(`^${body} ${esc(tail)}$`) });
      for (const tail of pool.temporal) out.push({ kind: 'citation', attribute, mode, qualified: true,
        re: new RegExp(`^${body}, (?:according to the inventory|as recorded|as logged|as filed) ${esc(tail)}$`) });
      for (const head of pool.tentative) out.push({ kind: 'citation', attribute, mode, qualified: true, re: new RegExp(`^${esc(head)} ${body.replace('[Tt]he', 'the')}$`) });
    }
  }
  return out;
}

const cache = new WeakMap();
function poolMatchers(pool, train) {
  if (!cache.has(pool)) cache.set(pool, matchers(pool, train));
  return cache.get(pool);
}

const NOTE_FORMATS = [['quote', /\n> [^\n]*\n/g], ['comment', /<!--[^>]*-->/g],
  ['paren', /\((?:[A-Z][a-z-]+(?: [a-z-]+)*|The human runbook)[^)]*\)/g], ['bracket', /\[(?:[A-Z][a-z-]+(?: [a-z-]+)*|The human runbook)[^\]]*\]/g]];
const NOTE_MARK = '\u0005';

/** Replaces every annotated operator note with a marker sentence; counts notes per format. */
function markNotes(text, formats) {
  for (const [format, pattern] of NOTE_FORMATS) {
    text = text.replace(pattern, () => { formats[format] = (formats[format] ?? 0) + 1; return ` ${NOTE_MARK}. `; });
  }
  return text.replace(/\n/g, ' ');
}

/** The claim's module, attribute and (citation) value, from the claim sentence alone. */
function claimOf(payload, kind, all) {
  const text = (payload.claim ?? payload.criterion).replace(/\.$/, '');
  const module = /Module (\d{6}-\d{6}-\d{6})/.exec(text)[1];
  if (kind !== 'citation') return { module, attribute: Object.entries(CRITERIA).find(([, name]) => text.includes(`verified ${name} for`))[0], value: null };
  const hit = all.find(matcher => matcher.kind === 'citation' && matcher.mode === 'exact' && !matcher.qualified && matcher.re.test(text));
  return { module, attribute: hit.attribute, value: hit.re.exec(text).groups.v };
}

/**
 * Record units of one generated row from visible text: { role, forms,
 * attribute, attr, value, sentence, slot } per record, plus the row layout.
 * Only `role === 'relevant'` reads generator metadata (the rendered position of
 * the label-defining record, `world.factPosition`); every other field, and the
 * blind roles, come from the claim and passage text.
 */
export function recordUnits(row, pools) {
  const { payload, world } = row, kind = world.kind, train = world.pool === 'train';
  const pool = train ? pools.train : pools.test, all = poolMatchers(pool, train);
  const full = payload.source ?? payload.evidence;
  const claim = claimOf(payload, kind, all);
  const formats = {};
  const roleNote = new RegExp(`^(?:The human runbook says ')?(?:${pool.roles.map(esc).join('|')}), `);
  const countNotes = text => (text.match(new RegExp(`(?:${pool.roles.map(esc).join('|')}), `, 'g')) ?? []).length;
  const notesContext = countNotes(payload.context ?? '');
  const notesTotal = notesContext + countNotes(full);
  markNotes(payload.context ?? '', formats);
  const text = markNotes(full.slice(full.indexOf('\n') + 1), formats);
  formats.plain = notesTotal - Object.values(formats).reduce((a, b) => a + b, 0);
  // Logical sentences: a coreference lead ("Module X <lead>.") continues into
  // the next sentence, whose first record takes the lead's place.
  const logical = [], notesAt = [];
  let current = null, continues = false, unparsed = 0;
  for (const sentence of text.split(/(?<=\.)\s+/).map(part => part.trim().replace(/\.$/, '')).filter(Boolean)) {
    if (sentence === NOTE_MARK || roleNote.test(sentence)) { notesAt.push(logical.length); continue; }
    if (!/Module \d|\b(?:It|it)\b|[Tt]hat module/.test(sentence)) continue;
    if (!continues) { current = []; logical.push(current); }
    continues = false;
    for (const part of sentence.split(/; (?!now |it |its current release|its present rollout|the current release|no independent|the present rollout|no external)/)) {
      const lead = LEAD.exec(part);
      if (lead) { current.push({ lead: lead[1] }); continues = true; } else current.push({ part });
    }
  }
  const units = [];
  let leadModule = null;
  logical.forEach((parts, sentenceIndex) => {
    const records = [];
    for (const item of parts) {
      if (item.lead) { leadModule = item.lead; continue; }
      records.push(item.part);
    }
    records.forEach((original, position) => {
      let part = original;
      const anchorMatch = new RegExp(`, ${esc(pool.anchor)} Module (\\d{6}-\\d{6}-\\d{6}),?`).exec(part);
      if (anchorMatch) part = part.replace(anchorMatch[0], part.slice(anchorMatch.index + anchorMatch[0].length).startsWith(' the ') ? ',' : '');
      const hit = all.find(matcher => matcher.kind === kind && matcher.re.test(part));
      if (!hit) { unparsed++; return; }
      const groups = hit.re.exec(part).groups, module = groups.m ?? leadModule;
      const attribute = kind === 'citation' ? hit.attribute : Object.entries(CRITERIA).find(([, name]) => name === groups.a)[0];
      const near = module !== claim.module && module.split('-').filter((group, i) => group === claim.module.split('-')[i]).length === 2;
      // The relevant record by its rendered identity: the generator records the
      // passage sentence that holds it (`world.factPosition`), and it is never
      // paired. Matching module and attribute instead would also catch a
      // claimed-module distractor that shares the relevant criterion.
      const relevant = sentenceIndex === world.factPosition && records.length === 1;
      const role = relevant ? 'relevant' : near ? 'near' : module === claim.module ? attribute === claim.attribute ? 'claimed-fact' : 'claimed-other'
        : attribute === claim.attribute ? 'other-claim' : 'other-other';
      const forms = [hit.mode];
      if (hit.qualified) forms.push('qualified');
      if (groups.v && / (?:and|as well as) /.test(groups.v)) forms.push('two-value');
      if (!groups.m) forms.push('coreference');
      if (anchorMatch) forms.push('anchor');
      if (forms.length === 1 && hit.mode === 'exact') forms.push('plain');
      const value = kind !== 'citation' || attribute !== claim.attribute ? 'none'
        : groups.v.split(/ (?:and|as well as) /).includes(claim.value) ? 'claimed' : 'other';
      units.push({ role, forms, attribute, attr: attribute === claim.attribute ? 'claim' : 'other', value, sentence: sentenceIndex,
        slot: records.length === 1 ? 'single' : position === 0 ? 'left' : 'right' });
    });
  });
  const layout = { notesContext, notesPassage: notesAt.length, notesAt, formats, sentences: logical.length,
    pair: logical.findIndex(parts => parts.filter(item => item.part).length > 1) };
  return { units, unparsed, layout };
}

const SURFACE_FORMS = ['plain', 'paraphrase', 'two-value', 'coreference', 'anchor', 'qualified'];
const MODE_FORMS = ['exact', 'negated', 'moved', 'exclusive', 'paraphrase', 'verified', 'checklist', 'explicit-none', 'planned',
  'stale', 'self-attested', 'partial'];

/**
 * Non-blind features: unit counts per non-relevant role, and per (role × form)
 * whether any unit and whether every unit of that role carries the form. Form
 * features are undefined for rows without that role, so a role's absence (a
 * role-count fact, scanned on its own) is never re-counted as a form fact. The
 * relevant record is not a feature: its role and forms are the variant.
 */
export function unitFeatures(units) {
  const features = {};
  for (const role of ROLES.filter(name => name !== 'relevant')) {
    const mine = units.filter(unit => unit.role === role);
    features[`${role}.count`] = mine.length;
    if (!mine.length) continue;
    for (const form of [...SURFACE_FORMS, ...MODE_FORMS.map(mode => `mode-${mode}`)]) {
      const tag = form.startsWith('mode-') ? form.slice(5) : form;
      const carriers = mine.filter(unit => unit.forms.includes(tag)).length;
      features[`${role}:${form}:any`] = carriers > 0;
      features[`${role}:${form}:all`] = carriers === mine.length;
    }
  }
  for (const form of ['paraphrase', 'two-value', 'coreference', 'anchor', 'qualified']) {
    features[`any-non-relevant:${form}`] = units.filter(unit => unit.role !== 'relevant' && unit.forms.includes(form)).length;
  }
  return features;
}

/**
 * Precision-1.0 groups: a feature value whose rows (>= minSupport) all share
 * one value of a target, or (for targets not in `onlyDirection`) all avoid
 * one value, where that pattern would arise by chance with probability below
 * maxChance. Allowed feature names (by exact name) are skipped, and a row
 * whose target is undefined is outside that target's population. Labels use both directions
 * (a "never supports" feature is a precision-1.0 cue for "not supports");
 * variants use the "only" direction.
 */
export function exclusiveFeatures(rows, featuresOf, targets, { minSupport = 5, maxChance = 1e-3, allowed = NON_BLIND_ALLOWED, onlyDirection = [] } = {}) {
  const found = [];
  const table = rows.map(featuresOf);
  for (const [targetName, targetOf] of Object.entries(targets)) {
    const bothDirections = !onlyDirection.includes(targetName);
    const labels = rows.map(targetOf);
    const names = new Set(table.flatMap(features => Object.keys(features)));
    for (const name of names) {
      if (allowed.includes(name)) continue;
      // Base rates among the rows where the feature is defined: a role-form
      // feature only exists where its role does, and role presence is a
      // role-count fact (scanned as `<role>.count`), so it is never re-counted here.
      const groups = new Map(), rate = new Map();
      let defined = 0;
      const inScope = i => table[i][name] !== undefined && labels[i] !== undefined;
      table.forEach((features, i) => {
        if (!inScope(i)) return;
        defined++;
        const key = String(features[name]);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(labels[i]);
      });
      table.forEach((features, i) => { if (inScope(i)) rate.set(labels[i], (rate.get(labels[i]) ?? 0) + 1 / defined); });
      for (const [value, ys] of groups) {
        if (ys.length < minSupport) continue;
        for (const [label, p] of rate) {
          const all = ys.every(y => y === label), none = bothDirections && ys.every(y => y !== label);
          const chance = all ? p ** ys.length : none ? (1 - p) ** ys.length : 1;
          if ((all || none) && chance < maxChance) {
            found.push({ target: targetName, feature: name, value, label, direction: all ? 'only' : 'never', support: ys.length, chance });
          }
        }
      }
    }
  }
  return found;
}

/**
 * Per-row counts over every record unit (all roles, as a reader sees them): one
 * count per form or mode tag (qualified, exact, negated, moved, exclusive,
 * paraphrase, two-value, coreference, and each criterion mode).
 */
export function countFeatures(units) {
  const counts = {};
  for (const tag of [...SURFACE_FORMS, ...MODE_FORMS]) counts[`count:${tag}`] = units.filter(unit => unit.forms.includes(tag)).length;
  counts['count:verified-family'] = units.filter(unit => ['exact', 'verified', 'checklist'].some(tag => unit.forms.includes(tag))).length;
  return counts;
}

/**
 * Best single-threshold rule (`count >= t` or `count < t`) per count feature and
 * one-vs-rest label, by balanced accuracy.
 */
export function countRuleBalancedAccuracy(rows, countsOf, labelOf) {
  const table = rows.map(countsOf), labels = rows.map(labelOf), best = [];
  for (const label of new Set(labels)) {
    const truth = labels.map(value => value === label), positives = truth.filter(Boolean).length, negatives = truth.length - positives;
    if (!positives || !negatives) continue;
    for (const name of Object.keys(table[0])) {
      const values = table.map(features => features[name]);
      for (const threshold of new Set(values)) {
        let tp = 0, fp = 0;
        values.forEach((value, i) => { if (value >= threshold) { if (truth[i]) tp++; else fp++; } });
        const score = (tp / positives + (negatives - fp) / negatives) / 2;
        best.push({ label, feature: name, threshold, balancedAccuracy: Math.max(score, 1 - score) });
      }
    }
  }
  return best.sort((a, b) => b.balancedAccuracy - a.balancedAccuracy);
}

/** Roles the blind-mode scan reads: records about modules that are neither the claimed module nor a near-miss of it. */
export const BLIND_ROLES = Object.freeze(['other-claim', 'other-other']);
const unitDims = unit => ({ attr: unit.attr, value: unit.value, mode: unit.forms[0], qualified: String(unit.forms.includes('qualified')),
  'two-value': String(unit.forms.includes('two-value')), coreference: String(unit.forms.includes('coreference')),
  anchor: String(unit.forms.includes('anchor')), slot: unit.slot });

/**
 * Blind-mode features of one row (a set of names): over the blind units only,
 * per single dimension and per pair of dimensions (attr, value, mode,
 * qualified, two-value, coreference, anchor, slot), the unit count (`n[k]=c`
 * and `n[k]>=t`), and per single dimension the first and last sentence index
 * and the dimension value at each blind-unit index and sentence; plus layout:
 * notes in context and passage, notes per format, each passage note's place,
 * the paired sentence's index, the logical sentence count and the blind unit
 * count. `simple` names (counts and layout) are the ones paired in the scan.
 */
export function blindFeatures({ units, layout }) {
  const blind = units.filter(unit => BLIND_ROLES.includes(unit.role));
  const features = new Set(), counts = new Map(), first = new Map(), last = new Map();
  blind.forEach((unit, index) => {
    const dims = Object.entries(unitDims(unit)).map(([name, value]) => `${name}=${value}`);
    const keys = [...dims, ...dims.flatMap((a, i) => dims.slice(i + 1).map(b => `${a}&${b}`))];
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    for (const key of dims) {
      if (!first.has(key)) first.set(key, unit.sentence);
      last.set(key, unit.sentence);
      features.add(`unit${index}[${key}]`);
      features.add(`sentence${unit.sentence}[${key}]`);
    }
  });
  for (const [key, count] of counts) {
    features.add(`n[${key}]=${count}`);
    for (let t = 1; t <= count; t++) features.add(`n[${key}]>=${t}`);
  }
  for (const [key, at] of first) { features.add(`first[${key}]@${at}`); features.add(`last[${key}]@${last.get(key)}`); }
  features.add(`blind=${blind.length}`);
  features.add(`notes.context=${layout.notesContext}`);
  features.add(`notes.passage=${layout.notesPassage}`);
  for (const [format, count] of Object.entries(layout.formats)) features.add(`notes.${format}=${count}`);
  for (const at of layout.notesAt) features.add(`note@${at}`);
  features.add(`pair@${layout.pair}`);
  features.add(`sentences=${layout.sentences}`);
  return features;
}
const simpleBlind = name => /^(?:n\[|blind=|notes\.|note@|pair@|sentences=)/.test(name);

const popcount = words => {
  let total = 0;
  for (let value of words) {
    value -= (value >>> 1) & 0x55555555;
    value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
    total += (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  return total;
};
function bitset(n, has) {
  const words = new Uint32Array(Math.ceil(n / 32));
  for (let i = 0; i < n; i++) if (has(i)) words[i >> 5] |= 1 << (i & 31);
  return words;
}
const and = (a, b, out, negate = false) => { for (let i = 0; i < a.length; i++) out[i] = a[i] & (negate ? ~b[i] : b[i]); return out; };

/**
 * Blind-mode precision-1.0 groups in one domain (rows of one kind and pool):
 * single features (present or absent) and conjunctions of two simple features
 * whose rows (>= minSupport) all carry one target value (`only`), or for
 * targets not in `onlyDirection` all avoid it (`never`), where that pattern
 * arises by chance with probability below maxChance. `targets` maps a name to
 * a row function returning a value, or undefined for rows outside that
 * target's population. Returns `target|value|direction|features` keys.
 */
export function blindExclusive(rows, featureSets, targets, { minSupport = 5, maxChance = 1e-3, onlyDirection = [] } = {}) {
  const hits = new Set();
  for (const [targetName, targetOf] of Object.entries(targets)) {
    const values = rows.map(targetOf), members = rows.map((_, i) => i).filter(i => values[i] !== undefined);
    const n = members.length;
    if (!n) continue;
    const names = [...new Set(members.flatMap(i => [...featureSets[i]]))];
    const bits = new Map();
    for (const name of names) {
      const present = bitset(n, j => featureSets[members[j]].has(name));
      bits.set(name, present);
      if (!simpleBlind(name) || name.includes(']>=')) bits.set(`NOT ${name}`, present.map(word => ~word));
    }
    const full = bitset(n, () => true);
    for (const value of bits.values()) and(value, full, value);
    const unique = new Map();
    for (const [name, value] of bits) {
      const support = popcount(value);
      if (support < minSupport || support === n) continue;
      const hash = Buffer.from(value.buffer).toString('base64');
      if (!unique.has(hash)) unique.set(hash, { name, value, support });
    }
    const labels = [...new Set(members.map(i => values[i]))].map(label => ({ label, set: bitset(n, j => values[members[j]] === label) }));
    for (const entry of labels) entry.p = popcount(entry.set) / n;
    const tmp = new Uint32Array(full.length);
    const test = (value, support, name) => {
      for (const { label, set, p } of labels) {
        if (p === 0 || p === 1) continue;
        const inside = popcount(and(value, set, tmp));
        if (inside === support && p ** support < maxChance) hits.add(`${targetName}|${label}|only|${name}`);
        if (!onlyDirection.includes(targetName) && inside === 0 && (1 - p) ** support < maxChance) hits.add(`${targetName}|${label}|never|${name}`);
      }
    };
    const list = [...unique.values()];
    for (const { name, value, support } of list) test(value, support, name);
    const simple = list.filter(entry => simpleBlind(entry.name.replace(/^NOT /, '')));
    const conjunction = new Uint32Array(full.length);
    for (let a = 0; a < simple.length; a++) for (let b = a + 1; b < simple.length; b++) {
      and(simple[a].value, simple[b].value, conjunction);
      const support = popcount(conjunction);
      if (support < minSupport || support === simple[a].support || support === simple[b].support) continue;
      test(conjunction, support, [simple[a].name, simple[b].name].sort().join(' && '));
    }
  }
  return hits;
}

/**
 * Blind-mode decision stump and depth-2 tree, learned on the train pool and
 * scored on the test pool by balanced accuracy, per target value (one vs
 * rest). Roots are the 100 best train stumps; each child split is chosen per
 * side. Returns the best stump and tree test scores per target value.
 */
export function blindTree(trainRows, trainSets, testRows, testSets, targets) {
  const results = [];
  for (const [targetName, targetOf] of Object.entries(targets)) {
    const trainIdx = trainRows.map((_, i) => i).filter(i => targetOf(trainRows[i]) !== undefined);
    const testIdx = testRows.map((_, i) => i).filter(i => targetOf(testRows[i]) !== undefined);
    const testNames = new Set(testIdx.flatMap(i => [...testSets[i]]));
    const names = [...new Set(trainIdx.flatMap(i => [...trainSets[i]]))].filter(name => testNames.has(name));
    const TR = { n: trainIdx.length, full: bitset(trainIdx.length, () => true) }, TE = { n: testIdx.length, full: bitset(testIdx.length, () => true) };
    const seen = new Set(), features = [];
    for (const name of names) {
      const train = bitset(TR.n, j => trainSets[trainIdx[j]].has(name));
      const hash = Buffer.from(train.buffer).toString('base64');
      if (seen.has(hash)) continue;
      seen.add(hash);
      features.push({ name, train, test: bitset(TE.n, j => testSets[testIdx[j]].has(name)) });
    }
    for (const label of new Set(trainIdx.map(i => targetOf(trainRows[i])))) {
      const yTR = bitset(TR.n, j => targetOf(trainRows[trainIdx[j]]) === label), yTE = bitset(TE.n, j => targetOf(testRows[testIdx[j]]) === label);
      const P = popcount(yTR), N = TR.n - P, Pt = popcount(yTE), Nt = TE.n - Pt;
      if (P < 3 || N < 3 || Pt < 3 || Nt < 3) continue;
      const t1 = new Uint32Array(TR.full.length), t2 = new Uint32Array(TR.full.length), u1 = new Uint32Array(TE.full.length);
      // Leaf: [score contribution, predict positive] on train; evaluate the same prediction on test.
      const leaf = region => {
        const pos = popcount(and(region, yTR, t1)) / P, neg = popcount(and(region, yTR, t2, true)) / N;
        return pos >= neg ? [pos / 2, true] : [neg / 2, false];
      };
      const score = (region, positive) => (positive ? popcount(and(region, yTE, u1)) / Pt : popcount(and(region, yTE, u1, true)) / Nt) / 2;
      const complement = (value, full) => and(full, value, new Uint32Array(full.length), true);
      const stumps = features.map(feature => {
        const left = leaf(feature.train), right = leaf(complement(feature.train, TR.full));
        return { feature, train: left[0] + right[0], left: left[1], right: right[1] };
      }).sort((a, b) => b.train - a.train);
      const best = stumps[0];
      const stumpTest = score(best.feature.test, best.left) + score(complement(best.feature.test, TE.full), best.right);
      let tree = { train: 0 };
      const x = new Uint32Array(TR.full.length);
      for (const root of stumps.slice(0, 100)) {
        const sides = [root.feature.train, complement(root.feature.train, TR.full)];
        const children = sides.map(side => {
          let pick = { score: -1 };
          for (const child of features) {
            const inside = leaf(and(side, child.train, x)), outside = leaf(and(side, child.train, x, true));
            if (inside[0] + outside[0] > pick.score) pick = { score: inside[0] + outside[0], child, inside: inside[1], outside: outside[1] };
          }
          return pick;
        });
        if (children[0].score + children[1].score > tree.train) tree = { train: children[0].score + children[1].score, root, children };
      }
      const testSides = [tree.root.feature.test, complement(tree.root.feature.test, TE.full)];
      const treeTest = tree.children.reduce((sum, child, i) => sum + score(and(testSides[i], child.child.test, new Uint32Array(TE.full.length)), child.inside)
        + score(and(testSides[i], child.child.test, new Uint32Array(TE.full.length), true), child.outside), 0);
      results.push({ target: targetName, label, stump: stumpTest, stumpFeature: best.feature.name, tree: treeTest,
        treeFeatures: [tree.root.feature.name, ...tree.children.map(child => child.child.name)] });
    }
  }
  return results;
}

const VERIFIED_FAMILY = ['exact', 'verified', 'checklist'];

/**
 * Claimed-module distractor features (a set of names): every record about the
 * claimed module with a non-claim attribute or criterion except the relevant
 * record itself (identified by rendered position). Counts, per-family counts,
 * per-attribute multiplicity, the family multiset of each same-attribute
 * group, verified-family records per group, and family pairs within a group.
 */
export function claimedDistractorFeatures({ units }) {
  const mine = units.filter(unit => unit.role === 'claimed-other');
  const features = new Set([`cd.n=${mine.length}`]);
  const familyOf = unit => unit.forms.includes('qualified') ? 'qualified' : unit.forms[0];
  const families = new Map();
  for (const unit of mine) families.set(familyOf(unit), (families.get(familyOf(unit)) ?? 0) + 1);
  for (const [family, count] of families) for (let t = 1; t <= count; t++) features.add(`cd.fam.${family}>=${t}`);
  const groups = new Map();
  for (const unit of mine) groups.set(unit.attribute, [...(groups.get(unit.attribute) ?? []), familyOf(unit)]);
  const sizes = [...groups.values()].map(group => group.length).sort();
  features.add(`cd.distinct=${groups.size}`);
  features.add(`cd.mult=${sizes.join(',')}`);
  features.add(`cd.maxGroup=${Math.max(0, ...sizes)}`);
  const verified = [...groups.values()].map(group => group.filter(family => VERIFIED_FAMILY.includes(family)).length);
  features.add(`cd.maxVerifiedGroup=${Math.max(0, ...verified)}`);
  for (const group of groups.values()) {
    features.add(`cd.group=${[...group].sort().join('+')}`);
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) features.add(`cd.pair=${[group[i], group[j]].sort().join('+')}`);
  }
  return features;
}

/** Numeric claimed-module distractor counts for single-threshold count rules. */
export function claimedDistractorCounts({ units }) {
  const mine = units.filter(unit => unit.role === 'claimed-other');
  const groups = new Map();
  for (const unit of mine) groups.set(unit.attribute, [...(groups.get(unit.attribute) ?? []), unit.forms[0]]);
  const counts = { 'cd.n': mine.length, 'cd.distinct': groups.size, 'cd.maxGroup': Math.max(0, ...[...groups.values()].map(group => group.length)),
    'cd.maxVerifiedGroup': Math.max(0, ...[...groups.values()].map(group => group.filter(mode => VERIFIED_FAMILY.includes(mode)).length)) };
  for (const tag of [...MODE_FORMS, 'qualified']) counts[`cd.count:${tag}`] = mine.filter(unit => unit.forms.includes(tag)).length;
  counts['cd.count:verified-family'] = mine.filter(unit => VERIFIED_FAMILY.some(tag => unit.forms.includes(tag))).length;
  return counts;
}

/**
 * Count rules learned on one pool and scored on another: per target value and
 * count feature, the best single-threshold rule (`>= t` or `< t`) on the
 * training rows, scored by balanced accuracy on the evaluation rows. Returns
 * the rules sorted by evaluation score.
 */
export function countRuleTransfer(trainRows, testRows, countsOf, labelOf) {
  const out = [];
  const tableTrain = trainRows.map(countsOf), tableTest = testRows.map(countsOf);
  const yTrain = trainRows.map(labelOf), yTest = testRows.map(labelOf);
  const score = (values, labels, label, threshold) => {
    let tp = 0, fp = 0, positives = 0;
    values.forEach((value, i) => { const positive = labels[i] === label; positives += positive; if (value >= threshold) { if (positive) tp++; else fp++; } });
    const negatives = values.length - positives;
    return positives && negatives ? (tp / positives + (negatives - fp) / negatives) / 2 : 0.5;
  };
  for (const label of new Set(yTrain)) {
    for (const name of Object.keys(tableTrain[0] ?? {})) {
      const train = tableTrain.map(features => features[name]), test = tableTest.map(features => features[name]);
      let best = { score: 0 };
      for (const threshold of new Set(train)) {
        const s = score(train, yTrain, label, threshold);
        if (Math.max(s, 1 - s) > best.score) best = { score: Math.max(s, 1 - s), threshold, flip: s < 0.5 };
      }
      if (best.threshold === undefined) continue;
      const s = score(test, yTest, label, best.threshold);
      out.push({ label, feature: name, threshold: best.threshold, train: best.score, balancedAccuracy: best.flip ? 1 - s : s });
    }
  }
  return out.sort((a, b) => b.balancedAccuracy - a.balancedAccuracy);
}

/** Binary features from per-row counts (`name>=t` for every observed t >= 1). */
export function countBinaryFeatures(counts) {
  const features = new Set();
  for (const [name, count] of Object.entries(counts)) for (let t = 1; t <= count; t++) features.add(`${name}>=${t}`);
  return features;
}

/**
 * Features of the relevant record alone (identified by rendered position): its
 * mode family, mode, each surface form, slot and sentence index. `kind` names
 * the feature class (`mode` or `surface` or `place`) for the label-defining
 * rule in `relevantLabelDefining`.
 */
export function relevantFeatures({ units }) {
  const unit = units.find(item => item.role === 'relevant');
  const features = new Map();
  if (!unit) return features;
  const mode = unit.forms[0];
  const family = VERIFIED_FAMILY.includes(mode) ? 'verified-family' : mode;
  features.set(`mode=${mode}`, 'mode');
  features.set(`family=${family}`, 'mode');
  features.set(`qualified=${unit.forms.includes('qualified')}`, 'mode');
  for (const form of ['plain', 'paraphrase', 'two-value']) features.set(`${form}=${unit.forms.includes(form)}`, 'surface');
  features.set(`coreference=${unit.forms.includes('coreference')}`, 'place');
  features.set(`sentence=${unit.sentence}`, 'place');
  return features;
}

/**
 * Which relevant-record feature classes define a variant: the mode for every
 * variant rendered by its own mode (and the claimed-fact variants whose value
 * relation needs the exact mode), the surface for the supports variants and
 * the injection counterparts. Mode-free variants (D29_V8_MODE_FREE_VARIANTS)
 * have none.
 */
export function relevantLabelDefining(variant, modeFree) {
  if (modeFree.includes(variant)) return [];
  if (['exact', 'paraphrase', 'multi-value', 'injection'].includes(variant)) return ['mode', 'surface'];
  return ['mode'];
}

const variantOfRow = row => row.slice.endsWith('-injection') ? 'injection' : row.world.variant;
const twoValuedClaim = row => ['port', 'protocol'].includes(row.world.claimAttribute);
/** Whether a variant target covers a row: the rows whose claim attribute admits that variant (d29WorldV4 applicability). */
export function variantAdmits(variant, row) {
  if (['multi-value', 'different-nonexclusive'].includes(variant)) return twoValuedClaim(row);
  if (variant === 'different-current') return !twoValuedClaim(row);
  return true;
}

/**
 * Relevant-record-only scores: per kind, pool and variant (one vs rest among
 * rows admitting it; the injection variant against its population), the
 * balanced accuracy of every single relevant-record feature that does not
 * define that variant (`relevantLabelDefining`). Rows with no provider
 * requests are left out. Returns scores sorted high to low.
 */
export function relevantOnlyScores(rows, parsed, { modeFree, inInjectionPopulation }) {
  const out = [];
  const scored = rows.filter(row => row.world.artifactPresent && row.world.testPassed);
  for (const kind of ['citation', 'phase-criterion']) for (const pool of ['train', 'test']) {
    const members = scored.filter(row => row.world.kind === kind && row.world.pool === pool);
    const features = new Map(members.map(row => [row, relevantFeatures(parsed.get(row))]));
    for (const variant of new Set(members.map(variantOfRow))) {
      const scope = variant === 'injection' ? members.filter(inInjectionPopulation)
        : members.filter(row => variantOfRow(row) !== 'injection' && variantAdmits(variant, row));
      const positives = scope.filter(row => variantOfRow(row) === variant), negatives = scope.filter(row => variantOfRow(row) !== variant);
      if (!positives.length || !negatives.length) continue;
      const skip = relevantLabelDefining(variant, modeFree);
      const names = new Map();
      for (const row of scope) for (const [name, cls] of features.get(row)) names.set(name, cls);
      for (const [name, cls] of names) {
        if (skip.includes(cls)) continue;
        const tp = positives.filter(row => features.get(row).has(name)).length / positives.length;
        const fp = negatives.filter(row => features.get(row).has(name)).length / negatives.length;
        out.push({ score: Math.max((tp + 1 - fp) / 2, (1 - tp + fp) / 2), what: `${kind}/${pool} ${variant} ${name} ${tp.toFixed(2)}/${fp.toFixed(2)}` });
      }
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * All-record (relevant-inclusive) count rules and count-feature trees for every
 * variant (one vs rest among rows admitting it), learned on one pool and
 * scored on the other, both ways. Returns scores sorted high to low.
 */
export function allRecordVariantScores(rows, parsed) {
  const out = [];
  const counts = new Map(rows.map(row => [row, countFeatures(parsed.get(row).units)]));
  const sets = new Map(rows.map(row => [row, countBinaryFeatures(counts.get(row))]));
  for (const kind of ['citation', 'phase-criterion']) {
    const train = rows.filter(row => row.world.kind === kind && row.world.pool === 'train');
    const test = rows.filter(row => row.world.kind === kind && row.world.pool === 'test');
    for (const [from, to, direction] of [[train, test, 'train->test'], [test, train, 'test->train']]) {
      for (const variant of new Set(from.map(variantOfRow))) {
        const targetOf = row => variantAdmits(variant, row) ? String(variantOfRow(row) === variant) : undefined;
        const a = from.filter(row => targetOf(row) !== undefined), b = to.filter(row => targetOf(row) !== undefined);
        for (const result of blindTree(a, a.map(row => sets.get(row)), b, b.map(row => sets.get(row)), { variant: targetOf })) {
          if (result.label === 'true') out.push({ score: Math.max(result.stump, result.tree), what: `${kind} ${direction} tree ${variant} [${result.treeFeatures.join(' | ')}]` });
        }
        const [best] = countRuleTransfer(a, b, row => counts.get(row), targetOf).filter(rule => rule.label === 'true');
        if (best) out.push({ score: best.balancedAccuracy, what: `${kind} ${direction} count ${variant} ${best.feature}>=${best.threshold}` });
      }
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * Round 16: clauses that assert a record but have no determinable subject.
 *
 * The visible text (claim or criterion, passage, context) is split into
 * clauses at `.`, `;`, line breaks, comment delimiters and the note brackets.
 * A clause asserts a record when it names a criterion, or an attribute noun
 * together with a value. Such a clause must name a module identifier, or be a
 * coreference (`it` / `its` / `that module`, or a subject ellipsis opening
 * with `now`) whose immediately preceding clause names a module or is itself
 * such a coreference. Returns the offending clauses.
 */
const MODULE_ID = /\bModule \d{6}-\d{6}-\d{6}\b/;
const CRITERION_NAMES = /\b(?:rollback coverage|security review sign-off|migration test coverage)\b/;
const ATTRIBUTE_NOUN = /\b(?:port|protocol|region|team|major version)\b/;
const ATTRIBUTE_VALUE = /\b(?:\d+|QUIC|TCP|UDP|SCTP|east|west|north|south|Cedar|Maple|Birch|Aspen)\b/;
const ANAPHOR = /^(?:it|now)\b|\b(?:it|its|that module)\b/i;
export function clausesOf(payload) {
  const text = [payload.claim ?? payload.criterion, payload.source ?? payload.evidence, payload.context].filter(Boolean).join('\n');
  return text.split(/\.(?=\s|$)|;|\n|<!--|-->|[()[\]]|^>\s/m).map(clause => clause.replace(/^\s*>\s*/, '').trim()).filter(Boolean);
}
export function assertsRecord(clause) {
  return CRITERION_NAMES.test(clause) || (ATTRIBUTE_NOUN.test(clause) && ATTRIBUTE_VALUE.test(clause));
}
export function subjectlessClauses(payload) {
  const clauses = clausesOf(payload), found = [];
  // A clause has a determinable subject when it names a module, or when it is a
  // coreference and its immediately preceding clause has one (so `Module N …. It
  // was released from port V; it is currently bound to port W` resolves to N).
  const resolved = [];
  clauses.forEach((clause, i) => {
    resolved[i] = MODULE_ID.test(clause) || (ANAPHOR.test(clause) && i > 0 && resolved[i - 1]);
    if (assertsRecord(clause) && !resolved[i]) found.push(clause);
  });
  return found;
}
