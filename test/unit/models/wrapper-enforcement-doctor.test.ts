// Exercise actual artifact controls independently of generated defaults.
import { describe, expect, it } from 'vitest';
import { deployedWrapperEnforcement, isConcreteWrapperModel, wrapperEnforcementReport,
  wrapperModelRisks } from '../../../src/models/wrapper-enforcement.js';

describe('doctor wrapper enforcement', () => {
  it('distinguishes observed pins from inherited model and effort', () => {
    expect(deployedWrapperEnforcement('codex', { model: 'custom-model', effort: 'medium', inheritedModel: 'gpt-6-astra' }))
      .toEqual({ model: 'pinned', effort: 'pinned', effectiveModel: 'custom-model', effectiveEffort: 'medium' });
    expect(deployedWrapperEnforcement('codex', { inheritedModel: 'gpt-6-luna', inheritedEffort: 'low' }))
      .toEqual({ model: 'inherited', effort: 'inherited', effectiveModel: 'gpt-6-luna', effectiveEffort: 'low' });
    expect(deployedWrapperEnforcement('codex', { model: 'custom-model', effort: 'bogus' }).effort).toBe('inherited');
    expect(deployedWrapperEnforcement('copilot', { model: 'custom-model', effort: 'high' }).effort).toBe('inherited');
    expect(deployedWrapperEnforcement('unknown', {}).model).toBe('inherited');
    expect(deployedWrapperEnforcement('claude', { effort: 'xhigh' }).effort).toBe('inherited');
    expect(deployedWrapperEnforcement('codex', { effort: 'xhigh' }).effort).toBe('pinned');
  });

  it.each(['hermes', 'warp', 'muse', 'grokbot'])('does not mistake mirror fields for native pins on %s', provider => {
    expect(deployedWrapperEnforcement(provider, { model: 'custom-model', effort: 'high', inheritedModel: 'global-model' }))
      .toMatchObject({ model: 'global-only', effort: 'global-only', effectiveModel: 'global-model' });
  });

  it('uses the existing report format for observed artifact model and effort', () => {
    expect(wrapperEnforcementReport('codex', { model: 'custom-model', effort: 'high' }))
      .toContain('Tier enforcement (deployed wrapper): pinned; effort: pinned via model_reasoning_effort.');
    expect(wrapperEnforcementReport('codex', {})).toContain('): inherited; effort: inherited.');
    expect(wrapperEnforcementReport('hermes', {})).toContain('): global-only; effort: global-only.');
  });

  it.each([' ', 'unknown', 'unresolved', 'placeholder', 'TODO', '${MODEL}', '<model>', 'configured/coding', 'Hint(role)'])(
    'flags unresolved value %s', model => {
      expect(isConcreteWrapperModel(model)).toBe(false);
      expect(wrapperModelRisks('codex', { model, inheritedModel: 'gpt-6-luna' }))
        .toContain('delegation.unresolved-model');
    });

  it('flags a missing effective model, including unknown providers', () => {
    expect(wrapperModelRisks('codex', {})).toEqual(['delegation.unresolved-model']);
    expect(wrapperModelRisks('unknown', { inheritedModel: 'gpt-6-astra' }))
      .toEqual(['delegation.flagship-inheritance']);
  });

  it.each(['gpt-6-astra', 'gpt-6.1-sol'])('flags unelected inherited expensive model %s', inheritedModel => {
    expect(wrapperModelRisks('codex', { inheritedModel })).toEqual(['delegation.flagship-inheritance']);
    expect(wrapperModelRisks('codex', { model: inheritedModel })).toEqual([]);
    expect(wrapperModelRisks('codex', { inheritedModel, election: 'user' })).toEqual([]);
    expect(wrapperModelRisks('codex', { inheritedModel, agentName: 'worker', flagshipAllowlist: ['worker'] })).toEqual([]);
    expect(wrapperModelRisks('codex', { inheritedModel, agentName: 'other', flagshipAllowlist: ['worker'] }))
      .toEqual(['delegation.flagship-inheritance']);
  });

  it('accounts for forced Claude fallback, premium aliases and global-only inheritance', () => {
    expect(wrapperModelRisks('claude', { model: 'sonnet', inheritedModel: 'opus', forceInheritedModel: true }))
      .toEqual(['delegation.flagship-inheritance']);
    expect(wrapperModelRisks('claude', { model: 'sonnet', inheritedModel: 'opus' })).toEqual([]);
    expect(wrapperModelRisks('hermes', { model: 'cheap', inheritedModel: 'gpt-6-astra' }))
      .toEqual(['delegation.flagship-inheritance']);
    expect(wrapperModelRisks('hermes', { inheritedModel: 'openai/gpt-6.1-sol' }))
      .toEqual(['delegation.flagship-inheritance']);
    expect(wrapperModelRisks('hermes', { inheritedModel: 'global-delegation-model' }))
      .toEqual(['delegation.unresolved-model']);
    expect(wrapperModelRisks('codex', { inheritedModel: 'gpt-6-luna' })).toEqual([]);
  });
});
