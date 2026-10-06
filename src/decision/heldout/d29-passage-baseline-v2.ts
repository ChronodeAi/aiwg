import { readFileSync } from 'node:fs';
import { sha256 } from '../compile-cache/identity.js';
import { d29PassageBaseline } from './d29-passage-baseline.js';

type Payload = Parameters<typeof d29PassageBaseline>[0];
type Statement = { module: string; attribute: string; values: string[]; exclusive: boolean; negated: boolean; qualified: boolean };
const identifier = '([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)';
const attribute = '(port|protocol|region|owner team|major version)';
const values = '([A-Za-z0-9-]+(?: and [A-Za-z0-9-]+)*)';
const singleValued = new Set(['region', 'owner team', 'major version']);
const forms: [RegExp, number, number, number, boolean, boolean][] = [
  [new RegExp(`^Module ${identifier} (?:uses|has|runs|listens on|now uses) ${attribute} ${values}$`), 1, 2, 3, false, false],
  [new RegExp(`^[Tt]he ${attribute} recorded for Module ${identifier} is ${values}$`), 2, 1, 3, false, false],
  [new RegExp(`^Port ${values} is the port Module ${identifier} uses$`), 2, 0, 1, false, false],
  [new RegExp(`^Module ${identifier} is configured for, and currently uses, ${attribute} ${values}$`), 1, 2, 3, false, false],
  [new RegExp(`^Module ${identifier} (?:does not use|no longer uses|does not have|no longer has|does not run|no longer runs) ${attribute} ${values}$`), 1, 2, 3, false, true],
  [new RegExp(`^Module ${identifier} uses a single ${attribute}, ${values}, with no alternatives$`), 1, 2, 3, true, false],
  [new RegExp(`^For Module ${identifier}, the ${attribute} is restricted to ${values}$`), 1, 2, 3, true, false],
  [new RegExp(`^Module ${identifier} uses exactly one ${attribute}: ${values}$`), 1, 2, 3, true, false],
  [new RegExp(`^Module ${identifier} only uses ${attribute} ${values}$`), 1, 2, 3, true, false],
  [new RegExp(`^Module ${identifier} uses ${attribute} ${values} and no other (?:port|protocol|region|owner team|major version)$`), 1, 2, 3, true, false],
];

function clauses(text: string): string[] {
  return text.split(/[.!?](?=\s|$|[)\]]|-->)|;|\r?\n|,?\s+(?:while|whereas|and)\s+(?=Module )/)
    .map(clause => clause.replace(/^(?:-->|<!--|[\s>()\[\]])+/, '').replace(/(?:-->|[\s()\[\]])+$/, ''))
    .filter(Boolean);
}

function statement(input: string): Statement | null {
  let text = input;
  const tentative = /^(?:An unconfirmed report suggests that|The draft proposes that|It is possible that) /;
  const scope = / (?:in staging|during the pilot|in the test environment)$/;
  const history = /, according to the inventory (?:before the 2025 migration|until the previous release|as of the retired pilot)$/;
  const qualified = tentative.test(text) || scope.test(text) || history.test(text)
    || / (?:might use|reportedly uses|was planned to use) /.test(text);
  text = text.replace(tentative, '').replace(scope, '').replace(history, '')
    .replace(/ (?:might use|reportedly uses|was planned to use) /, ' uses ');
  const noAlternatives = /, with no alternatives$/.test(text);
  if (noAlternatives && !/ uses a single /.test(text)) text = text.replace(/, with no alternatives$/, '');
  text = text.replace(new RegExp(`^(Module ${identifier}) (.*)$`), (_, prefix: string, _module: string, body: string) => {
    const normalized = body.replace(/^now /, '').replace(/^is now /, 'is ')
      .replace(/^is (?:not|no longer) owned by team /, 'does not use owner team ')
      .replace(/^is owned by team /, 'uses owner team ')
      .replace(/^is (?:not|no longer) deployed in region /, 'does not use region ')
      .replace(/^is deployed in region /, 'uses region ')
      .replace(/^(?:does not listen|no longer listens) on port /, 'does not use port ')
      .replace(/^(?:does not communicate|no longer communicates) over protocol /, 'does not use protocol ')
      .replace(/^listens only on port /, 'only uses port ')
      .replace(/^communicates only over protocol /, 'only uses protocol ')
      .replace(/^listens on port /, 'uses port ')
      .replace(/^communicates over protocol /, 'uses protocol ');
    return `${prefix} ${normalized}`;
  });
  for (const [pattern, moduleIndex, attributeIndex, valuesIndex, exclusive, negated] of forms) {
    const match = pattern.exec(text);
    if (match) return { module: match[moduleIndex], attribute: attributeIndex ? match[attributeIndex] : 'port',
      values: match[valuesIndex].split(' and '), exclusive: exclusive || noAlternatives, negated, qualified };
  }
  return null;
}

function statements(text: string): Statement[] {
  const result: Statement[] = [];
  let previous: string | null = null;
  for (const clause of clauses(text)) {
    const continued = /^(?:it |now )/.test(clause) && previous
      ? `Module ${previous} ${clause.replace(/^it /, '')}` : clause;
    const fact = statement(continued);
    if (fact) { result.push(fact); previous = fact.module; }
    else previous = null;
  }
  return result;
}

/** Visible-text comparator with explicit missing-fact handling; screening-control attempts remain unclassified. */
export function d29PassageBaselineV2(payload: Payload, hardPass: boolean) {
  if (!hardPass || payload.kind !== 'citation') return d29PassageBaseline(payload, hardPass);
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

export function d29PassageBaselineV2Digest(): `sha256:${string}` {
  return sha256(readFileSync(new URL(import.meta.url), 'utf8'));
}
