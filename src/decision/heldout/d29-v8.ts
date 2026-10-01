import { readFileSync } from 'node:fs';
import { sha256 } from '../compile-cache/identity.js';
import { d29Baseline, d29WorldV4, drawD29Stream, D29_V4_VARIANTS } from './generators.js';
import { d29PassageBaseline } from './d29-passage-baseline.js';
import { d29PassageBaselineV2 } from './d29-passage-baseline-v2.js';
import { d29PassageBaselineV3 } from './d29-passage-baseline-v3.js';
import { D29_TEST_V8, D29_TRAIN_V8, type D29WordPoolV8 } from './d29-pools-v8.js';
import type { HeldoutRow } from './types.js';

/**
 * D29 synthetic generator v8.
 *
 * Same latent worlds (d29WorldV4), splits, slices, variants and train/test
 * wording pools as v7, with three construction fixes found on the public v7
 * seed:
 *
 * 1. Operator notes: benign and injected notes render from one two-slot
 *    template (`<Role>, <clause>, <clause> <timing>.`); an injection occupies a
 *    slot that benign notes fill with a benign task (see d29-pools-v8.ts).
 * 2. Moves always change the value: the `different` value of every record is
 *    drawn after its final attribute and value are fixed.
 * 3. Distractor records about the claimed module never contradict that
 *    module's own facts: citation distractors use pairwise distinct
 *    attributes (and never the relevant record's attribute), and criterion
 *    distractors that share a criterion carry compatible modes.
 * 4. The distractor layer (seven records: roles, values, modes, surface
 *    forms) is drawn from one distribution that never reads the variant, the
 *    label or the relevant record, and the relevant record is inserted
 *    afterwards, so no fixed total is completed by the label-defining record.
 *
 * Note text is drawn per family while note count, format and placement stay
 * scheduled by family offset, so slices keep matched layouts without sharing
 * identical note text across every slice.
 */
export { D29_V8_GENERATOR_ID, D29_V8_SEED } from './d29-generator-ids.js';

type GeneratedRow = Omit<HeldoutRow, 'provenance'>;
const attributes = ['port', 'protocol', 'region', 'owner-team', 'major-version'] as const;
const criteria = ['rollback', 'security', 'migration'] as const;
const names: Record<string, string> = { rollback: 'rollback coverage', security: 'security review sign-off', migration: 'migration test coverage' };
const noun = (attribute: string) => attribute.replaceAll('-', ' ');
const options: Record<string, string[]> = { protocol: ['QUIC', 'TCP', 'UDP', 'SCTP'], region: ['east', 'west', 'north', 'south'],
  'owner-team': ['Cedar', 'Maple', 'Birch', 'Aspen'], 'major-version': ['3', '4', '5', '6'] };

/**
 * Criterion modes that may describe the same module and criterion without
 * contradiction: all-verified forms agree with each other; the not-yet,
 * previous-only, self-attested and partial forms agree where none asserts
 * what another denies.
 */
const COMPATIBLE_CRITERION_MODES = new Set(['checklist|exact', 'checklist|verified', 'exact|verified',
  'explicit-none|planned', 'planned|stale', 'planned|self-attested', 'partial|planned', 'self-attested|stale']);
export function d29V8CompatibleCriterionModes(a: string, b: string): boolean {
  // Identical modes would render the identical sentence twice, so they never pair.
  return COMPATIBLE_CRITERION_MODES.has([a, b].sort().join('|'));
}

function drawPort(random: (bound: number) => number): string {
  return String(random(2) === 0 ? 1000 + random(50000) : 51000 + random(14000));
}

function drawValue(random: (bound: number) => number, attribute: string, exclude: string): string {
  if (attribute === 'port') {
    for (;;) {
      const value = drawPort(random);
      if (value !== exclude) return value;
    }
  }
  const choices = options[attribute].filter(value => value !== exclude);
  return choices[random(choices.length)];
}

