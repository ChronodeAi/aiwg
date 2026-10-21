import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { comparisonPlan, comparisonReport } from '../../../tools/rules/release-compare.mjs';
import { RC_LANES } from '../../../tools/release/release-candidate.mjs';
import {
  QUARTERLY_BUNDLES,
  QUARTERLY_JOB,
  QUARTERLY_PROVIDERS,
  QUARTERLY_STEPS,
  QUARTERLY_WORKFLOW,
  assembleQuarterlyArtifact,
  authenticatedRunMetadata,
  quarterlyShardPlan,
  quarterlySourceInventory,
  runQuarterlyShard,
} from '../../../tools/release/quarterly-comparison-producer.mjs';

const roots = [];
const temp = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-quarterly-producer-')); roots.push(root); return root; };
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const commit = 'a'.repeat(40);
const baselineVersion = '2026.10.3';
const seed = 'quarterly-2026-q4';
const models = Object.freeze({
  claude: Object.freeze({ subject: 'claude-subject-202610', judge: 'claude-judge-202610' }),
  codex: Object.freeze({ subject: 'codex-subject-202610', judge: 'codex-judge-202610' }),
  hermes: Object.freeze({ subject: 'hermes-subject-202610', judge: 'hermes-judge-202610' }),
});
const scenarios = Object.freeze([
  Object.freeze({ id: 'delivery/one', domain: 'delivery', providers: [...QUARTERLY_PROVIDERS],
    prompt: 'Return ok.', assertions: [{ type: 'contains', value: 'ok' }], suspected_cause: 'Fixture only.' }),
  Object.freeze({ id: 'security/two', domain: 'security', providers: [...QUARTERLY_PROVIDERS],
    prompt: 'Return safe.', assertions: [{ type: 'contains', value: 'safe' }], suspected_cause: 'Fixture only.' }),
]);
const hash = value => createHash('sha256').update(value).digest('hex');

function pairResult(pair, model, judgeModel) {
  const score = { correctness: 4, completeness: 4, rule_alignment: 4, safety: 4 };
  const run = side => ({ model, trace: { text: side === 'A' ? 'ok safe' : 'ok safe', tools: [], completed: true, failed: false },
    assertions: pair.scenario.assertions.map(assertion => ({ ...assertion, pass: true })), passed: true, error: null, usage: null });
  return { id: pair.scenario.id, repetition: pair.repetition, order: pair.order, judge_order: pair.judge_order,
    runs: { A: run('A'), B: run('B') }, judgment: { model: judgeModel, winner: 'tie', reason: 'Equivalent fixture output.',
      scores: { A: score, B: score }, usage: null }, judge_error: null, suspected_cause: pair.scenario.suspected_cause };
}

