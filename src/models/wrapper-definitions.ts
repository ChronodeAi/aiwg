// Canonical wrapper identities reuse the three catalog roles and their existing tiers.
export const MODEL_WRAPPERS = {
  reasoning: 'aiwg-model-reasoning-worker',
  coding: 'aiwg-model-coding-worker',
  efficiency: 'aiwg-model-efficiency-worker',
} as const;
export type ModelRole = keyof typeof MODEL_WRAPPERS;

export const MODEL_WRAPPER_DEFINITIONS = [
  { name: MODEL_WRAPPERS.reasoning, role: 'reasoning', tier: 'premium', effort: 'high', readOnly: false },
  { name: MODEL_WRAPPERS.coding, role: 'coding', tier: 'standard', effort: 'medium', readOnly: false },
  { name: MODEL_WRAPPERS.efficiency, role: 'efficiency', tier: 'economy', effort: 'low', readOnly: false },
  { name: 'aiwg-model-explorer', role: 'efficiency', tier: 'economy', effort: 'low', readOnly: true },
  { name: 'aiwg-model-verifier', role: 'coding', tier: 'standard', effort: 'medium', readOnly: true },
] as const;
export type ModelWrapperDefinition = typeof MODEL_WRAPPER_DEFINITIONS[number];
