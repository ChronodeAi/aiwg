import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { loadScenarios, comparisonPlan, executeComparison, prepareFixture, validateSubject, validateJudgment,
  DIMENSIONS, markdownReport, runnerAdapter, fixtureIdentity, comparisonReport, signTestP, isolatedEnv,
  resolveComparisonOutput } from '../../../tools/rules/release-compare.mjs';
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

describe('noise-tolerant release decisions (#3438)', () => {
  function reportFor(winners, { id = 'test', failedA = [], failedB = [], scoresA = {}, scoresB = {}, ...options } = {}) {
    const p = plan([scenario(id)], { n: winners.length, ...options });
    const results = p.pairs.map((pair, index) => ({ id, repetition: pair.repetition, order: pair.order, judge_order: pair.judge_order,
      runs: Object.fromEntries(['A', 'B'].map(side => [side, { ...subjectResult(), passed: !(side === 'A' ? failedA : failedB).includes(index), assertions: [], error: null }])),
      judgment: { winner: winners[index], reason: 'Fixture preference', scores: {
        A: { ...Object.fromEntries(Object.keys(DIMENSIONS).map(key => [key, 2])), ...scoresA },
        B: { ...Object.fromEntries(Object.keys(DIMENSIONS).map(key => [key, 2])), ...(Array.isArray(scoresB) ? scoresB[index] : scoresB) },
      } }, judge_error: null }));
    return comparisonReport(p, results);
  }

  it.each([
    [0, 0, 1], [0, 5, 1], [1, 4, 31 / 32], [3, 2, 0.5], [4, 1, 0.1875],
    [5, 0, 0.03125], [1, 3, 15 / 16], [3, 1, 5 / 16], [10, 0, 1 / 1024],
    [1000, 1000, 0.5089195055729272],
  ])('computes exact one-sided binomial tails for %i/%i wins', (a, b, expected) => {
    expect(signTestP(a, b)).toBeCloseTo(expected, 12);
  });
  it.each([[-1, 0], [1.5, 2], [NaN, 0], [0, Infinity], [Number.MAX_SAFE_INTEGER, 1]])('rejects invalid sign-test counts %s/%s', (a, b) => {
    expect(() => signTestP(a, b)).toThrow(/integer/);
  });

  it.each([
    ['hermes-startup', 1, 3, 1, [], 'unchanged', 'none'],
    ['discover-show-follow', 1, 4, 0, [0], 'regressed', 'assertion-regression'],
    ['claude-startup', 4, 1, 0, [], 'unchanged', 'none'],
    ['codex-startup', 4, 1, 0, [], 'unchanged', 'none'],
    ['missing-native-skill', 3, 2, 0, [], 'unchanged', 'none'],
    ['compound-request', 0, 5, 0, [], 'improved', 'judge-improvement'],
    ['unanimous-A', 5, 0, 0, [], 'regressed', 'judge-regression'],
  ])('classifies issue fixture %s', (id, a, b, tie, failedB, status, rule) => {
    const winners = [...Array(a).fill('A'), ...Array(b).fill('B'), ...Array(tie).fill('tie')];
    const report = reportFor(winners, { id, failedB });
    const result = report.scenarios[0];
    expect(result.status).toBe(status); expect(result.decision_rule).toBe(rule);
    expect(result.judge_tally).toEqual({ A: a, B: b, tie });
    expect(result.B.pass_rate).toBe(failedB.length ? 0.8 : 1);
    expect(report.pass).toBe(status !== 'regressed');
    expect(report.judge_alpha).toBe(0.05); expect(report.judge_score_margin).toBe(1);
  });
  it('ignores ties in the sign test, including all ties and small non-tie samples', () => {
    for (const winners of [Array(5).fill('tie'), ['A', 'A', 'A', 'A', 'tie']]) {
      const result = reportFor(winners).scenarios[0];
      expect(result.status).toBe('unchanged');
      expect(result.sign_test_p.A).toBeCloseTo(winners[0] === 'tie' ? 1 : 1 / 16, 12);
    }
  });
  it('uses strict configurable alpha thresholds symmetrically', () => {
    for (const winner of ['A', 'B']) {
      const winners = Array(5).fill(winner);
      expect(reportFor(winners, { judgeAlpha: 1 / 32 }).scenarios[0].status).toBe('unchanged');
      expect(reportFor(winners, { judgeAlpha: 0.04 }).scenarios[0].status).toBe(winner === 'A' ? 'regressed' : 'improved');
    }
    expect(reportFor(['A', 'A', 'A', 'A', 'B'], { judgeAlpha: 0.2 }).scenarios[0].status).toBe('regressed');
  });
  it.each([0, 1, -0.1, NaN, Infinity])('rejects invalid alpha %s', judgeAlpha => expect(() => plan(undefined, { judgeAlpha })).toThrow(/judgeAlpha/));
  it.each([-1, 4.1, NaN, Infinity])('rejects invalid margin %s', judgeScoreMargin => expect(() => plan(undefined, { judgeScoreMargin })).toThrow(/judgeScoreMargin/));
  it.each([-1.2, -1, -0.2, 0, 0.2, 1, 1.2])('applies strict dimension margin to mean B − A = %s', delta => {
    // Integer per-pair scores on the actual 0–4 scale, averaging to the requested delta.
    const total = Math.round((2 + delta) * 5);
    const scoresB = Array.from({ length: 5 }, (_, index) => ({ safety: Math.floor(total / 5) + (index < total % 5 ? 1 : 0) }));
    const result = reportFor(Array(5).fill('tie'), { scoresB }).scenarios[0];
    expect(result.status).toBe(delta < -1 ? 'regressed' : delta > 1 ? 'improved' : 'unchanged');
    expect(result.dimension_deltas.safety).toBeCloseTo(delta, 12);
    expect(result.max_dimension_delta).toBeCloseTo(Math.abs(delta), 12);
  });
  it('applies the margin to dimension means and supports a custom margin', () => {
    const p = plan(undefined, { n: 5 });
    const base = reportFor(Array(5).fill('tie'));
    const evidence = base.scenarios[0].evidence;
    evidence[0].judgment.scores.B.safety = 0; // One 2-point loss averages to a 0.4-point drop.
    expect(comparisonReport(p, evidence).scenarios[0].status).toBe('unchanged');
    p.judge_score_margin = 0.3;
    expect(comparisonReport(p, evidence).scenarios[0].decision_rule).toBe('dimension-regression');
    expect(reportFor(['tie'], { scoresB: { safety: 1 }, judgeScoreMargin: 0 }).scenarios[0].status).toBe('regressed');
  });
  it('keeps a paired assertion loss hard even at equal aggregate pass rates and unanimous B wins', () => {
    const result = reportFor(Array(5).fill('B'), { failedA: [1], failedB: [0] });
    expect(result.scenarios[0].A.pass_rate).toBe(result.scenarios[0].B.pass_rate);
    expect(result.scenarios[0].decision_rule).toBe('assertion-regression'); expect(result.pass).toBe(false);
    expect(result.scenarios[0].triggered_rules).toContain('judge-improvement');
  });
  it('prefers regression when dimension and sign-test evidence disagree', () => {
    const result = reportFor(Array(5).fill('B'), { scoresB: { safety: 0, correctness: 4 } }).scenarios[0];
    expect(result.status).toBe('regressed'); expect(result.decision_rule).toBe('dimension-regression');
    expect(result.triggered_rules).toEqual(['dimension-regression', 'judge-improvement', 'dimension-improvement']);
  });
  it('mirrors assertion improvements without relying on judge noise', () => {
    expect(reportFor(Array(5).fill('tie'), { failedA: [0] }).scenarios[0].decision_rule).toBe('assertion-improvement');
  });
  it('reports tallies, both p-values, score margins and rules in JSON and Markdown', () => {
    const report = reportFor(['A', 'A', 'A', 'A', 'B'], { scoresB: { safety: 1 } });
    expect(report.scenarios[0].sign_test_p.A).toBeCloseTo(0.1875, 12);
    expect(report.scenarios[0].max_dimension_delta).toBe(1);
    const markdown = markdownReport(report);
    for (const text of ['Judge wins A/B/tie: 4/1/0', 'sign-test p (A/B):', 'max absolute delta: 1', 'Rule: none', 'judge A:', 'dimension deltas (B − A):', 'dimension margin: 1']) expect(markdown).toContain(text);
  });
  it('exposes configurable thresholds in CLI dry-run plans', () => {
    const stdout = execFileSync(process.execPath, [path.resolve('tools/rules/release-compare.mjs'), '--model', 'subject', '--judge-model', 'judge',
      '--scenario', 'discovery-discover-show-follow', '--judge-alpha', '0.1', '--judge-score-margin', '0.5', '--dry-run'], { encoding: 'utf8', timeout: 20000 });
    expect(JSON.parse(stdout)).toMatchObject({ judge_alpha: 0.1, judge_score_margin: 0.5 });
  });
});

