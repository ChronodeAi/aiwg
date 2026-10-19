import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { loadScenarios, comparisonPlan, executeComparison, prepareFixture, validateSubject, validateJudgment,
  DIMENSIONS, markdownReport, runnerAdapter, fixtureIdentity } from '../../../tools/rules/release-compare.mjs';
import { claudeAdapter } from '../../../tools/rules/release-compare-claude.mjs';
import { loadProbes } from '../../../tools/rules/run-rule-probes.mjs';

const roots = [];
const temp = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-compare-test-')); roots.push(root); return root; };
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const scenario = (id = 'test', value = 'follow') => ({ id, kind: 'positive', providers: ['claude', 'codex', 'hermes'], domain: 'delivery',
  prompt: `Scenario ${id}: choose follow or skip and explain the requested workflow. Return JSON {action,reason}.`,
  assertions: [{ type: 'json-equals', path: 'action', value }], files: { 'input.txt': 'fresh' }, suspected_cause: 'Missing rule binding' });
const subjectResult = (action = 'follow', extra = {}) => ({ model: 'subject', trace: { text: JSON.stringify({ action, reason: 'policy' }),
  tools: [{ name: 'Bash', input: 'aiwg show rule delivery-policy', success: true, output: 'policy' }], completed: true, failed: false }, usage: { input_tokens: 3, output_tokens: 4 }, ...extra });
const judgment = (winner = 'tie', left = 4, right = 4) => ({ model: 'judge', winner, reason: 'Evidence supports these scores.',
  scores: Object.fromEntries([['left', left], ['right', right]].map(([label, value]) => [label, Object.fromEntries(Object.keys(DIMENSIONS).map(key => [key, value]))])) });
function fixtures() {
  return Object.fromEntries(['A', 'B'].map(side => {
    const root = temp(), project = path.join(root, 'project'), packageRoot = path.join(root, 'package');
    fs.mkdirSync(project); fs.mkdirSync(packageRoot);
    for (const file of ['CLAUDE.md', 'AGENTS.md']) fs.writeFileSync(path.join(project, file), `Fixture ${side}`);
    fs.writeFileSync(path.join(project, 'side.txt'), side);
    fs.writeFileSync(path.join(packageRoot, 'identity.txt'), side);
    return [side, { root, project, packageRoot, identity: side === 'A' ? 'aiwg@2026.10.3' : 'tree:/operator/rc' }];
  }));
}
const plan = (scenarios = [scenario()], extra = {}) => comparisonPlan(scenarios, { model: 'subject', judgeModel: 'judge', n: 2, ...extra });

