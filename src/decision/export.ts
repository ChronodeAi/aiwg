import type { DecisionResult, RulesetResult } from './types.js';

/** Create an export copy. Provider correlation IDs remain internal unless policy permits them. */
export function decisionResultForExport<T extends DecisionResult | RulesetResult>(
  result: T,
  policy: { includeProviderRequestIds?: boolean } = {},
): T {
  const copy = structuredClone(result);
  if (policy.includeProviderRequestIds) return copy;
  const decisions: DecisionResult[] = copy.kind === 'DecisionResult'
    ? [copy as DecisionResult] : Object.values((copy as RulesetResult).spec.evaluations);
  for (const decision of decisions) {
    for (const attempt of decision.spec.attempts) {
      attempt.requestId = null;
      delete attempt.requestIdSource;
    }
  }
  return copy;
}
