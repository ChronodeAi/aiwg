import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});
import { RC_LANES, RC_STEPS, RC_WORKFLOW, SURFACES, sha256, writeCandidateManifest } from '../../../tools/release/release-candidate.mjs';
import { evaluateAssertions, parseTrace } from '../../../tools/rules/run-rule-probes.mjs';
import { buildHermesArgs, parseHermesStream } from '../../../tools/rules/release-compare-hermes.mjs';
import { DIMENSIONS, comparisonPlan, comparisonReport, loadScenarios } from '../../../tools/rules/release-compare.mjs';
import { QUARTERLY_RELEASE_APPROVAL_SCHEMA, RELEASE_APPROVAL_SCHEMA, acquireGithubReleaseEvidence,
  acquireGithubProductionComparisonReports, acquireGithubProductionReleaseEvidence, createGithubApiEvidenceClient,
  resolveQuarterlyComparisonSources, verifyComparisonApprovalGate, verifyComparisonApprovalReceipt, verifyComparisonReport, verifyStableReleaseApproval,
  verifyQuarterlySourceIdentity,
  verifySignedTagPair } from '../../../tools/release/release-evidence.mjs';

const roots = [];
const temp = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-release-evidence-')); roots.push(root); return root; };
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const repoRoot = path.resolve(import.meta.dirname, '../../..');
const version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
const repository = 'jmagly/aiwg', commit = 'a'.repeat(40), rcObject = 'b'.repeat(40), stableObject = 'c'.repeat(40);
const rcTag = `v${version}-rc.2`, stableTag = `v${version}`;
function quarterlySources() {
  const identity = sourcePath => ({ path: sourcePath, sha256: fs.existsSync(path.join(repoRoot, sourcePath))
    ? sha256(path.join(repoRoot, sourcePath)) : '8'.repeat(64) });
  return {
    claude: { subject: identity('tools/rules/release-compare-claude.mjs'), judge: identity('tools/rules/release-compare-claude.mjs') },
    codex: { subject: identity('tools/rules/release-compare-codex.mjs'), judge: identity('tools/rules/release-compare-codex.mjs'),
      runtime: identity('tools/rules/codex-evaluation-runtime.mjs'), parser: identity('tools/rules/run-rule-probes.mjs') },
    hermes: { subject: identity('tools/rules/release-compare-hermes.mjs'), judge: identity('tools/rules/release-compare-hermes.mjs') },
  };
}

function signedTags({ stableCommit = commit, checkout = commit } = {}) {
  return verifySignedTagPair({ root: repoRoot, rcTag, stableTag, spawn(command, args) {
    if (command === 'bash') return { status: 0, stdout: '' };
    if (args[0] === 'cat-file') return { status: 0, stdout: 'tag\n' };
    const ref = args[1];
    if (ref === 'HEAD') return { status: 0, stdout: `${checkout}\n` };
    if (ref.endsWith('^{commit}')) return { status: 0, stdout: `${ref.includes('-rc.') ? commit : stableCommit}\n` };
    return { status: 0, stdout: `${ref.includes('-rc.') ? rcObject : stableObject}\n` };
  } });
}

function candidateFixture() {
  const destination = temp(), project = path.join(destination, 'project'), directory = path.join(destination, 'bundle');
  fs.mkdirSync(project); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'aiwg', version }));
  fs.writeFileSync(path.join(directory, 'validation.json'), JSON.stringify({ version: 1, commit, pass: true,
    lanes: RC_LANES.map(lane => ({ lane, status: 'success' })) }));
  const packages = SURFACES.map(surface => {
    const filename = `${surface.stem}-${version}.tgz`, file = path.join(directory, filename);
    fs.writeFileSync(file, `exact ${surface.name}`);
    return { package: surface.name, filename, installed_version: version, sha256: sha256(file), status: 'success' };
  });
  fs.writeFileSync(path.join(directory, 'installed-smoke.json'), JSON.stringify({ version: 1, pass: true, packages }));
  fs.writeFileSync(path.join(directory, `aiwg-${version}.cdx.json`), '{"bomFormat":"CycloneDX","specVersion":"1.6"}');
  fs.writeFileSync(path.join(directory, 'install.sh'), '#!/bin/bash\n');
  const manifest = writeCandidateManifest({ root: project, output: directory, tag: rcTag,
    env: { GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: '12', GITHUB_RUN_ATTEMPT: '1', RUNNER_NAME: 'runner-1' },
    spawn: (command, args) => ({ status: 0, stdout: args[1] === rcTag ? rcObject : commit }) });
  const archivePath = path.join(destination, 'candidate.zip'); fs.writeFileSync(archivePath, 'downloaded immutable artifact');
  return { destination, directory, archivePath, manifest,
    candidate: { manifest, directory, artifact_id: 44, manifest_sha256: sha256(path.join(directory, 'rc-manifest.json')),
      package_tarball: `aiwg-${version}.tgz`, package_tarball_sha256: manifest.files[`aiwg-${version}.tgz`] } };
}

function apiData(fixture, approvalBody = '{}', overrides = {}) {
  const workflowId = 73, runId = 12, artifactId = 44;
  const workflow = { id: workflowId, path: RC_WORKFLOW };
  const run = { id: runId, workflow_id: workflowId, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'push', path: RC_WORKFLOW,
    repository: { full_name: repository }, head_repository: { full_name: repository }, head_sha: commit, head_branch: rcTag, updated_at: '2026-10-19T17:00:00Z' };
  const jobs = [{ name: 'Validate release candidate', run_id: runId, head_sha: commit, runner_name: 'runner-1', status: 'completed', conclusion: 'success',
    steps: RC_STEPS.map(name => ({ name, status: 'completed', conclusion: 'success' })) }];
  const artifact = { id: artifactId, name: `release-candidate-${commit}-${runId}-1`, expired: false,
    digest: `sha256:${sha256(fixture.archivePath)}`, workflow_run: { id: runId, head_sha: commit } };
  const source = { repository, path: RC_WORKFLOW, commit, content: fs.readFileSync(path.join(repoRoot, RC_WORKFLOW), 'utf8') };
  const approval = { id: 901, html_url: `https://github.com/${repository}/issues/3201#issuecomment-901`,
    actor: { id: 1159087, login: 'jmagly', type: 'User' }, created_at: '2026-10-19T18:00:00Z',
    updated_at: '2026-10-19T18:00:00Z', body: approvalBody };
  return { workflowId, runId, artifactId, workflow, run, jobs, artifact, source, approval, ...overrides };
}

