import { describe, expect, it } from 'vitest';
import { parseTrace, evaluateCompoundTrace, evaluateRequiredRuleChecks, parseAIWGCommand, loadProbes, buildPlan, validateBaseline } from '../../../tools/rules/run-rule-probes.mjs';
import { ROOT } from '../../../tools/rules/measure-startup-context.mjs';
import path from 'node:path';

const identities = { shim: '/tmp/sample/bin/aiwg', cli: '/tmp/sample/installation/node_modules/aiwg/bin/aiwg.mjs', node: process.execPath };
const row = { id: 'aiwg:skill:abc', type: 'skill', name: 'migrate-workspace', bound_rules: [{ name: 'cli-secondary' }], required_rule_checks: [{ rule_id: 'aiwg:rule:abc', fetch_command: 'aiwg show rule aiwg:rule:abc' }] };
const cmd = (id, command, output, exit = 0) => [{ type: 'item.started', item: { id, type: 'command_execution' } }, { type: 'item.completed', item: { id, type: 'command_execution', command, aggregated_output: output, status: 'completed', exit_code: exit } }];
const discovery = cmd('discover', 'aiwg discover migration --json', JSON.stringify({ results: [row] }));
const show = cmd('show', 'aiwg show skill migrate-workspace', 'skill body');
const fetch = cmd('fetch', 'aiwg show rule aiwg:rule:abc', 'rule body');
const action = cmd('action', '/bin/bash -lc \'aiwg migrate-workspace --dry-run\'', 'No legacy workspace detected. No migration needed.');
const evaluate = events => evaluateCompoundTrace(parseTrace([...events, { type: 'turn.completed' }].map(JSON.stringify).join('\n'), 'codex'), 'aiwg\\s+show\\s+skill', { type: 'skill', names: ['migrate-workspace'], rule: 'cli-secondary' }, identities, true);

