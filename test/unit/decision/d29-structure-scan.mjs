/**
 * Record-unit structure scan for D29 v8 rows (test helper, visible text only).
 *
 * Every record unit in the passage is parsed into its role relative to the
 * claim and its surface form:
 *
 * - role: `relevant` (the record carrying the row's latent fact: same module
 *   and attribute as the world's source), and for every other record
 *   `claimed-fact` (claimed module, claim attribute or required criterion),
 *   `claimed-other` (claimed module, other attribute), `other-claim` (another
 *   module, claim attribute), `other-other` (another module, other attribute)
 *   or `near` (a module differing from the claimed module in one digit group);
 * - form: `plain`, `paraphrase`, `two-value`, `coreference`, `anchor`,
 *   `qualified`, plus the mode family (`negated`, `moved`, `exclusive`, and
 *   each criterion mode).
 *
 * Features are counts of units per (role × form) and the multiset of forms per
 * role. `exclusiveFeatures` reports every feature value whose rows all carry
 * one label (or all avoid one label) or all come from one variant, with
 * support >= `minSupport` and chance probability below `maxChance`.
 */
const ESCAPE = /[.*+?^${}()|[\]\\]/g;
const esc = text => text.replace(ESCAPE, '\\$&');
const ATTRIBUTES = { port: 'port', protocol: 'protocol', region: 'region', 'owner-team': 'owner team', 'major-version': 'major version' };
const CRITERIA = { rollback: 'rollback coverage', security: 'security review sign-off', migration: 'migration test coverage' };
const SUBJECT = '(?:Module (?<m>\\d{6}-\\d{6}-\\d{6})|(?<p>It|it|that module|That module))';
const LEAD = /^Module (\d{6}-\d{6}-\d{6}) (?:completed its scheduled migration last week|finished its planned maintenance window yesterday|closed its rollout review this morning)$/;

/**
 * Label-defining features (the documented allowlist):
 * - every form of the `relevant` record: its mode and surface are the variant;
 * - role counts (`<role>.count`): the generator holds three claimed-module,
 *   five claim-attribute and three non-claim records in every row, so each
 *   role count is a fixed function of the relevant record's role (claimed
 *   module or not, claim attribute or not, near-miss module or not), which is
 *   the label itself; V8-19 asserts that functional dependence.
 * Every other (role × form) feature must not be exclusive.
 */
export const LABEL_DEFINING = Object.freeze([/^relevant[.:]/, /\.count$/]);
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

/** Record units of one generated row: { role, forms } from visible text plus the claim sentence. */
export function recordUnits(row, pools) {
  const { payload, world } = row, kind = world.kind, train = world.pool === 'train';
  const pool = train ? pools.train : pools.test, all = poolMatchers(pool, train);
  const full = payload.source ?? payload.evidence;
  const claimModule = /Module (\d{6}-\d{6}-\d{6})/.exec(payload.claim ?? payload.criterion)[1];
  const claimAttribute = world.claimAttribute;
  const text = full.slice(full.indexOf('\n') + 1).replace(/\n> [^\n]*\n/g, ' ').replace(/\n/g, ' ')
    .replace(/<!--[^>]*-->/g, ' ').replace(/\((?:[A-Z][a-z-]+(?: [a-z-]+)*|The human runbook)[^)]*\)/g, ' ')
    .replace(/\[(?:[A-Z][a-z-]+(?: [a-z-]+)*|The human runbook)[^\]]*\]/g, ' ');
  const units = [];
  let leadModule = null, unparsed = 0;
  for (const sentence of text.split(/(?<=\.)\s+/).map(part => part.trim().replace(/\.$/, '')).filter(Boolean)) {
    if (!/Module \d|\b(?:It|it)\b|[Tt]hat module/.test(sentence)) continue;
    for (let part of sentence.split(/; (?!now |it |the current release|no independent|the present rollout|no external)/)) {
      const lead = LEAD.exec(part);
      if (lead) { leadModule = lead[1]; continue; }
      const anchorMatch = new RegExp(`, ${esc(pool.anchor)} Module (\\d{6}-\\d{6}-\\d{6}),?`).exec(part);
      if (anchorMatch) part = part.replace(anchorMatch[0], part.slice(anchorMatch.index + anchorMatch[0].length).startsWith(' the ') ? ',' : '');
      const hit = all.find(matcher => matcher.kind === kind && matcher.re.test(part));
      if (!hit) { unparsed++; continue; }
      const groups = hit.re.exec(part).groups, module = groups.m ?? leadModule;
      const attribute = kind === 'citation' ? hit.attribute : Object.entries(CRITERIA).find(([, name]) => name === groups.a)[0];
      const near = module !== claimModule && module.split('-').filter((group, i) => group === claimModule.split('-')[i]).length === 2;
      const relevant = module === world.sourceModule && attribute === world.sourceAttribute;
      const role = relevant ? 'relevant' : near ? 'near' : module === claimModule ? attribute === claimAttribute ? 'claimed-fact' : 'claimed-other'
        : attribute === claimAttribute ? 'other-claim' : 'other-other';
      const forms = [hit.mode];
      if (hit.qualified) forms.push('qualified');
      if (groups.v && / (?:and|as well as) /.test(groups.v)) forms.push('two-value');
      if (!groups.m) forms.push('coreference');
      if (anchorMatch) forms.push('anchor');
      if (forms.length === 1 && hit.mode === 'exact') forms.push('plain');
      units.push({ role, forms });
    }
  }
  return { units, unparsed };
}

const SURFACE_FORMS = ['plain', 'paraphrase', 'two-value', 'coreference', 'anchor', 'qualified'];
const MODE_FORMS = ['exact', 'negated', 'moved', 'exclusive', 'paraphrase', 'verified', 'checklist', 'explicit-none', 'planned',
  'stale', 'self-attested', 'partial'];

/**
 * Features: unit counts per role (allowlisted, see LABEL_DEFINING), and per
 * (role × form) whether any unit and whether every unit of that role carries
 * the form. Form features are undefined for rows without that role, so a
 * role's absence (a role-count fact) is never re-counted as a form fact.
 */
export function unitFeatures(units) {
  const features = {};
  for (const role of ROLES) {
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
 * maxChance. Label-defining features are skipped. Labels use both directions
 * (a "never supports" feature is a precision-1.0 cue for "not supports");
 * variants use the "only" direction.
 */
export function exclusiveFeatures(rows, featuresOf, targets, { minSupport = 5, maxChance = 1e-3, skip = LABEL_DEFINING, onlyDirection = [] } = {}) {
  const found = [];
  const table = rows.map(featuresOf);
  for (const [targetName, targetOf] of Object.entries(targets)) {
    const bothDirections = !onlyDirection.includes(targetName);
    const labels = rows.map(targetOf);
    const names = new Set(table.flatMap(features => Object.keys(features)));
    for (const name of names) {
      if (skip.some(pattern => pattern.test(name))) continue;
      // Base rates among the rows where the feature is defined: a role-form
      // feature only exists where its role does, and role presence is a
      // role-count fact (allowlisted), so it is never re-counted here.
      const groups = new Map(), rate = new Map();
      let defined = 0;
      table.forEach((features, i) => {
        if (features[name] === undefined) return;
        defined++;
        const key = String(features[name]);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(labels[i]);
      });
      table.forEach((features, i) => { if (features[name] !== undefined) rate.set(labels[i], (rate.get(labels[i]) ?? 0) + 1 / defined); });
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
