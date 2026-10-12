import { readFileSync } from 'node:fs';
import { sha256 } from '../compile-cache/identity.js';
import { d29PassageBaseline } from './d29-passage-baseline.js';
import { D29_TRAIN } from './d29-pools.js';

type Payload = Parameters<typeof d29PassageBaseline>[0];
type Statement = { module: string; attribute: string; values: string[]; exclusive: boolean; negated: boolean; qualified: boolean };

/** The v3 comparator knows only TRAIN-pool wording: every verb, qualifier
 * and criterion pattern below is derived from the imported TRAIN pools, so
 * TEST-pool phrasing (novel verbs, periphrases, coreference) is
 * parser-unseen by construction. Screening-control attempts stay unclassified. */
const identifier = '([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)';
const values = '([A-Za-z0-9-]+(?: and [A-Za-z0-9-]+)*)';
const singleValued = new Set(['region', 'owner team', 'major version']);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Pattern { pattern: RegExp; attribute: string; exclusive: boolean; negated: boolean }
const patterns: Pattern[] = [];
for (const [name, verbs] of Object.entries(D29_TRAIN.verbs)) {
  const attribute = name.replaceAll('-', ' ');
  patterns.push({ pattern: new RegExp(`^Module ${identifier} ${escape(verbs.direct)} ${values}$`), attribute, exclusive: false, negated: false });
  patterns.push({ pattern: new RegExp(`^Module ${identifier} ${escape(verbs.negated)} ${values}$`), attribute, exclusive: false, negated: true });
  patterns.push({ pattern: new RegExp(`^Module ${identifier} ${escape(verbs.movedOut)} ${values}$`), attribute, exclusive: false, negated: true });
}
const scopedTails = D29_TRAIN.scoped.map(escape).join('|');
const tentativeHeads = D29_TRAIN.tentative.map(escape).join('|');
const temporalTails = D29_TRAIN.temporal.map(escape).join('|');
const restricted = (attribute: string) => new RegExp(`^For Module ${identifier}, the ${escape(attribute)} is restricted to ${values}$`);

function clauses(text: string): string[] {
  return text.split(/[.!?](?=\s|$|[)\]]|-->)|;|\r?\n|,?\s+(?:while|whereas|and)\s+(?=Module )/)
    .map(clause => clause.replace(/^(?:-->|<!--|[\s>()\[\]])+/, '').replace(/(?:-->|[\s()\[\]])+$/, ''))
    .filter(Boolean);
}

function statement(input: string): Statement | null {
  let text = input;
  const tentative = new RegExp(`^(?:${tentativeHeads}) `);
  const scope = new RegExp(` (?:${scopedTails})$`);
  const history = new RegExp(`, according to the inventory (?:${temporalTails})$`);
  const qualified = tentative.test(text) || scope.test(text) || history.test(text);
  text = text.replace(tentative, '').replace(scope, '').replace(history, '');
  const noAlternatives = /, with no alternatives$/.test(text);
  if (noAlternatives) text = text.replace(/, with no alternatives$/, '');
  for (const attribute of Object.keys(D29_TRAIN.verbs).map(name => name.replaceAll('-', ' '))) {
    const match = restricted(attribute).exec(text);
    if (match) return { module: match[1], attribute, values: match[2].split(' and '), exclusive: true, negated: false, qualified };
  }
  for (const { pattern, attribute, exclusive, negated } of patterns) {
    const match = pattern.exec(text);
    if (match) return { module: match[1], attribute, values: match[2].split(' and '), exclusive: exclusive || noAlternatives, negated, qualified };
  }
  const paraphraseMatch = new RegExp(`^The (port|protocol|region|owner team|major version) ${escape(D29_TRAIN.paraphraseVerb)} for Module ${identifier} is ${values}$`).exec(text);
  if (paraphraseMatch) return { module: paraphraseMatch[2], attribute: paraphraseMatch[1], values: paraphraseMatch[3].split(' and '), exclusive: noAlternatives, negated: false, qualified };
  return null;
}

function statements(text: string): Statement[] {
  const result: Statement[] = [];
  let previous: string | null = null;
  for (const clause of clauses(text)) {
    // TRAIN wording has no pronominal coreference; only `now ...` continuations.
    const continued = /^now /.test(clause) && previous ? `Module ${previous} ${clause.slice(4)}` : clause;
    const fact = statement(continued);
    if (fact) { result.push(fact); previous = fact.module; }
    else previous = null;
  }
  return result;
}

function trainReadyForms(module: string, name: string): Set<string> {
  return new Set(['exact', 'verified', 'checklist'].map(mode => D29_TRAIN.criterion[mode](module, name, '2')));
}

/** Train-wording comparator; screening-control attempts remain unclassified. */
export function d29PassageBaselineV3(payload: Payload, hardPass: boolean) {
  if (!hardPass) return { route: 'REVIEW', support: null };
  if (payload.kind === 'phase-criterion') {
    const match = new RegExp(`^Module ${identifier} requires independently verified (rollback coverage|security review sign-off|migration test coverage) for all components of the current release\\.$`).exec(payload.criterion ?? '');
    if (!match) return { route: 'REVIEW', support: null };
    const [, module, name] = match;
    const ready = clauses(payload.evidence ?? '').some(sentence => trainReadyForms(module, name).has(sentence));
    return { route: ready ? 'ADVISORY_READY' : 'REVIEW', support: null };
  }
  if (payload.kind !== 'citation') return { route: 'REVIEW', support: 'unclear' };
  const claimParts = clauses(payload.claim ?? ''), claim = claimParts.length === 1 ? statement(claimParts[0]) : null;
  if (!claim || claim.negated || claim.qualified || claim.values.length !== 1) return { route: 'REVIEW', support: 'unclear' };
  const facts = statements(payload.source ?? '').filter(fact => fact.module === claim.module && fact.attribute === claim.attribute);
  const current = facts.filter(fact => !fact.qualified);
  const contradicts = current.some(fact => fact.negated ? fact.values.includes(claim.values[0])
    : !fact.values.includes(claim.values[0]) && (fact.exclusive || singleValued.has(claim.attribute)));
  const supports = current.some(fact => !fact.negated && fact.values.includes(claim.values[0]));
  const support = contradicts ? 'contradicts' : supports ? 'supports' : facts.length ? 'unclear' : 'does-not-support';
  return { route: support === 'supports' ? 'ADVISORY_READY' : 'REVIEW', support };
}

export function d29PassageBaselineV3Digest(): `sha256:${string}` {
  return sha256(readFileSync(new URL(import.meta.url), 'utf8'));
}
