#!/usr/bin/env node
// Production evidence boundary for staged release candidates. This module is
// intentionally library-only: no command accepts candidate-supplied metadata.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createGithubEvidenceTransport } from './github-evidence-transport.mjs';
import { importImpl } from '../_resolve-impl.mjs';
import { RC_WORKFLOW, releaseIdentity, sha256, verifyRcBundle } from './release-candidate.mjs';
import { evaluateAssertions } from '../rules/run-rule-probes.mjs';
import { DIMENSIONS, comparisonPlan, comparisonReport, loadScenarios } from '../rules/release-compare.mjs';

const { boundedSpawnSync } = await importImpl(import.meta.url, 'process/bounded-child-process.mjs');
const ROOT = path.resolve(import.meta.dirname, '../..');
const SHA256 = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const EXTRACTION_REQUIREMENT = 'Verify extraction-to-directory binding in the production transport: the checked archive digest does not prove that the separately supplied bundle directory was extracted from that archive.';
export const REQUIRED_COMPARISON_PROVIDERS = Object.freeze(['claude', 'codex', 'hermes']);
export const RELEASE_APPROVAL_SCHEMA = 'aiwg-release-comparison-approval/v1';
const githubClients = new WeakSet();
const tagReceipts = new WeakSet();
const evidenceReceipts = new WeakSet();
const REMAINING_REQUIREMENTS = Object.freeze([
  'Qualify the authenticated GitHub transport in the production environment; this library cannot attest the caller token, TLS stack, or local adapter implementation.',
  'Record and authenticate comparison adapter/remote execution identity at run time; v1 reports retain paths and results but no transport attestation.',
  'Wire and review stable publication of the exact retained tarballs while preserving all existing release safeguards.',
]);
const unmetRequirements = extractionVerified => [...(extractionVerified ? [] : [EXTRACTION_REQUIREMENT]), ...REMAINING_REQUIREMENTS];

