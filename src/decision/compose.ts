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
  const failed = Object.values(evaluations).some(result => result.spec.status !== 'success');
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

  if (ruleset.spec.composition === 'collect') {
    const outcome = matches.map(rule => structuredClone(rule.outcome)) as JsonValue;
    validateAgainstSchema(ruleset.spec.outputSchema, outcome, 'collected outcome');
    return { status: 'completed', reason: 'none', outcome, matchedRules: matches.map(rule => rule.id) };
  }

  const top = matches.filter(rule => rule.priority === matches[0]!.priority);
  const unique = new Map<string, JsonValue>();
  for (const rule of top) unique.set(JSON.stringify(sortJson(rule.outcome)), rule.outcome);
  if (unique.size > 1) {
    if (ruleset.spec.conflict === 'review') {
      validateAgainstSchema(ruleset.spec.outputSchema, ruleset.spec.failureOutcome, 'failureOutcome');
      return {
        status: 'review',
        reason: 'conflicting-outcomes',
        outcome: structuredClone(ruleset.spec.failureOutcome),
        matchedRules: top.map(rule => rule.id),
      };
    }
    return { status: 'error', reason: 'conflicting-outcomes', matchedRules: top.map(rule => rule.id) };
  }
  const outcome = structuredClone(top[0]!.outcome);
  validateAgainstSchema(ruleset.spec.outputSchema, outcome, 'matched outcome');
  return { status: 'completed', reason: 'none', outcome, matchedRules: top.map(rule => rule.id) };
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, sortJson(child)]));
  }
  return value;
}
