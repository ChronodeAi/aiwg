import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProbes, buildPlan } from '../../../tools/rules/run-rule-probes.mjs';
import { ROOT } from '../../../tools/rules/measure-startup-context.mjs';

const catalog = path.join(ROOT, 'test/uat/rule-binding/common-target-discovery-probes.yaml');

describe('common-target discovery catalog', () => {
  it('selects known shared capability types and retains strict scenario rules', () => {
    const data = loadProbes(catalog);
    const selected = data.rules.filter(rule => ['tool-quota', 'decision-offload'].includes(rule.id));
    expect(selected.map(rule => rule.id)).toEqual(['tool-quota', 'decision-offload']);
    const compounds = selected.map(rule => ({ rule: rule.id, probe: rule.probes.find(probe => probe.id === 'compound-discovery') }));
    expect(compounds.map(({ rule, probe }) => [rule, probe.compound_expected])).toEqual([
      ['tool-quota', { type: 'skill', names: ['ralph'] }],
      ['decision-offload', { type: 'skill', names: ['decision-evaluate', 'decision-offload'] }],
    ]);
    for (const { rule, probe } of compounds) {
      expect(probe.kind).toBe('positive');
      expect(probe.prompt.toLowerCase()).not.toContain(rule);
      expect(probe.prompt).not.toMatch(/required.rule.check|bound.rules|checklist/i);
      expect(probe.compound_action).toBeTruthy();
    }
    const plan = buildPlan(data, { provider: 'codex', rules: selected.map(rule => rule.id), n: 1 });
    expect(plan.calls.filter(call => call.probe === 'compound-discovery').map(call => call.rule)).toEqual(['tool-quota', 'decision-offload']);
  });
});
