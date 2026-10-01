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
  // Two records in the same mode agree (partial coverage counts may differ, so not partial).
  return (a === b && a !== 'partial') || COMPATIBLE_CRITERION_MODES.has([a, b].sort().join('|'));
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

/** Index combinations of `size` from `count`, in lexicographic order. */
function* combinations(count: number, size: number): Generator<number[]> {
  const pick = Array.from({ length: size }, (_, i) => i);
  if (size > count) return;
  for (;;) {
    yield [...pick];
    let i = size - 1;
    while (i >= 0 && pick[i] === count - size + i) i--;
    if (i < 0) return;
    pick[i]++;
    for (let j = i + 1; j < size; j++) pick[j] = pick[j - 1] + 1;
  }
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
  const relevantIndex = modes.indexOf(relevantMode);
  const identifier = () => Array.from({ length: 3 }, () => String(100000 + random(900000))).join('-');
  const records = modes.map((mode, i) => ({ mode, module: i === relevantIndex ? world.sourceModule : identifier(),
    attribute: i === relevantIndex ? world.sourceAttribute : world.claimAttribute,
    value: i === relevantIndex ? world.sourceValue : '', different: '', pick: 0, k: '2', paraphrase: false, second: '' }));
  // Distractor modes are drawn independently of the variant (with
  // replacement), so the distractor layer never encodes the relevant mode by
  // its absence (v7 rendered each mode exactly once per row).
  // A length budget keeps every request inside the preregistered token bound:
  // the distractor modes' template lengths may not exceed the seven longest
  // distinct modes (the v7 worst case). It reads only the drawn distractor
  // modes, never the variant.
  const modeDraw = drawD29Stream(base.split, `v8:${base.familyId}:modes`);
  const modeLength = (mode: string) => citation
    ? (['scoped', 'temporal', 'tentative'].includes(mode) ? qualify(pool, train, fact(pool, train, 'X', 'protocol', 'QUIC', 'TCP', 'exact'), mode, 8)
      : fact(pool, train, 'X', 'protocol', 'QUIC', 'TCP', mode)).length
    : pool.criterion[mode]('X', 'security review sign-off', '2').length;
  const modeBudget = modes.map(modeLength).sort((a, b) => a - b).slice(1).reduce((a, b) => a + b, 0);
  const drawDistractorModes = () => {
    for (let attempt = 0; attempt < 256; attempt++) {
      const drawn = records.map((_, i) => i === relevantIndex ? '' : modes[modeDraw(modes.length)]);
      if (drawn.reduce((n, mode) => n + (mode ? modeLength(mode) : 0), 0) <= modeBudget) {
        drawn.forEach((mode, i) => { if (mode) records[i].mode = mode; });
        return;
      }
    }
    throw new Error('generator-mode-budget');
  };
  drawDistractorModes();
  const others = records.map((_, i) => i).filter(i => i !== relevantIndex);
  for (let i = others.length - 1; i > 0; i--) {
    const at = schedule(i + 1); [others[i], others[at]] = [others[at], others[i]];
  }
  // Claimed-module distractors: three mentions of the claimed module in every
  // row. Their attributes never repeat the claim attribute or the relevant
  // record's attribute on the same module, and never contradict each other.
  const targetCount = world.sourceModule === world.claimModule ? 2 : 3;
  const reserved = new Set<string>([world.claimAttribute]);
  if (world.sourceModule === world.claimModule) reserved.add(world.sourceAttribute);
  const available = (citation ? attributes : criteria).filter(attribute => !reserved.has(attribute));
  const start = random(available.length);
  const rotated = available.map((_, i) => available[(start + i) % available.length]);
  // Structural balance draws use their own stream so the content draws above
  // and below stay where they were.
  const balance = drawD29Stream(base.split, `v8:${base.familyId}:balance`);
  // Criterion rows whose relevant record names the required criterion on the
  // claimed module have two distractors over two free criteria; half of
  // them share one criterion (compatible modes), as wrong-attribute and
  // wrong-subject rows always must, so a same-criterion pair is never
  // exclusive to those variants.
  const preferShared = !citation && world.sourceModule === world.claimModule && world.sourceAttribute === world.claimAttribute
    && balance(2) === 0;
  // Pairwise-distinct attributes first (or a shared pair first when
  // preferred); criterion rows may share one criterion only between
  // compatible modes.
  const assign = (chosen: number[], pairOnly = false): (typeof available)[number][] | null => {
    const total = rotated.length ** chosen.length;
    for (const shared of pairOnly ? ['pair'] as const : [false, true] as const) {
      for (let code = 0; code < total; code++) {
        const assignment = chosen.map((_, i) => rotated[Math.floor(code / rotated.length ** i) % rotated.length]);
        const valid = chosen.every((a, i) => chosen.every((b, j) => j <= i || assignment[i] !== assignment[j]
          || (shared !== false && !citation && d29V8CompatibleCriterionModes(records[a].mode, records[b].mode))));
        if (valid && (shared !== 'pair' || new Set(assignment).size < assignment.length)) return assignment;
      }
    }
    return null;
  };
  let placed = false;
  // Rare draws without any compatible criterion pair redraw the distractor
  // modes (same stream), so placement never fails.
  for (let attempt = 0; attempt < 32 && !placed; attempt++) {
    if (attempt) drawDistractorModes();
    // A preferred shared pair searches every combination for a compatible pair,
    // exactly as wrong-attribute and wrong-subject rows must, before falling
    // back to distinct criteria.
    for (const pairOnly of preferShared ? [true, false] : [false]) {
      for (const combination of combinations(others.length, targetCount)) {
        const chosen = combination.map(i => others[i]);
        const assignment = assign(chosen, pairOnly);
        if (!assignment) continue;
        chosen.forEach((index, i) => { records[index].module = world.claimModule; records[index].attribute = assignment[i]; });
        placed = true;
        break;
      }
      if (placed) break;
    }
  }
  if (!placed) throw new Error('generator-claim-distractors');

  // Role-count invariant: every row has three claimed-module records, five
  // claim-attribute records and three non-claim records. Rows whose relevant
  // record names the claim attribute on the claimed module therefore give one
  // other-module record a non-claim attribute (a "free" record); in every other
  // row the claimed module already holds the three non-claim records. Role
  // counts are thus a fixed function of the relevant record's role, which is
  // label-defining, and carry nothing beyond it (asserted by V8-19).
  const sameModuleClaim = records[relevantIndex].module === world.claimModule && records[relevantIndex].attribute === world.claimAttribute;
  const nonClaim = others.filter(i => records[i].module !== world.claimModule);
  const freeCount = sameModuleClaim ? 1 : 0;
  const frees: number[] = [];
  // The last other-module record becomes the balancing record; the anchor
  // falls back to a drawn single-clause mode when no carrier has one.
  for (const i of [...nonClaim].reverse()) {
    if (frees.length === freeCount) break;
    frees.push(i);
  }
  const usedByClaimModule = new Set(records.filter(record => record.module === world.claimModule).map(record => record.attribute));
  frees.forEach((free, n) => {
    const extra = (citation ? rotated.filter(attribute => !usedByClaimModule.has(attribute)) : rotated)
      .filter(attribute => !frees.slice(0, n).some(j => records[j].attribute === attribute) || !citation);
    records[free].attribute = extra[random(extra.length)];
  });
  let anchorIndex = -1;
  if (world.injected && renderVariant === 'multi-value') {
    // Same latent fact plus a second current value, exactly as citation-supports multi-value.
    world.sourceValues = [drawValue(random, world.claimAttribute, world.claimValue), world.claimValue];
  }
  if (citation) {
    for (const record of records) {
      record.value ||= drawValue(random, record.attribute, world.claimValue);
      record.pick = random(9);
    }
    const relevant = records[relevantIndex];
    if (world.variant === 'negated' || world.variant === 'moved') relevant.value = world.claimValue;
    if (renderVariant === 'multi-value') relevant.value = train
      ? world.sourceValues.join(' and ') : `${world.sourceValues[0]} as well as ${world.sourceValues[1]}`;
    if (renderVariant === 'paraphrase') relevant.mode = 'paraphrase';
    if (['different-current', 'different-nonexclusive'].includes(world.variant)) relevant.value = world.sourceValue;
    // The anchor is a single-clause claimed-value record about another module
    // (see below); it carries the claimed value first. The claimed value
    // appears four times, including facts about other entities.
    const carriers = others.filter(i => records[i].module !== world.claimModule && !frees.includes(i));
    anchorIndex = carriers.find(i => ANCHOR_MODES.includes(records[i].mode)) ?? -1;
    if (anchorIndex < 0) {
      // No single-clause carrier was drawn: the first carrier takes one, by draw.
      anchorIndex = carriers[0];
      records[anchorIndex].mode = ANCHOR_MODES[modeDraw(ANCHOR_MODES.length)];
    }
    let remaining = 4 - Number(relevant.value.split(' and ').includes(world.claimValue) || relevant.value.split(' as well as ').includes(world.claimValue));
    for (const i of [anchorIndex, ...carriers.filter(i => i !== anchorIndex)]) {
      if (!remaining) break;
      records[i].attribute = world.claimAttribute; records[i].value = world.claimValue; remaining--;
    }
    // Moves change the value: `different` is drawn only after each record's
    // attribute and value are final, from that attribute's own options.
    for (const record of records) {
      record.different = record === relevant && world.variant === 'moved' ? world.sourceValue
        : drawValue(random, record.attribute, record.value);
    }
  }
  if (!citation) for (const record of records) record.k = String(1 + random(3));
  // Surface forms are independent of the support class (citation rows only):
  // - the exact-mode record (the relevant record or a distractor) renders
  //   plain, as a paraphrase, or as a two-value list (port/protocol) by the
  //   same offset rule that picks citation-supports variants, so plain short
  //   facts, the paraphrase frame and two-value lists occur at one rate in
  //   every slice; the extra value never equals the claimed value unless the
  //   row's variant is the supports multi-value case;
  // - an anchor: one claimed-value record about another module names the
  //   claimed module in a relative clause, so the claimed module and the
  //   claimed value share a clause in every row. The anchor is always a
  //   single-clause mode (negated, restricted, scoped, temporal, tentative):
  //   never a move (`…; now …` / `…; it …`) or an exclusivity tail, so no
  //   later pronoun or elliptical clause can take the claimed module as its
  //   antecedent.
  const relevantRecord = records[relevantIndex];
  const anchor = citation ? records[anchorIndex] : null;
  if (citation) {
    // The relevant record: supports and injected rows render it by their
    // variant (exact / paraphrase / two-value); the other exact-mode claimed
    // facts (different-current, different-nonexclusive) take the same offset
    // rule, so a paraphrased or two-valued claimed fact is never exclusive to
    // supports. Does-not-support relevant records (another attribute or a
    // near-miss module) are decorated exactly like a distractor (below).
    const surface = counterpartVariant(true, world.claimAttribute, offset);
    const variantFixed = ['exact', 'paraphrase', 'multi-value'].includes(renderVariant);
    const claimedFact = relevantRecord.module === world.claimModule && relevantRecord.attribute === world.claimAttribute;
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
    for (const i of claimedFact ? others : [...others, relevantIndex]) {
      const record = records[i], roll = decorate(4);
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
  const rotation = schedule(records.length);
  const ordered = [...records.slice(rotation), ...records.slice(0, rotation)];
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
    const candidates = others.map(i => records[i]).filter(record => record !== anchor);
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
  const pairedEntity = ordered.find(record => record.module === world.claimModule && record.attribute !== world.claimAttribute)!;
  const pairedValue = ordered.find(record => record.module !== world.claimModule
    && (citation ? record.value === world.claimValue : record.attribute === world.claimAttribute))!;
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
