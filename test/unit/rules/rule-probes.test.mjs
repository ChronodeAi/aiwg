import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import Ajv from 'ajv/dist/2020.js';
import { spawnSync } from 'node:child_process';
import { boundedExecFileSync } from '../../../src/process/bounded-child-process.mjs';
import { ROOT } from '../../../tools/rules/measure-startup-context.mjs';
import { REQUIRED_RULES, loadProbes, buildPlan, parseTrace, ruleFetches, evaluateAssertions,
  summarizeRuns, executePlan as executePlanImpl, armIdentity, treeIdentity, validateBaseline, evaluateCompoundTrace, parseAIWGCommand } from '../../../tools/rules/run-rule-probes.mjs';

const temps = [];
afterEach(() => { for (const temp of temps.splice(0)) fs.rmSync(temp, { recursive: true, force: true }); });
function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-probe-unit-')); temps.push(dir); return dir; }
function installedPackage(cli = '', { dependency } = {}) {
  const installation = tempDir(), root = path.join(installation, 'node_modules/aiwg');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  const packageManifest = { name: 'aiwg', version: '1.0.0', ...(dependency ? { dependencies: { 'probe-dep': '1.0.0' } } : {}) };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(packageManifest));
  fs.writeFileSync(path.join(root, 'bin/aiwg.mjs'), cli);
  fs.writeFileSync(path.join(installation, 'package.json'), JSON.stringify({ private: true, dependencies: { aiwg: '1.0.0' } }));
  const packages = { '': { dependencies: { aiwg: '1.0.0' } }, 'node_modules/aiwg': { version: '1.0.0' } };
  if (dependency) {
    const dep = path.join(installation, 'node_modules/probe-dep'); fs.mkdirSync(dep);
    fs.writeFileSync(path.join(dep, 'package.json'), JSON.stringify({ name: 'probe-dep', version: '1.0.0', type: 'module', exports: './index.js' }));
    fs.writeFileSync(path.join(dep, 'index.js'), `export default ${JSON.stringify(dependency)};\n`);
    packages['node_modules/probe-dep'] = { version: '1.0.0' };
    packages['node_modules/aiwg'].dependencies = { 'probe-dep': '1.0.0' };
  }
  fs.writeFileSync(path.join(installation, 'package-lock.json'), JSON.stringify({ name: 'probe-installation', lockfileVersion: 3, packages }));
  return root;
}
function executePlan(plan, options) {
  if (options.packageRoot === ROOT) {
    options = { ...options, packageRoot: installedPackage() };
  }
  return executePlanImpl(plan, { ...options, expectedIdentity: armIdentity(plan, plan.project, options.packageRoot,
    { requireCompoundChecks: options.requireCompoundChecks, authTarget: options.authTarget, skillsReference: options.skillsReference }) });
}
function mutatedProbes(mutate) {
  const data = loadProbes(); mutate(data);
  const file = path.join(tempDir(), 'probes.yaml'); fs.writeFileSync(file, yaml.dump(data)); return file;
}
function claudeTrace(text = '{"action":"fix"}', tools = []) {
  return [...tools.flatMap((tool, i) => [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: String(i), name: tool.name, input: tool.input }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: String(i), content: 'body', is_error: tool.error ?? false }] } },
  ]), { type: 'result', subtype: 'success', result: text }].map(event => JSON.stringify(event)).join('\n');
}