describe('governed migration preview', () => {
  it('uses a validated separate catalog with a neutral prompt', () => {
    const rule = loadProbes(path.join(ROOT, 'test/uat/rule-binding/governed-migration-probes.yaml')).rules.find(r => r.id === 'cli-secondary');
    const probe = rule.probes.find(p => p.id === 'governed-migration-preview');
    expect(probe.governed_action).toBe('migration-preview');
    expect(probe.prompt).not.toMatch(/cli-secondary|required.rule|checklist/i);
  });
  it('allows inspection before the required fetch but requires it before the actual action', () => {
    expect(evaluate([...discovery, ...show, ...fetch, ...action])).toMatchObject({ status: 'checked', pass: true });
    expect(evaluate([...discovery, ...cmd('read', 'cat .agents/skills/migrate-workspace/SKILL.md', 'body'), ...show, ...fetch, ...action])).toMatchObject({ status: 'checked', pass: true });
    expect(evaluate([...discovery, ...show, ...action, ...fetch])).toMatchObject({ status: 'checked', pass: false });
    expect(evaluate([...discovery, ...show, ...fetch])).toMatchObject({ status: 'invalid', pass: false });
    expect(evaluate([...discovery, ...fetch, ...action])).toMatchObject({ status: 'invalid', pass: false });
    expect(evaluate([...discovery, ...show, ...fetch, ...cmd('bad', 'aiwg migrate-workspace --dry-run', 'failed', 1), ...action])).toMatchObject({ status: 'invalid', pass: false });
    expect(evaluate([...discovery, ...show, ...fetch, ...cmd('bad', '/foreign/aiwg migrate-workspace --dry-run', 'no'), ...action])).toMatchObject({ status: 'invalid', pass: false });
    expect(evaluate([...discovery, ...show, ...fetch, ...cmd('bad', 'aiwg migrate-workspace', 'no'), ...action])).toMatchObject({ status: 'invalid', pass: false });
    expect(evaluate([...discovery, ...show, ...fetch, ...cmd('bad', '"/foreign/aiwg" migrate-workspace', 'no'), ...action])).toMatchObject({ status: 'invalid', pass: false });
  });
  it('accepts a selected CLI JSON alias only when its entire envelope binds the aligned checklist identity', () => {
    const alias = cmd('alias', 'aiwg show rule cli-secondary --json', JSON.stringify({ id: 'aiwg:rule:abc', type: 'rule', name: 'cli-secondary', content: 'rule body' }));
    expect(evaluate([...discovery, ...show, ...alias, ...action])).toMatchObject({ status: 'checked', pass: true });
    expect(evaluate([...discovery, ...show, ...action, ...alias])).toMatchObject({ status: 'checked', pass: false });
    for (const type of ['rule', 'behavior']) {
      const id = `aiwg:${type}:abc`, name = 'cli-secondary';
      const check = { rule_id: id, fetch_command: `aiwg show ${type} ${id}` };
      const envelope = { id, type, name, content: 'complete body' };
      const evaluateFetch = (command, output, exit = 0, late = false, bound = name) => {
        const events = late ? [...action, ...cmd('alias', command, output, exit)] : [...cmd('alias', command, output, exit), ...action];
        const trace = parseTrace([...events, { type: 'turn.completed' }].map(JSON.stringify).join('\n'), 'codex');
        const start = trace.tools.find(tool => parseAIWGCommand(tool.input, identities)?.kind === 'migration-preview').start_event;
        return evaluateRequiredRuleChecks([check], trace, null, identities, start, [{ name: bound }])[0].pass;
      };
      const command = `aiwg show ${type} ${name} --json`, body = JSON.stringify(envelope);
      expect(evaluateFetch(command, body)).toBe(true);
      expect(evaluateFetch(`aiwg show ${type} ${name}`, body)).toBe(false);
      expect(evaluateFetch(command, 'complete body')).toBe(false);
      expect(evaluateFetch(command, body, 1)).toBe(false);
      expect(evaluateFetch(command, body, 0, true)).toBe(false);
      expect(evaluateFetch(`/foreign/${command}`, body)).toBe(false);
      expect(evaluateFetch(command, body, 0, false, 'different')).toBe(false);
      for (const payload of [[], { result: envelope }, { ...envelope, id: `aiwg:${type}:other` },
        { ...envelope, type: 'other' }, { ...envelope, name: 'other' }, { ...envelope, content: '  ' },
        { ...envelope, content: ['body'] }]) expect(evaluateFetch(command, JSON.stringify(payload))).toBe(false);
      expect(evaluateFetch(command, `${body}\ntrailing prose`)).toBe(false);
    }
  });
  it('rejects forged equal or incorrectly bound baseline integrity evidence', () => {
    const data = loadProbes(path.join(ROOT, 'test/uat/rule-binding/governed-migration-probes.yaml'));
    const plan = buildPlan(data, { provider: 'codex', rules: ['cli-secondary'], n: 5 });
    plan.calls = plan.calls.filter(call => call.governed_action); plan.call_count = plan.calls.length;
    const identity = { fixture_sha256: 'a'.repeat(64), installation_sha256: 'b'.repeat(64) };
    const runs = plan.calls.map(call => ({ rule: call.rule, probe: call.probe, repetition: call.repetition, kind: call.kind, stdout: '', governed_integrity: { before: {}, after: {} } }));
    const baseline = { provider: plan.provider, model: plan.model, effort: plan.effort, probe_digest: plan.probe_digest, runs, identity };
    expect(() => validateBaseline(plan, baseline)).toThrow('Incomplete governed integrity evidence');
    for (const run of runs) run.governed_integrity = { before: { fixture: 'c'.repeat(64), installation: 'b'.repeat(64) }, after: { fixture: 'c'.repeat(64), installation: 'b'.repeat(64) } };
    expect(() => validateBaseline(plan, baseline)).toThrow('Incomplete governed integrity evidence');
  });

  it('recognizes only the exact safe selected command', () => {
    expect(parseAIWGCommand('/bin/bash -lc \'aiwg migrate-workspace --dry-run\'', identities)).toEqual({ kind: 'migration-preview' });
    for (const command of ['/foreign/aiwg migrate-workspace --dry-run', 'aiwg migrate-workspace', 'aiwg migrate-workspace --dry-run; touch x', 'aiwg migrate-workspace --dry-run > x']) expect(parseAIWGCommand(command, identities)).toBeNull();
  });
});