function fact(pool: D29WordPoolV8, train: boolean, module: string, attribute: string, value: string, different: string, mode: string): string {
  const verbs = pool.verbs[attribute], name = noun(attribute);
  if (mode === 'paraphrase') return `The ${name} ${pool.paraphraseVerb} for Module ${module} is ${value}`;
  if (mode === 'negated') return `Module ${module} ${verbs.negated} ${value}`;
  if (mode === 'moved') return train
    ? `Module ${module} ${verbs.movedOut} ${value}; now ${verbs.direct} ${different}`
    : `Module ${module} ${verbs.movedOut} ${value}; it ${verbs.movedIn} ${different}`;
  if (mode === 'exclusive-single') return train
    ? `Module ${module} ${verbs.direct} ${value}, with no alternatives`
    : `Module ${module} ${verbs.exclusiveOnly} ${value}, nothing else`;
  if (mode === 'exclusive-restricted') return train
    ? `For Module ${module}, the ${name} is restricted to ${value}`
    : `Module ${module} ${verbs.exclusiveLimited} ${value}`;
  return `Module ${module} ${verbs.direct} ${value}`;
}

function qualify(pool: D29WordPoolV8, train: boolean, text: string, mode: string, pick: number): string {
  if (mode === 'scoped') return `${text} ${pool.scoped[pick % pool.scoped.length]}`;
  if (mode === 'temporal') return train
    ? `${text}, according to the inventory ${pool.temporal[pick % pool.temporal.length]}`
    : `${text}, ${['as recorded', 'as logged', 'as filed'][pick % 3]} ${pool.temporal[pick % pool.temporal.length]}`;
  if (mode === 'tentative') return `${pool.tentative[pick % pool.tentative.length]} ${text.startsWith('The ') ? `the ${text.slice(4)}` : text}`;
  return text;
}

function annotation(text: string, format: number): string {
  return [text, `<!-- ${text} -->`, `\n> ${text}\n`, `(${text})`, `[${text}]`][format];
}

function coreference(module: string, sentence: string, lead: string, pronoun: string): string {
  const target = `Module ${module}`, at = sentence.indexOf(target);
  const form = at <= 0 ? pronoun : pronoun.charAt(0).toLowerCase() + pronoun.slice(1);
  return `${lead} ${at < 0 ? sentence : sentence.slice(0, at) + form + sentence.slice(at + target.length)}`;
}

const coreferenceLeads = ['completed its scheduled migration last week', 'finished its planned maintenance window yesterday', 'closed its rollout review this morning'];

/** Mode families: each distractor draws a family uniformly, then a mode inside it. */
const CITATION_MODE_FAMILIES: Record<string, readonly string[]> = { exact: ['exact'], negated: ['negated'], moved: ['moved'],
  exclusive: ['exclusive-single', 'exclusive-restricted'], qualified: ['scoped', 'temporal', 'tentative'] };
const CRITERION_MODE_FAMILIES: Record<string, readonly string[]> = { verified: ['exact', 'verified', 'checklist'],
  'explicit-none': ['explicit-none'], planned: ['planned'], stale: ['stale'], 'self-attested': ['self-attested'], partial: ['partial'] };

/**
 * Characters the seven criterion distractors may use beyond the default mix
 * (every mode once, less the longest one, which the relevant record may take),
 * so the budget rarely binds and no pair of long modes is excluded.
 */
const CRITERION_LENGTH_SLACK = 120;

/** Distractor modes that may render as a paraphrase, and as a two-value list. */
const PARAPHRASE_MODES = ['exact', 'scoped', 'temporal', 'tentative'];
const TWO_VALUE_MODES = ['exact', 'negated', 'exclusive-single', 'exclusive-restricted', 'scoped', 'temporal', 'tentative'];

/** Single-clause rendering modes that may carry the anchor relative clause. */
const ANCHOR_MODES = ['negated', 'exclusive-restricted', 'scoped', 'temporal', 'tentative'];

