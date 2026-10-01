import { readFileSync } from 'node:fs';
import { sha256 } from '../compile-cache/identity.js';
import { d29Baseline, d29WorldV4, drawD29Stream } from './generators.js';
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
export const D29_V8_GENERATOR_ID = 'd29-synthetic/v8';
export const D29_V8_SEED = 'd29-study-v8';

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
  if (mode === 'tentative') return `${pool.tentative[pick % pool.tentative.length]} ${text}`;
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
  const relevantMode = modes.includes(world.variant) ? world.variant : 'exact';
  const relevantIndex = modes.indexOf(relevantMode);
  const identifier = () => Array.from({ length: 3 }, () => String(100000 + random(900000))).join('-');
  const records = modes.map((mode, i) => ({ mode, module: i === relevantIndex ? world.sourceModule : identifier(),
    attribute: i === relevantIndex ? world.sourceAttribute : world.claimAttribute,
    value: i === relevantIndex ? world.sourceValue : '', different: '', pick: 0, k: '2' }));
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
  // Pairwise-distinct attributes first; criterion rows with fewer free
  // criteria than distractors may then share one only between compatible modes.
  const assign = (chosen: number[]): (typeof available)[number][] | null => {
    const total = rotated.length ** chosen.length;
    for (const shared of [false, true]) {
      for (let code = 0; code < total; code++) {
        const assignment = chosen.map((_, i) => rotated[Math.floor(code / rotated.length ** i) % rotated.length]);
        const valid = chosen.every((a, i) => chosen.every((b, j) => j <= i || assignment[i] !== assignment[j]
          || (shared && !citation && d29V8CompatibleCriterionModes(records[a].mode, records[b].mode))));
        if (valid) return assignment;
      }
    }
    return null;
  };
  let placed = false;
  for (const combination of combinations(others.length, targetCount)) {
    const chosen = combination.map(i => others[i]);
    const assignment = assign(chosen);
    if (!assignment) continue;
    chosen.forEach((index, i) => { records[index].module = world.claimModule; records[index].attribute = assignment[i]; });
    placed = true;
    break;
  }
  if (!placed) throw new Error('generator-claim-distractors');
  // Every row carries five claim-attribute records and three others. When the
  // relevant record already states the claim attribute about the claimed
  // module (two claimed-module distractors), one other-module record that
  // never carries the claimed value takes a further non-claim attribute, so
  // attribute counts cannot reveal the variant.
  if (records[relevantIndex].module === world.claimModule && records[relevantIndex].attribute === world.claimAttribute) {
    const free = others.filter(i => records[i].module !== world.claimModule).at(-1)!;
    const used = new Set(records.filter(record => record.module === world.claimModule).map(record => record.attribute));
    const extra = citation ? rotated.filter(attribute => !used.has(attribute)) : rotated;
    records[free].attribute = extra[random(extra.length)];
  }
  if (citation) {
    for (const record of records) {
      record.value ||= drawValue(random, record.attribute, world.claimValue);
      record.pick = random(9);
    }
    const relevant = records[relevantIndex];
    if (world.variant === 'negated' || world.variant === 'moved') relevant.value = world.claimValue;
    if (world.variant === 'multi-value') relevant.value = train
      ? world.sourceValues.join(' and ') : `${world.sourceValues[0]} as well as ${world.sourceValues[1]}`;
    if (world.variant === 'paraphrase') relevant.mode = 'paraphrase';
    if (['different-current', 'different-nonexclusive'].includes(world.variant)) relevant.value = world.sourceValue;
    // The claimed value appears four times, including facts about other entities.
    let remaining = 4 - Number(relevant.value.split(' and ').includes(world.claimValue) || relevant.value.split(' as well as ').includes(world.claimValue));
    for (const i of others.filter(i => records[i].module !== world.claimModule)) {
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
  const rotation = schedule(records.length);
  const ordered = [...records.slice(rotation), ...records.slice(0, rotation)];
  const render = (record: typeof records[number]): string => {
    if (!citation) return pool.criterion[record.mode](record.module, names[record.attribute], record.k);
    if (['scoped', 'temporal', 'tentative'].includes(record.mode)) {
      return qualify(pool, train, fact(pool, train, record.module, record.attribute, record.value, record.different, 'exact'), record.mode, record.pick);
    }
    return fact(pool, train, record.module, record.attribute, record.value, record.different, record.mode);
  };
  const unseen = !train && offset % 2 === 0;
  const relevantRender = unseen
    ? coreference(records[relevantIndex].module, render(records[relevantIndex]),
      `Module ${records[relevantIndex].module} ${coreferenceLeads[offset % 3]}.`,
      records[relevantIndex].mode === 'paraphrase' ? 'that module' : 'It')
    : render(records[relevantIndex]);
  const renderRelevant = (record: typeof records[number]) => record === records[relevantIndex] ? relevantRender : render(record);
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