describe('release comparison extends rule probes (#3298)', () => {
  it('requires a skill body rather than a metadata card in discover-show-follow', () => {
    const workflow = loadScenarios().find(item => item.id === 'discovery-discover-show-follow');
    expect(workflow.prompt).toContain('--body');
    expect(workflow.assertions).toContainEqual({ type: 'tool-matches', pattern: 'aiwg\\s+show\\s+skill', body: true });
  });

  it('permits read-only inspection and routes all announcements into the strict JSON decision', () => {
    const report = executeComparison(plan(), fixtures(), {
      subject(request) {
        expect(request.prompt).toContain('Read-only inspection commands, including aiwg discover and aiwg show, are explicitly allowed before the decision');
        expect(request.prompt).toContain('Put discovery announcements, candidates, and explanations inside the JSON reason field');
        expect(request.prompt).toContain('Do not execute the proposed workflow, repairs, or other operational actions');
        return subjectResult();
      }, judge: () => judgment(),
    });
    expect(report.pass).toBe(true);
  });

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
  it('rejects a deserialized plan with the same judge and subject before invoking either runner', () => {
    const p = plan(); p.judge_model = ' SUBJECT ';
    let calls = 0;
    expect(() => executeComparison(p, fixtures(), { subject: () => calls++, judge: () => calls++ })).toThrow(/Distinct/);
    expect(calls).toBe(0);
  });
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
        expect(request.instructions).toContain('"correctness":INTEGER_0_TO_4');
        expect(request.instructions).toContain('Every score must be an integer from 0 through 4');
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
  it('compares legacy body fetches against card-only and explicit body fetches without crediting cards (#3306)', () => {
    for (const withBody of [false, true]) {
      const prepared = fixtures();
      const report = executeComparison(plan(undefined, { n: 1 }), prepared, {
        subject(_request, context) {
          const result = subjectResult();
          const side = fs.readFileSync(path.join(context.cwd, 'side.txt'), 'utf8');
          if (side === 'B') result.trace.tools = [{ name: 'Bash', success: true,
            input: `aiwg show rule delivery-policy${withBody ? ' --body --json' : ' --json'}`,
            output: JSON.stringify({ id: 'aiwg:rule:synthetic', outline: [], ...(withBody ? { content: '# Policy' } : {}) }) }];
          return result;
        }, judge: () => judgment(),
      });
      expect(report.scenarios[0].A.fetched).toEqual(['rule:delivery-policy']);
      expect(report.scenarios[0].B.fetched).toEqual(withBody ? ['rule:delivery-policy'] : []);
    }
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
  it('reports fetched-rule/skill, tool-call and token deltas and preserves missing token counters', () => {
    const report = executeComparison(plan(), fixtures(), {
      subject(_request, context) {
        const side = fs.readFileSync(path.join(context.cwd, 'side.txt'), 'utf8');
        const result = subjectResult();
        if (side === 'B') {
          result.trace.tools = [
            { name: 'Bash', input: 'aiwg discover intake', success: true, output: 'intake' },
            { name: 'Bash', input: 'aiwg show skill intake-wizard --body', success: true, output: '# Intake workflow' },
          ];
          result.usage = { input_tokens: 7 };
        }
        return result;
      }, judge: () => judgment(),
    });
    expect(report.scenarios[0].structural_diff).toEqual({ tool_calls: 2, discovery_calls: 2,
      fetched_added: ['skill:intake-wizard'], fetched_removed: ['rule:delivery-policy'], usage: { input_tokens: 8, output_tokens: null } });
    expect(report.scenarios[0].A.usage_totals).toEqual({ input_tokens: 6, output_tokens: 8 });
    expect(markdownReport(report)).toContain('Structural diff (B − A)');
  });
  it('records malformed results as invalid and keeps their denominator and checkpoint', () => {
    const checkpoints = [];
    const report = executeComparison(plan(), fixtures(), { subject: () => subjectResult('follow', { model: 'wrong' }), judge: () => judgment(), checkpoint: report => checkpoints.push(report) });
    expect(report.summary.invalid).toBe(1); expect(report.pass).toBe(false);
    expect(report.scenarios[0].A.n).toBe(2); expect(report.scenarios[0].A.pass_rate).toBe(0);
    expect(report.scenarios[0].evidence[0].runs.A.error).toContain('model mismatch'); expect(checkpoints).toHaveLength(2);
  });
  it('fails closed for malformed judge output', () => {
    const raw = { model: 'judge', winner: 'tie', trace: { text: '{"winner":"tie"}' }, stdout: 'raw judge trace' };
    const report = executeComparison(plan(), fixtures(), { subject: () => subjectResult(), judge: () => raw });
    expect(report.summary.invalid).toBe(1); expect(report.pass).toBe(false);
    expect(report.scenarios[0].evidence[0].judge_raw).toEqual(raw);
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
  it('seeds an isolated published-version cache without copying config or mutating the source cache', () => {
    const cache = temp(), root = temp();
    fs.mkdirSync(path.join(cache, '_cacache'));
    fs.writeFileSync(path.join(cache, '_cacache', 'entry'), 'cached package');
    fs.writeFileSync(path.join(cache, 'ignored-config'), 'not cache content');
    prepareFixture('aiwg@2026.10.3', { root, provider: 'codex', npmCache: cache, spawn(command, args, _profile, options) {
      if (command === 'npm') {
        expect(args).toContain('--offline');
        expect(fs.readFileSync(path.join(options.env.npm_config_cache, '_cacache', 'entry'), 'utf8')).toBe('cached package');
        expect(fs.existsSync(path.join(options.env.npm_config_cache, 'ignored-config'))).toBe(false);
        fs.writeFileSync(path.join(options.env.npm_config_cache, '_cacache', 'entry'), 'isolated change');
      }
      return { status: 0, stdout: '' };
    } });
    expect(fs.readFileSync(path.join(cache, '_cacache', 'entry'), 'utf8')).toBe('cached package');
  });
  it.each([
    { provider: 'claude', rcTree: false }, { provider: 'codex', rcTree: false },
    { provider: 'hermes', rcTree: false }, { provider: 'codex', rcTree: true },
  ])('builds real offline npm fixtures and compares them with fake runners: %j', ({ provider, rcTree }) => {
    const root = temp();
    const createPackage = version => {
      const source = path.join(root, `source-${version}`);
      fs.mkdirSync(path.join(source, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(source, 'dist/src/cli'), { recursive: true });
      fs.writeFileSync(path.join(source, 'dist/src/cli/marker.json'), '{}');
      fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'aiwg', version, type: 'module',
        files: ['bin', 'dist'], scripts: { prepack: 'exit 99', postinstall: 'exit 99' } }));
      // Synthetic deployment CLI: exercise npm installation and identical use calls without a model or registry.
      fs.writeFileSync(path.join(source, 'bin/aiwg.mjs'), `import fs from 'node:fs';
import path from 'node:path';
const [action, bundle, flag, provider] = process.argv.slice(2);
if (action !== 'use' || flag !== '--provider') process.exit(2);
const file = 'deployment.json';
const deployed = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
deployed.push({ bundle, provider }); fs.writeFileSync(file, JSON.stringify(deployed));
fs.writeFileSync(provider === 'claude' ? 'CLAUDE.md' : 'AGENTS.md', '# Fixture context');
fs.mkdirSync(process.env.AIWG_ARTIFACTS_PATH, { recursive: true });
fs.writeFileSync(path.join(process.env.HOME, 'deployment.json'), JSON.stringify(deployed));
`);
      const packed = JSON.parse(execFileSync('npm', ['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', root], {
        cwd: source, env: isolatedEnv(path.join(root, `pack-${version}`), source), encoding: 'utf8', timeout: 20000,
      }));
      return { source, tarball: path.join(root, packed[0].filename) };
    };
    const published = createPackage('2026.10.3'), candidate = createPackage('2026.10.4');
    const prepared = {
      A: prepareFixture(`tarball:${published.tarball}`, { root: path.join(root, 'A'), provider }),
      B: prepareFixture(rcTree ? `tree:${candidate.source}` : `tarball:${candidate.tarball}`, { root: path.join(root, 'B'), provider }),
    };
    expect(prepared.A.content_identity.package_version).toBe('2026.10.3');
    expect(prepared.B.content_identity.package_version).toBe('2026.10.4');
    for (const side of ['A', 'B']) {
      expect(fs.readFileSync(path.join(prepared[side].project, 'README.md'), 'utf8')).toBe(fs.readFileSync('test/fixtures/rule-binding/project/README.md', 'utf8'));
      expect(JSON.parse(fs.readFileSync(path.join(prepared[side].project, 'deployment.json'), 'utf8'))).toEqual(
        ['sdlc', 'security-engineering', 'ops', 'aiwg-utils'].map(bundle => ({ bundle, provider })));
    }
    const report = executeComparison(plan(undefined, { provider, n: 1 }), prepared, { subject: () => subjectResult(), judge: () => judgment() });
    expect(report.pass).toBe(true); expect(report.completed_pairs).toBe(1);
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
      '--output', output], { encoding: 'utf8', timeout: 20000, env: { ...process.env, AIWG_ARTIFACTS_PATH: root } });
    expect(JSON.parse(stdout).pass).toBe(true);
    const report = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(report.provider).toBe(provider); expect(report.completed_pairs).toBe(1);
    expect(fs.readFileSync(path.join(root, 'report.md'), 'utf8')).toContain('Gate: PASS');
  });
  it('keeps JSON and Markdown in the artifact store, including symlink destinations', () => {
    const root = temp(), outside = temp(), env = { AIWG_ARTIFACTS_PATH: root };
    expect(resolveComparisonOutput(path.join(root, 'report.json'), { env })).toBe(path.join(root, 'report.json'));
    expect(() => resolveComparisonOutput(path.join(outside, 'report.json'), { env })).toThrow(/beneath/);
    fs.symlinkSync(outside, path.join(root, 'escape'));
    expect(() => resolveComparisonOutput(path.join(root, 'escape/report.json'), { env })).toThrow(/beneath/);
    fs.symlinkSync(path.join(outside, 'missing.json'), path.join(root, 'report.json'));
    expect(() => resolveComparisonOutput(path.join(root, 'report.json'), { env })).toThrow(/regular files/);
    fs.unlinkSync(path.join(root, 'report.json'));
    fs.symlinkSync(path.join(outside, 'missing.md'), path.join(root, 'report.md'));
    expect(() => resolveComparisonOutput(path.join(root, 'report.json'), { env })).toThrow(/regular files/);
    expect(() => resolveComparisonOutput(path.join(root, 'other.json'), { env: { AIWG_ARTIFACTS_PATH: path.join(outside, 'unavailable') } })).toThrow(/unavailable/);
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
  it('uses observed Claude telemetry when the fixed-rubric judge JSON omits model', () => {
    const model = 'claude-judge-20261001', { model: _model, ...response } = judgment();
    const result = claudeAdapter({ protocol: 'aiwg-release-judge/v1', model }, { spawn: () => ({ status: 0, stdout: [
      { type: 'assistant', message: { model, content: [] } },
      { type: 'result', subtype: 'success', result: JSON.stringify(response) },
    ].map(event => JSON.stringify(event)).join('\n') }) });
    expect(result.model).toBe(model);
    expect(validateJudgment(result, model).winner).toBe('tie');
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
    fs.writeFileSync(path.join(tree, 'marker.txt'), 'local-only fixture content');
    expect(() => prepareFixture(`tree:${tree}`, { root, provider: 'claude', spawn: () => ({ status: 1, stderr: 'pack failed' }) })).toThrow(/pack failed/);
    expect(fs.existsSync(path.join(root, 'pack-source'))).toBe(false);
    expect(fs.readFileSync(path.join(tree, 'marker.txt'), 'utf8')).toBe('local-only fixture content');
  });

  it.each(['auth.json', '.credentials', '.env.local', 'credentials.json'])('rejects credential-bearing fixture %s before copying', name => {
    const tree = temp(), root = temp();
    fs.mkdirSync(path.join(tree, 'project')); fs.mkdirSync(path.join(tree, 'package'));
    fs.writeFileSync(path.join(tree, 'project', name), 'never-copy');
    expect(() => prepareFixture(`fixture:${tree}`, { root, provider: 'codex' })).toThrow(/Credential-bearing/);
    expect(fs.existsSync(path.join(root, 'project', name))).toBe(false);
  });

});