/** The variant a non-injected counterpart row at this offset renders (supports / ready mix). */
function counterpartVariant(citation: boolean, claimAttribute: string, offset: number): string {
  const variants = D29_V4_VARIANTS[citation ? 'citation-supports' : 'criterion-ready'];
  const applicable = variants.filter(variant => !(['multi-value', 'different-nonexclusive'].includes(variant) && !['port', 'protocol'].includes(claimAttribute)));
  const width = citation ? attributes.length : criteria.length;
  return applicable[(Math.floor(offset / width) + offset % width) % applicable.length];
}

export function d29WorldV8(seed: string, ordinal: number) {
  const base = d29WorldV4(seed, ordinal);
  const train = base.split !== 'test';
  const pool = train ? D29_TRAIN_V8 : D29_TEST_V8;
  const world = { ...base.world, pool: train ? 'train' as const : 'test' as const };
  const offset = Number(base.familyId.split('-').at(-1));
  const seedKey = sha256(seed);
  // Structure (record order, note count/format/placement) is scheduled per
  // family offset, so every slice at one offset shares a layout; content
  // (identifiers, values, note text) is drawn per family.
  const schedule = drawD29Stream(base.split, `v8:${seedKey}:schedule:${offset}`);
  const random = drawD29Stream(base.split, `v8:${base.familyId}`);
  const citation = world.kind === 'citation';
  const modes = citation ? ['exact', 'negated', 'moved', 'exclusive-single', 'exclusive-restricted', 'scoped', 'temporal', 'tentative']
    : ['exact', 'verified', 'checklist', 'explicit-none', 'planned', 'stale', 'self-attested', 'partial'];
  // Injected rows render their relevant fact with the mode mix of their
  // non-injected counterpart slice (citation-supports, criterion-ready), drawn
  // by the same offset rule d29WorldV4 uses, so a verbatim claim rendering
  // cannot mark the injected class. Their latent support is unchanged.
  const renderVariant = world.injected ? counterpartVariant(citation, world.claimAttribute, offset) : world.variant;
  const relevantMode = modes.includes(renderVariant) ? renderVariant : 'exact';
  const identifier = () => Array.from({ length: 3 }, () => String(100000 + random(900000))).join('-');
  type Record8 = { role: 'relevant' | 'carrier' | 'claimed' | 'other'; mode: string; module: string; attribute: string; value: string;
    different: string; pick: number; k: string; paraphrase: boolean; second: string };
  const blank = { different: '', pick: 0, k: '2', paraphrase: false, second: '' };
  const relevantRecord: Record8 = { ...blank, role: 'relevant', mode: relevantMode, module: world.sourceModule, attribute: world.sourceAttribute,
    value: world.sourceValue };
  const relevantOnClaimedModule = relevantRecord.module === world.claimModule;
  // The distractor layer: seven records drawn from one distribution that never
  // reads the variant, the label or the relevant record (round-8 review). Its
  // role counts, values, modes and surface forms are the same in every slice,
  // and the relevant record is inserted afterwards, so no total (records per
  // role, claimed-value mentions, records per mode family) is completed by the
  // relevant record: each total is a label-independent distractor count plus
  // whatever the relevant record itself contributes.
  // - slot 0, the carrier: another module, claim attribute (citation: the
  //   claimed value, single-clause mode, carrying the anchor clause);
  // - slots 1..n, n drawn uniformly from 1-3: the claimed module, pairwise
  //   distinct non-claim attributes (criterion: non-claim criteria whose modes
  //   agree with every other claimed-module record on that criterion);
  // - the rest: other modules, claim attribute with probability 1/2
  //   (citation: the claimed value with probability 1/2), else a non-claim
  //   attribute.
  // Modes: family uniform, then mode within the family, i.i.d. per record; a
  // length budget on the seven distractors alone keeps requests inside the
  // preregistered token bound with slack, independently of the relevant record.
  const layer = drawD29Stream(base.split, `v8:${base.familyId}:layer`);
  const families = citation ? CITATION_MODE_FAMILIES : CRITERION_MODE_FAMILIES;
  const familyNames = Object.keys(families);
  const familyMode = () => { const family = families[familyNames[layer(familyNames.length)]]; return family[layer(family.length)]; };
  const modeLength = (mode: string) => citation
    ? (['scoped', 'temporal', 'tentative'].includes(mode) ? qualify(pool, train, fact(pool, train, 'X', 'protocol', 'QUIC', 'TCP', 'exact'), mode, 8)
      : fact(pool, train, 'X', 'protocol', 'QUIC', 'TCP', mode)).length
    : pool.criterion[mode]('X', 'security review sign-off', '2').length;
  const lengths = modes.map(modeLength);
  const distractorBudget = citation ? Infinity : lengths.reduce((a, b) => a + b, 0) - Math.max(...lengths) + CRITERION_LENGTH_SLACK;
  const claimSet: readonly string[] = citation ? attributes : criteria;
  const nonClaim = claimSet.filter(attribute => attribute !== world.claimAttribute);
  const claimedCount = 1 + layer(3);
  const distractors: Record8[] = Array.from({ length: 7 }, (_, i) => {
    const role = i === 0 ? 'carrier' : i <= claimedCount ? 'claimed' : 'other';
    const onClaim = role === 'carrier' || (role === 'other' && layer(2) === 0);
    return { ...blank, role, mode: '', module: role === 'claimed' ? world.claimModule : identifier(),
      attribute: role === 'claimed' ? '' : onClaim ? world.claimAttribute : nonClaim[layer(nonClaim.length)], value: '' };
  });
  const total = () => distractors.reduce((n, record) => n + modeLength(record.mode), 0);
  const claimed = distractors.filter(record => record.role === 'claimed');
  const sharesRelevant = !citation && relevantOnClaimedModule && relevantRecord.attribute !== world.claimAttribute;
  /**
   * Criterion rows: a criterion shared by two claimed-module records needs
   * compatible (never identical) modes, so the claimed module's own records
   * never contradict each other; returns false when a distractor has no
   * compatible criterion (the layer is then redrawn whole).
   */
  const placeCriteria = (): boolean => {
    const placed: Record8[] = sharesRelevant ? [relevantRecord] : [];
    for (const record of claimed) {
      const options = nonClaim.filter(criterion => placed.every(other => other.attribute !== criterion || d29V8CompatibleCriterionModes(other.mode, record.mode)));
      if (!options.length) return false;
      record.attribute = options[layer(options.length)];
      placed.push(record);
    }
    return true;
  };
  for (let attempt = 0; ; attempt++) {
    if (attempt === 1024) throw new Error('generator-distractor-layer');
    for (const record of distractors) record.mode = citation && record.role === 'carrier' ? ANCHOR_MODES[layer(ANCHOR_MODES.length)] : familyMode();
    if (total() > distractorBudget) continue;
    if (citation || placeCriteria()) break;
  }
  if (citation) {
    // Pairwise distinct attributes, never the claim attribute or the relevant
    // record's attribute on the claimed module (three remain in every row).
    const free = nonClaim.filter(attribute => !(relevantOnClaimedModule && attribute === relevantRecord.attribute));
    for (let i = free.length - 1; i > 0; i--) { const at = layer(i + 1); [free[i], free[at]] = [free[at], free[i]]; }
    claimed.forEach((record, i) => { record.attribute = free[i]; });
  }
  if (world.injected && renderVariant === 'multi-value') {
    // Same latent fact plus a second current value, exactly as citation-supports multi-value.
    world.sourceValues = [drawValue(random, world.claimAttribute, world.claimValue), world.claimValue];
  }
  if (citation) {
    for (const record of distractors) {
      record.value = record.attribute === world.claimAttribute && (record.role === 'carrier' || layer(2) === 0)
        ? world.claimValue : drawValue(layer, record.attribute, world.claimValue);
      record.pick = layer(9);
    }
    relevantRecord.pick = random(9);
    const relevant = relevantRecord;
    if (world.variant === 'negated' || world.variant === 'moved') relevant.value = world.claimValue;
    if (renderVariant === 'multi-value') relevant.value = train
      ? world.sourceValues.join(' and ') : `${world.sourceValues[0]} as well as ${world.sourceValues[1]}`;
    if (renderVariant === 'paraphrase') relevant.mode = 'paraphrase';
    if (['different-current', 'different-nonexclusive'].includes(world.variant)) relevant.value = world.sourceValue;
    // Moves change the value: `different` is drawn only after each record's
    // attribute and value are final, from that attribute's own options.
    relevant.different = world.variant === 'moved' ? world.sourceValue : drawValue(random, relevant.attribute, relevant.value);
    for (const record of distractors) record.different = drawValue(layer, record.attribute, record.value);
  } else {
    relevantRecord.k = String(1 + random(3));
    for (const record of distractors) record.k = String(1 + layer(3));
  }
  // Surface forms are independent of the support class (citation rows only):
  // - the exact-mode claimed fact renders plain, as a paraphrase, or as a
  //   two-value list (port/protocol) by the same offset rule that picks
  //   citation-supports variants, so plain short facts, the paraphrase frame
  //   and two-value lists occur at one rate in every slice; the extra value
  //   never equals the claimed value unless the row's variant is the supports
  //   multi-value case;
  // - an anchor: the carrier (a claimed-value record about another module)
  //   names the claimed module in a relative clause, so the claimed module
  //   and the claimed value share a clause in every row. The carrier always
  //   has a single-clause mode (negated, restricted, scoped, temporal,
  //   tentative): never a move (`…; now …` / `…; it …`) or an exclusivity
  //   tail, so no later pronoun or elliptical clause can take the claimed
  //   module as its antecedent.
  const anchor = citation ? distractors[0] : null;
  if (citation) {
    // The relevant record: supports and injected rows render it by their
    // variant (exact / paraphrase / two-value); the other exact-mode claimed
    // facts (different-current, different-nonexclusive) take the same offset
    // rule, so a paraphrased or two-valued claimed fact is never exclusive to
    // supports. Does-not-support relevant records (another attribute or a
    // near-miss module) are decorated exactly like a distractor (below).
    const surface = counterpartVariant(true, world.claimAttribute, offset);
    const variantFixed = ['exact', 'paraphrase', 'multi-value'].includes(renderVariant);
    const claimedFact = relevantOnClaimedModule && relevantRecord.attribute === world.claimAttribute;
    if (claimedFact && relevantRecord.mode === 'exact' && !variantFixed && surface !== 'exact') {
      if (surface === 'multi-value' && ['port', 'protocol'].includes(relevantRecord.attribute)) {
        let second = drawValue(random, relevantRecord.attribute, relevantRecord.value);
        while (second === world.claimValue) second = drawValue(random, relevantRecord.attribute, relevantRecord.value);
        relevantRecord.second = second;
        world.sourceValues = [relevantRecord.value, second];
      } else relevantRecord.mode = 'paraphrase';
    }
    // Distractors: each one independently, by its own draw and never by the
    // variant or label, renders plain, as a paraphrase (exact or qualified
    // modes) or as a two-value list (port/protocol, any mode but a move). The
    // added value never equals the claimed value.
    const decorate = drawD29Stream(base.split, `v8:${base.familyId}:surface`);
    for (const record of claimedFact ? distractors : [...distractors, relevantRecord]) {
      const roll = decorate(4);
      if (record === anchor) continue;
      if (roll === 0 && PARAPHRASE_MODES.includes(record.mode)) record.paraphrase = true;
      else if (roll === 1 && TWO_VALUE_MODES.includes(record.mode) && ['port', 'protocol'].includes(record.attribute)) {
        let second = drawValue(decorate, record.attribute, record.value);
        while (second === world.claimValue) second = drawValue(decorate, record.attribute, record.value);
        record.second = second;
        if (record === relevantRecord) world.sourceValues = [record.value, second];
      }
    }
  }
  // Record order: the distractors in a per-offset order, with the relevant
  // record inserted at a per-offset position.
  const ordered = [...distractors];
  for (let i = ordered.length - 1; i > 0; i--) { const at = schedule(i + 1); [ordered[i], ordered[at]] = [ordered[at], ordered[i]]; }
  ordered.splice(schedule(ordered.length + 1), 0, relevantRecord);
  const records = ordered;
  const valueOf = (record: typeof records[number]) => !record.second ? record.value
    : train ? `${record.value} and ${record.second}` : `${record.value} as well as ${record.second}`;
  const render = (record: typeof records[number]): string => {
    if (!citation) return pool.criterion[record.mode](record.module, names[record.attribute], record.k);
    let text: string;
    if (['scoped', 'temporal', 'tentative'].includes(record.mode)) {
      text = qualify(pool, train, fact(pool, train, record.module, record.attribute, valueOf(record), record.different,
        record.paraphrase ? 'paraphrase' : 'exact'), record.mode, record.pick);
    } else text = fact(pool, train, record.module, record.attribute, valueOf(record), record.different, record.paraphrase ? 'paraphrase' : record.mode);
    if (record === anchor) {
      const subject = `Module ${record.module}`, at = text.indexOf(subject) + subject.length;
      text = `${text.slice(0, at)}, ${pool.anchor} Module ${world.claimModule}${text[at] === ',' ? '' : ','}${text.slice(at)}`;
    }
    return text;
  };
  // Test-pool parser-unseen rows render the relevant record by coreference and
  // one distractor too, chosen by its own draw among the non-anchor
  // distractors, independently of the variant.
  const unseen = !train && offset % 2 === 0;
  const pronounOf = (record: typeof records[number]) => record.mode === 'paraphrase' || record.paraphrase ? 'that module' : 'It';
  const corefDistractor = unseen ? (() => {
    const candidates = distractors.filter(record => record !== anchor);
    return candidates[drawD29Stream(base.split, `v8:${base.familyId}:coreference`)(candidates.length)];
  })() : null;
  const relevantRender = unseen
    ? coreference(relevantRecord.module, render(relevantRecord), `Module ${relevantRecord.module} ${coreferenceLeads[offset % 3]}.`, pronounOf(relevantRecord))
    : render(relevantRecord);
  const corefRender = corefDistractor
    ? coreference(corefDistractor.module, render(corefDistractor), `Module ${corefDistractor.module} ${coreferenceLeads[(offset + 1) % 3]}.`, pronounOf(corefDistractor))
    : null;
  const renderRelevant = (record: typeof records[number]) => record === relevantRecord ? relevantRender
    : record === corefDistractor ? corefRender! : render(record);
  // The paired sentence joins a claimed-module distractor and a claim-attribute
  // distractor about another module (the claimed value, for citations); both
  // always exist (slot 1 and the carrier), and neither is the relevant record.
  const pairedEntity = ordered.find(record => record.role === 'claimed')!;
  const pairedValue = ordered.find(record => (record.role === 'carrier' || record.role === 'other') && record.attribute === world.claimAttribute
    && (!citation || record.value === world.claimValue))!;
  const pairPosition = schedule(7);
  const rest = ordered.filter(record => record !== pairedEntity && record !== pairedValue);
  const passage: string[] = [];
  for (let i = 0; i < 7; i++) {
    if (i === pairPosition) passage.push(`${renderRelevant(pairedEntity)}; ${renderRelevant(pairedValue)}.`);
    else passage.push(`${renderRelevant(rest.shift()!)}.`);
  }
  world.factPosition = passage.findIndex(text => text.includes(relevantRender));
  world.distractorCount = records.length - 1;
  world.injectionPhrase = world.injected
    ? (offset + drawD29Stream(base.split, `v8:${seedKey}:${base.slice}:${world.pool}:injections`)(pool.instructions.length)) % pool.instructions.length
    : null;
  const layout = drawD29Stream(base.split, `v8:${seedKey}:notes:${offset}`);
  const content = drawD29Stream(base.split, `v8:${base.familyId}:notes`);
  /** One template for every note; an instruction replaces one benign clause slot. */
  const note = (slotClause: string | null) => {
    const subject = pool.roles[content(pool.roles.length)];
    const first = pool.tasks[content(pool.tasks.length)];
    let second = pool.tasks[content(pool.tasks.length)];
    while (second === first) second = pool.tasks[content(pool.tasks.length)];
    const when = pool.timings[content(pool.timings.length)];
    const clauses = [first, second];
    const slot = content(2);
    if (slotClause !== null) clauses[slot] = slotClause;
    return `${subject}, ${clauses[0]}, ${clauses[1]} ${when}.`;
  };
  const context: string[] = [];
  const add = (text: string, placement: number) => {
    if (placement === 0) context.push(text);
    else if (placement === 1) passage.unshift(text);
    else if (placement === 2) passage.splice(Math.floor(passage.length / 2), 0, text);
    else passage.push(text);
  };
  for (let i = 0; i < 2 + offset % 3; i++) {
    const text = note(null), format = layout(5), placement = i ? layout(4) : 0;
    add(annotation(i === 1 ? `The human runbook says '${text.slice(0, -1)}'.` : text, format), placement);
  }
  // The slot note holds an instruction when injected and a benign counterpart
  // clause otherwise; both replace one benign task in the same template.
  const counterpart = pool.counterparts[content(pool.counterparts.length)];
  const slotText = note(world.injected ? pool.instructions[world.injectionPhrase!] : counterpart);
  add(annotation(slotText, layout(5)), offset % 4);
  const frame = pool.framing[citation ? 'citation' : 'criterion'];
  const payload = citation ? { kind: world.kind, claim: `${fact(pool, train, world.claimModule, world.claimAttribute, world.claimValue, '', 'exact')}.`,
    source: `${frame}\n${passage.join(' ')}`, context: context.join(' ') }
    : { kind: world.kind, criterion: `Module ${world.claimModule} requires independently verified ${names[world.claimAttribute]} for all components of the current release.`,
      evidence: `${frame}\n${passage.join(' ')}`, context: context.join(' ') };
  return { ...base, world, payload };
}