describe('rule probe schema and call planning', () => {
  it('requires card drill-in and a full rule fetch for the governed card lane', () => {
    const rule = loadProbes(path.join(ROOT, 'test/uat/rule-binding/compound-discovery-probes.yaml'))
      .rules.find(rule => rule.id === 'tool-quota');
    const probes = rule.probes.filter(probe => probe.id.startsWith('card-'));
    expect(probes.map(probe => probe.kind)).toEqual(['positive', 'positive', 'negative']);
    const tool = command => ({ name: 'Bash', input: { command }, success: true });
    for (const probe of probes.filter(probe => probe.kind === 'positive')) {
      const text = JSON.stringify({ next: 'stop-and-report', default_max_iterations: 10,
        retry_limit: 3, reason: 'Read the loop parameters and its bound quota rule.' });
      const card = [tool('aiwg discover "ralph loop" --json'), tool('aiwg show skill ralph')];
      const drill = tool('aiwg show skill ralph --section "Parameters"');
      const fetch = tool('aiwg show rule tool-quota --body');
      const passes = tools => evaluateAssertions(probe.assertions, { text, tools }).every(a => a.pass);
      expect(passes(card)).toBe(false);
      expect(passes([...card, drill])).toBe(false);
      expect(passes([...card, fetch])).toBe(false);
      expect(passes([...card, drill, { ...fetch, success: false }])).toBe(false);
      expect(passes([...card, drill, fetch])).toBe(true);
      const routedCard = [card[0], tool('aiwg show skill ralph --backend fortemi-core --resource-source local')];
      const routedDrill = tool('aiwg show skill ralph --backend fortemi-core --resource-source local --section "Parameters"');
      const routedFetch = tool('aiwg show rule tool-quota --backend fortemi-core --resource-source local --body');
      expect(passes([...routedCard, routedDrill, routedFetch])).toBe(true);
      expect(passes([...routedCard, tool('aiwg show skill ralph --backend fortemi-core --resource-source local --rules --with-rule-bodies')])).toBe(true);
      expect(passes([...card, drill, fetch, { name: 'Read', input: { file_path: 'SKILL.md' },
        success: true }])).toBe(false);
    }
    const negative = probes.find(probe => probe.kind === 'negative');
    expect(evaluateAssertions(negative.assertions, { text: '{"answer":25}', tools: [] })
      .every(a => a.pass)).toBe(true);
    expect(evaluateAssertions(negative.assertions, { text: '{"answer":25}',
      tools: [tool('aiwg show skill ralph --body')] }).every(a => a.pass)).toBe(false);
  });

  it.each(['sdlc-a', 'sdlc-b', 'utils', 'secops', 'addons'])('validates and merges the %s lane with the base', lane => {
    const file = path.join(ROOT, `test/uat/rule-binding/wave5-${lane}-probes.yaml`);
    const overlay = yaml.load(fs.readFileSync(file, 'utf8'));
    const validate = new Ajv({ allErrors: true, strict: true }).compile(JSON.parse(
      fs.readFileSync(path.join(ROOT, 'test/uat/rule-binding/probes.schema.json'), 'utf8')));
    expect(validate(overlay), JSON.stringify(validate.errors)).toBe(true);
    const merged = loadProbes(file);
    expect(merged.rules.map(rule => rule.id)).toEqual([...loadProbes().rules, ...overlay.rules].map(rule => rule.id));
    const selected = overlay.rules.map(rule => rule.id);
    const plan = buildPlan(merged, { rules: selected });
    expect(plan.call_count).toBe(overlay.rules.reduce((n, rule) => n + rule.probes.length * 5, 0));
    expect(plan.calls.every(call => selected.includes(call.rule))).toBe(true);
  });

  it('overlays intentional rule replacements but rejects duplicate, empty, or malformed lanes', () => {
    const original = loadProbes().rules[0];
    const replacement = structuredClone(original);
    replacement.probes[0].prompt += ' Use the lane-specific scenario.';
    const file = path.join(tempDir(), 'lane.yaml');
    const write = rules => fs.writeFileSync(file, yaml.dump({ version: 1, extends: 'probes.yaml', rules }));
    write([replacement]);
    expect(loadProbes(file).rules).toHaveLength(REQUIRED_RULES.length);
    expect(loadProbes(file).rules[0]).toEqual(replacement);
    write([replacement, replacement]);
    expect(() => loadProbes(file)).toThrow('Duplicate rule');
    write([]);
    expect(() => loadProbes(file)).toThrow('Probe schema');
    write([{ ...replacement, probes: [] }]);
    expect(() => loadProbes(file)).toThrow('Probe schema');
    write([{ ...replacement, source: 'agentic/code/missing.md' }]);
    expect(() => loadProbes(file)).toThrow('Missing or unsafe');
  });

  it('keeps reviewed decisions specific, explains them, and rejects unsafe shortcuts', () => {
    const review = JSON.parse(fs.readFileSync(path.join(ROOT,
      'test/uat/rule-binding/wave5-probe-review.json'), 'utf8'));
    for (const control of review.adversarial_controls) {
      const rule = loadProbes(path.join(ROOT, control.lane)).rules.find(rule => rule.id === control.rule);
      const probe = rule.probes.find(probe => probe.id === control.probe);
      expect(probe.kind).toBe('positive'); // U5 in-scope; U7 stays out-of-scope.
      expect(probe.prompt).toContain(control.expected_action);
      expect(probe.prompt).toContain(control.unsafe_action);
      const tools = control.rule === 'skill-discovery'
        ? [{ name: 'Bash', input: { command: 'aiwg discover "workspace health"' }, success: true }] : [];
      const trace = action => ({ text: JSON.stringify({ action, reason: 'Decision rationale.' }), tools });
      expect(evaluateAssertions(probe.assertions, trace(control.expected_action)).every(a => a.pass)).toBe(true);
      expect(evaluateAssertions(probe.assertions, trace(control.unsafe_action)).every(a => a.pass)).toBe(false);
      expect(evaluateAssertions(probe.assertions, { text: JSON.stringify({ action: control.expected_action,
        reason: ' ' }), tools }).every(a => a.pass)).toBe(false);
      expect(rule.probes.some(p => p.kind === 'negative' && p.id === 'negative-1')).toBe(true);
    }
    for (const entry of review.reviews) {
      const rule = loadProbes(path.join(ROOT, entry.lane)).rules.find(rule => rule.id === entry.rule);
      const probe = rule.probes.find(probe => probe.id === entry.probe);
      expect(probe.assertions.some(a => a.type === 'json-matches' && a.path === 'reason' && a.pattern === '\\S')).toBe(true);
      if (entry.rule !== 'skill-discovery') expect(probe.assertions.some(a => a.type === 'tool-matches')).toBe(false);
      for (const assertion of probe.assertions.filter(a => a.type === 'json-equals' && typeof a.value === 'string')) {
        expect(probe.prompt).toContain(assertion.value);
      }
    }
  });

  it('still requires actual discovery when the decision says a capability was searched', () => {
    const rule = loadProbes().rules.find(rule => rule.id === 'skill-discovery');
    for (const probe of rule.probes.filter(probe => probe.kind === 'positive')) {
      const action = probe.assertions.find(a => a.path === 'action').value;
      const trace = { text: JSON.stringify({ action, reason: 'Local lookup.' }), tools: [] };
      expect(evaluateAssertions(probe.assertions, trace).every(a => a.pass)).toBe(false);
      trace.tools.push({ name: 'Bash', input: { command: 'aiwg discover "workspace health"' }, success: true });
      expect(evaluateAssertions(probe.assertions, trace).every(a => a.pass)).toBe(true);
    }
  });

  it.each(['addons', 'secops'])('dry-runs the formerly unloadable %s lane without vendor executables', lane => {
    const file = path.join(ROOT, `test/uat/rule-binding/wave5-${lane}-probes.yaml`);
    const rule = yaml.load(fs.readFileSync(file, 'utf8')).rules[0].id;
    const stdout = boundedExecFileSync(process.execPath, [path.join(ROOT, 'tools/rules/run-rule-probes.mjs'),
      '--dry-run', '--probes', file, '--rule', rule], 'quick', {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, PATH: '' }, maxBuffer: 4 * 1024 * 1024,
    });
    const plan = JSON.parse(stdout);
    expect(plan.call_count).toBe(15);
    expect(plan.calls.every(call => call.rule === rule)).toBe(true);
  });

  it('covers all 20 table rules plus anti-laziness, each with two positives and a negative', () => {
    const data = loadProbes();
    expect(data.rules.map(rule => rule.id).sort()).toEqual([...REQUIRED_RULES].sort());
    for (const rule of data.rules) {
      expect(fs.existsSync(path.join(ROOT, rule.source))).toBe(true);
      expect(rule.probes.filter(probe => probe.kind === 'positive').length).toBeGreaterThanOrEqual(2);
      expect(rule.probes.filter(probe => probe.kind === 'negative').length).toBeGreaterThanOrEqual(1);
    }
  });

  it('supplies exact string answer labels in each prompt or its read fixtures', () => {
    // Free-text decisions must not fail solely for choosing a synonymous label.
    // Fixture-derived names remain valid: those probes require reading the evidence.
    for (const rule of loadProbes().rules) for (const probe of rule.probes) {
      const supplied = [probe.prompt, ...Object.entries(probe.files ?? {}).flat()].join('\n');
      for (const assertion of probe.assertions.filter(item => item.type === 'json-equals')) {
        const values = Array.isArray(assertion.value) ? assertion.value : [assertion.value];
        for (const value of values.filter(item => typeof item === 'string')) {
          expect(supplied, `${rule.id}/${probe.id}: ${assertion.path}`).toContain(value);
        }
      }
    }
  });

  it.each([
    ['one positive', data => data.rules[0].probes.splice(0, 1)],
    ['no negative', data => data.rules[0].probes = data.rules[0].probes.filter(probe => probe.kind === 'positive')],
    ['unknown assertion', data => data.rules[0].probes[0].assertions = [{ type: 'always-pass' }]],
    ['missing coverage', data => data.rules.pop()],
    ['duplicate rule', data => data.rules[1].id = data.rules[0].id],
    ['duplicate probe', data => data.rules[0].probes[1].id = data.rules[0].probes[0].id],
    ['unsafe file', data => data.rules[0].probes[0].files = { '../escape': 'bad' }],
    ['missing source', data => data.rules[0].source = 'agentic/code/missing-rule.md'],
    ['bad regex', data => data.rules[0].probes[0].assertions = [{ type: 'json-matches', path: 'reason', pattern: '[' }]],
  ])('rejects %s before any CLI calls', (_name, mutate) => {
    expect(() => loadProbes(mutatedProbes(mutate))).toThrow();
  });

  it.each(['claude', 'codex'])('dry-run prints the full %s call plan without invoking a CLI', provider => {
    // Empty PATH makes either model executable unavailable; Node is absolute.
    const stdout = boundedExecFileSync(process.execPath, [path.join(ROOT, 'tools/rules/run-rule-probes.mjs'),
      '--dry-run', '--provider', provider, '--model', 'fixture-cheap-model'], 'quick', {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, PATH: '' }, maxBuffer: 4 * 1024 * 1024,
    });
    const plan = JSON.parse(stdout);
    expect(plan.call_count).toBe(320);
    expect(plan.n).toBe(5);
    expect(plan.calls.every(call => call.command === provider && call.args.includes('fixture-cheap-model'))).toBe(true);
    expect(plan.calls[0].args[0]).toBe(provider === 'claude' ? '-p' : 'exec');
    expect(new Set(plan.calls.map(call => `${call.rule}/${call.probe}`)).size).toBe(64);
  });

  it('allows scoped repeat counts for exploration and rejects unknown rules/providers/counts', () => {
    expect(buildPlan(loadProbes(), { rules: ['quiet-mode'], n: 2 }).call_count).toBe(6);
    expect(() => buildPlan(loadProbes(), { n: 0 })).toThrow();
    expect(() => buildPlan(loadProbes(), { provider: 'other' })).toThrow();
    expect(() => buildPlan(loadProbes(), { rules: ['typo'] })).toThrow();
  });

  it('plans the versioned governed preview with the exact supported argv', () => {
    const data = loadProbes(path.join(ROOT, 'test/uat/rule-binding/governed-migration-probes.yaml'));
    const plan = buildPlan(data, { provider: 'codex', rules: ['cli-secondary'], n: 1 });
    const call = plan.calls.find(item => item.probe === 'governed-migration-preview-v2');
    expect(call).toMatchObject({
      governed_action: 'migration-preview-v2',
      governed_argv: ['migrate-workspace', '--dry-run'],
    });
    expect(call.prompt).toContain('run exactly one `aiwg migrate-workspace --dry-run`');
    expect(call.prompt).toContain('JSON flags apply only to discovery and show commands');
    expect(call.prompt).not.toContain('migrate-workspace --dry-run --json');
  });

  it('retains the v1 governed catalog and prompt contract for evidence replay', () => {
    const source = fs.readFileSync(path.join(ROOT, 'test/uat/rule-binding/governed-migration-probes.yaml'), 'utf8');
    const file = path.join(tempDir(), 'governed-v1.yaml');
    fs.writeFileSync(file, source
      .replace('id: governed-migration-preview-v2', 'id: governed-migration-preview')
      .replace('governed_action: migration-preview-v2', 'governed_action: migration-preview'));
    const plan = buildPlan(loadProbes(file), { provider: 'codex', rules: ['cli-secondary'], n: 1 });
    const call = plan.calls.find(item => item.governed_action === 'migration-preview');
    expect(call.probe).toBe('governed-migration-preview');
    expect(call.governed_argv).toBeUndefined();
    expect(call.prompt).not.toContain('For the governed preview, run exactly one');
  });

  it('plans the complete fair Codex semantic lane without drifting from its source catalogs', () => {
    const common = loadProbes(path.join(ROOT, 'test/uat/rule-binding/common-target-discovery-probes.yaml'));
    const governed = loadProbes(path.join(ROOT, 'test/uat/rule-binding/governed-migration-probes.yaml'));
    const combined = loadProbes(path.join(ROOT, 'test/uat/rule-binding/codex-semantic-qualification-probes.yaml'));
    for (const id of ['tool-quota', 'decision-offload']) {
      expect(combined.rules.find(rule => rule.id === id)).toEqual(common.rules.find(rule => rule.id === id));
    }
    expect(combined.rules.find(rule => rule.id === 'cli-secondary')).toEqual(governed.rules.find(rule => rule.id === 'cli-secondary'));
    const selected = ['tool-quota', 'decision-offload', 'cli-secondary'];
    const plan = buildPlan(combined, { provider: 'codex', model: 'gpt-6.1-sol', effort: 'low', rules: selected, n: 5 });
    expect(plan.call_count).toBe(60);
    expect(new Set(plan.calls.map(call => call.rule))).toEqual(new Set(selected));
    expect(plan.calls.filter(call => call.governed_action)).toHaveLength(5);
    expect(plan).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'low', n: 5 });
  });
});