function clientFor(fixture, data, calls = []) {
  return createGithubApiEvidenceClient({
    getAuthenticatedIdentity(input) { calls.push(['identity', input]); return { id: 77, login: 'release-app', type: 'Bot', server_date: '2026-10-20T00:00:00Z' }; },
    getWorkflow(input) { calls.push(['workflow', input]); return data.workflow; },
    getRun(input) { calls.push(['run', input]); return data.run; },
    listJobs(input) { calls.push(['jobs', input]); return data.jobsPage ?? { items: data.jobs, complete: true, totalCount: data.jobs.length }; },
    getArtifact(input) { calls.push(['artifact', input]); return data.artifact; },
    getWorkflowSource(input) { calls.push(['source', input]); return data.source; },
    downloadArtifact(input) { calls.push(['download', input]); return data.download ?? { archivePath: fixture.archivePath, bundleDirectory: fixture.directory }; },
    listApprovals(input) { calls.push(['approvals', input]); return data.approvalsPage ?? { items: [data.approval], complete: true, totalCount: 1 }; },
  });
}

async function acquire(fixture, data, tags = signedTags()) {
  return acquireGithubReleaseEvidence({ client: clientFor(fixture, data), repository,
    workflowId: data.workflowId, runId: data.runId, artifactId: data.artifactId,
    destination: fixture.destination, tags });
}

async function quarterlyReceipt(candidateCommit = commit) {
  const testedCommit = commit, workflowId = 74, runId = 55, artifactId = 66, directory = temp();
  const reports = {};
  for (const provider of ['claude', 'codex', 'hermes']) {
    const bytes = JSON.stringify({ provider }); fs.writeFileSync(path.join(directory, `${provider}.json`), bytes);
    reports[provider] = textHash(bytes);
  }
  const validation = { version: 2, profile: 'quarterly-full-v1', commit: testedCommit, runner: 'quarterly', node: process.version, pass: true,
    lanes: RC_LANES.map(lane => ({ lane, started_at: '2026-10-10T12:05:00Z', completed_at: '2026-10-10T12:50:00Z', status: 'success' })) };
  const validationBytes = JSON.stringify(validation); fs.writeFileSync(path.join(directory, 'validation.json'), validationBytes);
  const attestation = { schema: 'aiwg-quarterly-comparison-attestation/v1', profile: 'quarterly-full-v1', repository,
    quarter: '2026-Q4', valid_from: '2026-10-01T00:00:00.000Z', valid_through: '2027-01-01T00:00:00.000Z', tested_commit: testedCommit,
    workflow_id: workflowId, run_id: runId, run_attempt: 2, started_at: '2026-10-10T12:05:00Z', completed_at: '2026-10-10T12:55:00Z',
    package_version: version, package_tarball: `aiwg-${version}.tgz`, package_tarball_sha256: '9'.repeat(64),
    validation_sha256: textHash(validationBytes), reports, sources: quarterlySources() };
  fs.writeFileSync(path.join(directory, 'quarterly-attestation.json'), JSON.stringify(attestation));
  const archive = path.join(temp(), 'quarterly.zip');
  const zipped = spawnSync('python3', ['-c', `import os,sys,zipfile
z=zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED)
for name in os.listdir(sys.argv[1]): z.write(os.path.join(sys.argv[1],name),name)
z.close()`, directory, archive], { timeout: 30000, killSignal: 'SIGKILL' });
  expect(zipped.status).toBe(0);
  const bytes = fs.readFileSync(archive), digest = textHash(bytes);
  const response = data => new Response(JSON.stringify(data), { status: 200,
    headers: { 'content-type': 'application/json', date: 'Tue, 20 Oct 2026 18:00:00 GMT' } });
  const fetchImpl = async url => {
    const pathname = new URL(url).pathname;
    if (pathname === '/user') return response({ id: 77, login: 'release-app', type: 'User' });
    if (pathname.endsWith(`/actions/workflows/${workflowId}`)) return response({ id: workflowId, path: '.github/workflows/release-comparison.yml' });
    if (pathname.endsWith(`/actions/runs/${runId}`)) return response({ id: runId, workflow_id: workflowId, head_sha: testedCommit,
      status: 'completed', conclusion: 'success', run_attempt: 2, run_started_at: '2026-10-10T12:00:00Z', updated_at: '2026-10-10T13:00:00Z' });
    if (pathname.endsWith(`/attempts/2/jobs`)) return response({ total_count: 1, jobs: [{ name: 'Retain comparisons', run_id: runId,
      head_sha: testedCommit, status: 'completed', conclusion: 'success', steps: [{ name: 'Run comparisons', status: 'completed', conclusion: 'success' },
        { name: 'Retain comparison evidence', status: 'completed', conclusion: 'success' }] }] });
    if (pathname.endsWith(`/actions/artifacts/${artifactId}`)) return response({ id: artifactId, expired: false,
      digest: `sha256:${digest}`, workflow_run: { id: runId, head_sha: testedCommit } });
    if (pathname.includes('/compare/')) return response(candidateCommit === testedCommit
      ? { status: 'identical', ahead_by: 0, behind_by: 0, base_commit: { sha: testedCommit }, merge_base_commit: { sha: testedCommit }, commits: [] }
      : { status: 'ahead', ahead_by: 1, behind_by: 0, base_commit: { sha: testedCommit }, merge_base_commit: { sha: testedCommit }, commits: [{ sha: candidateCommit }] });
    if (pathname.endsWith(`/actions/artifacts/${artifactId}/zip`)) return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
    return response({});
  };
  return acquireGithubProductionComparisonReports({ token: 'test-user-token', approvalIssue: 3201, repository,
    workflowId, runId, artifactId, candidateCommit, destination: temp(), requiredJobName: 'Retain comparisons',
    requiredSteps: ['Run comparisons', 'Retain comparison evidence'], fetchImpl });
}

const scenario = (id = 'case') => ({ id, kind: 'positive', providers: ['claude', 'codex', 'hermes'], domain: 'delivery',
  prompt: 'Return JSON.', assertions: [{ type: 'json-equals', path: 'action', value: 'follow' }], files: {}, suspected_cause: 'test' });
