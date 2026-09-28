import type { DecisionResult, DecisionRuleset, JsonValue } from './types.js';
import { evaluatePredicate } from './predicates.js';
import { validateAgainstSchema } from './validate.js';

export interface CompositionResult {
  status: 'completed' | 'defaulted' | 'review' | 'error';
  reason: 'none' | 'no-match' | 'conflicting-outcomes' | 'invalid-output' | 'evaluation-failed';
  outcome?: JsonValue;
  matchedRules: string[];
}

export function composeRuleset(
  ruleset: DecisionRuleset,
  input: unknown,
  evaluations: Record<string, DecisionResult>,
): CompositionResult {
  const referencedAliases = referencedDecisionAliases(ruleset);
  const requiredEvaluations = new Map(ruleset.spec.evaluations
    .filter(evaluation => referencedAliases.includes(evaluation.alias))
    .map(evaluation => [evaluation.alias, evaluation]));
  const suppliedFailed = Object.values(evaluations).some(result => !acceptedEvaluation(result));
  const requiredFailed = [...requiredEvaluations].some(([alias, evaluation]) => {
    const result = evaluations[alias];
    return !result || !acceptedEvaluation(result) || !samePin(result.spec.decision, evaluation.decision);
  });
  const failed = suppliedFailed || requiredFailed;
  if (failed) {
    validateAgainstSchema(ruleset.spec.outputSchema, ruleset.spec.failureOutcome, 'failureOutcome');
    return {
      status: 'review',
      reason: 'evaluation-failed',
      outcome: structuredClone(ruleset.spec.failureOutcome),
      matchedRules: [],
    };
  }

  const matches = ruleset.spec.rules
    .filter(rule => evaluatePredicate(rule.when, input, evaluations) === true)
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));

  if (matches.length === 0) {
    validateAgainstSchema(ruleset.spec.outputSchema, ruleset.spec.defaultOutcome, 'defaultOutcome');
    return { status: 'defaulted', reason: 'no-match', outcome: structuredClone(ruleset.spec.defaultOutcome), matchedRules: [] };
  }

  if (ruleset.spec.composition === 'collect' || ruleset.spec.composition.startsWith('collect-')) {
    const collected = matches.map(rule => structuredClone(rule.outcome)) as JsonValue[];
    const outcome = ruleset.spec.composition === 'collect' ? collected : aggregateCollect(collected, ruleset.spec.composition);
    validateAgainstSchema(ruleset.spec.outputSchema, outcome, 'collected outcome');
    return { status: 'completed', reason: 'none', outcome, matchedRules: matches.map(rule => rule.id) };
  }

  if (ruleset.spec.composition === 'unique' && matches.length > 1) return conflictResult(ruleset, matches);

  if (ruleset.spec.composition === 'any') {
    const first = sortJson(matches[0]!.outcome);
    if (matches.some(rule => JSON.stringify(sortJson(rule.outcome)) !== JSON.stringify(first))) return conflictResult(ruleset, matches);
    const outcome = structuredClone(matches[0]!.outcome);
    validateAgainstSchema(ruleset.spec.outputSchema, outcome, 'matched outcome');
    return { status: 'completed', reason: 'none', outcome, matchedRules: matches.map(rule => rule.id) };
  }

  const top = matches.filter(rule => rule.priority === matches[0]!.priority);
  const unique = new Map<string, JsonValue>();
  for (const rule of top) unique.set(JSON.stringify(sortJson(rule.outcome)), rule.outcome);
  if (unique.size > 1) return conflictResult(ruleset, top);
  const outcome = structuredClone(top[0]!.outcome);
  validateAgainstSchema(ruleset.spec.outputSchema, outcome, 'matched outcome');
  return { status: 'completed', reason: 'none', outcome, matchedRules: top.map(rule => rule.id) };
}



function acceptedEvaluation(result: DecisionResult): boolean {
  return result.spec.status === 'success'
    && (result.spec.acceptance === undefined || result.spec.acceptance.disposition === 'act');
}

function samePin(left: DecisionResult['spec']['decision'], right: DecisionRuleset['spec']['evaluations'][number]['decision']): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest;
}

function referencedDecisionAliases(ruleset: DecisionRuleset): string[] {
  const aliases = new Set<string>();
  const visit = (predicate: DecisionRuleset['spec']['rules'][number]['when']): void => {
    if ('all' in predicate) predicate.all.forEach(visit);
    else if ('any' in predicate) predicate.any.forEach(visit);
    else if ('not' in predicate) visit(predicate.not);
    else if (predicate.left.source === 'decision' && predicate.left.alias) aliases.add(predicate.left.alias);
  };
  ruleset.spec.rules.forEach(rule => visit(rule.when));
  return [...aliases].sort();
}

function conflictResult(ruleset: DecisionRuleset, matches: DecisionRuleset['spec']['rules']): CompositionResult {
  if (ruleset.spec.conflict === 'review') {
    validateAgainstSchema(ruleset.spec.outputSchema, ruleset.spec.failureOutcome, 'failureOutcome');
    return {
      status: 'review',
      reason: 'conflicting-outcomes',
      outcome: structuredClone(ruleset.spec.failureOutcome),
      matchedRules: matches.map(rule => rule.id),
    };
  }
  return { status: 'error', reason: 'conflicting-outcomes', matchedRules: matches.map(rule => rule.id) };
}

function aggregateCollect(values: JsonValue[], composition: DecisionRuleset['spec']['composition']): JsonValue {
  if (composition === 'collect-count') return values.length;
  if (!values.every(value => typeof value === 'number' && Number.isFinite(value))) {
    throw new Error(`${composition} requires finite numeric outcomes`);
  }
  const numbers = values as number[];
  if (composition === 'collect-sum') return numbers.reduce((sum, value) => sum + value, 0);
  if (composition === 'collect-min') return Math.min(...numbers);
  if (composition === 'collect-max') return Math.max(...numbers);
  return values as JsonValue;
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, sortJson(child)]));
  }
  return value;
}