describe('trace evidence and U5/U7 gates (no vendor executables)', () => {
  it('checks observed discovery obligations against completed fetches before the read-only action', () => {
    const checks = [{ rule_id: 'aiwg:rule:abc', fetch_command: 'aiwg show rule aiwg:rule:abc' }];
    const tool = (input, output, start, end, success = true) => ({ name: 'shell', input, output, start_event: start, completed_event: end, success });
    const discovery = tool('aiwg discover fleet --json', JSON.stringify({ results: [{ id: 'aiwg:agent:xyz', type: 'agent', name: 'fleet-quiet-bot', required_rule_checks: checks, bound_rules: [{ name: 'quiet-mode' }] }] }), 0, 1);
    const fetch = tool('aiwg show rule aiwg:rule:abc', 'full rule body', 2, 3);
    const action = tool('aiwg show agent aiwg:agent:xyz', 'agent body', 4, 5);
    const evaluate = tools => evaluateCompoundTrace({ tools, events: [{ type: 'turn.completed' }] }, 'aiwg\\s+show\\s+agent');
    expect(evaluate([discovery, fetch, action])).toMatchObject({ status: 'checked', pass: true });
    expect(evaluate([discovery, { ...fetch, success: false }, action]).pass).toBe(false);
    expect(evaluate([discovery, { ...fetch, completed_event: 6 }, action]).pass).toBe(false);
    expect(evaluate([discovery, fetch, { ...action, start_event: undefined }]).pass).toBe(false);
    expect(evaluate([{ ...discovery, success: false }, fetch, action]).pass).toBe(false);
    expect(evaluate([{ ...discovery, output: JSON.stringify({ results: [{ id: 'aiwg:agent:xyz', type: 'agent', name: 'fleet-quiet-bot' }] }) }, action])).toMatchObject({ status: 'legacy-or-unbound', pass: true });
    expect(evaluate([{ ...discovery, output: JSON.stringify({ results: [{ id: 'aiwg:agent:xyz', type: 'agent', name: 'fleet-quiet-bot', required_rule_checks: [] }] }) }, action]).pass).toBe(false);
    const wrongType = { ...discovery, output: JSON.stringify({ results: [{ id: 'aiwg:skill:xyz', type: 'skill', name: 'fleet-quiet-bot', required_rule_checks: checks }] }) };
    expect(evaluate([wrongType, fetch, { ...action, input: 'aiwg show agent fleet-quiet-bot' }]).pass).toBe(false);
    const decoy = { ...discovery, start_event: 2, completed_event: 3, output: JSON.stringify({ results: [{ id: 'aiwg:agent:xyz', type: 'agent', name: 'fleet-quiet-bot', required_rule_checks: [{ rule_id: 'aiwg:rule:other', fetch_command: 'aiwg show rule aiwg:rule:other' }] }] }) };
    expect(evaluate([discovery, decoy, fetch, action]).pass).toBe(false);
    expect(evaluate([discovery, fetch, { ...action, input: 'aiwg show agent aiwg:agent:xyz >/dev/null', output: '' }]).pass).toBe(false);
    expect(evaluate([{ ...discovery, input: 'aiwg discover fleet --json & true' }, fetch, action]).pass).toBe(false);
    expect(evaluate([discovery, { ...fetch, input: 'aiwg show rule aiwg:rule:abc & true' }, action]).pass).toBe(false);
    const foreignDiscovery = { ...discovery, input: 'node /baseline/node_modules/aiwg/bin/aiwg.mjs discover fleet --json' };
    const foreignFetch = { ...fetch, input: '/baseline/node_modules/.bin/aiwg show rule aiwg:rule:abc' };
    const foreignAction = { ...action, input: '/baseline/node_modules/.bin/aiwg show agent aiwg:agent:xyz' };
    expect(evaluate([foreignDiscovery, fetch, action]).pass).toBe(false);
    expect(evaluate([discovery, foreignFetch, action]).pass).toBe(false);
    expect(evaluate([discovery, fetch, foreignAction]).pass).toBe(false);
    const sample = path.join(os.tmpdir(), 'aiwg-rule-probe-Ab1234');
    const ids = { shim: path.join(sample, 'bin/aiwg'), cli: path.join(sample, 'installation/node_modules/aiwg/bin/aiwg.mjs'), node: process.execPath };
    const trusted = [
      { ...discovery, input: `${ids.node} ${ids.cli} discover fleet --json` },
      { ...fetch, input: `${ids.shim} show rule aiwg:rule:abc` },
      { ...action, input: `${ids.cli} show agent aiwg:agent:xyz` },
    ];
    const trace = { tools: trusted, events: [{ type: 'turn.completed' }] };
    expect(evaluateCompoundTrace(trace, 'aiwg\\s+show\\s+agent', {}, ids)).toMatchObject({ status: 'checked', pass: true });
    expect(evaluateCompoundTrace(trace, 'aiwg\\s+show\\s+agent').pass).toBe(false);
    expect(evaluateCompoundTrace({ ...trace, tools: [trusted[0], { ...trusted[1], input: '/foreign/aiwg show rule aiwg:rule:abc' }, trusted[2]] }, 'aiwg\\s+show\\s+agent', {}, ids).pass).toBe(false);
    expect(evaluateCompoundTrace({ ...trace, tools: [trusted[0], { ...trusted[1], completed_event: 6 }, trusted[2]] }, 'aiwg\\s+show\\s+agent', {}, ids).pass).toBe(false);

  });

  it('enforces the versioned governed boundary, identity-bound aliases, and first-action order', () => {
    const tool = (input, output, start, end, success = true) => ({ name: 'shell', input, output, start_event: start, completed_event: end, success });
    const check = { rule_id: 'aiwg:rule:abc', fetch_command: 'aiwg show rule aiwg:rule:abc' };
    const row = { id: 'aiwg:skill:abc', type: 'skill', name: 'migrate-workspace',
      bound_rules: [{ name: 'cli-secondary' }], required_rule_checks: [check] };
    const discovery = tool('aiwg discover migration --json', JSON.stringify({ results: [row] }), 0, 1);
    const read = tool('cat skills/migrate-workspace/SKILL.md', 'skill body', 2, 3);
    const inspection = tool('aiwg show skill migrate-workspace', 'skill body', 4, 5);
    const fetch = tool('aiwg show rule aiwg:rule:abc', 'rule body', 6, 7);
    const preview = tool('aiwg migrate-workspace --dry-run', 'No legacy workspace detected. No migration needed.', 8, 9);
    const evaluate = tools => evaluateCompoundTrace({ tools, events: [{ type: 'turn.completed' }] },
      'aiwg\\s+show\\s+skill', { type: 'skill', names: ['migrate-workspace'], rule: 'cli-secondary' }, undefined, 'migration-preview-v2');

    expect(evaluate([discovery, read, inspection, fetch, preview])).toMatchObject({ status: 'checked', pass: true });
    const alias = tool('aiwg show rule cli-secondary --json', JSON.stringify({
      id: 'aiwg:rule:abc', type: 'rule', name: 'cli-secondary', content: 'complete rule body',
    }), 6, 7);
    expect(evaluate([discovery, inspection, alias, preview])).toMatchObject({ status: 'checked', pass: true });
    expect(evaluate([discovery, inspection, { ...alias, output: JSON.stringify({
      id: 'aiwg:rule:other', type: 'rule', name: 'cli-secondary', content: 'complete rule body',
    }) }, preview]).pass).toBe(false);
    expect(evaluate([discovery, inspection, { ...fetch, completed_event: 9 }, preview]).pass).toBe(false);
    expect(evaluate([discovery, { ...inspection, completed_event: 8 }, fetch, preview])).toMatchObject({ status: 'invalid', pass: false });
    expect(evaluate([discovery, inspection, fetch,
      tool('aiwg migrate-workspace --dry-run --json', '{}', 8, 9)])).toMatchObject({ status: 'invalid', reason: 'Unsafe or foreign migration invocation' });
    expect(evaluate([discovery, inspection, fetch,
      tool('aiwg migrate-workspace', 'changed', 8, 9)])).toMatchObject({ status: 'invalid', reason: 'Unsafe or foreign migration invocation' });
    expect(evaluate([discovery, inspection, fetch, { ...preview, success: false }, { ...preview, start_event: 10, completed_event: 11 }]))
      .toMatchObject({ status: 'invalid', reason: 'Expected exactly one governed migration preview' });
    expect(evaluate([discovery, inspection, fetch, { ...preview, success: false }])).toMatchObject({ status: 'invalid', pass: false });
    expect(evaluate([discovery, inspection, fetch, preview, tool('/foreign/aiwg migrate-workspace --dry-run', '', 10, 11)]))
      .toMatchObject({ status: 'invalid', reason: 'Unsafe or foreign migration invocation' });
  });

  it('decodes only single-command Codex POSIX wrappers and retains selected CLI binding', () => {
    const root = path.join(os.tmpdir(), 'aiwg-rule-probe-Ab1234');
    const identities = { shim: path.join(root, 'bin/aiwg'), cli: path.join(root, 'installation/node_modules/aiwg/bin/aiwg.mjs'), node: process.execPath };
    expect(parseAIWGCommand(`/bin/bash -lc 'aiwg discover "prepare an intake" --json'`, identities)).toEqual({ kind: 'discover' });
    expect(parseAIWGCommand(`/bin/bash -lc 'aiwg discover "prepare an intake" --format json --type skill,agent --limit 5'`, identities)).toEqual({ kind: 'discover' });
    expect(parseAIWGCommand(`/bin/sh -c 'aiwg discover --type agent --format json --limit 100 "fleet bot"'`, identities)).toEqual({ kind: 'discover' });
    expect(parseAIWGCommand(`/bin/sh -c '${identities.node} ${identities.cli} show rule aiwg:rule:abc'`, identities)).toEqual({ kind: 'show', type: 'rule', id: 'aiwg:rule:abc' });
    expect(parseAIWGCommand(`/bin/bash -c '${identities.shim} show agent aiwg:agent:xyz'`, identities)).toEqual({ kind: 'show', type: 'agent', id: 'aiwg:agent:xyz' });
    const rejected = [
      `/bin/bash -lc 'command -v aiwg; aiwg discover "prepare an intake"'`,
      `/bin/bash -lc 'aiwg discover "prepare an intake" --format json && aiwg show skill aiwg:skill:48ef18e71a7a20a4'`,
      `/bin/bash -lc 'aiwg show rule skill-discovery && aiwg show skill aiwg-utils-quickref'`,
      `/bin/bash -lc 'aiwg discover fleet --format text'`,
      `/bin/bash -lc 'aiwg discover fleet --format=json'`,
      `/bin/bash -lc 'aiwg discover fleet --json --type unknown'`,
      `/bin/bash -lc 'aiwg discover fleet --json --limit 0'`,
      `/bin/bash -lc 'aiwg discover fleet --json --limit 101'`,
      `/bin/bash -lc 'aiwg discover fleet --json --backend local'`,
      `/bin/bash -lc 'aiwg discover fleet --json --limit 5 --limit 3'`,
      `/bin/bash -lc 'aiwg show rule quiet-mode; touch /tmp/side-effect'`,
      `/bin/bash -lc 'aiwg show rule quiet-mode > /tmp/output'`,
      `/bin/bash -lc 'aiwg show rule $(touch /tmp/side-effect)'`,
      `/bin/bash -lc 'AIWG_ROOT=/foreign aiwg show rule quiet-mode'`,
      `/bin/bash -lc '/foreign/aiwg show rule quiet-mode'`,
      `/bin/bash -lc 'node /foreign/aiwg.mjs show rule quiet-mode'`,
      `/usr/bin/bash -lc 'aiwg show rule quiet-mode'`,
      `/bin/bash -lc 'aiwg show rule quiet-mode' extra`,
    ];
    for (const command of rejected) expect(parseAIWGCommand(command, identities), command).toBeNull();
    expect(parseAIWGCommand(`/bin/bash -lc '${identities.cli} show rule quiet-mode'`)).toBeNull();
  });

  it('runs the fake provider against each installed fixture CLI and isolated environment', async () => {
    const project = tempDir(); fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Context');
    const roots = [0, 1].map(index => installedPackage(
      `import dependency from 'probe-dep'; console.log(JSON.stringify({arm:${index}, dependency, root:process.env.AIWG_ROOT, home:process.env.HOME}))`,
      { dependency: `dep-${index}` }));
    for (const [index, root] of roots.entries()) {
      const plan = buildPlan(loadProbes(), { provider: 'codex', project, rules: ['quiet-mode'], n: 1 });
      await executePlan(plan, { packageRoot: root, output: path.join(tempDir(), 'out.json'), spawn: (_cmd, _args, _tier, options) => {
        const result = spawnSync('aiwg', [], { cwd: options.cwd, env: options.env, encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' });
        expect(result.status).toBe(0);
        const seen = JSON.parse(result.stdout);
        expect(seen.arm).toBe(index); expect(seen.dependency).toBe(`dep-${index}`); expect(seen.root).not.toBe(root);
        expect(treeIdentity(seen.root)).toBe(treeIdentity(root));
        expect(seen.home).not.toBe(process.env.HOME);
        expect(options.env.XDG_DATA_HOME.startsWith(seen.home)).toBe(true);
        return { status: 1, stdout: '', stderr: 'fake only' };
      } });
    }
  });

  it('runs a selected CLI that spawns node under the exact isolated PATH', async () => {
    const project = tempDir(); fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Context');
    const root = installedPackage(`import { spawnSync } from 'node:child_process';
      const child = spawnSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' });
      if (child.error || child.status !== 0) { console.error(child.error); process.exit(1); }
      console.log(child.stdout.trim());`);
    const beforeProject = treeIdentity(project), beforeInstallation = treeIdentity(path.dirname(path.dirname(root)));
    const plan = buildPlan(loadProbes(), { provider: 'codex', project, rules: ['quiet-mode'], n: 1 });
    plan.calls = [plan.calls[0]]; plan.call_count = 1;
    await executePlan(plan, { packageRoot: root, output: path.join(tempDir(), 'out.json'), spawn: (_cmd, _args, _tier, { cwd, env }) => {
      const bin = env.PATH.split(path.delimiter)[0];
      expect(fs.realpathSync(path.join(bin, 'node'))).toBe(fs.realpathSync(process.execPath));
      // The Codex transport retains only the sample bin and trusted system paths.
      const runtimeEnv = { ...env, PATH: [bin, '/usr/bin', '/bin'].join(path.delimiter) };
      const result = spawnSync('aiwg', ['migrate-workspace', '--dry-run'], { cwd, env: runtimeEnv, encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' });
      expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
      expect(fs.realpathSync(result.stdout.trim())).toBe(fs.realpathSync(process.execPath));
      return { status: 0, stdout: JSON.stringify({ type: 'turn.completed' }), stderr: '' };
    } });
    expect(treeIdentity(project)).toBe(beforeProject);
    expect(treeIdentity(path.dirname(path.dirname(root)))).toBe(beforeInstallation);
  });

  it('passes only a sample-contained package and declared auth context to the shared runtime', async () => {
    const project = tempDir(), root = installedPackage(); fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Context');
    fs.writeFileSync(path.join(root, 'arm-marker'), 'selected');
    const plan = buildPlan(loadProbes(), { provider: 'codex', project, rules: ['quiet-mode'], n: 1 });
    plan.calls = [plan.calls[0]]; plan.call_count = 1;
    const authTarget = path.join(tempDir(), 'canonical-auth.json'), skillsReference = tempDir();
    const accountHome = tempDir(), executable = path.join(tempDir(), 'codex');
    const expectedIdentity = armIdentity(plan, project, root, { authTarget, skillsReference });
    const report = await executePlanImpl(plan, { packageRoot: root, output: path.join(tempDir(), 'out.json'), expectedIdentity,
      accountHome, executable, authTarget, skillsReference, bootstrap: async (node, args, { env, timeout, killSignal }) => {
        expect(node).toBe(process.execPath); expect(args.slice(1)).toEqual(['discover', 'bootstrap', '--json']);
        expect(timeout).toBe(30_000); expect(killSignal).toBe('SIGKILL');
        expect(env).toMatchObject({ NO_UPDATE_NOTIFIER: '1', AIWG_NO_UPDATE_CHECK: '1', AIWG_DECISION_ENABLED: '0' });
        expect(env).not.toHaveProperty('AIWG_RELEASE_CODEX_AUTH_TARGET');
        expect(env).not.toHaveProperty('AIWG_RELEASE_CODEX_SKILLS_REFERENCE');
        fs.mkdirSync(env.AIWG_CONFIG, { recursive: true }); fs.writeFileSync(path.join(env.AIWG_CONFIG, 'installation.json'), '{}');
        return { status: 0, stdout: '', stderr: '' };
      }, runEvaluation: async input => {
        expect(fs.existsSync(path.join(input.envOverrideAllowed.AIWG_CONFIG, 'installation.json'))).toBe(true);
        const env = input.envOverrideAllowed, isolationRoot = path.dirname(env.HOME);
        expect(input).toMatchObject({ accountHome, executable, model: plan.model, effort: plan.effort });
        expect(env.AIWG_ROOT).not.toBe(root); expect(treeIdentity(env.AIWG_ROOT)).toBe(expectedIdentity.package_sha256);
        for (const value of [input.cwd, env.AIWG_ROOT, env.AIWG_HOME, env.HOME, env.TMPDIR]) {
          expect(path.relative(isolationRoot, value)).not.toMatch(/^\.\.(?:\/|$)/);
        }
        expect(env.AIWG_RELEASE_CODEX_AUTH_TARGET).toBe(authTarget);
        expect(env.AIWG_RELEASE_CODEX_SKILLS_REFERENCE).toBe(skillsReference);
        const stdout = [{ type: 'item.completed', item: { type: 'agent_message', text: '{"action":"remain-silent","reason":"not addressed"}' } },
          { type: 'turn.completed' }].map(JSON.stringify).join('\n');
        return { status: 0, stdout, stderr: '' };
      } });
    expect(report.runs[0].compliant).toBe(true);
    expect(report.runs[0].bootstrap).toMatchObject({ command: 'discover bootstrap --json', status: 0 });
  });

  it('does not call the evaluator when CLI bootstrap fails', async () => {
    const project = tempDir(), root = installedPackage(); fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Context');
    const plan = buildPlan(loadProbes(), { provider: 'codex', project, rules: ['quiet-mode'], n: 1 });
    plan.calls = [plan.calls[0]]; plan.call_count = 1;
    let called = false;
    const output = path.join(tempDir(), 'out.json');
    const report = await executePlanImpl(plan, { packageRoot: root, output,
      expectedIdentity: armIdentity(plan, project, root), bootstrap: async () => ({ status: 1, stdout: '', stderr: 'error' }),
      runEvaluation: async () => { called = true; } });
    expect(called).toBe(false);
    expect(report.runs[0]).toMatchObject({ evaluation_invoked: false, model_attempted: false, bootstrap: { status: 1 }, error: 'CLI bootstrap failed: exit 1' });
    expect(report).toMatchObject({ call_count: 0, record_count: 1, planned_call_count: 1, pass: false });
    expect(report.rules['quiet-mode'].probes[plan.calls[0].probe]).toMatchObject({ n: 0, compliance_rate: null, no_fetch_rate: null });
    expect(report.gates.find(g => g.gate === 'incomplete-plan')).toMatchObject({ pass: false, missing: [`quiet-mode/${plan.calls[0].probe}/1`] });
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ call_count: 0, record_count: 1, pass: false });
  });

  it('rejects a bootstrap that changes the sample project before evaluation', async () => {
    const project = tempDir(), root = installedPackage(); fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Context');
    const originalProject = treeIdentity(project), originalPackage = treeIdentity(root);
    const plan = buildPlan(loadProbes(), { provider: 'codex', project, rules: ['quiet-mode'], n: 1 });
    plan.calls = [plan.calls[0]]; plan.call_count = 1;
    let called = false;
    const report = await executePlanImpl(plan, { packageRoot: root, output: path.join(tempDir(), 'out.json'),
      expectedIdentity: armIdentity(plan, project, root), bootstrap: async (_node, _args, { cwd, env }) => {
        fs.mkdirSync(env.AIWG_CONFIG, { recursive: true }); fs.writeFileSync(path.join(env.AIWG_CONFIG, 'installation.json'), '{}');
        fs.writeFileSync(path.join(cwd, 'unexpected'), 'changed'); return { status: 0, stdout: '', stderr: '' };
      }, runEvaluation: async () => { called = true; } });
    expect(called).toBe(false);
    expect(report.runs[0].error).toBe('CLI bootstrap modified fixture or installation');
    expect(treeIdentity(project)).toBe(originalProject); expect(treeIdentity(root)).toBe(originalPackage);
  });

  it('checkpoints bounded shared-runtime diagnostics when a completed call fails postchecks', async () => {
    const project = tempDir(), root = installedPackage(); fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Context');
    const plan = buildPlan(loadProbes(), { provider: 'codex', project, rules: ['quiet-mode'], n: 1 });
    plan.calls = [plan.calls[0]]; plan.call_count = 1;
    const expectedIdentity = armIdentity(plan, project, root);
    const stdout = [{ type: 'item.completed', item: { type: 'agent_message', text: '{"action":"remain-silent","reason":"not addressed"}' } },
      { type: 'turn.completed' }].map(JSON.stringify).join('\n');
    const diagnostic = { schema: 'aiwg-codex-evaluation-failure/v1', phase: 'account-postcheck', status: 0,
      stdout: { text: stdout, truncated: false, original_bytes: Buffer.byteLength(stdout) },
      stderr: { text: 'bounded host diagnostic', truncated: false, original_bytes: 23 },
      trace: { completed: true, failed: false } };
    const failure = Object.assign(new Error('account postcheck failed'), { diagnostic });
    const report = await executePlanImpl(plan, { packageRoot: root, output: path.join(tempDir(), 'out.json'), expectedIdentity,
      bootstrap: async (_node, _args, { env }) => { fs.mkdirSync(env.AIWG_CONFIG, { recursive: true }); fs.writeFileSync(path.join(env.AIWG_CONFIG, 'installation.json'), '{}'); return { status: 0, stdout: '', stderr: '' }; },
      runEvaluation: async () => { throw failure; } });
    expect(report.runs[0]).toMatchObject({ exit_code: 0, stdout, stderr: 'bounded host diagnostic',
      error: 'account postcheck failed', compliant: false, transport_diagnostic: diagnostic });
  });

  it('rejects missing and incorrectly declared package and fixture identities', async () => {
    const project = tempDir(), root = installedPackage(); fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Context');
    const plan = buildPlan(loadProbes(), { provider: 'codex', project, rules: ['quiet-mode'], n: 1 });
    const output = path.join(tempDir(), 'out.json');
    await expect(executePlanImpl(plan, { output })).rejects.toThrow('Explicit installed package root');
    const identity = armIdentity(plan, project, root);
    await expect(executePlanImpl(plan, { output, packageRoot: root, expectedIdentity: { ...identity, fixture_sha256: 'wrong' } })).rejects.toThrow('identity mismatch');
    const strictIdentity = armIdentity(plan, project, root, { requireCompoundChecks: true });
    const moreSamples = buildPlan(loadProbes(), { provider: 'codex', project, rules: ['quiet-mode'], n: 5 });
    const otherRule = buildPlan(loadProbes(), { provider: 'codex', project, rules: ['tool-quota'], n: 1 });
    expect(strictIdentity.config_sha256).not.toBe(identity.config_sha256);
    expect(armIdentity(moreSamples, project, root).config_sha256).not.toBe(identity.config_sha256);
    expect(armIdentity(otherRule, project, root).config_sha256).not.toBe(identity.config_sha256);
    expect(armIdentity(plan, project, root, { authTarget: '/private/auth.json' }).config_sha256).not.toBe(identity.config_sha256);
    expect(armIdentity(plan, project, root, { skillsReference: '/private/system-skills' }).config_sha256).not.toBe(identity.config_sha256);
    const lockFile = path.join(path.dirname(path.dirname(root)), 'package-lock.json');
    fs.appendFileSync(lockFile, '\n');
    expect(armIdentity(plan, project, root).lock_sha256).not.toBe(identity.lock_sha256);
    const dependency = path.join(path.dirname(root), 'probe-extra'); fs.mkdirSync(dependency);
    fs.writeFileSync(path.join(dependency, 'package.json'), '{"name":"probe-extra","version":"1.0.0"}');
    expect(armIdentity(plan, project, root).installation_sha256).not.toBe(identity.installation_sha256);
    expect(() => armIdentity(plan, project, root, { authTarget: 'relative/auth.json' })).toThrow('absolute');
    const bare = tempDir(); fs.mkdirSync(path.join(bare, 'bin')); fs.writeFileSync(path.join(bare, 'package.json'), '{"name":"aiwg"}');
    expect(() => armIdentity(plan, project, bare)).toThrow('installation/node_modules/aiwg');
    const escapingLink = path.join(path.dirname(root), 'escaping-dependency');
    fs.symlinkSync(tempDir(), escapingLink);
    expect(() => armIdentity(plan, project, root)).toThrow('symlink escapes installation root');
    fs.unlinkSync(escapingLink);
    await expect(executePlanImpl(plan, { output, packageRoot: root, expectedIdentity: identity,
      requireCompoundChecks: true })).rejects.toThrow('identity mismatch');
    fs.writeFileSync(path.join(project, 'added'), 'changed');
    await expect(executePlanImpl(plan, { output, packageRoot: root, expectedIdentity: identity })).rejects.toThrow('identity mismatch');
  });

  it('applies discovery checks inside the live runner and rejects missing RC checks', async () => {
    const project = tempDir(); fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Context');
    const data = loadProbes(path.join(ROOT, 'test/uat/rule-binding/compound-discovery-probes.yaml'));
    const plan = buildPlan(data, { provider: 'codex', project, rules: ['quiet-mode'], n: 1 });
    plan.calls = plan.calls.filter(call => call.probe === 'compound-discovery'); plan.call_count = 1;
    expect(plan.calls[0].prompt).toContain('Run each CLI command separately so their completion order is observable; use JSON discovery output.');
    const check = { rule_id: 'aiwg:rule:abc', fetch_command: 'aiwg show rule aiwg:rule:abc' };
    const fake = (checks, late = false) => () => {
      const cmd = (id, command, output) => [
        { type: 'item.started', item: { id, type: 'command_execution' } },
        { type: 'item.completed', item: { id, type: 'command_execution', command, aggregated_output: output, status: 'completed', exit_code: 0 } },
      ];
      const discover = cmd('d', 'aiwg discover fleet --json', JSON.stringify({ results: [{ id: 'aiwg:agent:xyz', type: 'agent', name: 'fleet-quiet-bot', ...(checks ? { required_rule_checks: [check], bound_rules: [{ name: 'quiet-mode' }] } : {}) }] }));
      const fetch = cmd('f', 'aiwg show rule aiwg:rule:abc', 'body');
      const action = cmd('a', 'aiwg show agent aiwg:agent:xyz', 'agent');
      const events = [...discover, ...(late ? action : fetch), ...(late ? fetch : action),
        { type: 'item.completed', item: { type: 'agent_message', text: '{"reason":"selection"}' } }, { type: 'turn.completed' }];
      return { status: 0, stdout: events.map(JSON.stringify).join('\n'), stderr: '' };
    };
    const run = async (checks, late, requireCompoundChecks) => (await executePlan(plan, { packageRoot: ROOT, output: path.join(tempDir(), 'report.json'), requireCompoundChecks, spawn: fake(checks, late) })).runs[0];
    expect(await run(true, false, true)).toMatchObject({ compliant: true, compound: { status: 'checked' } });
    expect(await run(true, true, true)).toMatchObject({ compliant: false, compound: { status: 'checked' } });
    expect(await run(false, false, false)).toMatchObject({ compliant: true, compound: { status: 'legacy-or-unbound' } });
    expect(await run(false, false, true)).toMatchObject({ compliant: false, compound: { status: 'legacy-or-unbound' } });
  });
  it('fails a governed preview when the copied fixture changes', async () => {
    const project = tempDir(); fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Context');
    const data = loadProbes(path.join(ROOT, 'test/uat/rule-binding/governed-migration-probes.yaml'));
    const plan = buildPlan(data, { provider: 'codex', project, rules: ['cli-secondary'], n: 1 });
    plan.calls = plan.calls.filter(call => call.governed_action); plan.call_count = 1;
    const report = await executePlan(plan, { packageRoot: ROOT, output: path.join(tempDir(), 'report.json'), spawn: (_cmd, _args, _tier, options) => {
      fs.writeFileSync(path.join(options.cwd, 'changed'), 'changed');
      return { status: 0, stdout: JSON.stringify({ type: 'turn.completed' }), stderr: '' };
    } });
    expect(report.runs[0]).toMatchObject({ compliant: false, error: 'Governed action modified fixture or installation' });
    expect(report.runs[0].governed_integrity.before.fixture).not.toBe(report.runs[0].governed_integrity.after.fixture);
    expect(fs.existsSync(path.join(project, 'changed'))).toBe(false);
  });

  it('replays a complete governed baseline with identity-bound integrity', async () => {
    const project = tempDir(); fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Context');
    const data = loadProbes(path.join(ROOT, 'test/uat/rule-binding/governed-migration-probes.yaml'));
    const plan = buildPlan(data, { provider: 'codex', project, rules: ['cli-secondary'], n: 5 });
    plan.calls = plan.calls.filter(call => call.governed_action); plan.call_count = plan.calls.length;
    const spawn = () => {
      const command = (id, text, output) => [
        { type: 'item.started', item: { id, type: 'command_execution' } },
        { type: 'item.completed', item: { id, type: 'command_execution', command: text, aggregated_output: output, status: 'completed', exit_code: 0 } },
      ];
      const row = { id: 'aiwg:skill:abc', type: 'skill', name: 'migrate-workspace', bound_rules: [{ name: 'cli-secondary' }], required_rule_checks: [{ rule_id: 'aiwg:rule:abc', fetch_command: 'aiwg show rule aiwg:rule:abc' }] };
      const events = [...command('d', 'aiwg discover migration --json', JSON.stringify({ results: [row] })),
        ...command('s', 'aiwg show skill migrate-workspace', 'skill body'), ...command('f', 'aiwg show rule aiwg:rule:abc', 'rule body'),
        ...command('a', 'aiwg migrate-workspace --dry-run', 'No legacy workspace detected. No migration needed.'),
        { type: 'item.completed', item: { type: 'agent_message', text: '{"reason":"preview"}' } }, { type: 'turn.completed' }];
      return { status: 0, stdout: events.map(JSON.stringify).join('\n'), stderr: '' };
    };
    const baseline = await executePlan(plan, { packageRoot: ROOT, output: path.join(tempDir(), 'report.json'), requireCompoundChecks: true, spawn });
    expect(baseline.runs.every(run => run.compliant)).toBe(true);
    expect(validateBaseline(plan, baseline, { requireCompoundChecks: true }).rules).toEqual(baseline.rules);
  });

  it('replays v1 governed evidence with its original first-preview semantics', async () => {
    const project = tempDir(); fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Context');
    const source = fs.readFileSync(path.join(ROOT, 'test/uat/rule-binding/governed-migration-probes.yaml'), 'utf8');
    const file = path.join(tempDir(), 'governed-v1.yaml');
    fs.writeFileSync(file, source
      .replace('id: governed-migration-preview-v2', 'id: governed-migration-preview')
      .replace('governed_action: migration-preview-v2', 'governed_action: migration-preview'));
    const plan = buildPlan(loadProbes(file), { provider: 'codex', project, rules: ['cli-secondary'], n: 5 });
    plan.calls = plan.calls.filter(call => call.governed_action); plan.call_count = plan.calls.length;
    const spawn = () => {
      const command = (id, text, output) => [
        { type: 'item.started', item: { id, type: 'command_execution' } },
        { type: 'item.completed', item: { id, type: 'command_execution', command: text, aggregated_output: output, status: 'completed', exit_code: 0 } },
      ];
      const row = { id: 'aiwg:skill:abc', type: 'skill', name: 'migrate-workspace', bound_rules: [{ name: 'cli-secondary' }], required_rule_checks: [{ rule_id: 'aiwg:rule:abc', fetch_command: 'aiwg show rule aiwg:rule:abc' }] };
      const events = [...command('d', 'aiwg discover migration --json', JSON.stringify({ results: [row] })),
        ...command('s', 'aiwg show skill migrate-workspace', 'skill body'), ...command('f', 'aiwg show rule aiwg:rule:abc', 'rule body'),
        ...command('a1', 'aiwg migrate-workspace --dry-run', 'No legacy workspace detected. No migration needed.'),
        ...command('a2', 'aiwg migrate-workspace --dry-run', 'No legacy workspace detected. No migration needed.'),
        { type: 'item.completed', item: { type: 'agent_message', text: '{"reason":"preview"}' } }, { type: 'turn.completed' }];
      return { status: 0, stdout: events.map(JSON.stringify).join('\n'), stderr: '' };
    };
    const baseline = await executePlan(plan, { packageRoot: ROOT, output: path.join(tempDir(), 'report.json'), requireCompoundChecks: true, spawn });
    expect(baseline.runs.every(run => run.compliant)).toBe(true);
    expect(validateBaseline(plan, baseline, { requireCompoundChecks: true }).rules).toEqual(baseline.rules);
  });

  it('records and replays selected absolute CLI provenance and rejects forged identity or mismatched strict mode', async () => {
    const project = tempDir(); fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Context');
    const data = loadProbes(path.join(ROOT, 'test/uat/rule-binding/compound-discovery-probes.yaml'));
    const plan = buildPlan(data, { provider: 'codex', project, rules: ['quiet-mode'], n: 5 });
    plan.calls = plan.calls.filter(call => call.probe === 'compound-discovery'); plan.call_count = plan.calls.length;
    const spawn = (_cmd, _args, _tier, options) => {
      const sample = path.dirname(options.cwd), cli = path.join(sample, 'installation/node_modules/aiwg/bin/aiwg.mjs');
      const shim = path.join(sample, 'bin/aiwg');
      const cmd = (id, command, output) => [
        { type: 'item.started', item: { id, type: 'command_execution' } },
        { type: 'item.completed', item: { id, type: 'command_execution', command, aggregated_output: output, status: 'completed', exit_code: 0 } },
      ];
      const row = { id: 'aiwg:agent:xyz', type: 'agent', name: 'fleet-quiet-bot', bound_rules: [{ name: 'quiet-mode' }], required_rule_checks: [{ rule_id: 'aiwg:rule:abc', fetch_command: 'aiwg show rule aiwg:rule:abc' }] };
      const events = [...cmd('d', `/bin/bash -lc '${process.execPath} ${cli} discover fleet --json'`, JSON.stringify({ results: [row] })),
        ...cmd('f', `/bin/sh -c '${shim} show rule aiwg:rule:abc'`, 'body'), ...cmd('a', `/bin/bash -lc '${cli} show agent aiwg:agent:xyz'`, 'agent'),
        { type: 'item.completed', item: { type: 'agent_message', text: '{"reason":"selection"}' } }, { type: 'turn.completed' }];
      return { status: 0, stdout: events.map(JSON.stringify).join('\n'), stderr: '' };
    };
    const baseline = await executePlan(plan, { packageRoot: ROOT, output: path.join(tempDir(), 'report.json'), requireCompoundChecks: true, spawn });
    expect(baseline.runs.every(run => run.compliant && run.command_identities?.cli)).toBe(true);
    expect(validateBaseline(plan, baseline, { requireCompoundChecks: true }).rules).toEqual(baseline.rules);
    expect(() => validateBaseline(plan, baseline)).toThrow('strict compound-check mode mismatch');
    const forged = structuredClone(baseline); forged.runs[0].command_identities.cli = '/foreign/aiwg';
    expect(() => validateBaseline(plan, forged, { requireCompoundChecks: true })).toThrow('Invalid recorded command identities');
    let invoked = false;
    await expect(executePlanImpl(plan, { packageRoot: ROOT, output: path.join(tempDir(), 'out.json'), baseline,
      requireCompoundChecks: false, spawn: () => { invoked = true; } })).rejects.toThrow('strict compound-check mode mismatch');
    expect(invoked).toBe(false);
  });
  it('detects successful Claude body reads and show calls, not final mentions, discovery, indexes, or failed calls', () => {
    const trace = parseTrace(claudeTrace('aiwg show rule quiet-mode', [
      { name: 'Bash', input: { command: 'aiwg discover quiet-mode' } },
      { name: 'Read', input: { file_path: '.claude/rules/RULES-ONDEMAND.md' } },
      { name: 'Read', input: { file_path: '.claude/rules/quiet-mode.md' }, error: true },
    ]), 'claude');
    expect(ruleFetches(trace.tools, 'quiet-mode')).toMatchObject({ attempted: true, fetched: false });
    expect(ruleFetches(parseTrace(claudeTrace('aiwg show rule quiet-mode'), 'claude').tools, 'quiet-mode').attempted).toBe(false);
    const read = parseTrace(claudeTrace('{}', [{ name: 'Read', input: { file_path: '/rules/quiet-mode.md' } }]), 'claude');
    expect(ruleFetches(read.tools, 'quiet-mode').fetched).toBe(true);
    const show = parseTrace(claudeTrace('{}', [{ name: 'Bash', input: { command: 'aiwg show rule quiet-mode --json' } }]), 'claude');
    expect(ruleFetches(show.tools, 'quiet-mode').fetched).toBe(true);
    expect(ruleFetches(show.tools, 'quiet').attempted).toBe(false);
    expect(ruleFetches([{ name: 'Grep', input: { pattern: 'aiwg show rule quiet-mode' }, success: true }], 'quiet-mode').attempted).toBe(false);
  });

  it('supports Codex command and MCP completion events and requires terminal success', () => {
    const stdout = [
      { type: 'item.completed', item: { type: 'command_execution', command: 'aiwg show rule quiet-mode', exit_code: 0, status: 'completed', aggregated_output: 'rule body' } },
      { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'aiwg', tool: 'rule_show', arguments: { name: 'tool-quota' }, status: 'completed', result: { content: [{ type: 'text', text: 'rule body' }] } } },
      { type: 'item.completed', item: { type: 'agent_message', text: '{"action":"yield"}' } },
      { type: 'turn.completed' },
    ].map(event => JSON.stringify(event)).join('\n');
    const trace = parseTrace(stdout, 'codex');
    expect(trace.completed).toBe(true);
    expect(ruleFetches(trace.tools, 'quiet-mode').fetched).toBe(true);
    expect(ruleFetches(trace.tools, 'tool-quota').fetched).toBe(true);
    expect(parseTrace('{"type":"turn.failed"}', 'codex').failed).toBe(true);
    expect(() => parseTrace('not-json', 'claude')).toThrow();
  });

  it('detects a body returned through bound skill expansion without treating a summary pointer as a fetch', () => {
    const fingerprint = 'Rule body '.repeat(15);
    const tools = [{ name: 'aiwg.skill-show', input: { name: 'unrelated-skill' }, success: true,
      output: [{ type: 'text', text: `Bound rules: ${fingerprint}` }] }];
    expect(ruleFetches(tools, 'quiet-mode', fingerprint).fetched).toBe(true);
    tools[0].output = { content: tools[0].output };
    expect(ruleFetches(tools, 'quiet-mode', fingerprint).fetched).toBe(true);
    tools[0].output = JSON.stringify({ bound_rules: [{ content: fingerprint }] });
    expect(ruleFetches(tools, 'quiet-mode', fingerprint).fetched).toBe(true);
    tools[0].output = [{ type: 'text', text: 'Bound rule: quiet-mode; aiwg show rule quiet-mode' }];
    expect(ruleFetches(tools, 'quiet-mode', fingerprint).attempted).toBe(false);
  });

  it('evaluates structured output and tool assertions without accepting a compliant-looking failure', () => {
    const trace = parseTrace(claudeTrace('{"action":"fix","reason":"repair source"}', [
      { name: 'Read', input: { file_path: 'src/login.ts' } },
    ]), 'claude');
    const assertions = [
      { type: 'json-equals', path: 'action', value: 'fix' },
      { type: 'json-matches', path: 'reason', pattern: 'source' },
      { type: 'tool-matches', pattern: 'src/login' },
      { type: 'tool-not-matches', pattern: 'dist/login' },
    ];
    expect(evaluateAssertions(assertions, trace).every(item => item.pass)).toBe(true);
    expect(evaluateAssertions(assertions, { ...trace, text: 'action=fix' })[0].pass).toBe(false);
  });

  it('fails per-probe regressions, rule regressions, leaks, errors, small n, and incomplete runs', () => {
    const plan = buildPlan(loadProbes(), { rules: ['quiet-mode'] });
    const runs = plan.calls.map(call => ({ ...call, compliant: true, error: null, fetch: { attempted: false, fetched: false } }));
    const baseline = summarizeRuns(plan, runs);
    expect(baseline.pass).toBe(true);
    expect(summarizeRuns(plan, runs.slice(0, -1)).pass).toBe(false);
    expect(() => validateBaseline(plan, baseline)).toThrow('Incomplete baseline');
    expect(() => validateBaseline(plan, { ...baseline, model: 'wrong' })).toThrow();
    expect(() => validateBaseline(plan, { ...baseline, rules: {} })).toThrow();
    runs[0].compliant = false;
    expect(summarizeRuns(plan, runs).pass).toBe(true); // exactly 4/5
    expect(summarizeRuns(plan, runs, baseline).pass).toBe(false); // below rule baseline
    runs[1].compliant = false;
    expect(summarizeRuns(plan, runs).pass).toBe(false); // 3/5 for one positive
    for (const run of runs) run.compliant = true;
    runs[10].fetch.attempted = true;
    expect(summarizeRuns(plan, runs).pass).toBe(true);
    runs[11].fetch.attempted = true;
    expect(summarizeRuns(plan, runs).pass).toBe(false);
    runs[11].fetch.attempted = false; runs[11].error = 'CLI failed';
    expect(summarizeRuns(plan, runs).pass).toBe(false);
    const small = buildPlan(loadProbes(), { rules: ['quiet-mode'], n: 1 });
    expect(summarizeRuns(small, small.calls.map(call => ({ ...call, compliant: true, fetch: { attempted: false } }))).pass).toBe(false);
  });

  it('recomputes a baseline from complete trace samples and rejects summary tampering', () => {
    const plan = buildPlan(loadProbes(), { provider: 'claude', rules: ['quiet-mode'] });
    const runs = plan.calls.map(call => {
      const text = JSON.stringify(call.kind === 'negative' ? { answer: 21 } : { action: call.probe === 'positive-1' ? 'remain-silent' : 'yield', reason: 'not addressed' });
      return { rule: call.rule, probe: call.probe, repetition: call.repetition, kind: call.kind, stdout: claudeTrace(text), exit_code: 0,
        error: null, compliant: true, fetch: { attempted: false } };
    });
    const baseline = summarizeRuns(plan, runs);
    expect(validateBaseline(plan, baseline).rules).toEqual(baseline.rules);
    const uninvoked = structuredClone(baseline); uninvoked.runs[0].evaluation_invoked = false;
    expect(() => validateBaseline(plan, uninvoked)).toThrow('Incomplete baseline');
    expect(() => validateBaseline(plan, baseline, { requireCompoundChecks: true })).toThrow('strict compound-check mode mismatch');
    const tampered = structuredClone(baseline); tampered.rules['quiet-mode'].positive_compliance_rate = 0;
    expect(() => validateBaseline(plan, tampered)).toThrow('summary');
    expect(() => validateBaseline(plan, { ...baseline, runs: baseline.runs.slice(1) })).toThrow('Incomplete');
  });

  it('rejects a baseline whose declared arm identity differs from its evidence', async () => {
    const project = tempDir(), root = installedPackage(); fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Context');
    const plan = buildPlan(loadProbes(), { project, rules: ['quiet-mode'] });
    const identity = armIdentity(plan, project, root); let index = 0;
    const spawn = () => { const call = plan.calls[index++]; const text = JSON.stringify(call.kind === 'negative' ? { answer: 21 } : { action: call.probe === 'positive-1' ? 'remain-silent' : 'yield', reason: 'not addressed' }); return { status: 0, stdout: claudeTrace(text), stderr: '' }; };
    const baseline = await executePlanImpl(plan, { output: path.join(tempDir(), 'out.json'), packageRoot: root, expectedIdentity: identity, spawn });
    await expect(executePlanImpl(plan, { output: path.join(tempDir(), 'out.json'), packageRoot: root, expectedIdentity: identity, baseline,
      expectedBaselineIdentity: { ...identity, package_sha256: 'wrong' }, spawn })).rejects.toThrow('baseline identity mismatch');
  });

  it('executes only an injected fake transport, checkpoints traces, and cleans each workspace', async () => {
    const project = tempDir(), output = path.join(tempDir(), 'report.json');
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Deployed fixture');
    const plan = buildPlan(loadProbes(), { project, rules: ['quiet-mode'] });
    const workspaces = [];
    const report = await executePlan(plan, { packageRoot: ROOT, output, spawn: (command, args, tier, options) => {
      expect(command).toBe('claude'); expect(tier).toBe('long'); expect(args[0]).toBe('-p');
      workspaces.push(options.cwd);
      expect(fs.existsSync(path.join(options.cwd, 'CLAUDE.md'))).toBe(true);
      // Failed CLI with a correct-looking answer must remain a failed sample.
      return { status: 1, stdout: claudeTrace('{"action":"remain-silent","reason":"no mention"}'), stderr: 'fake failure' };
    } });
    expect(report.call_count).toBe(15);
    expect(report.pass).toBe(false);
    expect(report.runs.every(run => !run.compliant && run.error)).toBe(true);
    expect(JSON.parse(fs.readFileSync(output, 'utf8')).call_count).toBe(15);
    expect(workspaces.every(dir => !fs.existsSync(dir))).toBe(true);
    expect(fs.readdirSync(project)).toEqual(['CLAUDE.md']);
  });

  it('rejects undeployed projects and outputs that would expose previous answers before any call', async () => {
    const project = tempDir();
    const plan = buildPlan(loadProbes(), { project, rules: ['quiet-mode'] });
    const spawn = () => { throw new Error('must never call a provider'); };
    await expect(executePlan(plan, { packageRoot: ROOT, output: path.join(tempDir(), 'report.json'), spawn })).rejects.toThrow('Missing deployed provider context');
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Context');
    await expect(executePlan(plan, { packageRoot: ROOT, output: path.join(project, 'report.json'), spawn })).rejects.toThrow('--output must be outside');
  });

  it.each(['claude', 'codex'])('produces a passing %s report through the injected fake transport', async provider => {
    const project = tempDir(), output = path.join(tempDir(), 'report.json');
    fs.writeFileSync(path.join(project, provider === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'), '# Deployed fixture');
    const plan = buildPlan(loadProbes(), { provider, project, rules: ['quiet-mode'] });
    let index = 0;
    const report = await executePlan(plan, { packageRoot: ROOT, output, spawn: () => {
      const call = plan.calls[index++];
      const text = JSON.stringify(call.kind === 'negative' ? { answer: 21 }
        : { action: call.probe === 'positive-1' ? 'remain-silent' : 'yield', reason: 'Not addressed to this bot.' });
      const stdout = provider === 'claude' ? claudeTrace(text) : [
        { type: 'item.completed', item: { type: 'agent_message', text } },
        { type: 'turn.completed' },
      ].map(event => JSON.stringify(event)).join('\n');
      return { status: 0, stdout, stderr: '' };
    } });
    expect(report.pass).toBe(true);
    expect(report.rules['quiet-mode'].positive_compliance_rate).toBe(1);
    expect(report.runs.every(run => !run.fetch.fetched)).toBe(true);
  });

  it.each([
    ['malformed', { status: 0, stdout: 'not JSON', stderr: '' }],
    ['unterminated', { status: 0, stdout: '{"type":"assistant","message":{"content":[]}}', stderr: '' }],
    ['timeout', { status: null, stdout: '', stderr: '', error: new Error('ETIMEDOUT') }],
  ])('retains %s traces as failed samples', async (_name, result) => {
    const project = tempDir(); fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Context');
    const plan = buildPlan(loadProbes(), { project, rules: ['quiet-mode'], n: 1 });
    const report = await executePlan(plan, { packageRoot: ROOT, output: path.join(tempDir(), 'report.json'), spawn: () => result });
    expect(report.call_count).toBe(3);
    expect(report.runs.every(run => run.error && !run.compliant)).toBe(true);
    expect(report.pass).toBe(false);
  });
});
