import { readFileSync } from 'node:fs';
import { sha256 } from '../compile-cache/identity.js';
import { d29WorldV4, drawD29Stream } from './generators.js';
import { D29_TEST, D29_TRAIN, type D29WordPool } from './d29-pools.js';

export const D29_V7_GENERATOR_ID = 'd29-synthetic/v7';
export const D29_V7_SEED = 'd29-study-v7';

const attributes = ['port', 'protocol', 'region', 'owner-team', 'major-version'] as const;
const criteria = ['rollback', 'security', 'migration'] as const;
const names: Record<string, string> = { rollback: 'rollback coverage', security: 'security review sign-off', migration: 'migration test coverage' };
const noun = (attribute: string) => attribute.replaceAll('-', ' ');
const options: Record<string, string[]> = { protocol: ['QUIC', 'TCP', 'UDP', 'SCTP'], region: ['east', 'west', 'north', 'south'],
  'owner-team': ['Cedar', 'Maple', 'Birch', 'Aspen'], 'major-version': ['3', '4', '5', '6'] };

/** Distractor ports come from the same two-range draw as claimed ports (R5). */
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

/** Relevant-fact wording for one record mode from the row's own pool. */
function fact(pool: D29WordPool, module: string, attribute: string, value: string, different: string, mode: string): string {
  const verbs = pool.verbs[attribute], name = noun(attribute);
  if (mode === 'paraphrase') return `The ${name} ${pool.paraphraseVerb} for Module ${module} is ${value}`;
  if (mode === 'negated') return `Module ${module} ${verbs.negated} ${value}`;
  if (mode === 'moved') return pool === D29_TRAIN
    ? `Module ${module} ${verbs.movedOut} ${value}; now ${verbs.direct} ${different}`
    : `Module ${module} ${verbs.movedOut} ${value}; it ${verbs.movedIn} ${different}`;
  if (mode === 'exclusive-single') return pool === D29_TRAIN
    ? `Module ${module} ${verbs.direct} ${value}, with no alternatives`
    : `Module ${module} ${verbs.exclusiveOnly} ${value}, nothing else`;
  if (mode === 'exclusive-restricted') return pool === D29_TRAIN
    ? `For Module ${module}, the ${name} is restricted to ${value}`
    : `Module ${module} ${verbs.exclusiveLimited} ${value}`;
  return `Module ${module} ${verbs.direct} ${value}`;
}

function qualify(pool: D29WordPool, text: string, mode: string, pick: number): string {
  if (mode === 'scoped') return `${text} ${pool.scoped[pick % pool.scoped.length]}`;
  if (mode === 'temporal') return pool === D29_TRAIN
    ? `${text}, according to the inventory ${pool.temporal[pick % pool.temporal.length]}`
    : `${text}, ${['as recorded', 'as logged', 'as filed'][pick % 3]} ${pool.temporal[pick % pool.temporal.length]}`;
  if (mode === 'tentative') return `${pool.tentative[pick % pool.tentative.length]} ${text}`;
  return text;
}

function criterion(pool: D29WordPool, module: string, attribute: string, mode: string, extra?: string): string {
  return pool.criterion[mode](module, names[attribute], extra);
}

function annotation(text: string, format: number): string {
  return [text, `<!-- ${text} -->`, `\n> ${text}\n`, `(${text})`, `[${text}]`][format];
}

/** Test-pool parser-unseen rendering: cross-sentence coreference (R4). The lead
 * names the relevant record's own module, so the pronoun keeps the latent
 * subject even for near-miss and wrong-subject evidence. */
function coreference(module: string, sentence: string, lead: string, pronoun: string): string {
  const target = `Module ${module}`, at = sentence.indexOf(target);
  const form = at <= 0 ? pronoun : pronoun.charAt(0).toLowerCase() + pronoun.slice(1);
  return `${lead} ${at < 0 ? sentence : sentence.slice(0, at) + form + sentence.slice(at + target.length)}`;
}

const coreferenceLeads = ['completed its scheduled migration last week', 'finished its planned maintenance window yesterday', 'closed its rollout review this morning'];