const scores = value => Object.fromEntries(Object.keys(DIMENSIONS).map(dimension => [dimension, value]));
const textHash = value => createHash('sha256').update(value).digest('hex');
function addSyntheticCodexReceipts(results, identities, model, judgeModel, adapter) {
  const makeTrace = (text, tools = []) => {
    const events = [{ type: 'thread.started' }, { type: 'turn.started' }];
    for (const [index, tool] of tools.entries()) { const id = `tool-${index}`; events.push({ type: 'item.started', item: { id, type: 'command_execution' } }, { type: 'item.completed', item: { id, type: 'command_execution', command: typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input), aggregated_output: 'synthetic body', exit_code: 0, status: 'completed' } }); }
    events.push({ type: 'item.completed', item: { id: 'message', type: 'agent_message', text } }, { type: 'turn.completed' });
    const stdout = events.map(JSON.stringify).join('\n');
    return { stdout, trace: parseTrace(stdout, 'codex') };
  };
  const source = { adapter_source_sha256: sha256(adapter), runtime_source_sha256: sha256(path.join(path.dirname(adapter), 'codex-evaluation-runtime.mjs')), trace_parser_sha256: sha256(path.join(path.dirname(adapter), 'run-rule-probes.mjs')) };
  const receipt = (run, requestedModel, fixtureHash) => ({ schema: 'aiwg-comparison-runtime-observation/v1', authenticated: false, provider: 'codex', requested_model: requestedModel, requested_effort: 'low', reported_remote_model: null, reported_remote_backend: null, executable_sha256: 'a'.repeat(64), ...source, argv_sha256: 'b'.repeat(64), prompt_sha256: 'c'.repeat(64), fixture_identity_sha256: fixtureHash, transcript_sha256: textHash(run.stdout), trace_sha256: textHash(JSON.stringify(run.trace)) });
  for (const pair of results) {
    for (const side of ['A', 'B']) {
      const run = pair.runs[side]; Object.assign(run, makeTrace(run.trace.text, run.trace.tools));
      run.runtime_receipt = receipt(run, model, textHash(JSON.stringify(identities[side])));
    }
    const j = pair.judgment;
    const blind = { winner: j.winner === 'tie' ? 'tie' : pair.judge_order[0] === j.winner ? 'left' : 'right', reason: j.reason, scores: { left: j.scores[pair.judge_order[0]], right: j.scores[pair.judge_order[1]] } };
    Object.assign(j, makeTrace(JSON.stringify(blind)));
    j.runtime_receipt = receipt(j, judgeModel, null);
  }
}

function addSyntheticHermesReceipts(results, identities, model, judgeModel, adapter, plan) {
  const scenarios = new Map(plan.pairs.map(pair => [pair.scenario.id, pair.scenario]));
  const makeTrace = (text, requestedModel, tools = []) => {
    const events = [{ type: 'system', subtype: 'init', model: requestedModel, session_id: 'synthetic', timestamp: 1 }];
    for (const [index, tool] of tools.entries()) {
      const id = `tool-${index}`;
      events.push({ type: 'tool_use', name: 'terminal', input: { command: 'aiwg discover "synthetic evidence"' }, tool_call_id: id, timestamp: 2 },
        { type: 'tool_result', name: 'terminal', output: JSON.stringify(tool.output ?? tool), duration_ms: 1, is_error: false, tool_call_id: id, timestamp: 3 });
    }
    events.push({ type: 'text', text, timestamp: 4 }, { type: 'result', session_id: 'synthetic', exit_code: 0, text,
      tokens: { input: 1, output: 1, total: 2, cache_read: 0, cache_write: 0 }, duration_ms: 1, timestamp: 5 });
    const stdout = events.map(JSON.stringify).join('\n');
    return { stdout, trace: parseHermesStream(stdout, { judge: tools.length === 0 && requestedModel === judgeModel, expectedModel: requestedModel }) };
  };
  const receipt = (run, requestedModel, fixtureHash, effort) => ({ schema: 'aiwg-comparison-runtime-observation/v1', authenticated: false,
    provider: 'hermes', requested_model: requestedModel, requested_provider: 'fixture-provider', requested_effort: effort, hermes_version: '0.21.6+387.gdce1e9b',
    reported_remote_model: null, reported_remote_backend: null, qualification_authenticated: false,
    qualification_id: 'synthetic-qualification', qualification_controller: 'synthetic-controller', qualification_producer: 'synthetic-producer',
    launcher_sha256: 'a'.repeat(64), hermes_executable_sha256: 'b'.repeat(64), boundary_profile_sha256: 'c'.repeat(64),
    boundary_receipt_sha256: 'd'.repeat(64), adapter_source_sha256: sha256(adapter),
    argv_sha256: textHash(JSON.stringify(buildHermesArgs({ model: requestedModel, provider: 'fixture-provider', effort, judge: requestedModel === judgeModel }))),
    prompt_sha256: 'f'.repeat(64), fixture_identity_sha256: fixtureHash, transcript_sha256: textHash(run.stdout), trace_sha256: textHash(JSON.stringify(run.trace)) });
  for (const pair of results) {
    for (const side of ['A', 'B']) {
      const run = pair.runs[side]; Object.assign(run, makeTrace(run.trace.text, model, run.trace.tools));
      run.assertions = evaluateAssertions(scenarios.get(pair.id).assertions, run.trace); run.passed = run.assertions.length > 0 && run.assertions.every(item => item.pass);
      run.runtime_receipt = receipt(run, model, textHash(JSON.stringify(identities[side])), 'low');
    }
    const j = pair.judgment;
    const blind = { winner: j.winner === 'tie' ? 'tie' : pair.judge_order[0] === j.winner ? 'left' : 'right', reason: j.reason, scores: { left: j.scores[pair.judge_order[0]], right: j.scores[pair.judge_order[1]] } };
    Object.assign(j, makeTrace(JSON.stringify(blind), judgeModel)); j.runtime_receipt = receipt(j, judgeModel, null, 'medium');
  }
}