const hash = value => createHash('sha256').update(value).digest('hex');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const plainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => plainObject(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
function assertPage(page, key) {
  if (!plainObject(page) || !Array.isArray(page.items) || page.complete !== true
    || (page.totalCount !== undefined && page.totalCount !== page.items.length)) throw new Error(`Incomplete authenticated ${key} collection`);
  return page.items;
}
function within(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function run(command, args, { root, env = process.env, spawn = boundedSpawnSync } = {}) {
  const result = spawn(command, args, 'long', { cwd: root, env, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args[0] ?? ''} failed: ${result.error?.message ?? result.stderr ?? result.status}`);
  return String(result.stdout ?? '').trim();
}

/**
 * Wrap a read-only, authenticated GitHub API transport. The transport is the
 * production trust boundary and must authenticate GitHub itself. This factory
 * prevents candidate JSON from being passed directly to the verifier; it does
 * not attest a caller's token, TLS stack, or local transport implementation.
 */
export function createGithubApiEvidenceClient(transport) {
  const methods = ['getAuthenticatedIdentity', 'getWorkflow', 'getRun', 'listJobs', 'getArtifact',
    'getWorkflowSource', 'downloadArtifact', 'listApprovals'];
  if (!plainObject(transport) || methods.some(name => typeof transport[name] !== 'function')) {
    throw new Error(`GitHub evidence transport requires ${methods.join(', ')}`);
  }
  const client = Object.freeze(Object.fromEntries(methods.map(name => [name, input => transport[name](input)])));
  githubClients.add(client);
  return client;
}

/** Verify both annotated tags with the repository maintainer keyring. */
export function verifySignedTagPair({ root = ROOT, rcTag, stableTag, spawn = boundedSpawnSync } = {}) {
  const packageVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  releaseIdentity(rcTag, packageVersion);
  releaseIdentity(stableTag, packageVersion, 'stable');
  const inspect = tag => {
    const ref = `refs/tags/${tag}`;
    if (run('git', ['cat-file', '-t', ref], { root, spawn }) !== 'tag') throw new Error(`Release tag must be annotated: ${tag}`);
    run('bash', [path.join(root, 'tools/ci/verify-signed-tag.sh')], {
      root, spawn, env: { ...process.env, AIWG_VERIFY_TAG_REF: ref },
    });
    const object = run('git', ['rev-parse', ref], { root, spawn });
    const commit = run('git', ['rev-parse', `${ref}^{commit}`], { root, spawn });
    if (!SHA.test(object) || !SHA.test(commit)) throw new Error(`Invalid signed tag identity: ${tag}`);
    return { tag, object, commit };
  };
  const rc = inspect(rcTag), stable = inspect(stableTag);
  if (rc.commit !== stable.commit) throw new Error('Signed RC and stable tags must resolve to the same commit');
  const checkout = run('git', ['rev-parse', 'HEAD'], { root, spawn });
  if (checkout !== rc.commit) throw new Error('Verifier checkout must be the exact signed release commit');
  const receipt = deepFreeze({ schema: 'signed-release-tag-pair/v1', packageVersion, rc, stable,
    commit: rc.commit, checkout });
  tagReceipts.add(receipt);
  return receipt;
}

/**
 * Acquire all forge metadata through the read-only API client, download the
 * artifact through that same client, and bind it to locally verified tags.
 */
export async function acquireGithubReleaseEvidence(input = {}) {
  return acquireGithubReleaseEvidenceInternal(input);
}
async function acquireGithubReleaseEvidenceInternal({ client, repository, workflowId, runId, artifactId,
  destination, tags } = {}, consumeExtractionProof = () => false) {
  if (!githubClients.has(client)) throw new Error('Use a GitHub API evidence client; candidate JSON is not accepted');
  if (!tagReceipts.has(tags)) throw new Error('A locally verified signed tag-pair receipt is required');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !Number.isSafeInteger(workflowId) || workflowId < 1
    || !Number.isSafeInteger(runId) || runId < 1 || !Number.isSafeInteger(artifactId) || artifactId < 1
    || !nonempty(destination)) throw new Error('Invalid GitHub evidence acquisition identity');
  fs.mkdirSync(destination, { recursive: true });
  const identity = await client.getAuthenticatedIdentity({ repository });
  if ((!Number.isSafeInteger(identity?.id) && !nonempty(identity?.id)) || !nonempty(identity?.login)) {
    throw new Error('GitHub API caller identity was not authenticated');
  }
  const [workflow, runMetadata, artifact, source, approvalsPage] = await Promise.all([
    client.getWorkflow({ repository, workflowId }),
    client.getRun({ repository, runId }),
    client.getArtifact({ repository, artifactId }),
    client.getWorkflowSource({ repository, path: RC_WORKFLOW, commit: tags.commit }),
    client.listApprovals({ repository, commit: tags.commit, rcTag: tags.rc.tag, stableTag: tags.stable.tag }),
  ]);
  const jobsPage = await client.listJobs({ repository, runId, attempt: runMetadata?.run_attempt });
  const jobs = assertPage(jobsPage, 'job');
  const approvals = assertPage(approvalsPage, 'approval');
  if (workflow?.id !== workflowId || artifact?.id !== artifactId || runMetadata?.id !== runId) throw new Error('GitHub API identity mismatch');
  if (!exactKeys(source, ['repository', 'path', 'commit', 'content']) || source.repository !== repository
    || source.path !== RC_WORKFLOW || source.commit !== tags.commit || typeof source.content !== 'string') {
    throw new Error('Invalid exact-commit workflow source response');
  }
  const download = await client.downloadArtifact({ repository, artifactId, destination });
  if (!plainObject(download) || !nonempty(download.archivePath) || !nonempty(download.bundleDirectory)
    || !fs.existsSync(download.archivePath) || !fs.lstatSync(download.archivePath).isFile()
    || !fs.existsSync(download.bundleDirectory) || !fs.lstatSync(download.bundleDirectory).isDirectory()) {
    throw new Error('GitHub artifact download escaped its destination or is incomplete');
  }
  const realDestination = fs.realpathSync(destination);
  if (!within(realDestination, fs.realpathSync(download.archivePath))
    || !within(realDestination, fs.realpathSync(download.bundleDirectory))) {
    throw new Error('GitHub artifact download escaped its destination or is incomplete');
  }
  const archiveSha256 = sha256(download.archivePath);
  if (!SHA256.test(archiveSha256) || artifact.digest !== `sha256:${archiveSha256}`) {
    throw new Error('Downloaded artifact digest does not match authenticated GitHub metadata');
  }
  const workflowSource = { schema: 'workflow-source/v1', repository, path: RC_WORKFLOW,
    commit: tags.commit, sha256: hash(source.content) };
  const verified = verifyRcBundle({ directory: download.bundleDirectory, run: runMetadata, jobs,
    artifact, workflow, workflowSource, repository, commit: tags.commit, stableTag: tags.stable.tag,
    rcTagObjectSha: tags.rc.object });
  const manifestPath = path.join(verified.directory, 'rc-manifest.json');
  const rootTarball = `aiwg-${verified.manifest.package_version}.tgz`;
  const extractionVerified = consumeExtractionProof(download, archiveSha256);
  const receipt = deepFreeze({ schema: 'github-release-evidence/v1', repository,
    production_identity_authenticated: false, ready_for_publication: false,
    unmet_requirements: unmetRequirements(extractionVerified),
    apiCaller: { id: identity.id, login: identity.login, type: identity.type ?? null },
    workflow, run: runMetadata, jobs, artifact, workflowSource, approvals,
    tags, archive: { sha256: archiveSha256, path: path.resolve(download.archivePath), extraction_verified: extractionVerified },
    candidate: { ...verified, manifest_sha256: sha256(manifestPath), package_tarball: rootTarball,
      package_tarball_sha256: verified.manifest.files[rootTarball] } });
  evidenceReceipts.add(receipt);
  return receipt;
}

/** Production acquisition owns extraction of the same digest-checked archive bytes. */
export async function acquireGithubProductionReleaseEvidence({ token, approvalIssue, fetchImpl, ...input } = {}) {
  const transport = createGithubEvidenceTransport({ token, approvalIssue, fetchImpl });
  let proof = null;
  const download = transport.downloadArtifact;
  transport.downloadArtifact = async options => {
    const { archivePath } = await download(options);
    const stat = fs.lstatSync(archivePath);
    if (!stat.isFile() || stat.size > 256 * 1024 * 1024) throw new Error('Invalid release archive');
    const bytes = fs.readFileSync(archivePath);
    const digest = hash(bytes);
    // Validate the authenticated API digest *before* parsing attacker-controlled ZIP bytes.
    const artifact = await transport.getArtifact(options);
    if (artifact?.digest !== `sha256:${digest}`) throw new Error('Downloaded artifact digest does not match authenticated GitHub metadata');
    const directory = fs.mkdtempSync(path.join(options.destination, 'candidate-extract-'));
    // The parser sees neither provider credentials nor Python startup hooks. The
    // interpreter and all parent directories must be root-owned and non-writable
    // by unprivileged users; PATH never selects executable code.
    const interpreter = fs.realpathSync('/usr/bin/python3');
    for (let current = interpreter; ; current = path.dirname(current)) {
      const info = fs.statSync(current);
      if (info.uid !== 0 || (info.mode & 0o022) !== 0) throw new Error('Untrusted Python interpreter or parent directory');
      if (current === path.parse(current).root) break;
    }
    const result = spawnSync(interpreter, ['-I', '-S', path.join(ROOT, 'tools/release/extract-release-archive.py'), directory],
      { input: bytes, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024, env: { LANG: 'C.UTF-8' } });
    if (result.error || result.status !== 0) {
      fs.rmSync(directory, { recursive: true, force: true });
      throw new Error(`Release archive extraction failed: ${result.error?.message ?? result.stderr}`);
    }
    const files = Object.fromEntries(fs.readdirSync(directory).sort().map(name => [name, sha256(path.join(directory, name))]));
    proof = { digest, archivePath: path.resolve(archivePath), directory: path.resolve(directory), files };
    return { archivePath, bundleDirectory: directory };
  };
  try {
    return await acquireGithubReleaseEvidenceInternal({ ...input, client: createGithubApiEvidenceClient(transport) }, (downloaded, digest) => {
      const current = proof;
      proof = null;
      if (!current || current.digest !== digest || current.archivePath !== path.resolve(downloaded.archivePath)
        || current.directory !== path.resolve(downloaded.bundleDirectory)) return false;
      const entries = fs.readdirSync(current.directory, { withFileTypes: true });
      return entries.length === Object.keys(current.files).length && entries.every(entry => entry.isFile()
        && Object.hasOwn(current.files, entry.name) && sha256(path.join(current.directory, entry.name)) === current.files[entry.name]);
    });
  } finally { proof = null; }
}

function validateFixture(identity, side, { baselineVersion, candidate }) {
  const keys = ['spec', 'package_version', 'tarball_sha256', 'deployed_context_sha256',
    'package_tree_sha256', 'installation_lock_sha256'];
  if (!exactKeys(identity, keys) || !SHA256.test(identity.deployed_context_sha256 ?? '')
    || !SHA256.test(identity.package_tree_sha256 ?? '') || !SHA256.test(identity.installation_lock_sha256 ?? '')) {
    throw new Error(`Incomplete ${side} package/context identity`);
  }
  if (side === 'A') {
    if (identity.spec !== `aiwg@${baselineVersion}` || identity.package_version !== baselineVersion
      || identity.tarball_sha256 !== null) throw new Error('Baseline fixture identity mismatch');
  } else if (!String(identity.spec).startsWith('tarball:') || identity.package_version !== candidate.manifest.package_version
    || identity.tarball_sha256 !== candidate.package_tarball_sha256
    || path.basename(identity.spec.slice(8)) !== candidate.package_tarball) throw new Error('Candidate fixture is not the exact retained tarball');
}
function validateLivePair(pair, expected, report) {
  if (pair.id !== expected.scenario.id || pair.repetition !== expected.repetition
    || !same(pair.order, expected.order) || !same(pair.judge_order, expected.judge_order)) throw new Error('Comparison pair schedule mismatch');
  for (const side of ['A', 'B']) {
    const run = pair.runs?.[side];
    if (run?.model !== report.model || run.error !== null || typeof run.passed !== 'boolean'
      || run.trace?.completed !== true || run.trace?.failed !== false || !Array.isArray(run.trace?.tools)
      || !Array.isArray(run.assertions) || typeof run.trace.text !== 'string') throw new Error('Comparison contains incomplete or non-live subject results');
    const assertions = evaluateAssertions(expected.scenario.assertions, run.trace);
    const passed = assertions.length > 0 && assertions.every(assertion => assertion.pass);
    if (!same(assertions, run.assertions) || run.passed !== passed) {
      throw new Error('Comparison assertions or pass result do not match canonical retained trace evidence');
    }
  }
  const judgment = pair.judgment;
  if (pair.judge_error !== null || judgment?.model !== report.judge_model || !['A', 'B', 'tie'].includes(judgment?.winner)
    || !nonempty(judgment?.reason)) throw new Error('Comparison contains incomplete or non-live judge results');
  for (const side of ['A', 'B']) for (const dimension of Object.keys(DIMENSIONS)) {
    const score = judgment.scores?.[side]?.[dimension];
    if (!Number.isInteger(score) || score < 0 || score > 4) throw new Error('Comparison judge score is invalid');
  }
}
function regressionSignals(pair) {
  const signals = [];
  if (pair.runs.A.passed && !pair.runs.B.passed) signals.push('deterministic-pass-lost');
  if (pair.judgment.winner === 'A') signals.push('judge-preferred-baseline');
  for (const dimension of Object.keys(DIMENSIONS)) {
    if (pair.judgment.scores.B[dimension] < pair.judgment.scores.A[dimension]) signals.push(`judge-score:${dimension}`);
  }
  return signals;
}
function validateAdapter(file, label) {
  if (!path.isAbsolute(file ?? '') || /(?:^|[/\\])test[/\\]fixtures[/\\]release-compare(?:[/\\]|$)/.test(file)
    || !fs.existsSync(file) || !fs.lstatSync(file).isFile()) throw new Error(`${label} comparison adapter is missing or is an offline fixture`);
  const digest = sha256(file);
  for (const fixture of ['subject.mjs', 'judge.mjs']) {
    const known = path.join(ROOT, 'test/fixtures/release-compare', fixture);
    if (fs.existsSync(known) && digest === sha256(known)) throw new Error(`${label} comparison adapter is an offline fixture copy`);
  }
  return digest;
}

/** Validate one unchanged #3298 report against its canonical plan. */
export function verifyComparisonReport({ file, report, plan, candidate, baselineVersion, expectedBundles } = {}) {
  if (!nonempty(file) || !fs.existsSync(file) || !fs.lstatSync(file).isFile()) throw new Error('Comparison report must be a regular file');
  const reportBytes = fs.readFileSync(file);
  let retainedReport;
  try { retainedReport = JSON.parse(reportBytes); } catch { throw new Error('Comparison report file must contain JSON'); }
  if (!same(retainedReport, report)) throw new Error('Comparison input does not match the exact retained report file');
  const reportKeys = ['version', 'fixtures', 'provider', 'model', 'judge_model', 'corpus_digest', 'seed', 'n', 'call_counts',
    'token_estimate_inputs', 'planned_pairs', 'completed_pairs', 'summary', 'pass', 'scenarios', 'fixture_inputs', 'bundles', 'adapters'];
  if (!exactKeys(report, reportKeys) || report.version !== 1 || report.provider !== plan?.provider || report.model !== plan.model
    || report.judge_model !== plan.judge_model || report.model.trim().toLowerCase() === report.judge_model.trim().toLowerCase()) {
    throw new Error('Comparison report format or provider/model identity mismatch');
  }
  if (report.n !== plan.n || report.seed !== plan.seed || report.corpus_digest !== plan.corpus_digest
    || report.planned_pairs !== plan.pairs.length || report.completed_pairs !== plan.pairs.length
    || !same(report.call_counts, plan.call_counts) || report.summary?.invalid !== 0) throw new Error('Comparison coverage is incomplete or invalid');
  if (!same([...(report.bundles ?? [])].sort(), [...expectedBundles].sort())
    || report.fixture_inputs?.A !== `aiwg@${baselineVersion}` || !String(report.fixture_inputs?.B ?? '').startsWith('tarball:')) {
    throw new Error('Comparison fixture or bundle selection mismatch');
  }
  validateFixture(report.fixtures?.A, 'A', { baselineVersion, candidate });
  validateFixture(report.fixtures?.B, 'B', { baselineVersion, candidate });
  const subjectAdapterSha256 = validateAdapter(report.adapters?.subject, 'Subject');
  const judgeAdapterSha256 = validateAdapter(report.adapters?.judge, 'Judge');
  const expectedPairs = new Map(plan.pairs.map(pair => [`${pair.scenario.id}\u0000${pair.repetition}`, pair]));
  const results = [];
  if (!Array.isArray(report.scenarios)) throw new Error('Comparison scenarios are missing');
  for (const scenario of report.scenarios) {
    if (!expectedPairs.has(`${scenario.id}\u00001`) || !Array.isArray(scenario.evidence) || scenario.evidence.length !== plan.n) {
      throw new Error('Comparison scenario coverage mismatch');
    }
    for (const pair of scenario.evidence) {
      const key = `${scenario.id}\u0000${pair.repetition}`, expected = expectedPairs.get(key);
      if (!expected) throw new Error('Unexpected or duplicate comparison case');
      validateLivePair(pair, expected, report); expectedPairs.delete(key); results.push(pair);
    }
  }
  if (expectedPairs.size || results.length !== plan.pairs.length) throw new Error('Comparison case coverage is incomplete');
  const recomputed = comparisonReport(plan, results, report.fixtures);
  if (!same(recomputed.summary, report.summary) || recomputed.pass !== report.pass
    || !same(recomputed.scenarios, report.scenarios)) {
    throw new Error('Comparison aggregate does not match retained case evidence');
  }
  const reportSha256 = hash(reportBytes);
  const regressions = results.map(pair => ({ provider: report.provider, scenario: pair.id, repetition: pair.repetition,
    report_sha256: reportSha256, signals: regressionSignals(pair) })).filter(item => item.signals.length);
  return { provider: report.provider, sha256: reportSha256, corpus_digest: report.corpus_digest,
    baseline_package_tree_sha256: report.fixtures.A.package_tree_sha256,
    candidate_package_tree_sha256: report.fixtures.B.package_tree_sha256,
    candidate_context_sha256: report.fixtures.B.deployed_context_sha256,
    subject_adapter_sha256: subjectAdapterSha256, judge_adapter_sha256: judgeAdapterSha256, regressions };
}

function expectedCandidateBinding(evidence) {
  const candidate = evidence.candidate;
  return { repository: evidence.repository, commit: candidate.manifest.commit, rc_tag: candidate.manifest.rc_tag,
    rc_tag_object_sha: evidence.tags.rc.object, stable_tag: evidence.tags.stable.tag,
    stable_tag_object_sha: evidence.tags.stable.object, workflow_id: evidence.workflow.id,
    run_id: candidate.manifest.run_id, run_attempt: candidate.manifest.run_attempt,
    artifact_id: candidate.artifact_id, artifact_sha256: evidence.archive.sha256,
    manifest_sha256: candidate.manifest_sha256, package_version: candidate.manifest.package_version,
    package_tarball_sha256: candidate.package_tarball_sha256 };
}
function approvalPayload(item, repository) {
  if (!plainObject(item) || (!Number.isSafeInteger(item.id) && !nonempty(item.id))
    || !nonempty(item.html_url) || !item.html_url.startsWith(`https://github.com/${repository}/`)
    || (!Number.isSafeInteger(item.actor?.id) && !nonempty(item.actor?.id)) || !nonempty(item.actor?.login)
    || !nonempty(item.created_at) || !nonempty(item.updated_at)
    || !nonempty(item.body) || item.body.length > 4 * 1024 * 1024) throw new Error('Malformed authenticated approval envelope');
  try { return JSON.parse(item.body); } catch { throw new Error('Approval body must be the structured release approval receipt'); }
}
function verifyApproval(evidence, bindings, policy) {
  const candidates = evidence.approvals.filter(item => policy.allowedApprovalIssuerIds.map(String).includes(String(item.actor?.id)));
  if (candidates.length !== 1) throw new Error('Exactly one approval from an authenticated allowed issuer is required');
  const envelope = candidates[0], payload = approvalPayload(envelope, evidence.repository);
  if (!exactKeys(payload, ['schema', 'repository', 'decision', 'candidate', 'reports', 'dispositions'])
    || payload.schema !== RELEASE_APPROVAL_SCHEMA || payload.repository !== evidence.repository || payload.decision !== 'approve'
    || !same(payload.candidate, expectedCandidateBinding(evidence))) throw new Error('Approval is not bound to the exact candidate');
  const reportKeys = ['provider', 'sha256', 'corpus_digest', 'baseline_package_tree_sha256', 'candidate_package_tree_sha256',
    'candidate_context_sha256', 'subject_adapter_sha256', 'judge_adapter_sha256'];
  if (!Array.isArray(payload.reports) || payload.reports.length !== bindings.length
    || payload.reports.some(item => !exactKeys(item, reportKeys))) throw new Error('Approval report bindings are malformed');
  const normalize = item => reportKeys.map(key => item[key]);
  const sortBindings = items => items.map(normalize).sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  if (!same(sortBindings(payload.reports), sortBindings(bindings))) throw new Error('Approval report digest/identity mismatch');
  const regressions = bindings.flatMap(binding => binding.regressions);
  const dispositions = payload.dispositions;
  const dispositionKeys = ['provider', 'scenario', 'repetition', 'report_sha256', 'signals', 'decision', 'reason', 'evidence'];
  if (!Array.isArray(dispositions) || dispositions.length !== regressions.length
    || dispositions.some(item => !exactKeys(item, dispositionKeys) || item.decision !== 'accept'
      || !nonempty(item.reason) || !nonempty(item.evidence))) throw new Error('Every regression requires an exact authenticated disposition');
  const key = item => `${item.provider}\u0000${item.scenario}\u0000${item.repetition}`;
  const byKey = new Map(dispositions.map(item => [key(item), item]));
  if (byKey.size !== dispositions.length) throw new Error('Duplicate regression disposition');
  for (const regression of regressions) {
    const disposition = byKey.get(key(regression));
    if (!disposition || disposition.report_sha256 !== regression.report_sha256
      || !same(disposition.signals, regression.signals)) throw new Error('Regression disposition is not bound to the exact case evidence');
  }
  return { id: envelope.id, url: envelope.html_url,
    issuer: { id: envelope.actor.id, login: envelope.actor.login, type: envelope.actor.type ?? null } };
}

/** Verify approval content while taking issuer identity only from acquired API evidence. */
export function verifyComparisonApprovalReceipt({ evidence, reportBindings, policy } = {}) {
  if (!evidenceReceipts.has(evidence)) throw new Error('Approval requires an acquired GitHub evidence receipt');
  if (!Array.isArray(reportBindings) || !plainObject(policy)
    || !Array.isArray(policy.allowedApprovalIssuerIds) || !policy.allowedApprovalIssuerIds.length
    || new Set(policy.allowedApprovalIssuerIds.map(String)).size !== policy.allowedApprovalIssuerIds.length) {
    throw new Error('Approval verification requires report bindings and allowed issuer IDs');
  }
  return deepFreeze(verifyApproval(evidence, reportBindings, policy));
}

/**
 * Validate complete live comparison reports and an API-authenticated approval.
 * This still cannot publish: a reviewed production API transport and stable
 * publisher integration remain explicit unmet requirements.
 */
export function verifyComparisonApprovalGate({ evidence, reportFiles, policy } = {}) {
  if (!evidenceReceipts.has(evidence)) throw new Error('Comparison approval requires an acquired GitHub evidence receipt');
  if (!plainObject(policy) || policy.repetitions !== 5 || !nonempty(policy.seed)
    || !/^\d{4}\.(?:[1-9]|1[0-2])\.(?:0|[1-9]\d*)$/.test(policy.baselineVersion ?? '')
    || !Array.isArray(policy.expectedBundles) || !policy.expectedBundles.length || new Set(policy.expectedBundles).size !== policy.expectedBundles.length
    || !Array.isArray(policy.allowedApprovalIssuerIds) || !policy.allowedApprovalIssuerIds.length || !plainObject(policy.models)) {
    throw new Error('Trusted comparison policy must fix n=5, seed, baseline, bundles, models, and allowed issuer IDs');
  }
  if (!Array.isArray(reportFiles) || reportFiles.length !== REQUIRED_COMPARISON_PROVIDERS.length) throw new Error('One report per required provider is required');
  const corpus = loadScenarios(), bindings = [];
  for (const provider of REQUIRED_COMPARISON_PROVIDERS) {
    const model = policy.models[provider];
    if (!plainObject(model) || !nonempty(model.subject) || !nonempty(model.judge)
      || model.subject.trim().toLowerCase() === model.judge.trim().toLowerCase()) throw new Error(`Trusted ${provider} model policy is invalid`);
    const matching = reportFiles.filter(file => {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')).provider === provider; } catch { return false; }
    });
    if (matching.length !== 1) throw new Error(`Exactly one ${provider} comparison report is required`);
    const file = path.resolve(matching[0]), report = JSON.parse(fs.readFileSync(file, 'utf8'));
    const plan = comparisonPlan(corpus, { provider, model: model.subject, judgeModel: model.judge,
      n: policy.repetitions, seed: policy.seed });
    bindings.push(verifyComparisonReport({ file, report, plan, candidate: evidence.candidate,
      baselineVersion: policy.baselineVersion, expectedBundles: policy.expectedBundles }));
  }
  const approval = verifyComparisonApprovalReceipt({ evidence, reportBindings: bindings, policy });
  return deepFreeze({ structural_evidence_complete: true, production_identity_authenticated: false,
    comparison_reports: bindings, approval, ready_for_publication: false,
    unmet_requirements: unmetRequirements(evidence.archive.extraction_verified) });
}