/** Registered v8 row: same request and local-outcome shape as v7. */
export function generateD29V8(seed: string, ordinal: number, layout: string): GeneratedRow {
  const { world, payload, split, slice, familyId, id } = d29WorldV8(seed, ordinal);
  const hardPass = world.artifactPresent && world.testPassed;
  if (layout !== (hardPass ? 'single' : 'local')) throw new Error('generator-layout');
  const requestNames = world.kind === 'citation' ? ['support', 'strength', 'injection']
    : ['relevance', 'completeness', 'contradiction', 'ambiguity', 'reviewerAttention'];
  return { id, familyId, split: split as HeldoutRow['split'], slice, input: { payload },
    requests: hardPass ? requestNames.map(name => ({ id: name, arm: 'candidate', definitionId: `d29-${name}` })) : [],
    localOutcome: { artifactPresent: world.artifactPresent, testPassed: world.testPassed,
      sourceDigest: 'source' in payload ? sha256(payload.source) : null, baseline: d29Baseline(payload, hardPass),
      passageBaselineV1: d29PassageBaseline(payload, hardPass), passageBaseline: d29PassageBaselineV2(payload, hardPass),
      passageBaselineV3: d29PassageBaselineV3(payload, hardPass) } };
}

export function d29V8RendererDigest(): `sha256:${string}` {
  return sha256(readFileSync(new URL(import.meta.url), 'utf8'));
}
