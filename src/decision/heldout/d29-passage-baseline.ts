import { readFileSync } from 'node:fs';
import { sha256 } from '../compile-cache/identity.js';

type Payload = { kind: string; claim?: string; source?: string; criterion?: string; evidence?: string; context?: string };
type Statement = { module: string; attribute: string; values: string[]; exclusive: boolean; negated: boolean };
const identifier = '([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)';
const attribute = '(port|protocol|region|owner team|major version)';
const values = '([A-Za-z0-9-]+(?: and [A-Za-z0-9-]+)*)';
const singleValued = new Set(['region', 'owner team', 'major version']);

function sentences(text: string): string[] {
  return text.split(/[.!?](?=\s|$|[)\]]|-->)|;|\r?\n/)
    .map(sentence => sentence.replace(/^(?:-->|<!--|[\s>()\[\]])+/, '').replace(/(?:-->|[\s()\[\]])+$/, ''))
    .filter(Boolean);
}

function statement(text: string): Statement | null {
  const forms: [RegExp, number, number, number, boolean, boolean][] = [
    [new RegExp(`^Module ${identifier} (?:uses|has|runs|listens on|now uses) ${attribute} ${values}$`), 1, 2, 3, false, false],
    [new RegExp(`^The ${attribute} recorded for Module ${identifier} is ${values}$`), 2, 1, 3, false, false],
    [new RegExp(`^Port ${values} is the port Module ${identifier} uses$`), 2, 0, 1, false, false],
    [new RegExp(`^Module ${identifier} is configured for, and currently uses, ${attribute} ${values}$`), 1, 2, 3, false, false],
    [new RegExp(`^Module ${identifier} (?:does not use|no longer uses|does not have|no longer has|does not run|no longer runs) ${attribute} ${values}$`), 1, 2, 3, false, true],
    [new RegExp(`^Module ${identifier} uses a single ${attribute}, ${values}, with no alternatives$`), 1, 2, 3, true, false],
    [new RegExp(`^For Module ${identifier}, the ${attribute} is restricted to ${values}$`), 1, 2, 3, true, false],
    [new RegExp(`^Module ${identifier} uses exactly one ${attribute}: ${values}$`), 1, 2, 3, true, false],
    [new RegExp(`^Module ${identifier} only uses ${attribute} ${values}$`), 1, 2, 3, true, false],
    [new RegExp(`^Module ${identifier} uses ${attribute} ${values} and no other (?:port|protocol|region|owner team|major version)$`), 1, 2, 3, true, false],
  ];
  for (const [pattern, moduleIndex, attributeIndex, valuesIndex, exclusive, negated] of forms) {
    const match = pattern.exec(text);
    if (match) return { module: match[moduleIndex], attribute: attributeIndex ? match[attributeIndex] : 'port',
      values: match[valuesIndex].split(' and '), exclusive, negated };
  }
  return null;
}

function verifiedCriterion(criterion: string, evidence: string): boolean {
  const match = new RegExp(`^Module ${identifier} requires independently verified (rollback coverage|security review sign-off|migration test coverage) for all components of the current release\\.$`).exec(criterion);
  if (!match) return false;
  const [, module, name] = match;
  const accepted = new Set([
    `Module ${module} has ${name} independently verified for all components of the current release`,
    `An independent assessor verified ${name} for every component in the current release of Module ${module}`,
    `The current release checklist for Module ${module} records independent verification of ${name} for all components`,
  ]);
  return sentences(evidence).some(sentence => accepted.has(sentence));
}

/** Deliberately naive visible-text comparator: context and screening-control attempts are not classified. */
export function d29PassageBaseline(payload: Payload, hardPass: boolean) {
  if (!hardPass) return { route: 'REVIEW', support: null };
  if (payload.kind === 'citation') {
    const claimParts = sentences(payload.claim ?? ''), claim = claimParts.length === 1 ? statement(claimParts[0]) : null;
    if (!claim || claim.negated || claim.values.length !== 1) return { route: 'REVIEW', support: 'unclear' };
    const facts = sentences(payload.source ?? '').map(statement).filter((fact): fact is Statement =>
      fact !== null && fact.module === claim.module && fact.attribute === claim.attribute);
    const contradicts = facts.some(fact => fact.negated ? fact.values.includes(claim.values[0])
      : !fact.values.includes(claim.values[0]) && (fact.exclusive || singleValued.has(claim.attribute)));
    const supports = facts.some(fact => !fact.negated && fact.values.includes(claim.values[0]));
    const support = contradicts ? 'contradicts' : supports ? 'supports' : 'unclear';
    return { route: support === 'supports' ? 'ADVISORY_READY' : 'REVIEW', support };
  }
  return { route: payload.kind === 'phase-criterion' && verifiedCriterion(payload.criterion ?? '', payload.evidence ?? '')
    ? 'ADVISORY_READY' : 'REVIEW', support: null };
}

export function d29PassageBaselineDigest(): `sha256:${string}` {
  return sha256(readFileSync(new URL(import.meta.url), 'utf8'));
}
