import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import Ajv from 'ajv/dist/2020.js';
import { boundedExecFileSync } from '../../../src/process/bounded-child-process.mjs';
import { ROOT } from '../../../tools/rules/measure-startup-context.mjs';
import { REQUIRED_RULES, loadProbes, buildPlan, parseTrace, ruleFetches, evaluateAssertions,
  summarizeRuns, executePlan, validateBaseline } from '../../../tools/rules/run-rule-probes.mjs';

const temps = [];
afterEach(() => { for (const temp of temps.splice(0)) fs.rmSync(temp, { recursive: true, force: true }); });
function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-probe-unit-')); temps.push(dir); return dir; }
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
});

describe('trace evidence and U5/U7 gates (no vendor executables)', () => {
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
    validateBaseline(plan, baseline);
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

  it('executes only an injected fake transport, checkpoints traces, and cleans each workspace', () => {
    const project = tempDir(), output = path.join(tempDir(), 'report.json');
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Deployed fixture');
    const plan = buildPlan(loadProbes(), { project, rules: ['quiet-mode'] });
    const workspaces = [];
    const report = executePlan(plan, { output, spawn: (command, args, tier, options) => {
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

  it('rejects undeployed projects and outputs that would expose previous answers before any call', () => {
    const project = tempDir();
    const plan = buildPlan(loadProbes(), { project, rules: ['quiet-mode'] });
    const spawn = () => { throw new Error('must never call a provider'); };
    expect(() => executePlan(plan, { output: path.join(tempDir(), 'report.json'), spawn })).toThrow('Missing deployed provider context');
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Context');
    expect(() => executePlan(plan, { output: path.join(project, 'report.json'), spawn })).toThrow('--output must be outside');
  });

  it.each(['claude', 'codex'])('produces a passing %s report through the injected fake transport', provider => {
    const project = tempDir(), output = path.join(tempDir(), 'report.json');
    fs.writeFileSync(path.join(project, provider === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'), '# Deployed fixture');
    const plan = buildPlan(loadProbes(), { provider, project, rules: ['quiet-mode'] });
    let index = 0;
    const report = executePlan(plan, { output, spawn: () => {
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
  ])('retains %s traces as failed samples', (_name, result) => {
    const project = tempDir(); fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Context');
    const plan = buildPlan(loadProbes(), { project, rules: ['quiet-mode'], n: 1 });
    const report = executePlan(plan, { output: path.join(tempDir(), 'report.json'), spawn: () => result });
    expect(report.call_count).toBe(3);
    expect(report.runs.every(run => run.error && !run.compliant)).toBe(true);
    expect(report.pass).toBe(false);
  });
});
