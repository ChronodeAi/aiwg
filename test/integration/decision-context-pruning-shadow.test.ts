import { describe, expect, it } from 'vitest';
import {
  applyContextPruningPilot,
  assertShadowPromptByteIdentical,
  contextPruningDigest,
  renderContextPrompt,
  type ContextPruningCandidate,
  type ContextPruningPolicy,
} from '../../src/decision/context-pruning.js';

const now = () => '2026-09-29T12:00:00.000Z';
const digest = (value: unknown) => contextPruningDigest(value);

function item(id: string, content: string): ContextPruningCandidate {
  return {
    schemaVersion: 'decision-context-candidate/v1',
    itemId: id,
    locator: `fixture://${id}`,
    content,
    contentDigest: digest(content),
    source: { kind: 'ordinary', addedAt: now() },
    tokenEstimate: content.length,
    priority: 0.5,
    trust: 'untrusted',
    sensitivity: 'internal',
    dependencies: [],
    protectedHints: [],
    taskSubject: 'snapshot',
    dataPolicy: { externalEvaluation: 'allowed', localOnly: false, legalAction: 'none' },
  };
}

const basePolicy: ContextPruningPolicy = {
  mode: 'shadow',
  minimumConfidenceBps: 8_000,
  minimumMarginBps: 1_000,
  allowedDestructiveActions: ['drop'],
  calibrationDigest: `sha256:${'c'.repeat(64)}`,
  modelIdentityDigest: `sha256:${'d'.repeat(64)}`,
};

describe('D26 shadow prompt snapshot', () => {
  it('keeps baseline prompts byte-identical when disabled and in shadow mode', () => {
    const candidates = [
      item('rules', 'system and project instructions remain in the actual prompt'),
      item('distractor', 'ordinary retrieved note that shadow evidence would drop'),
    ];
    const baseline = renderContextPrompt(candidates);
    const disabled = applyContextPruningPilot({ candidates, policy: { ...basePolicy, mode: 'disabled' }, now });
    const shadow = applyContextPruningPilot({ candidates, policy: basePolicy, now, evidence: [{
      itemId: 'distractor',
      subject: 'context-item:distractor',
      status: 'success',
      proposedAction: 'drop',
      confidenceBps: 9_000,
      marginBps: 2_000,
      calibrated: true,
      calibrationDigest: basePolicy.calibrationDigest!,
      modelIdentityDigest: basePolicy.modelIdentityDigest!,
      decisionReceiptDigest: digest('receipt'),
    }] });
    expect(disabled.downstreamItemIds).toEqual(['rules', 'distractor']);
    expect(shadow.downstreamItemIds).toEqual(['rules', 'distractor']);
    expect(() => assertShadowPromptByteIdentical(baseline, disabled, candidates)).not.toThrow();
    expect(() => assertShadowPromptByteIdentical(baseline, shadow, candidates)).not.toThrow();
    expect(Buffer.from(renderContextPrompt(candidates)).equals(Buffer.from(baseline))).toBe(true);
  });
});
