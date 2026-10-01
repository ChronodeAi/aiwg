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
 * Record units of one generated row from visible text: { role, forms, attr,
 * value, sentence, slot } per record, plus the row layout. Only `role ===
 * 'relevant'` reads the latent world (to name the label-defining record); every
 * other field, and the blind roles, come from the claim and passage text.
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
    for (const part of sentence.split(/; (?!now |it |the current release|no independent|the present rollout|no external)/)) {
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
      const relevant = module === world.sourceModule && attribute === world.sourceAttribute;
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
      units.push({ role, forms, attr: attribute === claim.attribute ? 'claim' : 'other', value, sentence: sentenceIndex,
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