describe('release comparison extends rule probes (#3298)', () => {
  it('includes every base and lane probe variant and thirty workflows in five domains on three providers', () => {
    const corpus = loadScenarios();
    const files = ['probes.yaml', 'wave5-utils-probes.yaml', 'wave5-sdlc-a-probes.yaml', 'wave5-sdlc-b-probes.yaml', 'wave5-secops-probes.yaml', 'wave5-addons-probes.yaml'];
    for (const file of files) for (const rule of loadProbes(path.resolve('test/uat/rule-binding', file)).rules) for (const probe of rule.probes) {
      expect(corpus.some(item => item.rule === rule.id && item.prompt === probe.prompt && JSON.stringify(item.assertions) === JSON.stringify(probe.assertions))).toBe(true);
    }
    const workflows = corpus.filter(item => item.domain !== 'rule-probe');
    expect(workflows).toHaveLength(30);
    expect(new Set(workflows.map(item => item.domain)).size).toBe(5);
    for (const provider of ['claude', 'codex', 'hermes']) expect(plan(workflows, { provider, n: 1 }).pairs).toHaveLength(30);
  });
  it('randomizes paired subject and independent blind judge order reproducibly', () => {
    const first = plan([scenario()], { n: 40, seed: 'repeatable' });
    expect(first).toEqual(plan([scenario()], { n: 40, seed: 'repeatable' }));
    expect(first.pairs).not.toEqual(plan([scenario()], { n: 40, seed: 'other' }).pairs);
    for (const field of ['order', 'judge_order']) expect(new Set(first.pairs.map(pair => pair[field].join('')))).toEqual(new Set(['AB', 'BA']));
    expect(first.pairs.some(pair => pair.order[0] !== pair.judge_order[0])).toBe(true);
  });
  it.each([0, -1, 1.5, NaN])('rejects invalid repetitions %s', n => expect(() => plan(undefined, { n })).toThrow());
  it.each(['subject', ' SUBJECT '])('requires a distinct judge model %s', judgeModel => expect(() => plan(undefined, { judgeModel })).toThrow(/Distinct/));
  it('runs paired repetitions in isolated homes with release-local discovery and blinded judge inputs', () => {
    const prepared = fixtures(), p = plan(), calls = [], judgeInputs = [], homes = [];
    fs.writeFileSync(path.join(prepared.A.project, 'reference.md'), prepared.A.packageRoot);
    fs.writeFileSync(path.join(prepared.B.project, 'reference.md'), prepared.B.packageRoot);
    const report = executeComparison(p, prepared, {
      subject(request, context) {
        expect(request.model).toBe('subject'); expect(request).not.toHaveProperty('side');
        const side = fs.readFileSync(path.join(context.cwd, 'side.txt'), 'utf8'); calls.push(side);
        expect(fs.readFileSync(path.join(context.cwd, 'reference.md'), 'utf8')).toBe(context.env.AIWG_ROOT);
        expect(context.env.HOME).not.toBe(process.env.HOME); homes.push(context.env.HOME);
        expect(fs.readFileSync(path.join(context.cwd, 'input.txt'), 'utf8')).toBe('fresh');
        expect(fs.readFileSync(path.join(context.env.AIWG_ROOT, 'identity.txt'), 'utf8')).toBe(side);
        expect(context.env.AIWG_ARTIFACTS_PATH.startsWith(path.dirname(context.cwd))).toBe(true);
        const wrapper = fs.readFileSync(path.join(context.env.PATH.split(path.delimiter)[0], 'aiwg'), 'utf8');
        expect(wrapper).toContain(context.env.AIWG_ROOT);
        fs.writeFileSync(path.join(context.cwd, 'input.txt'), 'contaminated');
        const result = subjectResult(); result.trace.text = JSON.stringify({ action: 'follow', reason: `Observed aiwg@2026.10.3 ${prepared[side].identity} ${context.cwd}` });
        return result;
      },
      judge(request, context) {
        judgeInputs.push(request); expect(request.rubric).toEqual(DIMENSIONS);
        expect(request).not.toHaveProperty('fixtures'); expect(request).not.toHaveProperty('subject_model');
        const json = JSON.stringify(request);
        expect(json).not.toContain('2026.10.3'); expect(json).not.toContain('/operator/rc');
        expect(json).not.toContain('aiwg-release-sample-');
        expect(context.cwd).not.toContain(prepared.A.root);
        return judgment();
      },
    });
    expect(calls).toEqual(p.pairs.flatMap(pair => pair.order));
    expect(new Set(homes).size).toBe(4);
    expect(homes.every(home => !fs.existsSync(home))).toBe(true);
    expect(judgeInputs).toHaveLength(2); expect(report.pass).toBe(true);
    expect(report.scenarios[0].A.tool_calls).toBe(2);
    expect(report.scenarios[0].B.usage[0].input_tokens).toBe(3);
    expect(report.scenarios[0].A.fetched).toEqual(['rule:delivery-policy']);
  });
  it('sorts regressions first and retains both transcripts, failed assertions, fetches and causes', () => {
    const prepared = fixtures();
    const report = executeComparison(plan([scenario('unchanged'), scenario('regression')]), prepared, {
      subject(request, context) {
        const side = fs.readFileSync(path.join(context.cwd, 'side.txt'), 'utf8');
        return subjectResult(request.prompt.includes('Scenario regression:') && side === 'B' ? 'skip' : 'follow');
      }, judge: () => judgment(),
    });
    expect(report.summary.regressed).toBe(1);
    expect(report.scenarios[0].id).toBe('regression');
    expect(report.scenarios[1].status).toBe('unchanged'); expect(report.pass).toBe(false);
    const evidence = report.scenarios[0].evidence[0];
    expect(evidence.runs.A.trace.text).toContain('follow'); expect(evidence.runs.B.trace.text).toContain('skip');
    expect(evidence.runs.B.assertions[0].pass).toBe(false);
    expect(markdownReport(report)).toContain('Missing rule binding');
    expect(markdownReport(report)).toContain('aiwg show rule delivery-policy');
    expect(report.scenarios[0].A.pass_rate).toBe(1); expect(report.scenarios[0].B.pass_rate).toBe(0);
  });
  it('maps blinded judge dimensions back to releases and detects qualitative regression despite deterministic ties', () => {
    const p = plan(undefined, { n: 1 }), prepared = fixtures();
    const badLabel = p.pairs[0].judge_order[0] === 'A' ? 'left' : 'right';
    const report = executeComparison(p, prepared, { subject: () => subjectResult(), judge: () => judgment(badLabel, badLabel === 'left' ? 4 : 1, badLabel === 'right' ? 4 : 1) });
    expect(report.summary.regressed).toBe(1);
    expect(report.scenarios[0].A.judge_scores.safety).toBe(4); expect(report.scenarios[0].B.judge_scores.safety).toBe(1);
  });
  it('records malformed results as invalid and keeps their denominator and checkpoint', () => {
    const checkpoints = [];
    const report = executeComparison(plan(), fixtures(), { subject: () => subjectResult('follow', { model: 'wrong' }), judge: () => judgment(), checkpoint: report => checkpoints.push(report) });
    expect(report.summary.invalid).toBe(1); expect(report.pass).toBe(false);
    expect(report.scenarios[0].A.n).toBe(2); expect(report.scenarios[0].A.pass_rate).toBe(0);
    expect(report.scenarios[0].evidence[0].runs.A.error).toContain('model mismatch'); expect(checkpoints).toHaveLength(2);
  });
  it('fails closed for malformed judge output', () => {
    const report = executeComparison(plan(), fixtures(), { subject: () => subjectResult(), judge: () => ({ model: 'judge', winner: 'tie' }) });
    expect(report.summary.invalid).toBe(1); expect(report.pass).toBe(false);
  });
  it.each([
    subjectResult('follow', { trace: { text: '{}', tools: [], completed: false, failed: false } }),
    subjectResult('follow', { usage: { input_tokens: -1 } }), subjectResult('follow', { usage: { output_tokens: '3' } }),
  ])('rejects malformed normalized subject results', result => expect(() => validateSubject(result, 'subject', 'hermes')).toThrow());
  it('rejects incomplete or out-of-range judge dimensions', () => {
    const result = judgment(); result.scores.left.safety = 5;
    expect(() => validateJudgment(result, 'judge')).toThrow(/score/);
  });
  it('copies deployed fixtures without writing source or following external symlinks', () => {
    const prepared = fixtures(), outside = temp();
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(prepared.A.project, 'external'));
    const root = path.join(temp(), 'destination');
    const fixture = prepareFixture(`fixture:${prepared.A.root}`, { root, provider: 'hermes' });
    expect(fs.existsSync(path.join(fixture.project, 'AGENTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(fixture.project, 'external'))).toBe(false);
    expect(fs.readFileSync(path.join(prepared.A.project, 'side.txt'), 'utf8')).toBe('A');
  });
  it.each(['aiwg@2026.10.3', 'tarball:/tmp/rc.tgz'])('isolates package installation and deployment with networking opt-in: %s', spec => {
    const root = temp(), calls = [];
    if (spec.startsWith('tarball:')) { spec = `tarball:${path.join(root, 'input.tgz')}`; fs.writeFileSync(spec.slice(8), 'rc payload'); }
    const fixture = prepareFixture(spec, { root, provider: 'codex', spawn(command, args, profile, options) {
      calls.push({ command, args, options });
      expect(options.env.HOME.startsWith(root)).toBe(true);
      expect(options.env.npm_config_cache.startsWith(root)).toBe(true);
      if (command === 'npm') {
        fs.mkdirSync(path.join(root, 'installation/node_modules/aiwg/bin'), { recursive: true });
        fs.writeFileSync(path.join(root, 'installation/node_modules/aiwg/bin/aiwg.mjs'), '');
      }
      return { status: 0, stdout: '', stderr: '' };
    } });
    expect(calls[0].args).toContain('--offline'); expect(calls[0].args).toContain('--ignore-scripts');
    expect(calls.slice(1).every(call => call.args.includes('use') && call.options.cwd === fixture.project)).toBe(true);
    expect(fixture.packageRoot).toContain('installation/node_modules/aiwg');
    if (spec.startsWith('tarball:')) expect(fixture.content_identity.tarball_sha256).toBe(createHash('sha256').update('rc payload').digest('hex'));
  });
  it('runs JSON adapters in the supplied isolated context using stdin without shell interpolation', () => {
    const root = temp();
    const adapter = runnerAdapter('/tmp/adapter.mjs', (command, args, profile, options) => {
      expect(command).toBe(process.execPath); expect(args).toEqual(['/tmp/adapter.mjs']);
      expect(JSON.parse(options.input).prompt).toBe('`$(hostile)`'); expect(options.cwd).toBe(root);
      return { status: 0, stdout: '{"ok":true}' };
    });
    expect(adapter({ prompt: '`$(hostile)`' }, { cwd: root, env: {} })).toEqual({ ok: true });
  });
  it('packs a built RC copy into an isolated install root without running package lifecycle scripts', () => {
    const tree = temp(), root = temp(), calls = [];
    fs.mkdirSync(path.join(tree, 'dist/src/cli'), { recursive: true });
    fs.writeFileSync(path.join(tree, 'package.json'), '{"name":"aiwg"}');
    const fixture = prepareFixture(`tree:${tree}`, { root, provider: 'claude', spawn(command, args, profile, options) {
      calls.push({ command, args, options });
      expect(options.env.HOME.startsWith(root)).toBe(true);
      if (args[0] === 'pack') {
        expect(options.cwd).toBe(path.join(root, 'pack-source'));
        expect(args).toContain('--ignore-scripts');
        fs.writeFileSync(path.join(root, 'rc.tgz'), 'packed RC');
        return { status: 0, stdout: '[{"filename":"rc.tgz"}]' };
      }
      return { status: 0, stdout: '' };
    } });
    expect(calls[1].args.at(-1)).toBe(path.join(root, 'rc.tgz'));
    expect(fs.existsSync(path.join(fixture.root, 'pack-source'))).toBe(false);
    expect(fixture.content_identity.tarball_sha256).toBe(createHash('sha256').update('packed RC').digest('hex'));
    expect(fs.readdirSync(tree).sort()).toEqual(['dist', 'package.json']);
  });
  it('rejects malformed workflow assertions and traversal paths before executing adapters', () => {
    const file = path.join(temp(), 'scenarios.yaml');
    const workflow = scenario();
    fs.writeFileSync(file, JSON.stringify({ version: 1, probe_catalogs: [], workflows: [workflow] }));
    expect(loadScenarios(file)).toHaveLength(1);
    workflow.files = { '../escape': 'bad' };
    fs.writeFileSync(file, JSON.stringify({ version: 1, probe_catalogs: [], workflows: [workflow] }));
    expect(() => loadScenarios(file)).toThrow(/Unsafe/);
    workflow.files = {}; workflow.assertions = [{ type: 'unknown' }];
    fs.writeFileSync(file, JSON.stringify({ version: 1, probe_catalogs: [], workflows: [workflow] }));
    expect(() => loadScenarios(file)).toThrow(/schema/);
  });
  it.each(['claude', 'codex', 'hermes'])('executes the real CLI with offline adapters for %s and saves both report formats', provider => {
    const root = temp(), prepared = fixtures(), file = path.join(root, 'scenarios.yaml'), output = path.join(root, 'report.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, probe_catalogs: [], workflows: [scenario()] }));
    const stdout = execFileSync(process.execPath, [path.resolve('tools/rules/release-compare.mjs'), '--a', `fixture:${prepared.A.root}`,
      '--b', `fixture:${prepared.B.root}`, '--scenarios', file, '--provider', provider, '--model', 'subject', '--judge-model', 'judge', '--n', '1',
      '--subject-runner', path.resolve('test/fixtures/release-compare/subject.mjs'), '--judge-runner', path.resolve('test/fixtures/release-compare/judge.mjs'),
      '--output', output], { encoding: 'utf8', timeout: 20000 });
    expect(JSON.parse(stdout).pass).toBe(true);
    const report = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(report.provider).toBe(provider); expect(report.completed_pairs).toBe(1);
    expect(fs.readFileSync(path.join(root, 'report.md'), 'utf8')).toContain('Gate: PASS');
  });

  it('ships a Claude adapter that reuses the read-only probe argv and verifies actual model telemetry', () => {
    const model = 'claude-test-20261001';
    const request = { protocol: 'aiwg-release-subject/v1', provider: 'claude', model, prompt: 'Return JSON.' };
    let args;
    const spawn = (command, argv, profile, options) => {
      expect(command).toBe('claude'); expect(options.timeout).toBe(180000); args = argv;
      return { status: 0, stdout: [
        { type: 'assistant', message: { model, content: [{ type: 'text', text: '{"action":"follow"}' }] } },
        { type: 'result', subtype: 'success', result: '{"action":"follow"}', usage: { input_tokens: 1, output_tokens: 2 } },
      ].map(event => JSON.stringify(event)).join('\n') };
    };
    expect(claudeAdapter(request, { spawn }).model).toBe(model);
    expect(args).toContain('Bash(aiwg show:*)'); expect(args).toContain('--no-session-persistence');
    expect(() => claudeAdapter({ ...request, model: 'haiku' }, { spawn })).toThrow(/snapshot/);
    expect(() => claudeAdapter(request, { spawn: () => ({ status: 0, stdout: '{"type":"result","subtype":"success","result":"{}"}' }) })).toThrow(/Observed/);
  });
  it('runs the shipped Claude judge with no tools and parses the fixed rubric response', () => {
    const model = 'claude-judge-20261001';
    const expected = { ...judgment(), model };
    const result = claudeAdapter({ protocol: 'aiwg-release-judge/v1', model, left: {}, right: {} }, { spawn(command, args) {
      expect(args.slice(args.indexOf('--tools'))).toEqual(['--tools', '']);
      return { status: 0, stdout: [
        { type: 'assistant', message: { model, content: [] } },
        { type: 'result', subtype: 'success', result: JSON.stringify(expected) },
      ].map(event => JSON.stringify(event)).join('\n') };
    } });
    expect(result).toEqual({ ...expected, usage: {} });
  });

  it('binds fixture reports and checkpoints to exact package/context bytes and installed version', () => {
    const prepared = fixtures();
    fs.writeFileSync(path.join(prepared.A.packageRoot, 'package.json'), '{"name":"aiwg","version":"2026.10.3"}');
    const before = fixtureIdentity(prepared.A);
    expect(before.package_version).toBe('2026.10.3');
    expect(before.package_tree_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fixtureIdentity(prepared.A)).toEqual(before);
    fs.writeFileSync(path.join(prepared.A.project, 'CLAUDE.md'), '# Changed obligation');
    const changed = fixtureIdentity(prepared.A);
    expect(changed.deployed_context_sha256).not.toBe(before.deployed_context_sha256);
    expect(changed.package_tree_sha256).toBe(before.package_tree_sha256);
    const checkpoints = [];
    const report = executeComparison(plan(), prepared, { subject: () => subjectResult(), judge: () => judgment(), checkpoint: report => checkpoints.push(report) });
    expect(report.fixtures.A).toEqual(changed);
    expect(checkpoints.every(checkpoint => checkpoint.fixtures.A.deployed_context_sha256 === changed.deployed_context_sha256)).toBe(true);
  });

  it('removes RC source staging after failed packing without changing the source tree', () => {
    const tree = temp(), root = temp();
    fs.mkdirSync(path.join(tree, 'dist/src/cli'), { recursive: true });
    fs.writeFileSync(path.join(tree, '.env.local'), 'local-only fixture content');
    expect(() => prepareFixture(`tree:${tree}`, { root, provider: 'claude', spawn: () => ({ status: 1, stderr: 'pack failed' }) })).toThrow(/pack failed/);
    expect(fs.existsSync(path.join(root, 'pack-source'))).toBe(false);
    expect(fs.readFileSync(path.join(tree, '.env.local'), 'utf8')).toBe('local-only fixture content');
  });

});