function comparisonFixture(candidate, { provider = 'claude', n = 2, regression = false } = {}) {
  const root = temp(), subject = path.join(root, 'synthetic-contract-subject.mjs'), judge = path.join(root, 'synthetic-contract-judge.mjs');
  fs.writeFileSync(subject, 'export default async function subject() {}\n');
  fs.writeFileSync(judge, 'export default async function judge() {}\n');
  const model = `${provider}-subject-20261001`, judgeModel = `${provider}-judge-20261002`;
  const plan = comparisonPlan([scenario()], { provider, model, judgeModel, n, seed: 'release-seed' });
  const results = plan.pairs.map((pair, index) => ({ id: pair.scenario.id, domain: pair.scenario.domain,
    repetition: pair.repetition, order: pair.order, judge_order: pair.judge_order, suspected_cause: 'test',
    runs: Object.fromEntries(['A', 'B'].map(side => {
      const trace = { text: regression && index === 0 && side === 'B' ? '{"action":"omit"}' : '{"action":"follow"}',
        tools: [], completed: true, failed: false };
      const assertions = evaluateAssertions(pair.scenario.assertions, trace);
      return [side, { model, passed: assertions.length > 0 && assertions.every(assertion => assertion.pass), error: null,
        assertions, tool_stats: { fetched: [], discovery_calls: 0 }, trace, usage: {} }];
    })),
    judgment: { model: judgeModel, winner: regression && index === 0 ? 'A' : 'tie', reason: 'Synthetic contract evidence; not live execution.',
      scores: { A: scores(4), B: scores(regression && index === 0 ? 3 : 4) } }, judge_error: null }));
  const identities = {
    A: { spec: 'aiwg@2026.10.2', package_version: '2026.10.2', tarball_sha256: null,
      deployed_context_sha256: '1'.repeat(64), package_tree_sha256: '2'.repeat(64), installation_lock_sha256: '3'.repeat(64) },
    B: { spec: `tarball:/release/${candidate.package_tarball}`, package_version: version,
      tarball_sha256: candidate.package_tarball_sha256, deployed_context_sha256: '4'.repeat(64),
      package_tree_sha256: '5'.repeat(64), installation_lock_sha256: '6'.repeat(64) },
  };
  if (provider === 'codex') {
    const adapter = path.resolve('tools/rules/release-compare-codex.mjs');
    addSyntheticCodexReceipts(results, identities, model, judgeModel, adapter);
    return syntheticCodexReport(root, candidate, plan, results, identities, adapter);
  }
  if (provider === 'hermes') {
    const adapter = path.resolve('tools/rules/release-compare-hermes.mjs');
    addSyntheticHermesReceipts(results, identities, model, judgeModel, adapter, plan);
    return syntheticCodexReport(root, candidate, plan, results, identities, adapter);
  }
  const report = { ...comparisonReport(plan, results, identities), fixture_inputs: { A: 'aiwg@2026.10.2', B: identities.B.spec },
    bundles: ['sdlc', 'security-engineering'], adapters: { subject, judge } };
  const file = path.join(root, `${provider}.json`); fs.writeFileSync(file, JSON.stringify(report));
  return { root, file, report, plan, binding: verifyComparisonReport({ file, report, plan, candidate,
    baselineVersion: '2026.10.2', expectedBundles: report.bundles }) };
}

function syntheticCodexReport(root, candidate, plan, results, identities, adapter) {
  const report = { ...comparisonReport(plan, results, identities), fixture_inputs: { A: 'aiwg@2026.10.2', B: identities.B.spec }, bundles: ['sdlc', 'security-engineering'], adapters: { subject: adapter, judge: adapter } };
  const file = path.join(root, 'codex.json'); fs.writeFileSync(file, JSON.stringify(report));
  return { root, file, report, plan, binding: verifyComparisonReport({ file, report, plan, candidate, baselineVersion: '2026.10.2', expectedBundles: report.bundles }) };
}

function candidateApproval(fixture, binding, { dispositions, extra = {} } = {}) {
  const candidate = { repository, commit, rc_tag: rcTag, rc_tag_object_sha: rcObject, stable_tag: stableTag,
    stable_tag_object_sha: stableObject, workflow_id: 73, run_id: 12, run_attempt: 1,
    artifact_id: 44, artifact_sha256: sha256(fixture.archivePath),
    manifest_sha256: fixture.candidate.manifest_sha256, package_version: version,
    package_tarball_sha256: fixture.candidate.package_tarball_sha256 };
  const reports = [Object.fromEntries(Object.entries(binding).filter(([key]) => key !== 'regressions'))];
  const defaultDispositions = binding.regressions.map(item => ({ ...item, decision: 'accept',
    reason: 'Maintainer accepts this exact measured regression.', evidence: 'Reviewed retained transcripts and assertions.' }));
  return { schema: RELEASE_APPROVAL_SCHEMA, repository, decision: 'approve', candidate, reports,
    dispositions: dispositions ?? defaultDispositions, ...extra };
}

