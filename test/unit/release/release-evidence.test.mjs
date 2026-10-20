import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});
import { RC_LANES, RC_STEPS, RC_WORKFLOW, SURFACES, sha256, writeCandidateManifest } from '../../../tools/release/release-candidate.mjs';
import { evaluateAssertions } from '../../../tools/rules/run-rule-probes.mjs';
import { DIMENSIONS, comparisonPlan, comparisonReport, loadScenarios } from '../../../tools/rules/release-compare.mjs';
import { RELEASE_APPROVAL_SCHEMA, acquireGithubReleaseEvidence, acquireGithubProductionReleaseEvidence, createGithubApiEvidenceClient,
  verifyComparisonApprovalGate, verifyComparisonApprovalReceipt, verifyComparisonReport,
  verifySignedTagPair } from '../../../tools/release/release-evidence.mjs';

const roots = [];
const temp = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-release-evidence-')); roots.push(root); return root; };
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const repoRoot = path.resolve(import.meta.dirname, '../../..');
const version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
const repository = 'jmagly/aiwg', commit = 'a'.repeat(40), rcObject = 'b'.repeat(40), stableObject = 'c'.repeat(40);
const rcTag = `v${version}-rc.2`, stableTag = `v${version}`;

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
    repository: { full_name: repository }, head_repository: { full_name: repository }, head_sha: commit, head_branch: rcTag };
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
    getAuthenticatedIdentity(input) { calls.push(['identity', input]); return { id: 77, login: 'release-app', type: 'Bot' }; },
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

const scenario = (id = 'case') => ({ id, kind: 'positive', providers: ['claude', 'codex', 'hermes'], domain: 'delivery',
  prompt: 'Return JSON.', assertions: [{ type: 'json-equals', path: 'action', value: 'follow' }], files: {}, suspected_cause: 'test' });
const scores = value => Object.fromEntries(Object.keys(DIMENSIONS).map(dimension => [dimension, value]));
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
  const report = { ...comparisonReport(plan, results, identities), fixture_inputs: { A: 'aiwg@2026.10.2', B: identities.B.spec },
    bundles: ['sdlc', 'security-engineering'], adapters: { subject, judge } };
  const file = path.join(root, `${provider}.json`); fs.writeFileSync(file, JSON.stringify(report));
  return { root, file, report, plan, binding: verifyComparisonReport({ file, report, plan, candidate,
    baselineVersion: '2026.10.2', expectedBundles: report.bundles }) };
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
z.close()`, fixture.directory, fixture.archivePath]);
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
    const evidence = await acquire(fixture, apiData(fixture, JSON.stringify(approval)));
    const verified = verifyComparisonApprovalReceipt({ evidence, reportBindings: [comparison.binding],
      policy: { allowedApprovalIssuerIds: [1159087] } });
    expect(verified.issuer).toEqual({ id: 1159087, login: 'jmagly', type: 'User' });
    expect(comparison.binding.regressions[0]).toMatchObject({ provider: 'claude', scenario: 'case' });
    expect(comparison.binding.regressions[0].repetition).toBeGreaterThan(0);
    expect(() => verifyComparisonApprovalReceipt({ evidence: JSON.parse(JSON.stringify(evidence)),
      reportBindings: [comparison.binding], policy: { allowedApprovalIssuerIds: [1159087] } })).toThrow(/acquired GitHub evidence/);
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
        tools: [{ name: 'synthetic-contract-tool', input: { command: 'README.md src/probe.ts package.json CONTRIBUTING.md aiwg discover src/login.ts aiwg show skill' }, success: true }] };
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