function fixture() {
  const root = temp(), shards = path.join(root, 'shards'), output = path.join(root, 'artifact');
  fs.mkdirSync(shards);
  const version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
  const candidate = path.join(root, `aiwg-${version}.tgz`); fs.writeFileSync(candidate, 'fixture tarball bytes');
  const validationFile = path.join(root, 'validation.json');
  const startedAt = '2026-10-20T10:00:00.000Z', completedAt = '2026-10-20T11:00:00.000Z';
  fs.writeFileSync(validationFile, JSON.stringify({ version: 2, profile: 'quarterly-full-v1', commit,
    runner: 'fixture', node: process.version, lanes: RC_LANES.map(lane => ({ lane, started_at: startedAt, status: 'success', completed_at: completedAt })), pass: true }));
  const sources = quarterlySourceInventory(repoRoot), shardCount = 2;
  for (const provider of QUARTERLY_PROVIDERS) {
    const plan = comparisonPlan(scenarios, { provider, model: models[provider].subject, judgeModel: models[provider].judge, n: 5, seed });
    const results = plan.pairs.map(pair => pairResult(pair, models[provider].subject, models[provider].judge));
    const report = comparisonReport(plan, results, { A: { identity: 'baseline' }, B: { identity: 'candidate' } });
    const fullPlan = { version: plan.version, provider, model: plan.model, judge_model: plan.judge_model, n: plan.n,
      seed: plan.seed, corpus_digest: plan.corpus_digest, call_counts: plan.call_counts, planned_pairs: plan.pairs.length };
    for (let index = 0; index < shardCount; index += 1) {
      fs.writeFileSync(path.join(shards, `${provider}-${String(index).padStart(2, '0')}.json`), JSON.stringify({
        schema: 'aiwg-quarterly-comparison-shard/v1', provider, shard_index: index, shard_count: shardCount,
        full_plan: fullPlan, fixture_inputs: { A: `aiwg@${baselineVersion}`, B: `tarball:${candidate}` },
        bundles: [...QUARTERLY_BUNDLES], sources, fixtures: report.fixtures,
        results: results.filter((_pair, pairIndex) => pairIndex % shardCount === index),
      }));
    }
  }
  const env = { GITHUB_REPOSITORY: 'jmagly/aiwg', GITHUB_SHA: commit, GITHUB_REF: 'refs/heads/main',
    GITHUB_RUN_ID: '55', GITHUB_RUN_ATTEMPT: '2' };
  const runMetadata = { id: 55, workflow_id: 74, run_attempt: 2, head_sha: commit, event: 'workflow_dispatch',
    status: 'in_progress', conclusion: null, path: QUARTERLY_WORKFLOW, run_started_at: '2026-10-20T09:55:00Z',
    server_date: 'Tue, 20 Oct 2026 11:10:00 GMT', repository: { full_name: 'jmagly/aiwg' },
    head_repository: { full_name: 'jmagly/aiwg' } };
  const verifyReport = ({ report }) => ({ provider: report.provider, regressions: [] });
  return { root, shards, output, candidate, validationFile, env, runMetadata, verifyReport, shardCount, sources, version };
}

