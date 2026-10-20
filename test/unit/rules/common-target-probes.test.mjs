import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProbes, buildPlan, parseTrace, evaluateCompoundTrace } from '../../../tools/rules/run-rule-probes.mjs';
import { ROOT } from '../../../tools/rules/measure-startup-context.mjs';

const catalog = path.join(ROOT, 'test/uat/rule-binding/common-target-discovery-probes.yaml');

describe('common-target discovery catalog', () => {
  it('accepts a narrow match after unrelated discovery, while rejecting duplicate or conflicting rows', () => {
    const rule = { rule_id: 'aiwg:rule:abc', fetch_command: 'aiwg show rule aiwg:rule:abc' };
    const row = { id: 'aiwg:skill:abc', type: 'skill', name: 'ralph', bound_rules: [{ name: 'tool-quota' }], required_rule_checks: [rule] };
    const command = (id, text, output) => [
      { type: 'item.started', item: { id, type: 'command_execution' } },
      { type: 'item.completed', item: { id, type: 'command_execution', command: text, aggregated_output: output, status: 'completed', exit_code: 0 } },
    ];
    const run = (later, first = []) => {
      const events = [...command('broad', 'aiwg discover broad --json', JSON.stringify({ results: first })),
        ...command('narrow', 'aiwg discover narrow --json', JSON.stringify({ results: later })),
        ...command('other', 'aiwg discover other --json', JSON.stringify({ results: [] })),
        ...command('rule', 'aiwg show rule aiwg:rule:abc', 'rule body'),
        ...command('action', 'aiwg show skill ralph', 'skill body'), { type: 'turn.completed' }];
      return evaluateCompoundTrace(parseTrace(events.map(JSON.stringify).join('\n'), 'codex'), 'aiwg\\s+show\\s+skill', { type: 'skill', names: ['ralph'], rule: 'tool-quota' });
    };
    expect(run([row])).toMatchObject({ status: 'checked', pass: true });
    expect(run([row, row])).toMatchObject({ status: 'invalid', pass: false });
    expect(run([])).toMatchObject({ status: 'invalid', pass: false });
    expect(run([{ ...row, id: 'aiwg:skill:other' }], [row])).toMatchObject({ status: 'invalid', pass: false });
    expect(run([{ ...row, required_rule_checks: [] }], [row])).toMatchObject({ status: 'invalid', pass: false });
  });

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
