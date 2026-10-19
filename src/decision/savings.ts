import type { DecisionConfig } from '../config/decision-config.js';

/** Planning assumptions, not a vendor price quote or measured caller usage. */
export const DEFAULT_DECISION_SAVINGS_WEIGHTS = {
  caller_model_class: 'reasoning' as const,
  reasoning_tokens: 1024,
  output_tokens: 128,
  llm_per_mtok: 15,
  jev_per_mtok: 0.2,
};

export interface DecisionSavingsWeights {
  caller_model_class: 'standard' | 'reasoning';
  reasoning_tokens: number;
  output_tokens: number;
  llm_per_mtok: number;
  jev_per_mtok: number;
}

export interface DecisionSavingsMethod extends DecisionSavingsWeights {
  version: 'aiwg-decision-savings/v2';
  input_tokens: number;
}

export function decisionSavingsWeights(ask?: DecisionConfig['ask']): DecisionSavingsWeights {
  const modelClass = ask?.savings?.caller_model_class ?? 'reasoning';
  return {
    ...DEFAULT_DECISION_SAVINGS_WEIGHTS,
    ...ask?.cost,
    caller_model_class: modelClass,
    reasoning_tokens: ask?.savings?.reasoning_tokens ?? (modelClass === 'reasoning' ? 1024 : 256),
    output_tokens: ask?.savings?.output_tokens ?? 128,
  };
}

export function estimateDecisionSavings(inputTokens: number, answered: boolean, jevTokens: number, weights: DecisionSavingsWeights) {
  const llmTokens = answered ? inputTokens + weights.reasoning_tokens + weights.output_tokens : 0;
  return {
    llm_tokens_avoided: llmTokens,
    jev_tokens: jevTokens,
    cost_weighted_net_usd: (llmTokens * weights.llm_per_mtok - jevTokens * weights.jev_per_mtok) / 1_000_000,
    estimationMethod: { version: 'aiwg-decision-savings/v2' as const, input_tokens: inputTokens, ...weights },
  };
}