describe('quarterly comparison producer', () => {
  it('partitions every canonical comparison pair exactly once', () => {
    const plans = Array.from({ length: 3 }, (_unused, shardIndex) => quarterlyShardPlan({ provider: 'codex',
      model: models.codex.subject, judgeModel: models.codex.judge, seed, shardIndex, shardCount: 3, scenarios }));
    const full = plans[0].full.pairs.map(pair => `${pair.scenario.id}\0${pair.repetition}`).sort();
    const selected = plans.flatMap(item => item.selected.pairs).map(pair => `${pair.scenario.id}\0${pair.repetition}`).sort();
    expect(selected).toEqual(full);
    expect(new Set(selected).size).toBe(full.length);
    expect(plans.reduce((sum, item) => sum + item.selected.call_counts.total, 0)).toBe(plans[0].full.call_counts.total);
  });

  it('assigns the complete production corpus across all 16 provider shards', () => {
    for (const provider of QUARTERLY_PROVIDERS) {
      const plans = Array.from({ length: 16 }, (_unused, shardIndex) => quarterlyShardPlan({ provider,
        model: models[provider].subject, judgeModel: models[provider].judge, seed, shardIndex }));
      const expected = plans[0].full.pairs.map(pair => `${pair.scenario.id}\0${pair.repetition}`).sort();
      const actual = plans.flatMap(item => item.selected.pairs).map(pair => `${pair.scenario.id}\0${pair.repetition}`).sort();
      expect(actual).toEqual(expected);
      expect(new Set(actual).size).toBe(expected.length);
      expect(plans.every(item => item.selected.pairs.length > 0)).toBe(true);
    }
  });

  it('writes a shard only after its source inventory remains stable', () => {
    const root = temp(), output = path.join(root, 'codex-00.json'), candidate = path.join(root, 'candidate.tgz');
    fs.writeFileSync(candidate, 'candidate');
    const fixtures = { A: { identity: 'A' }, B: { identity: 'B' } };
    const shard = runQuarterlyShard({ root: repoRoot, output, provider: 'codex', model: models.codex.subject,
      judgeModel: models.codex.judge, seed, baselineVersion, candidateTarball: candidate, shardIndex: 0,
      shardCount: 1, scenarios, prepare: spec => fixtures[spec.startsWith('aiwg@') ? 'A' : 'B'],
      execute: (plan, identities, { checkpoint }) => {
        const report = comparisonReport(plan, plan.pairs.map(pair => pairResult(pair, models.codex.subject, models.codex.judge)), identities);
        checkpoint(report); return report;
      } });
    expect(shard.sources).toEqual(quarterlySourceInventory(repoRoot));
    expect(JSON.parse(fs.readFileSync(output, 'utf8')).results).toHaveLength(10);
  });

  it('removes a checkpoint instead of retaining a shard after source mutation', () => {
    const root = temp(), output = path.join(root, 'codex-00.json'), candidate = path.join(root, 'candidate.tgz');
    fs.writeFileSync(candidate, 'candidate');
    for (const identity of Object.values(quarterlySourceInventory(repoRoot)).flatMap(Object.values)) {
      const destination = path.join(root, identity.path); fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(repoRoot, identity.path), destination);
    }
    expect(() => runQuarterlyShard({ root, output, provider: 'codex', model: models.codex.subject,
      judgeModel: models.codex.judge, seed, baselineVersion, candidateTarball: candidate, shardIndex: 0,
      shardCount: 1, scenarios, prepare: spec => ({ identity: spec }), execute: (plan, identities, { checkpoint }) => {
        const report = comparisonReport(plan, plan.pairs.map(pair => pairResult(pair, models.codex.subject, models.codex.judge)), identities);
        checkpoint(report); fs.appendFileSync(path.join(root, 'tools/rules/release-compare-codex.mjs'), '\n// mutation\n'); return report;
      } })).toThrow(/source changed during shard execution/);
    expect(fs.existsSync(output)).toBe(false);
    expect(fs.readdirSync(root).some(name => name.includes('.partial'))).toBe(false);
  });

  it('completes a valid shard that measures a regression', () => {
    const root = temp(), output = path.join(root, 'claude-00.json'), candidate = path.join(root, 'candidate.tgz');
    fs.writeFileSync(candidate, 'candidate');
    const shard = runQuarterlyShard({ root: repoRoot, output, provider: 'claude', model: models.claude.subject,
      judgeModel: models.claude.judge, seed, baselineVersion, candidateTarball: candidate, shardIndex: 0,
      shardCount: 1, scenarios, prepare: spec => ({ identity: spec }), execute: (plan, identities) => {
        const results = plan.pairs.map(pair => pairResult(pair, models.claude.subject, models.claude.judge));
        results[0].runs.B.trace.text = 'degraded'; results[0].runs.B.assertions[0].pass = false; results[0].runs.B.passed = false;
        results[0].judgment.winner = 'A'; return comparisonReport(plan, results, identities);
      } });
    expect(shard.results).toHaveLength(10);
    expect(fs.existsSync(output)).toBe(true);
  });

  it('atomically assembles the exact five-file current-quarter artifact', () => {
    const data = fixture();
    const manifest = assembleQuarterlyArtifact({ root: repoRoot, output: data.output, validationFile: data.validationFile,
      candidateTarball: data.candidate, shardsDirectory: data.shards, baselineVersion, seed, models,
      runMetadata: data.runMetadata, env: data.env, completedAt: '2026-10-20T11:05:00.000Z',
      shardCount: data.shardCount, scenarios, verifyReport: data.verifyReport, gitCommit: commit });
    expect(fs.readdirSync(data.output).sort()).toEqual(['claude.json', 'codex.json', 'hermes.json', 'quarterly-attestation.json', 'validation.json']);
    expect(manifest).toMatchObject({ schema: 'aiwg-quarterly-comparison-attestation/v1', profile: 'quarterly-full-v1',
      repository: 'jmagly/aiwg', quarter: '2026-Q4', tested_commit: commit, workflow_id: 74, run_id: 55, run_attempt: 2,
      package_version: data.version, sources: data.sources });
    expect(manifest.package_tarball_sha256).toBe(hash('fixture tarball bytes'));
    for (const provider of QUARTERLY_PROVIDERS) {
      const reportFile = path.join(data.output, `${provider}.json`), report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
      expect(manifest.reports[provider]).toBe(hash(fs.readFileSync(reportFile)));
      expect(report).toMatchObject({ provider, model: models[provider].subject, judge_model: models[provider].judge,
        seed, n: 5, planned_pairs: 10, completed_pairs: 10, pass: true });
    }
  });

  it('rejects incomplete shards and leaves no partial artifact', () => {
    const data = fixture(); fs.rmSync(path.join(data.shards, 'hermes-01.json'));
    expect(() => assembleQuarterlyArtifact({ root: repoRoot, output: data.output, validationFile: data.validationFile,
      candidateTarball: data.candidate, shardsDirectory: data.shards, baselineVersion, seed, models,
      runMetadata: data.runMetadata, env: data.env, completedAt: '2026-10-20T11:05:00.000Z',
      shardCount: data.shardCount, scenarios, verifyReport: data.verifyReport, gitCommit: commit })).toThrow(/directory inventory is invalid/);
    expect(fs.existsSync(data.output)).toBe(false);
    expect(fs.readdirSync(data.root).some(name => name.startsWith('.quarterly-comparison-'))).toBe(false);
  });

  it('rejects source drift carried by a shard', () => {
    const data = fixture(), file = path.join(data.shards, 'claude-00.json'), shard = JSON.parse(fs.readFileSync(file, 'utf8'));
    shard.sources.claude.subject.sha256 = '0'.repeat(64); fs.writeFileSync(file, JSON.stringify(shard));
    expect(() => assembleQuarterlyArtifact({ root: repoRoot, output: data.output, validationFile: data.validationFile,
      candidateTarball: data.candidate, shardsDirectory: data.shards, baselineVersion, seed, models,
      runMetadata: data.runMetadata, env: data.env, completedAt: '2026-10-20T11:05:00.000Z',
      shardCount: data.shardCount, scenarios, verifyReport: data.verifyReport, gitCommit: commit })).toThrow(/shard identity is invalid/);
  });

  it('does not expose partial evidence when deep report verification fails', () => {
    const data = fixture();
    expect(() => assembleQuarterlyArtifact({ root: repoRoot, output: data.output, validationFile: data.validationFile,
      candidateTarball: data.candidate, shardsDirectory: data.shards, baselineVersion, seed, models,
      runMetadata: data.runMetadata, env: data.env, completedAt: '2026-10-20T11:05:00.000Z',
      shardCount: data.shardCount, scenarios, verifyReport: () => { throw new Error('invalid runtime observation'); }, gitCommit: commit })).toThrow(/invalid runtime observation/);
    expect(fs.existsSync(data.output)).toBe(false);
  });

  it('retains measured regressions for later exact approval disposition', () => {
    const data = fixture(), file = path.join(data.shards, 'claude-00.json'), shard = JSON.parse(fs.readFileSync(file, 'utf8'));
    const pair = shard.results[0]; pair.runs.B.trace.text = 'degraded'; pair.runs.B.assertions[0].pass = false; pair.runs.B.passed = false;
    pair.judgment.winner = 'A'; pair.judgment.scores.B.correctness = 2; fs.writeFileSync(file, JSON.stringify(shard));
    assembleQuarterlyArtifact({ root: repoRoot, output: data.output, validationFile: data.validationFile,
      candidateTarball: data.candidate, shardsDirectory: data.shards, baselineVersion, seed, models,
      runMetadata: data.runMetadata, env: data.env, completedAt: '2026-10-20T11:05:00.000Z',
      shardCount: data.shardCount, scenarios, verifyReport: ({ report }) => ({ provider: report.provider,
        regressions: report.provider === 'claude' ? [{ scenario: pair.id, repetition: pair.repetition }] : [] }), gitCommit: commit });
    const report = JSON.parse(fs.readFileSync(path.join(data.output, 'claude.json'), 'utf8'));
    expect(report.pass).toBe(false);
    expect(report.summary.regressed).toBe(1);
  });

  it('rejects impossible or future producer timestamps', () => {
    const impossible = fixture(); impossible.runMetadata.server_date = 'Tue, 31 Feb 2026 11:10:00 GMT';
    const assemble = (data, completedAt) => assembleQuarterlyArtifact({ root: repoRoot, output: data.output,
      validationFile: data.validationFile, candidateTarball: data.candidate, shardsDirectory: data.shards,
      baselineVersion, seed, models, runMetadata: data.runMetadata, env: data.env, completedAt,
      shardCount: data.shardCount, scenarios, verifyReport: data.verifyReport, gitCommit: commit });
    expect(() => assemble(impossible, '2026-10-20T11:05:00.000Z')).toThrow(/Invalid GitHub server timestamp/);
    const future = fixture(); expect(() => assemble(future, '2026-10-20T11:11:00.000Z')).toThrow(/outside the authenticated current run/);
  });

  it('authenticates the active dispatch metadata without following redirects', async () => {
    const env = { GITHUB_REPOSITORY: 'jmagly/aiwg', GITHUB_RUN_ID: '55', GITHUB_TOKEN: 'fixture-token', GITHUB_API_URL: 'https://api.github.test' };
    const metadata = await authenticatedRunMetadata(env, async (url, options) => {
      expect(url).toBe('https://api.github.test/repos/jmagly/aiwg/actions/runs/55');
      expect(options).toMatchObject({ redirect: 'error' });
      expect(options.headers.authorization).toBe('Bearer fixture-token');
      return new Response(JSON.stringify({ id: 55, workflow_id: 74, run_attempt: 2, head_sha: commit,
        event: 'workflow_dispatch', status: 'in_progress', conclusion: null, path: QUARTERLY_WORKFLOW,
        run_started_at: '2026-10-20T09:55:00Z',
        repository: { full_name: 'jmagly/aiwg' }, head_repository: { full_name: 'jmagly/aiwg' } }),
      { status: 200, headers: { 'content-type': 'application/json', date: 'Tue, 20 Oct 2026 11:10:00 GMT' } });
    });
    expect(metadata).toMatchObject({ id: 55, workflow_id: 74, path: QUARTERLY_WORKFLOW });
  });

  it('rejects non-JSON run metadata responses', async () => {
    const env = { GITHUB_REPOSITORY: 'jmagly/aiwg', GITHUB_RUN_ID: '55', GITHUB_TOKEN: 'fixture-token' };
    await expect(authenticatedRunMetadata(env, async () => new Response('redirected login', {
      status: 200, headers: { 'content-type': 'text/html' },
    }))).rejects.toThrow(/metadata request failed/);
  });

  it('defines a dispatch-only, non-publishing, pinned producer workflow', () => {
    const source = fs.readFileSync(path.join(repoRoot, QUARTERLY_WORKFLOW), 'utf8'), workflow = yaml.load(source);
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.permissions).toEqual({ contents: 'read', actions: 'read' });
    expect(workflow.jobs.compare.strategy).toMatchObject({ 'fail-fast': false, 'max-parallel': 6,
      matrix: { provider: QUARTERLY_PROVIDERS, shard: Array.from({ length: 16 }, (_unused, index) => index) } });
    expect(workflow.jobs.retain.name).toBe(QUARTERLY_JOB);
    expect(workflow.jobs.retain.needs).toEqual(['validate', 'compare']);
    expect(workflow.jobs.retain.steps.map(step => step.name)).toEqual(expect.arrayContaining(QUARTERLY_STEPS));
    for (const job of Object.values(workflow.jobs)) expect(job['runs-on']).toEqual(['self-hosted', 'linux', 'x64', 'aiwg-quarterly-comparison']);
    expect(source).toContain('retention-days: 120');
    expect(source).not.toMatch(/npm publish|gh release|git tag|contents:\s*write|id-token:\s*write|secrets\.|schedule:|\n\s+push:/);
    const digestLines = fs.readFileSync(path.join(repoRoot, 'ci/digests.txt'), 'utf8').split('\n');
    for (const match of source.matchAll(/uses:\s*([^@\s]+)@([^\s]+)/g)) {
      expect(match[2]).toMatch(/^[a-f0-9]{40}$/);
      expect(digestLines.some(line => line.startsWith(`action  ${match[1]}`) && line.includes(match[2]))).toBe(true);
    }
  });
});