describe('release evidence acquisition and approval gates (#3201)', () => {
  it('verifies both signed annotated tags and requires the same commit', () => {
    const receipt = signedTags();
    expect(receipt.commit).toBe(commit); expect(receipt.rc.object).toBe(rcObject); expect(receipt.stable.object).toBe(stableObject);
    expect(() => signedTags({ stableCommit: 'd'.repeat(40) })).toThrow(/same commit/);
    expect(() => signedTags({ checkout: 'e'.repeat(40) })).toThrow(/exact signed/);
  });

  it('acquires workflow/run/job/artifact/source/approval evidence only through the API seam and binds the downloaded digest', async () => {
    const fixture = candidateFixture(), data = apiData(fixture), calls = [], tags = signedTags();
    const evidence = await acquireGithubReleaseEvidence({ client: clientFor(fixture, data, calls), repository,
      workflowId: data.workflowId, runId: data.runId, artifactId: data.artifactId, destination: fixture.destination, tags });
    expect(evidence.archive.sha256).toBe(sha256(fixture.archivePath));
    expect(evidence.candidate.manifest.commit).toBe(commit); expect(evidence.apiCaller.login).toBe('release-app');
    expect(calls.find(([name]) => name === 'jobs')[1].attempt).toBe(1);
    expect(() => Object.assign(evidence, { repository: 'attacker/repo' })).toThrow();
    await expect(acquireGithubReleaseEvidence({ client: {}, repository, workflowId: 1, runId: 1, artifactId: 1,
      destination: fixture.destination, tags })).rejects.toThrow(/candidate JSON/);
    await expect(acquireGithubReleaseEvidence({ client: clientFor(fixture, data), repository, workflowId: data.workflowId,
      runId: data.runId, artifactId: data.artifactId, destination: fixture.destination,
      tags: JSON.parse(JSON.stringify(tags)) })).rejects.toThrow(/locally verified/);
  });

  it('acquires and extracts the authenticated archive through the production boundary', async () => {
    const fixture = candidateFixture();
    const zipped = spawnSync('python3', ['-c', `import os,sys,zipfile
z=zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED)
for name in os.listdir(sys.argv[1]): z.write(os.path.join(sys.argv[1],name),name)
z.close()`, fixture.directory, fixture.archivePath], { timeout: 30000, killSignal: 'SIGKILL' });
    expect(zipped.status).toBe(0);
    const data = apiData(fixture), tags = signedTags(), target = temp();
    const fetchImpl = async url => {
      const parsed = new URL(url), pathname = parsed.pathname;
      let body;
      if (pathname === '/user') body = { id: 77, login: 'release-app' };
      else if (pathname.endsWith('/actions/workflows/73')) body = data.workflow;
      else if (pathname.endsWith('/actions/runs/12')) body = data.run;
      else if (pathname.endsWith('/attempts/1/jobs')) body = { total_count: data.jobs.length, jobs: data.jobs };
      else if (pathname.endsWith('/actions/artifacts/44/zip')) return new Response(fs.readFileSync(fixture.archivePath));
      else if (pathname.endsWith('/actions/artifacts/44')) body = data.artifact;
      else if (pathname.includes('/contents/')) body = { type: 'file', path: RC_WORKFLOW, encoding: 'base64', content: Buffer.from(data.source.content).toString('base64') };
      else if (pathname.endsWith('/comments')) body = [];
      else throw new Error('Unexpected fake URL');
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const input = { token: 'test-token', approvalIssue: 3201, fetchImpl, repository, workflowId: 73, runId: 12, artifactId: 44, destination: target, tags };
    const fakeBin = temp(), marker = path.join(fakeBin, 'executed');
    fs.writeFileSync(path.join(fakeBin, 'python3'), `#!/bin/sh\necho invoked > "${marker}"\nexit 99\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(fakeBin, 'sitecustomize.py'), `import os\nopen(${JSON.stringify(marker)}, 'w').write(os.environ.get('GITHUB_TOKEN', 'absent'))\n`);
    const previous = { PATH: process.env.PATH, PYTHONPATH: process.env.PYTHONPATH, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
    process.env.PATH = fakeBin; process.env.PYTHONPATH = fakeBin; process.env.GITHUB_TOKEN = 'credential-sentinel';
    let result;
    try { result = await acquireGithubProductionReleaseEvidence(input); }
    finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    expect(fs.existsSync(marker)).toBe(false);
    const parserCall = vi.mocked(spawnSync).mock.calls.find(([command, args]) => args?.some(value => String(value).endsWith('extract-release-archive.py')));
    expect(parserCall[0]).toBe(fs.realpathSync('/usr/bin/python3'));
    expect(parserCall[2].env).toEqual({ LANG: 'C.UTF-8' });
    expect(parserCall[2].env.GITHUB_TOKEN).toBeUndefined();
    expect(result.archive.extraction_verified).toBe(true);
    expect(result.candidate.manifest.commit).toBe(commit);
    expect(result.ready_for_publication).toBe(false);
    expect(result.production_identity_authenticated).toBe(false);
    expect(result.unmet_requirements).toHaveLength(3);
    const replay = { ...data, download: { archivePath: result.archive.path, bundleDirectory: result.candidate.directory } };
    const replayInput = { client: clientFor(fixture, replay), repository, workflowId: 73, runId: 12, artifactId: 44, destination: target, tags };
    const unchanged = await acquireGithubReleaseEvidence(replayInput);
    expect(unchanged.archive.extraction_verified).toBe(false);
    const manifestPath = path.join(result.candidate.directory, 'rc-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, injected: 'modified' }));
    const modified = await acquireGithubReleaseEvidence(replayInput);
    expect(modified.archive.extraction_verified).toBe(false);
    expect(modified.unmet_requirements.join(' ')).toMatch(/extraction-to-directory/);
    fs.unlinkSync(manifestPath);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const replaced = await acquireGithubReleaseEvidence(replayInput);
    expect(replaced.archive.extraction_verified).toBe(false);
    data.artifact = { ...data.artifact, digest: `sha256:${'f'.repeat(64)}` };
    await expect(acquireGithubProductionReleaseEvidence({ ...input, destination: temp() })).rejects.toThrow(/digest/);
  });

  it('does not authenticate independently supplied bundle contents from the archive digest', async () => {
    const fixture = candidateFixture();
    // This is deliberately not an archive of fixture.directory. Structural
    // validation can succeed, but must retain the unmet extraction boundary.
    expect(fs.readFileSync(fixture.archivePath, 'utf8')).toBe('downloaded immutable artifact');
    const evidence = await acquire(fixture, apiData(fixture));
    expect(evidence.archive.extraction_verified).toBe(false);
    expect(evidence.production_identity_authenticated).toBe(false);
    expect(evidence.ready_for_publication).toBe(false);
    expect(evidence.unmet_requirements.join(' ')).toMatch(/extraction-to-directory binding/);
  });

  it.each(['artifact-digest', 'workflow-source', 'jobs-page'])('fails closed on untrusted %s evidence', async failure => {
    const fixture = candidateFixture(), data = apiData(fixture);
    if (failure === 'artifact-digest') data.artifact.digest = `sha256:${'f'.repeat(64)}`;
    if (failure === 'workflow-source') data.source.commit = 'd'.repeat(40);
    if (failure === 'jobs-page') data.jobsPage = { items: data.jobs, complete: false };
    await expect(acquire(fixture, data)).rejects.toThrow();
  });

  it('validates report coverage, completed result structure, package/context identities, and distinct models', () => {
    const fixture = candidateFixture(), comparison = comparisonFixture(fixture.candidate);
    expect(comparison.binding.provider).toBe('claude'); expect(comparison.binding.regressions).toHaveLength(0);
    comparison.report.scenarios[0].evidence.pop(); fs.writeFileSync(comparison.file, JSON.stringify(comparison.report));
    expect(() => verifyComparisonReport({ file: comparison.file, report: comparison.report, plan: comparison.plan,
      candidate: fixture.candidate, baselineVersion: '2026.10.2', expectedBundles: comparison.report.bundles })).toThrow(/coverage/);
  });

  it.each(['empty-assertions', 'forged-assertion', 'false-pass', 'trace-mismatch'])(
    'rejects %s rather than trusting self-reported deterministic outcomes', failure => {
      const fixture = candidateFixture(), comparison = comparisonFixture(fixture.candidate);
      const run = comparison.report.scenarios[0].evidence[0].runs.B;
      if (failure === 'empty-assertions') run.assertions = [];
      if (failure === 'forged-assertion') run.assertions[0].pass = false;
      if (failure === 'false-pass') run.passed = false;
      if (failure === 'trace-mismatch') run.trace.text = '{"action":"omit"}';
      fs.writeFileSync(comparison.file, JSON.stringify(comparison.report));
      expect(() => verifyComparisonReport({ file: comparison.file, report: comparison.report, plan: comparison.plan,
        candidate: fixture.candidate, baselineVersion: '2026.10.2', expectedBundles: comparison.report.bundles })).toThrow(/canonical retained trace/);
    });
  it.each(['pass-rate', 'judge-average'])('rejects forged %s aggregates despite unchanged statuses', failure => {
    const fixture = candidateFixture(), comparison = comparisonFixture(fixture.candidate);
    const aggregate = comparison.report.scenarios[0].B;
    if (failure === 'pass-rate') aggregate.pass_rate = 0;
    else aggregate.judge_scores.correctness = 0;
    fs.writeFileSync(comparison.file, JSON.stringify(comparison.report));
    expect(() => verifyComparisonReport({ file: comparison.file, report: comparison.report, plan: comparison.plan,
      candidate: fixture.candidate, baselineVersion: '2026.10.2', expectedBundles: comparison.report.bundles })).toThrow(/aggregate/);
  });

  it('binds verification to the exact retained report bytes', () => {
    const fixture = candidateFixture(), comparison = comparisonFixture(fixture.candidate);
    comparison.report.unretained = true;
    expect(() => verifyComparisonReport({ file: comparison.file, report: comparison.report, plan: comparison.plan,
      candidate: fixture.candidate, baselineVersion: '2026.10.2', expectedBundles: comparison.report.bundles })).toThrow(/exact retained/);
  });

  it('rejects self-reported runtime authentication added to a v1 report', () => {
    const fixture = candidateFixture(), comparison = comparisonFixture(fixture.candidate);
    comparison.report.runtime_attestation = { authenticated: true, transport: 'live' };
    fs.writeFileSync(comparison.file, JSON.stringify(comparison.report));
    expect(() => verifyComparisonReport({ file: comparison.file, report: comparison.report, plan: comparison.plan,
      candidate: fixture.candidate, baselineVersion: '2026.10.2', expectedBundles: comparison.report.bundles })).toThrow(/identity mismatch/);
  });

  it('rejects an invalid retained Codex judge winner before mapping judge order', () => {
    const fixture = candidateFixture(), comparison = comparisonFixture(fixture.candidate, { provider: 'codex', n: 1 });
    const pair = comparison.report.scenarios[0].evidence[0], judgment = pair.judgment;
    const events = judgment.stdout.trim().split('\n').map(line => JSON.parse(line));
    const message = events.find(event => event.type === 'item.completed' && event.item?.type === 'agent_message');
    const blind = JSON.parse(message.item.text); blind.winner = 'sideways'; message.item.text = JSON.stringify(blind);
    judgment.stdout = events.map(JSON.stringify).join('\n'); judgment.trace = parseTrace(judgment.stdout, 'codex');
    judgment.winner = pair.judge_order[1];
    judgment.runtime_receipt.transcript_sha256 = textHash(judgment.stdout);
    judgment.runtime_receipt.trace_sha256 = textHash(JSON.stringify(judgment.trace));
    const recomputed = comparisonReport(comparison.plan, comparison.report.scenarios.flatMap(item => item.evidence), comparison.report.fixtures);
    comparison.report.summary = recomputed.summary; comparison.report.pass = recomputed.pass; comparison.report.scenarios = recomputed.scenarios;
    fs.writeFileSync(comparison.file, JSON.stringify(comparison.report));
    expect(() => verifyComparisonReport({ file: comparison.file, report: comparison.report, plan: comparison.plan,
      candidate: fixture.candidate, baselineVersion: '2026.10.2', expectedBundles: comparison.report.bundles })).toThrow(/judge response/);
  });

  it.each(['stub-adapter', 'candidate-digest', 'incomplete-live', 'same-judge'])('rejects %s comparison evidence', failure => {
    const fixture = candidateFixture(), comparison = comparisonFixture(fixture.candidate);
    if (failure === 'stub-adapter') {
      const copied = path.join(comparison.root, 'copied-live-name.mjs');
      fs.copyFileSync(path.join(repoRoot, 'test/fixtures/release-compare/subject.mjs'), copied);
      comparison.report.adapters.subject = copied;
    }
    if (failure === 'candidate-digest') comparison.report.fixtures.B.tarball_sha256 = 'f'.repeat(64);
    if (failure === 'incomplete-live') comparison.report.scenarios[0].evidence[0].runs.B.trace.completed = false;
    if (failure === 'same-judge') comparison.report.judge_model = comparison.report.model;
    fs.writeFileSync(comparison.file, JSON.stringify(comparison.report));
    expect(() => verifyComparisonReport({ file: comparison.file, report: comparison.report, plan: comparison.plan,
      candidate: fixture.candidate, baselineVersion: '2026.10.2', expectedBundles: comparison.report.bundles })).toThrow();
  });

  it('takes approval issuer identity from the authenticated API envelope and binds every regression disposition', async () => {
    const fixture = candidateFixture(), comparison = comparisonFixture(fixture.candidate, { regression: true });
    const approval = candidateApproval(fixture, comparison.binding);
    const data = apiData(fixture, JSON.stringify(approval));
    data.approvalsPage = { items: [data.approval, { ...data.approval, id: 902, body: JSON.stringify({ schema: 'aiwg-stable-release-approval/v1' }) }], complete: true, totalCount: 2 };
    const evidence = await acquire(fixture, data);
    const verified = verifyComparisonApprovalReceipt({ evidence, reportBindings: [comparison.binding],
      policy: { allowedApprovalIssuerIds: [1159087] } });
    expect(verified.issuer).toEqual({ id: 1159087, login: 'jmagly', type: 'User' });
    expect(comparison.binding.regressions[0]).toMatchObject({ provider: 'claude', scenario: 'case' });
    expect(comparison.binding.regressions[0].repetition).toBeGreaterThan(0);
    expect(() => verifyComparisonApprovalReceipt({ evidence: JSON.parse(JSON.stringify(evidence)),
      reportBindings: [comparison.binding], policy: { allowedApprovalIssuerIds: [1159087] } })).toThrow(/acquired GitHub evidence/);
  });

  it('authenticates an exact stable approval without comparison reports', async () => {
    const fixture = candidateFixture(), comparison = comparisonFixture(fixture.candidate);
    const candidate = candidateApproval(fixture, comparison.binding).candidate;
    candidate.validation_profile = 'legacy-full-v1';
    delete candidate.stable_tag; delete candidate.stable_tag_object_sha;
    const body = JSON.stringify({ schema: 'aiwg-stable-release-approval/v1', repository: 'jmagly/aiwg', decision: 'approve', policy_sha256: '9'.repeat(64), candidate });
    const data = apiData(fixture, body);
    data.approvalsPage = { items: [data.approval, { ...data.approval, id: 902, body: JSON.stringify(candidateApproval(fixture, comparison.binding)) }], complete: true, totalCount: 2 };
    const evidence = await acquire(fixture, data);
    expect(verifyStableReleaseApproval({ evidence, allowedIssuerIds: [1159087], policySha256: '9'.repeat(64), bodySha256: textHash(body) }).issuer.id).toBe(1159087);
    expect(() => verifyStableReleaseApproval({ evidence, allowedIssuerIds: [999], policySha256: '9'.repeat(64), bodySha256: textHash(body) })).toThrow();
    expect(() => verifyStableReleaseApproval({ evidence, allowedIssuerIds: [1159087], policySha256: '9'.repeat(64), bodySha256: 'f'.repeat(64) })).toThrow();
    expect(() => verifyStableReleaseApproval({ evidence: JSON.parse(JSON.stringify(evidence)), allowedIssuerIds: [1159087], policySha256: '9'.repeat(64), bodySha256: textHash(body) })).toThrow();
    const altered = JSON.parse(body); altered.candidate.commit = 'f'.repeat(40);
    const wrong = await acquire(fixture, apiData(fixture, JSON.stringify(altered)));
    expect(() => verifyStableReleaseApproval({ evidence: wrong, allowedIssuerIds: [1159087], policySha256: '9'.repeat(64), bodySha256: textHash(JSON.stringify(altered)) })).toThrow();
    expect(() => verifyStableReleaseApproval({ evidence, allowedIssuerIds: [1159087], policySha256: '8'.repeat(64), bodySha256: textHash(body) })).toThrow();
    const stale = apiData(fixture, body); stale.approval.updated_at = '2026-10-19T16:00:00Z';
    const staleEvidence = await acquire(fixture, stale);
    expect(() => verifyStableReleaseApproval({ evidence: staleEvidence, allowedIssuerIds: [1159087], policySha256: '9'.repeat(64), bodySha256: textHash(body) })).toThrow(/timestamp/);

  });

  it('binds quarterly approval to the exact current attestation and candidate validation profile', async () => {
    const fixture = candidateFixture(), comparison = comparisonFixture(fixture.candidate), comparisonEvidence = await quarterlyReceipt();
    const candidate = candidateApproval(fixture, comparison.binding).candidate;
    candidate.validation_profile = 'legacy-full-v1';
    const approval = { schema: QUARTERLY_RELEASE_APPROVAL_SCHEMA, repository, decision: 'approve',
      basis: 'quarterly-cross-provider-comparison', candidate_behavior_directly_compared: false, candidate,
      quarterly_attestation: { quarter: comparisonEvidence.quarter.id, valid_from: comparisonEvidence.quarter.valid_from,
        valid_through: comparisonEvidence.quarter.valid_through, tested_commit: comparisonEvidence.run.commit,
        candidate_commit: comparisonEvidence.ancestry.candidate_commit, relation: comparisonEvidence.ancestry.relation,
        workflow_id: comparisonEvidence.workflow.id, run_id: comparisonEvidence.run.id, run_attempt: comparisonEvidence.run.attempt,
        artifact_id: comparisonEvidence.artifact.id, artifact_sha256: comparisonEvidence.archive_sha256,
        manifest_sha256: comparisonEvidence.attestation.sha256, validation_profile: comparisonEvidence.validation.profile,
        validation_sha256: comparisonEvidence.validation.sha256 },
      reports: [Object.fromEntries(Object.entries(comparison.binding).filter(([key]) => key !== 'regressions'))], dispositions: [] };
    const evidence = await acquire(fixture, apiData(fixture, JSON.stringify(approval)));
    expect(verifyComparisonApprovalReceipt({ evidence, comparisonEvidence, reportBindings: [comparison.binding],
      policy: { mode: 'utc-calendar-quarter', allowedApprovalIssuerIds: [1159087] } }).issuer.id).toBe(1159087);

    const wrong = structuredClone(approval); wrong.candidate.validation_profile = 'quarterly-full-v1';
    const wrongEvidence = await acquire(fixture, apiData(fixture, JSON.stringify(wrong)));
    expect(() => verifyComparisonApprovalReceipt({ evidence: wrongEvidence, comparisonEvidence,
      reportBindings: [comparison.binding], policy: { mode: 'utc-calendar-quarter', allowedApprovalIssuerIds: [1159087] } }))
      .toThrow(/exact candidate/);
  });

  it('resolves quarterly sources in the consumer workspace and ignores stale producer absolute adapter paths', async () => {
    const fixture = candidateFixture(), comparisonEvidence = await quarterlyReceipt();
    const comparison = comparisonFixture(fixture.candidate, { provider: 'claude' });
    comparison.report.adapters = { subject: '/producer/runner/tools/rules/release-compare-claude.mjs',
      judge: '/producer/runner/tools/rules/release-compare-claude.mjs' };
    fs.writeFileSync(comparison.file, JSON.stringify(comparison.report));
    const trustedSources = resolveQuarterlyComparisonSources(comparisonEvidence, 'claude');
    expect(verifyComparisonReport({ file: comparison.file, report: comparison.report, plan: comparison.plan,
      candidate: fixture.candidate, baselineVersion: '2026.10.2', expectedBundles: comparison.report.bundles,
      trustedSources }).provider).toBe('claude');
    expect(() => verifyComparisonReport({ file: comparison.file, report: comparison.report, plan: comparison.plan,
      candidate: fixture.candidate, baselineVersion: '2026.10.2', expectedBundles: comparison.report.bundles,
      trustedSources: structuredClone(trustedSources) })).toThrow(/in-process receipt/);
  });

  it('rejects escaped, symlinked, and changed quarterly source identities', () => {
    const root = temp(), source = path.join(root, 'tools/rules/source.mjs'); fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'export default 1;\n');
    const identity = { path: 'tools/rules/source.mjs', sha256: sha256(source) };
    expect(verifyQuarterlySourceIdentity({ root, identity, expectedPath: identity.path }).sha256).toBe(identity.sha256);
    expect(() => verifyQuarterlySourceIdentity({ root, identity: { path: '../escape.mjs', sha256: identity.sha256 },
      expectedPath: '../escape.mjs' })).toThrow(/escapes/);
    fs.appendFileSync(source, 'changed\n');
    expect(() => verifyQuarterlySourceIdentity({ root, identity, expectedPath: identity.path })).toThrow(/differs/);
    fs.rmSync(source); const outside = path.join(root, 'outside.mjs'); fs.writeFileSync(outside, 'export default 1;\n'); fs.symlinkSync(outside, source);
    expect(() => verifyQuarterlySourceIdentity({ root, identity: { ...identity, sha256: sha256(outside) }, expectedPath: identity.path })).toThrow(/differs/);
  });

  it.each(['unauthorized', 'self-asserted-issuer', 'missing-disposition', 'wrong-report'])('rejects %s approval claims', async failure => {
    const fixture = candidateFixture(), comparison = comparisonFixture(fixture.candidate, { regression: true });
    const approval = candidateApproval(fixture, comparison.binding);
    if (failure === 'self-asserted-issuer') approval.issuer = { id: 1159087, login: 'jmagly' };
    if (failure === 'missing-disposition') approval.dispositions = [];
    if (failure === 'wrong-report') approval.reports[0].sha256 = 'f'.repeat(64);
    const data = apiData(fixture, JSON.stringify(approval));
    if (failure === 'unauthorized') data.approval.actor.id = 999;
    const evidence = await acquire(fixture, data);
    expect(() => verifyComparisonApprovalReceipt({ evidence, reportBindings: [comparison.binding],
      policy: { allowedApprovalIssuerIds: [1159087] } })).toThrow();
  });

  it('accepts complete synthetic canonical three-provider n=5 contracts while keeping production publication disabled', async () => {
    const fixture = candidateFixture(), corpus = loadScenarios();
    // Synthetic protocol fixture only: these fabricated transcripts are not
    // live execution, model acceptance, or authority to publish anything.
    const witness = 'synthetic 1 all pass host: compute-03 argon2id hkdf right-size stakeholder evidence critical root cause ownership authorization untrusted nonce trust identity redact read-only dry-run restore baseline unavailable rollback review local canonical post-merge fail regression discover architect WORKSPACE AGENTS fetch full before';
    const syntheticTrace = scenario => {
      const decision = { synthetic_contract_fixture: true };
      const assign = (field, value, onlyMissing = false) => {
        const parts = field.split('.'); let current = decision;
        for (const part of parts.slice(0, -1)) current = current[part] ??= {};
        const leaf = parts.at(-1);
        if (!onlyMissing || !Object.hasOwn(current, leaf)) current[leaf] = value;
      };
      for (const assertion of scenario.assertions) if (assertion.type === 'json-equals') assign(assertion.path, assertion.value);
      for (const assertion of scenario.assertions) if (assertion.type === 'json-matches') assign(assertion.path, witness, true);
      const trace = { text: JSON.stringify(decision), completed: true, failed: false,
        tools: [{ name: 'synthetic-contract-tool', input: { command: 'README.md src/probe.ts package.json CONTRIBUTING.md aiwg discover src/login.ts aiwg show skill' },
          // Body-fetch assertions require authored skill content, not a metadata card (#3436).
          output: { content: '# Synthetic skill body' }, success: true }] };
      expect(evaluateAssertions(scenario.assertions, trace).every(assertion => assertion.pass), scenario.id).toBe(true);
      return trace;
    };
    const reportFiles = [], bindings = [];
    const policy = { repetitions: 5, seed: 'synthetic-full-contract', baselineVersion: '2026.10.2',
      expectedBundles: ['sdlc', 'security-engineering'], allowedApprovalIssuerIds: [1159087], models: {} };
    let pairs = 0;
    for (const provider of ['claude', 'codex', 'hermes']) {
      const template = comparisonFixture(fixture.candidate, { provider });
      policy.models[provider] = { subject: template.report.model, judge: template.report.judge_model };
      const plan = comparisonPlan(corpus, { provider, model: template.report.model,
        judgeModel: template.report.judge_model, n: policy.repetitions, seed: policy.seed });
      const results = plan.pairs.map(pair => {
        const trace = syntheticTrace(pair.scenario);
        const assertions = evaluateAssertions(pair.scenario.assertions, trace);
        const run = { model: plan.model, passed: assertions.length > 0 && assertions.every(assertion => assertion.pass), error: null,
          assertions, trace, tool_stats: { fetched: [], discovery_calls: 0 }, usage: {} };
        return { id: pair.scenario.id, domain: pair.scenario.domain, repetition: pair.repetition,
          order: pair.order, judge_order: pair.judge_order, suspected_cause: 'Synthetic contract fixture; no live acceptance.',
          runs: { A: structuredClone(run), B: structuredClone(run) },
          judgment: { model: plan.judge_model, winner: 'tie', reason: 'Synthetic contract fixture only.',
            scores: { A: scores(4), B: scores(4) } }, judge_error: null };
      });
      if (provider === 'codex') addSyntheticCodexReceipts(results, template.report.fixtures, plan.model, plan.judge_model, template.report.adapters.subject);
      if (provider === 'hermes') addSyntheticHermesReceipts(results, template.report.fixtures, plan.model, plan.judge_model, template.report.adapters.subject, plan);
      pairs += results.length;
      const report = { ...comparisonReport(plan, results, template.report.fixtures),
        fixture_inputs: template.report.fixture_inputs, bundles: policy.expectedBundles, adapters: template.report.adapters };
      fs.writeFileSync(template.file, JSON.stringify(report)); reportFiles.push(template.file);
      bindings.push(verifyComparisonReport({ file: template.file, report, plan, candidate: fixture.candidate,
        baselineVersion: policy.baselineVersion, expectedBundles: policy.expectedBundles }));
    }
    expect(corpus.length).toBe(286); expect(pairs).toBe(4290);
    const approval = candidateApproval(fixture, bindings[0]);
    approval.reports = bindings.map(binding => Object.fromEntries(Object.entries(binding).filter(([key]) => key !== 'regressions')));
    approval.dispositions = [];
    const evidence = await acquire(fixture, apiData(fixture, JSON.stringify(approval)));
    const result = verifyComparisonApprovalGate({ evidence, reportFiles, policy });
    expect(result.structural_evidence_complete).toBe(true);
    expect(result.comparison_reports.map(binding => binding.provider)).toEqual(['claude', 'codex', 'hermes']);
    expect(result.comparison_reports.every(binding => binding.regressions.length === 0)).toBe(true);
    expect(result.approval.issuer.id).toBe(1159087);
    expect(evidence.archive.extraction_verified).toBe(false);
    expect(evidence.production_identity_authenticated).toBe(false);
    expect(evidence.ready_for_publication).toBe(false);
    expect(result.production_identity_authenticated).toBe(false);
    expect(result.ready_for_publication).toBe(false);
    expect(result.unmet_requirements.join(' ')).toMatch(/extraction-to-directory binding/);
  });

  it('keeps publication disabled and requires the complete canonical three-provider gate', async () => {
    const fixture = candidateFixture(), comparison = comparisonFixture(fixture.candidate);
    const approval = candidateApproval(fixture, comparison.binding);
    const evidence = await acquire(fixture, apiData(fixture, JSON.stringify(approval)));
    const policy = { repetitions: 5, seed: 'release-seed', baselineVersion: '2026.10.2',
      expectedBundles: ['sdlc', 'security-engineering'], allowedApprovalIssuerIds: [1159087],
      models: Object.fromEntries(['claude', 'codex', 'hermes'].map(provider => [provider,
        { subject: `${provider}-subject-20261001`, judge: `${provider}-judge-20261002` }])) };
    expect(() => verifyComparisonApprovalGate({ evidence, reportFiles: [comparison.file], policy })).toThrow(/One report per/);
    expect(() => verifyComparisonApprovalGate({ evidence, reportFiles: [comparison.file, comparison.file, comparison.file], policy })).toThrow(/Exactly one/);
  });
});