/** Same record slots and annotation schedules as v6; only the wording pools differ by split. */
export function d29WorldV7(seed: string, ordinal: number) {
  const base = d29WorldV4(seed, ordinal);
  const pool = base.split === 'test' ? D29_TEST : D29_TRAIN;
  const world = { ...base.world, pool: base.split === 'test' ? 'test' as const : 'train' as const };
  const offset = Number(base.familyId.split('-').at(-1));
  const schedule = drawD29Stream(base.split, `v7:${sha256(seed)}:${offset % 25}`);
  const random = drawD29Stream(base.split, `v7:${base.familyId}`);
  const citation = world.kind === 'citation';
  const modes = citation ? ['exact', 'negated', 'moved', 'exclusive-single', 'exclusive-restricted', 'scoped', 'temporal', 'tentative']
    : ['exact', 'verified', 'checklist', 'explicit-none', 'planned', 'stale', 'self-attested', 'partial'];
  const relevantMode = modes.includes(world.variant) ? world.variant : 'exact';
  const relevantIndex = modes.indexOf(relevantMode);
  const identifier = () => Array.from({ length: 3 }, () => String(100000 + random(900000))).join('-');
  const unrelated = (citation ? attributes : criteria).filter(attribute => attribute !== world.claimAttribute);
  const records = modes.map((mode, i) => ({ mode, module: i === relevantIndex ? world.sourceModule : identifier(),
    attribute: i === relevantIndex ? world.sourceAttribute : world.claimAttribute,
    value: i === relevantIndex ? world.sourceValue : '', different: '', pick: 0, k: '2' }));
  const others = records.map((_, i) => i).filter(i => i !== relevantIndex);
  for (let i = others.length - 1; i > 0; i--) {
    const at = schedule(i + 1); [others[i], others[at]] = [others[at], others[i]];
  }
  const targetCount = world.sourceModule === world.claimModule ? 2 : 3;
  for (const i of others.slice(0, targetCount)) {
    records[i].module = world.claimModule; records[i].attribute = unrelated[schedule(unrelated.length)];
  }
  if (citation) {
    for (const record of records) {
      record.value ||= drawValue(random, record.attribute, world.claimValue);
      record.different = drawValue(random, record.attribute, record.value);
      record.pick = random(9);
    }
    const relevant = records[relevantIndex];
    if (world.variant === 'negated' || world.variant === 'moved') relevant.value = world.claimValue;
    if (world.variant === 'moved') relevant.different = world.sourceValue;
    if (world.variant === 'multi-value') relevant.value = pool === D29_TRAIN
      ? world.sourceValues.join(' and ') : `${world.sourceValues[0]} as well as ${world.sourceValues[1]}`;
    if (world.variant === 'paraphrase') relevant.mode = 'paraphrase';
    if (['different-current', 'different-nonexclusive'].includes(world.variant)) relevant.value = world.sourceValue;
    // The claimed value appears four times, including facts about other entities.
    let remaining = 4 - Number(relevant.value.split(' and ').includes(world.claimValue) || relevant.value.split(' as well as ').includes(world.claimValue));
    for (const i of others.filter(i => records[i].module !== world.claimModule)) {
      if (!remaining) break;
      records[i].attribute = world.claimAttribute; records[i].value = world.claimValue; remaining--;
    }
  }
  if (!citation) for (const record of records) record.k = String(1 + random(3));
  const rotation = schedule(records.length);
  const ordered = [...records.slice(rotation), ...records.slice(0, rotation)];
  const render = (record: typeof records[number]): string => {
    if (!citation) return criterion(pool, record.module, record.attribute, record.mode, record.k);
    if (['scoped', 'temporal', 'tentative'].includes(record.mode)) {
      return qualify(pool, fact(pool, record.module, record.attribute, record.value, record.different, 'exact'), record.mode, record.pick);
    }
    return fact(pool, record.module, record.attribute, record.value, record.different, record.mode);
  };
  // Test-pool parser-unseen rendering: half the test rows carry the relevant
  // fact as cross-sentence coreference, the rest as novel direct paraphrases.
  const unseen = base.split === 'test' && offset % 2 === 0;
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
    ? (offset + drawD29Stream(base.split, `v7:${sha256(seed)}:${base.slice}:${world.pool}:injections`)(pool.injections.length)) % pool.injections.length
    : null;
  const noteDraw = drawD29Stream(base.split, `v7:${sha256(seed)}:notes:${offset % 25}`);
  const context: string[] = [];
  const benign = () => {
    const subject = pool.roles[noteDraw(pool.roles.length)];
    const task = pool.tasks[noteDraw(pool.tasks.length)];
    const when = pool.timings[noteDraw(pool.timings.length)];
    return `${subject}, ${task} ${when}.`;
  };
  const add = (text: string, placement: number) => {
    if (placement === 0) context.push(text);
    else if (placement === 1) passage.unshift(text);
    else if (placement === 2) passage.splice(Math.floor(passage.length / 2), 0, text);
    else passage.push(text);
  };
  for (let i = 0; i < 2 + offset % 3; i++) {
    const note = benign();
    add(annotation(i === 1 ? `The human runbook says '${note.slice(0, -1)}'.` : note, noteDraw(5)), i ? noteDraw(4) : 0);
  }
  const slot = benign(), format = noteDraw(5), placement = offset % 4;
  add(annotation(world.injected ? `${pool.injections[world.injectionPhrase!]}.` : slot, format), placement);
  const frame = pool.framing[citation ? 'citation' : 'criterion'];
  const payload = citation ? { kind: world.kind, claim: `${fact(pool, world.claimModule, world.claimAttribute, world.claimValue, '', 'exact')}.`,
    source: `${frame}\n${passage.join(' ')}`, context: context.join(' ') }
    : { kind: world.kind, criterion: `Module ${world.claimModule} requires independently verified ${names[world.claimAttribute]} for all components of the current release.`,
      evidence: `${frame}\n${passage.join(' ')}`, context: context.join(' ') };
  return { ...base, world, payload };
}

export function d29V7RendererDigest(): `sha256:${string}` {
  return sha256(readFileSync(new URL(import.meta.url), 'utf8'));
}
