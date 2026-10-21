#!/usr/bin/env node
// Production evidence boundary for staged release candidates. This module is
// intentionally library-only: no command accepts candidate-supplied metadata.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createGithubEvidenceTransport } from './github-evidence-transport.mjs';
import { importImpl } from '../_resolve-impl.mjs';
import { RC_LANES, RC_WORKFLOW, releaseIdentity, sha256, verifyRcBundle } from './release-candidate.mjs';
import { evaluateAssertions, parseTrace } from '../rules/run-rule-probes.mjs';
import { DIMENSIONS, comparisonPlan, comparisonReport, loadScenarios } from '../rules/release-compare.mjs';
import { buildHermesArgs, parseHermesStream } from '../rules/release-compare-hermes.mjs';

const { boundedSpawnSync } = await importImpl(import.meta.url, 'process/bounded-child-process.mjs');
const ROOT = path.resolve(import.meta.dirname, '../..');
const SHA256 = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const EXTRACTION_REQUIREMENT = 'Verify extraction-to-directory binding in the production transport: the checked archive digest does not prove that the separately supplied bundle directory was extracted from that archive.';
export const REQUIRED_COMPARISON_PROVIDERS = Object.freeze(['claude', 'codex', 'hermes']);
export const RELEASE_APPROVAL_SCHEMA = 'aiwg-release-comparison-approval/v1';
export const QUARTERLY_RELEASE_APPROVAL_SCHEMA = 'aiwg-release-comparison-approval/v2';
export const QUARTERLY_ATTESTATION_SCHEMA = 'aiwg-quarterly-comparison-attestation/v1';
const QUARTERLY_SOURCE_PATHS = Object.freeze({
  claude: Object.freeze({ subject: 'tools/rules/release-compare-claude.mjs', judge: 'tools/rules/release-compare-claude.mjs' }),
  codex: Object.freeze({ subject: 'tools/rules/release-compare-codex.mjs', judge: 'tools/rules/release-compare-codex.mjs',
    runtime: 'tools/rules/codex-evaluation-runtime.mjs', parser: 'tools/rules/run-rule-probes.mjs' }),
  hermes: Object.freeze({ subject: 'tools/rules/release-compare-hermes.mjs', judge: 'tools/rules/release-compare-hermes.mjs' }),
});
const githubClients = new WeakSet();
const tagReceipts = new WeakSet();
const evidenceReceipts = new WeakSet();
const productionEvidenceReceipts = new WeakSet();
const comparisonArtifactReceipts = new WeakSet();
const quarterlySourceReceipts = new WeakSet();
const comparisonGateReceipts = new WeakMap();
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
function parseTimestamp(value, label) {
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
  const http = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
  if (!nonempty(value) || (!iso.test(value) && !http.test(value))) throw new Error(`Invalid ${label} timestamp`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`Invalid ${label} timestamp`);
  const canonical = iso.test(value) ? value.replace(/(?<!\.\d{3})Z$/, '.000Z') : value;
  const roundTrip = iso.test(value) ? new Date(milliseconds).toISOString() : new Date(milliseconds).toUTCString();
  if (roundTrip !== canonical) throw new Error(`Invalid ${label} timestamp`);
  return milliseconds;
}
function utcQuarter(value) {
  const date = new Date(parseTimestamp(value, 'UTC quarter'));
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  const start = new Date(Date.UTC(date.getUTCFullYear(), (quarter - 1) * 3, 1));
  const through = new Date(Date.UTC(date.getUTCFullYear(), quarter * 3, 1));
  return { id: `${date.getUTCFullYear()}-Q${quarter}`, valid_from: start.toISOString(), valid_through: through.toISOString(), start: start.getTime(), through: through.getTime() };
}
function validateQuarterlySourceManifest(sources) {
  if (!exactKeys(sources, REQUIRED_COMPARISON_PROVIDERS)) throw new Error('Quarterly source identity inventory is incomplete');
  for (const provider of REQUIRED_COMPARISON_PROVIDERS) {
    const expected = QUARTERLY_SOURCE_PATHS[provider], actual = sources[provider];
    if (!exactKeys(actual, Object.keys(expected))) throw new Error(`Quarterly ${provider} source identity inventory is incomplete`);
    for (const [kind, expectedPath] of Object.entries(expected)) {
      const identity = actual[kind];
      if (!exactKeys(identity, ['path', 'sha256']) || identity.path !== expectedPath || !SHA256.test(identity.sha256 ?? '')) {
        throw new Error(`Quarterly ${provider} ${kind} source identity is invalid`);
      }
    }
  }
  return sources;
}
/** Pure source portability check; it grants no comparison or publication authority. */
export function verifyQuarterlySourceIdentity({ root, identity, expectedPath } = {}) {
  if (!nonempty(root) || !exactKeys(identity, ['path', 'sha256']) || identity.path !== expectedPath
    || !SHA256.test(identity.sha256 ?? '') || path.isAbsolute(expectedPath ?? '')) {
    throw new Error('Invalid quarterly comparison source identity');
  }
  const canonicalRoot = fs.realpathSync(root), file = path.resolve(canonicalRoot, expectedPath);
  const relative = path.relative(canonicalRoot, file);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error('Quarterly source path escapes the repository');
  }
  let stat; try { stat = fs.lstatSync(file); } catch { throw new Error('Quarterly comparison source is unavailable'); }
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file || sha256(file) !== identity.sha256) {
    throw new Error('Quarterly comparison source differs from the attested tested-commit source');
  }
  return deepFreeze({ path: file, sha256: identity.sha256 });
}
export function quarterlySourceAvailability(root = ROOT) {
  const problems = [];
  for (const [provider, sources] of Object.entries(QUARTERLY_SOURCE_PATHS)) {
    for (const [kind, sourcePath] of Object.entries(sources)) {
      const file = path.resolve(root, sourcePath);
      let stat; try { stat = fs.lstatSync(file); } catch { stat = null; }
      if (!stat?.isFile() || stat.isSymbolicLink()) problems.push(`Missing canonical quarterly ${provider} ${kind} source: ${sourcePath}`);
    }
  }
  return problems;
}
export function resolveQuarterlyComparisonSources(receipt, provider) {
  assertProductionComparisonReports(receipt);
  const identities = receipt.sources?.[provider], expected = QUARTERLY_SOURCE_PATHS[provider];
  if (!identities || !expected) throw new Error(`Missing trusted quarterly ${provider} sources`);
  const resolved = {};
  for (const [kind, expectedPath] of Object.entries(expected)) {
    const identity = identities[kind];
    try { resolved[kind] = verifyQuarterlySourceIdentity({ root: ROOT, identity, expectedPath }); }
    catch (error) { throw new Error(`Quarterly ${provider} ${kind} source rejected: ${error.message}`); }
  }
  const sourceReceipt = deepFreeze(resolved);
  quarterlySourceReceipts.add(sourceReceipt);
  return sourceReceipt;
}
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
function extractProductionArchive(bytes, destination, prefix) {
  const directory = fs.mkdtempSync(path.join(destination, prefix));
  const interpreter = fs.realpathSync('/usr/bin/python3');
  for (let current = interpreter; ; current = path.dirname(current)) {
    const info = fs.statSync(current);
    if (info.uid !== 0 || (info.mode & 0o022) !== 0) throw new Error('Untrusted Python interpreter or parent directory');
    if (current === path.parse(current).root) break;
  }
  const result = spawnSync(interpreter, ['-I', '-S', path.join(ROOT, 'tools/release/extract-release-archive.py'), directory],
    { input: bytes, encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, env: { LANG: 'C.UTF-8' } });
  if (result.error || result.status !== 0) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw new Error(`Release archive extraction failed: ${result.error?.message ?? result.stderr}`);
  }
  return directory;
}
function verifyQuarterlyFullValidation(file, commit, { startedAt, completedAt } = {}) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error('Invalid quarterly full validation evidence');
  let evidence; try { evidence = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('Malformed quarterly full validation evidence'); }
  if (!exactKeys(evidence, ['version', 'profile', 'commit', 'runner', 'node', 'lanes', 'pass']) || evidence.version !== 2
    || evidence.profile !== 'quarterly-full-v1' || evidence.commit !== commit || evidence.pass !== true
    || !nonempty(evidence.runner) || !nonempty(evidence.node)
    || !Array.isArray(evidence.lanes) || evidence.lanes.length !== RC_LANES.length) throw new Error('Quarterly full validation profile is incomplete');
  for (const lane of RC_LANES) {
    const matches = evidence.lanes.filter(item => item?.lane === lane && item.status === 'success'
      && nonempty(item.started_at) && nonempty(item.completed_at));
    const laneStartedAt = matches.length === 1 ? parseTimestamp(matches[0].started_at, `${lane} start`) : NaN;
    const laneCompletedAt = matches.length === 1 ? parseTimestamp(matches[0].completed_at, `${lane} completion`) : NaN;
    if (matches.length !== 1 || laneStartedAt > laneCompletedAt
      || (startedAt !== undefined && laneStartedAt < startedAt)
      || (completedAt !== undefined && laneCompletedAt > completedAt)) {
      throw new Error(`Quarterly full validation lane is missing or failed: ${lane}`);
    }
  }
  return evidence;
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
    // The parser sees neither provider credentials nor Python startup hooks.
    const directory = extractProductionArchive(bytes, options.destination, 'candidate-extract-');
    const files = Object.fromEntries(fs.readdirSync(directory).sort().map(name => [name, sha256(path.join(directory, name))]));
    proof = { digest, archivePath: path.resolve(archivePath), directory: path.resolve(directory), files };
    return { archivePath, bundleDirectory: directory };
  };
  try {
    const evidence = await acquireGithubReleaseEvidenceInternal({ ...input, client: createGithubApiEvidenceClient(transport) }, (downloaded, digest) => {
      const current = proof;
      proof = null;
      if (!current || current.digest !== digest || current.archivePath !== path.resolve(downloaded.archivePath)
        || current.directory !== path.resolve(downloaded.bundleDirectory)) return false;
      const entries = fs.readdirSync(current.directory, { withFileTypes: true });
      return entries.length === Object.keys(current.files).length && entries.every(entry => entry.isFile()
        && Object.hasOwn(current.files, entry.name) && sha256(path.join(current.directory, entry.name)) === current.files[entry.name]);
    });
    if (!evidence.archive.extraction_verified) throw new Error('Production artifact extraction proof was not retained');
    productionEvidenceReceipts.add(evidence);
    return evidence;
  } finally { proof = null; }
}

/** Acquire one current-quarter comparison attestation and its exact three reports. */
export async function acquireGithubProductionComparisonReports({ token, approvalIssue, repository,
  workflowId, runId, artifactId, candidateCommit, destination, requiredJobName, requiredSteps,
  mode = 'utc-calendar-quarter', fetchImpl } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !Number.isSafeInteger(workflowId) || workflowId < 1
    || !Number.isSafeInteger(runId) || runId < 1 || !Number.isSafeInteger(artifactId) || artifactId < 1
    || !SHA.test(candidateCommit ?? '') || !['per-release', 'utc-calendar-quarter'].includes(mode)
    || !nonempty(destination) || !nonempty(requiredJobName)
    || !Array.isArray(requiredSteps) || !requiredSteps.length || requiredSteps.some(step => !nonempty(step))) throw new Error('Invalid comparison artifact identity');
  const transport = createGithubEvidenceTransport({ token, approvalIssue, fetchImpl });
  const [workflow, runMetadata, artifact] = await Promise.all([
    transport.getWorkflow({ repository, workflowId }), transport.getRun({ repository, runId }),
    transport.getArtifact({ repository, artifactId }),
  ]);
  // Fetch identity last so its authenticated HTTP Date is an observation made
  // after the completed-run metadata used below.
  const identity = await transport.getAuthenticatedIdentity({ repository });
  const serverQuarter = mode === 'utc-calendar-quarter' ? utcQuarter(identity?.server_date) : null;
  const testedCommit = runMetadata?.head_sha;
  if ((!Number.isSafeInteger(identity?.id) && !nonempty(identity?.id)) || !nonempty(identity?.login)
    || workflow?.id !== workflowId || runMetadata?.id !== runId || runMetadata?.workflow_id !== workflowId
    || !SHA.test(testedCommit ?? '') || runMetadata?.status !== 'completed' || runMetadata?.conclusion !== 'success'
    || artifact?.id !== artifactId || artifact?.expired !== false || artifact?.workflow_run?.id !== runId
    || artifact?.workflow_run?.head_sha !== testedCommit) throw new Error('Comparison artifact is not bound to the successful tested-commit workflow run');
  let ancestry = null, identical = false;
  if (mode === 'per-release') {
    if (testedCommit !== candidateCommit) throw new Error('Per-release comparison must test the exact release candidate');
  } else {
    ancestry = await transport.compareCommits({ repository, base: testedCommit, head: candidateCommit });
    identical = testedCommit === candidateCommit && ancestry?.status === 'identical'
      && ancestry?.ahead_by === 0 && ancestry?.behind_by === 0;
    // GitHub caps the returned commits array at 250 without pagination, but documents
    // its final entry as the most recent commit in the entire comparison. Bind that
    // documented head back to the exact candidate SHA requested in the endpoint.
    const commits = Array.isArray(ancestry?.commits) ? ancestry.commits : [];
    const ahead = ancestry?.status === 'ahead' && ancestry?.ahead_by > 0 && ancestry?.behind_by === 0
      && commits.length > 0 && commits.at(-1)?.sha === candidateCommit;
    if ((!identical && !ahead) || ancestry?.base_commit?.sha !== testedCommit
      || ancestry?.merge_base_commit?.sha !== testedCommit) throw new Error('Quarterly tested commit is not an ancestor of the release candidate');
  }
  const jobsPage = await transport.listJobs({ repository, runId, attempt: runMetadata.run_attempt });
  const jobs = assertPage(jobsPage, 'comparison job');
  const matchingJobs = jobs.filter(job => job.name === requiredJobName && job.run_id === runId && job.head_sha === testedCommit
    && job.status === 'completed' && job.conclusion === 'success');
  if (matchingJobs.length !== 1) throw new Error('Comparison artifact run lacks the trusted successful job');
  for (const name of requiredSteps) {
    const matches = (matchingJobs[0].steps ?? []).filter(step => step.name === name
      && step.status === 'completed' && step.conclusion === 'success');
    if (matches.length !== 1) throw new Error(`Comparison artifact run lacks trusted successful step: ${name}`);
  }
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const { archivePath } = await transport.downloadArtifact({ repository, artifactId, destination });
  const stat = fs.lstatSync(archivePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 * 1024) throw new Error('Invalid comparison archive');
  const bytes = fs.readFileSync(archivePath), archiveSha256 = hash(bytes);
  if (artifact.digest !== `sha256:${archiveSha256}`) throw new Error('Comparison archive digest does not match authenticated GitHub metadata');
  const directory = extractProductionArchive(bytes, destination, 'comparison-extract-');
  try {
    const reportNames = REQUIRED_COMPARISON_PROVIDERS.map(provider => `${provider}.json`);
    if (mode === 'per-release') {
      const entries = fs.readdirSync(directory, { withFileTypes: true });
      if (entries.length !== reportNames.length || entries.some(entry => !entry.isFile())
        || entries.map(entry => entry.name).sort().join('\0') !== [...reportNames].sort().join('\0')) {
        throw new Error('Per-release comparison artifact must contain exactly three provider reports');
      }
      const reportFiles = REQUIRED_COMPARISON_PROVIDERS.map(provider => path.join(directory, `${provider}.json`));
      for (const [index, provider] of REQUIRED_COMPARISON_PROVIDERS.entries()) {
        let report; try { report = JSON.parse(fs.readFileSync(reportFiles[index], 'utf8')); } catch { throw new Error(`Malformed ${provider} comparison report`); }
        if (report?.provider !== provider) throw new Error(`Comparison report provider mismatch: ${provider}`);
      }
      const receipt = deepFreeze({ mode, repository, workflow: { id: workflow.id, path: workflow.path },
        run: { id: runMetadata.id, attempt: runMetadata.run_attempt, commit: testedCommit,
          started_at: runMetadata.run_started_at ?? null, completed_at: runMetadata.updated_at ?? null,
          job: requiredJobName, steps: [...requiredSteps] },
        artifact: { id: artifact.id, digest: artifact.digest }, archive_sha256: archiveSha256,
        apiCaller: { id: identity.id, login: identity.login, type: identity.type ?? null },
        directory: path.resolve(directory), reportFiles: reportFiles.map(file => path.resolve(file)) });
      comparisonArtifactReceipts.add(receipt);
      return receipt;
    }
    const expected = ['quarterly-attestation.json', 'validation.json',
      ...reportNames].sort();
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    if (entries.length !== expected.length || entries.some(entry => !entry.isFile())
      || entries.map(entry => entry.name).sort().join('\0') !== expected.join('\0')) {
      throw new Error('Comparison artifact must contain exactly one quarterly attestation, full validation record, and three provider reports');
    }
    const manifestFile = path.join(directory, 'quarterly-attestation.json');
    let manifest; try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { throw new Error('Malformed quarterly comparison attestation'); }
    const manifestKeys = ['schema', 'profile', 'repository', 'quarter', 'valid_from', 'valid_through', 'tested_commit',
      'workflow_id', 'run_id', 'run_attempt', 'started_at', 'completed_at', 'package_version', 'package_tarball',
      'package_tarball_sha256', 'validation_sha256', 'reports', 'sources'];
    const runStartedAt = parseTimestamp(runMetadata.run_started_at, 'comparison run start');
    const runCompletedAt = parseTimestamp(runMetadata.updated_at, 'comparison run completion');
    const attestationStartedAt = parseTimestamp(manifest?.started_at, 'quarterly validation start');
    const attestationCompletedAt = parseTimestamp(manifest?.completed_at, 'quarterly validation completion');
    const validationFile = path.join(directory, 'validation.json');
    if (!exactKeys(manifest, manifestKeys) || manifest.schema !== QUARTERLY_ATTESTATION_SCHEMA || manifest.profile !== 'quarterly-full-v1'
      || manifest.repository !== repository || manifest.quarter !== serverQuarter.id
      || manifest.valid_from !== serverQuarter.valid_from || manifest.valid_through !== serverQuarter.valid_through
      || manifest.tested_commit !== testedCommit || manifest.workflow_id !== workflowId || manifest.run_id !== runId
      || manifest.run_attempt !== runMetadata.run_attempt || runStartedAt < serverQuarter.start || runCompletedAt >= serverQuarter.through
      || runStartedAt > attestationStartedAt || attestationStartedAt > attestationCompletedAt
      || attestationCompletedAt > runCompletedAt || runCompletedAt > parseTimestamp(identity.server_date, 'GitHub server')
      || !/^\d{4}\.(?:[1-9]|1[0-2])\.(?:0|[1-9]\d*)$/.test(manifest.package_version ?? '')
      || manifest.package_tarball !== `aiwg-${manifest.package_version}.tgz`
      || !SHA256.test(manifest.package_tarball_sha256 ?? '') || manifest.validation_sha256 !== sha256(validationFile)
      || !exactKeys(manifest.reports, REQUIRED_COMPARISON_PROVIDERS)) {
      throw new Error('Quarterly comparison attestation does not match its authenticated run or UTC quarter');
    }
    validateQuarterlySourceManifest(manifest.sources);
    verifyQuarterlyFullValidation(validationFile, testedCommit,
      { startedAt: attestationStartedAt, completedAt: attestationCompletedAt });
    const reportFiles = REQUIRED_COMPARISON_PROVIDERS.map(provider => path.join(directory, `${provider}.json`));
    for (const [index, provider] of REQUIRED_COMPARISON_PROVIDERS.entries()) {
      let report; try { report = JSON.parse(fs.readFileSync(reportFiles[index], 'utf8')); } catch { throw new Error(`Malformed ${provider} comparison report`); }
      if (report?.provider !== provider || manifest.reports[provider] !== sha256(reportFiles[index])) throw new Error(`Comparison report digest/provider mismatch: ${provider}`);
    }
    const receipt = deepFreeze({ repository, workflow: { id: workflow.id, path: workflow.path },
      run: { id: runMetadata.id, attempt: runMetadata.run_attempt, commit: testedCommit,
        started_at: runMetadata.run_started_at, completed_at: runMetadata.updated_at,
        job: requiredJobName, steps: [...requiredSteps] },
      artifact: { id: artifact.id, digest: artifact.digest }, archive_sha256: archiveSha256,
      apiCaller: { id: identity.id, login: identity.login, type: identity.type ?? null },
      observed_at: identity.server_date, quarter: { id: serverQuarter.id, valid_from: serverQuarter.valid_from,
        valid_through: serverQuarter.valid_through }, attestation: { ...manifest, sha256: sha256(manifestFile) },
      sources: manifest.sources,
      validation: { profile: manifest.profile, sha256: manifest.validation_sha256, lanes: [...RC_LANES] },
      ancestry: { tested_commit: testedCommit, candidate_commit: candidateCommit,
        relation: identical ? 'identical' : 'ancestor', ahead_by: ancestry.ahead_by },
      testedCandidate: { manifest: { package_version: manifest.package_version }, package_tarball: manifest.package_tarball,
        package_tarball_sha256: manifest.package_tarball_sha256 },
      directory: path.resolve(directory), reportFiles: reportFiles.map(file => path.resolve(file)) });
    comparisonArtifactReceipts.add(receipt);
    return receipt;
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function assertProductionComparisonReports(receipt) {
  if (!comparisonArtifactReceipts.has(receipt)) throw new Error('Stable promotion requires in-process authenticated comparison reports');
  return receipt;
}

/** Internal-capability assertion used by the stable-promotion orchestrator. */
export function assertProductionReleaseEvidence(evidence) {
  if (!productionEvidenceReceipts.has(evidence) || evidence?.archive?.extraction_verified !== true) {
    throw new Error('Stable promotion requires in-process production GitHub evidence');
  }
  return evidence;
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
function verifyCodexReceipt(run, model, fixtureHash, sourceHashes) {
  const receipt = run?.runtime_receipt;
  const keys = ['schema', 'authenticated', 'provider', 'requested_model', 'requested_effort', 'reported_remote_model', 'reported_remote_backend', 'executable_sha256', 'adapter_source_sha256', 'runtime_source_sha256', 'trace_parser_sha256', 'argv_sha256', 'prompt_sha256', 'fixture_identity_sha256', 'transcript_sha256', 'trace_sha256'];
  const digests = ['executable_sha256', 'adapter_source_sha256', 'runtime_source_sha256', 'trace_parser_sha256', 'argv_sha256', 'prompt_sha256', 'transcript_sha256', 'trace_sha256'];
  if (!exactKeys(receipt, keys) || receipt.schema !== 'aiwg-comparison-runtime-observation/v1' || receipt.authenticated !== false || receipt.provider !== 'codex' || receipt.requested_model !== model || !nonempty(receipt.requested_effort) || receipt.reported_remote_model !== null || receipt.reported_remote_backend !== null || digests.some(key => !SHA256.test(receipt[key] ?? '')) || receipt.fixture_identity_sha256 !== fixtureHash || receipt.adapter_source_sha256 !== sourceHashes.adapter || receipt.runtime_source_sha256 !== sourceHashes.runtime || receipt.trace_parser_sha256 !== sourceHashes.parser || typeof run.stdout !== 'string' || receipt.transcript_sha256 !== hash(run.stdout) || receipt.trace_sha256 !== hash(JSON.stringify(run.trace)) || run.trace?.completed !== true || run.trace?.failed !== false) throw new Error('Invalid unauthenticated Codex runtime observation');
  let parsed; try { parsed = parseTrace(run.stdout, 'codex'); } catch { throw new Error('Invalid Codex event stream'); }
  if (!same(parsed, run.trace)) throw new Error('Codex trace differs from event stream');
  return receipt;
}
function verifyHermesReceipt(run, model, fixtureHash, sourceHashes, judge = false) {
  const receipt = run?.runtime_receipt;
  const keys = ['schema', 'authenticated', 'provider', 'requested_model', 'requested_provider', 'requested_effort', 'hermes_version', 'reported_remote_model', 'reported_remote_backend',
    'qualification_authenticated', 'qualification_id', 'qualification_controller', 'qualification_producer', 'launcher_sha256', 'hermes_executable_sha256',
    'boundary_profile_sha256', 'boundary_receipt_sha256', 'adapter_source_sha256', 'argv_sha256', 'prompt_sha256', 'fixture_identity_sha256', 'transcript_sha256', 'trace_sha256'];
  const digests = ['launcher_sha256', 'hermes_executable_sha256', 'boundary_profile_sha256', 'boundary_receipt_sha256', 'adapter_source_sha256', 'argv_sha256', 'prompt_sha256', 'transcript_sha256', 'trace_sha256'];
  const allowedEfforts = new Set(['low', 'medium', 'high']);
  let expectedArgvSha256 = null;
  try { expectedArgvSha256 = hash(JSON.stringify(buildHermesArgs({ model, provider: receipt?.requested_provider, effort: receipt?.requested_effort, judge }))); }
  catch { /* The common validation below reports the invalid runtime observation. */ }
  if (!exactKeys(receipt, keys) || receipt.schema !== 'aiwg-comparison-runtime-observation/v1' || receipt.authenticated !== false
    || receipt.provider !== 'hermes' || receipt.requested_model !== model || !nonempty(receipt.requested_provider) || receipt.requested_provider === 'auto'
    || receipt.hermes_version !== '0.21.6+387.gdce1e9b'
    || !allowedEfforts.has(receipt.requested_effort) || receipt.argv_sha256 !== expectedArgvSha256
    || receipt.reported_remote_model !== null || receipt.reported_remote_backend !== null
    || receipt.qualification_authenticated !== false || !nonempty(receipt.qualification_id) || !nonempty(receipt.qualification_controller)
    || !nonempty(receipt.qualification_producer) || digests.some(key => !SHA256.test(receipt[key] ?? ''))
    || receipt.fixture_identity_sha256 !== fixtureHash || receipt.adapter_source_sha256 !== sourceHashes.adapter
    || typeof run.stdout !== 'string' || receipt.transcript_sha256 !== hash(run.stdout)
    || receipt.trace_sha256 !== hash(JSON.stringify(run.trace)) || run.trace?.completed !== true || run.trace?.failed !== false) {
    throw new Error('Invalid unauthenticated Hermes runtime observation');
  }
  let parsed; try { parsed = parseHermesStream(run.stdout, { judge, expectedModel: model }); }
  catch { throw new Error('Invalid Hermes stream-json evidence'); }
  if (!same(parsed, run.trace)) throw new Error('Hermes trace differs from stream-json evidence');
  return receipt;
}
function validateLivePair(pair, expected, report, sourceHashes) {
  if (pair.id !== expected.scenario.id || pair.repetition !== expected.repetition
    || !same(pair.order, expected.order) || !same(pair.judge_order, expected.judge_order)) throw new Error('Comparison pair schedule mismatch');
  for (const side of ['A', 'B']) {
    const run = pair.runs?.[side];
    if (run?.model !== report.model || run.error !== null || typeof run.passed !== 'boolean'
      || run.trace?.completed !== true || run.trace?.failed !== false || !Array.isArray(run.trace?.tools)
      || !Array.isArray(run.assertions) || typeof run.trace.text !== 'string') throw new Error('Comparison contains incomplete or non-live subject results');
    if (report.provider === 'codex') {
      verifyCodexReceipt(run, report.model, hash(JSON.stringify(report.fixtures[side])), sourceHashes);
    } else if (report.provider === 'hermes') {
      verifyHermesReceipt(run, report.model, hash(JSON.stringify(report.fixtures[side])), sourceHashes);
    }
    const assertions = evaluateAssertions(expected.scenario.assertions, run.trace);
    const passed = assertions.length > 0 && assertions.every(assertion => assertion.pass);
    if (!same(assertions, run.assertions) || run.passed !== passed) {
      throw new Error('Comparison assertions or pass result do not match canonical retained trace evidence');
    }
  }
  if (report.provider === 'codex' && ['requested_effort', 'executable_sha256', 'adapter_source_sha256', 'runtime_source_sha256', 'trace_parser_sha256'].some(key => pair.runs.A.runtime_receipt[key] !== pair.runs.B.runtime_receipt[key])) throw new Error('Codex comparison settings differ between sides');
  if (report.provider === 'hermes' && ['requested_provider', 'requested_effort', 'hermes_version', 'qualification_id', 'qualification_controller', 'qualification_producer', 'launcher_sha256', 'hermes_executable_sha256', 'boundary_profile_sha256', 'boundary_receipt_sha256', 'adapter_source_sha256', 'argv_sha256', 'prompt_sha256'].some(key => pair.runs.A.runtime_receipt[key] !== pair.runs.B.runtime_receipt[key])) throw new Error('Hermes comparison settings differ between sides');
  const judgment = pair.judgment;
  if (pair.judge_error !== null || judgment?.model !== report.judge_model || !['A', 'B', 'tie'].includes(judgment?.winner)
    || !nonempty(judgment?.reason)) throw new Error('Comparison contains incomplete or non-live judge results');
  if (report.provider === 'codex') {
    const receipt = verifyCodexReceipt(judgment, report.judge_model, null, sourceHashes);
    if (receipt.executable_sha256 !== pair.runs.A.runtime_receipt.executable_sha256 || judgment.trace.events.some(event => !['thread.started', 'turn.started', 'turn.completed', 'item.started', 'item.updated', 'item.completed'].includes(event.type) || (event.type.startsWith('item.') && (!event.item || !['agent_message', 'reasoning'].includes(event.item.type))))) throw new Error('Invalid Codex judge runtime trace');
    let blind; try { blind = JSON.parse(judgment.trace.text); } catch { throw new Error('Invalid Codex judge response'); }
    if (!['left', 'right', 'tie'].includes(blind.winner) || (blind.winner === 'tie' ? 'tie' : pair.judge_order[blind.winner === 'left' ? 0 : 1]) !== judgment.winner || blind.reason !== judgment.reason || !same(blind.scores?.left, judgment.scores[pair.judge_order[0]]) || !same(blind.scores?.right, judgment.scores[pair.judge_order[1]])) throw new Error('Codex judge response does not match retained trace');
  } else if (report.provider === 'hermes') {
    const receipt = verifyHermesReceipt(judgment, report.judge_model, null, sourceHashes, true);
    const subject = pair.runs.A.runtime_receipt;
    if (['requested_provider', 'hermes_version', 'qualification_id', 'qualification_controller', 'qualification_producer', 'launcher_sha256', 'hermes_executable_sha256', 'boundary_profile_sha256', 'boundary_receipt_sha256', 'adapter_source_sha256'].some(key => receipt[key] !== subject[key])) throw new Error('Hermes judge boundary differs from subject boundary');
    let blind; try { blind = JSON.parse(judgment.trace.text); } catch { throw new Error('Invalid Hermes judge response'); }
    if (!['left', 'right', 'tie'].includes(blind.winner) || (blind.winner === 'tie' ? 'tie' : pair.judge_order[blind.winner === 'left' ? 0 : 1]) !== judgment.winner || blind.reason !== judgment.reason || !same(blind.scores?.left, judgment.scores[pair.judge_order[0]]) || !same(blind.scores?.right, judgment.scores[pair.judge_order[1]])) throw new Error('Hermes judge response does not match retained trace');
  }
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
export function verifyComparisonReport({ file, report, plan, candidate, baselineVersion, expectedBundles, trustedSources } = {}) {
  if (trustedSources && !quarterlySourceReceipts.has(trustedSources)) throw new Error('Trusted quarterly sources require an authenticated in-process receipt');
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
  const subjectAdapterSha256 = trustedSources?.subject?.sha256 ?? validateAdapter(report.adapters?.subject, 'Subject');
  const judgeAdapterSha256 = trustedSources?.judge?.sha256 ?? validateAdapter(report.adapters?.judge, 'Judge');
  const sourceHashes = report.provider === 'codex' ? (trustedSources
    ? { adapter: subjectAdapterSha256, runtime: trustedSources.runtime?.sha256, parser: trustedSources.parser?.sha256 }
    : { adapter: subjectAdapterSha256, runtime: sha256(path.join(path.dirname(report.adapters.subject), 'codex-evaluation-runtime.mjs')), parser: sha256(path.join(path.dirname(report.adapters.subject), 'run-rule-probes.mjs')) })
    : report.provider === 'hermes' ? { adapter: subjectAdapterSha256 } : null;
  if (trustedSources && (!SHA256.test(subjectAdapterSha256) || !SHA256.test(judgeAdapterSha256)
    || (report.provider === 'codex' && (!SHA256.test(sourceHashes.runtime) || !SHA256.test(sourceHashes.parser))))) {
    throw new Error('Trusted quarterly comparison source identities are incomplete');
  }
  if (report.provider === 'codex' && subjectAdapterSha256 !== judgeAdapterSha256) throw new Error('Codex subject and judge must use the same reviewed adapter');
  if (report.provider === 'hermes' && subjectAdapterSha256 !== judgeAdapterSha256) throw new Error('Hermes subject and judge must use the same reviewed adapter');
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
      validateLivePair(pair, expected, report, sourceHashes); expectedPairs.delete(key); results.push(pair);
    }
  }
  if (expectedPairs.size || results.length !== plan.pairs.length) throw new Error('Comparison case coverage is incomplete');
  if (report.provider === 'codex' && results.length) {
    const first = results[0];
    for (const pair of results) for (const role of ['A', 'B', 'judge']) {
      const receipt = role === 'judge' ? pair.judgment.runtime_receipt : pair.runs[role].runtime_receipt;
      const reference = role === 'judge' ? first.judgment.runtime_receipt : first.runs.A.runtime_receipt;
      if (['requested_effort', 'executable_sha256', 'adapter_source_sha256', 'runtime_source_sha256', 'trace_parser_sha256'].some(key => receipt[key] !== reference[key])) throw new Error('Codex runtime settings differ across comparison pairs');
    }
  }
  if (report.provider === 'hermes' && results.length) {
    const first = results[0];
    for (const pair of results) for (const role of ['A', 'B', 'judge']) {
      const receipt = role === 'judge' ? pair.judgment.runtime_receipt : pair.runs[role].runtime_receipt;
      const reference = role === 'judge' ? first.judgment.runtime_receipt : first.runs.A.runtime_receipt;
      if (['requested_provider', 'requested_effort', 'hermes_version', 'qualification_id', 'qualification_controller', 'qualification_producer', 'launcher_sha256', 'hermes_executable_sha256', 'boundary_profile_sha256', 'boundary_receipt_sha256', 'adapter_source_sha256', 'argv_sha256'].some(key => receipt[key] !== reference[key])) throw new Error('Hermes runtime boundary differs across comparison pairs');
    }
  }
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

function expectedCandidateBinding(evidence, includeValidationProfile = false) {
  const candidate = evidence.candidate;
  return { repository: evidence.repository, commit: candidate.manifest.commit, rc_tag: candidate.manifest.rc_tag,
    rc_tag_object_sha: evidence.tags.rc.object, stable_tag: evidence.tags.stable.tag,
    stable_tag_object_sha: evidence.tags.stable.object, workflow_id: evidence.workflow.id,
    run_id: candidate.manifest.run_id, run_attempt: candidate.manifest.run_attempt,
    artifact_id: candidate.artifact_id, artifact_sha256: evidence.archive.sha256,
    manifest_sha256: candidate.manifest_sha256, package_version: candidate.manifest.package_version,
    package_tarball_sha256: candidate.package_tarball_sha256,
    ...(includeValidationProfile ? { validation_profile: candidate.validation_profile } : {}) };
}
function approvalPayload(item, repository) {
  if (!plainObject(item) || (!Number.isSafeInteger(item.id) && !nonempty(item.id))
    || !nonempty(item.html_url) || !item.html_url.startsWith(`https://github.com/${repository}/`)
    || (!Number.isSafeInteger(item.actor?.id) && !nonempty(item.actor?.id)) || !nonempty(item.actor?.login)
    || !nonempty(item.created_at) || !nonempty(item.updated_at)
    || !nonempty(item.body) || item.body.length > 4 * 1024 * 1024) throw new Error('Malformed authenticated approval envelope');
  try { return JSON.parse(item.body); } catch { throw new Error('Approval body must be the structured release approval receipt'); }
}
function expectedQuarterlyBinding(receipt) {
  assertProductionComparisonReports(receipt);
  return { quarter: receipt.quarter.id, valid_from: receipt.quarter.valid_from, valid_through: receipt.quarter.valid_through,
    tested_commit: receipt.run.commit, candidate_commit: receipt.ancestry.candidate_commit,
    relation: receipt.ancestry.relation, workflow_id: receipt.workflow.id, run_id: receipt.run.id,
    run_attempt: receipt.run.attempt, artifact_id: receipt.artifact.id, artifact_sha256: receipt.archive_sha256,
    manifest_sha256: receipt.attestation.sha256, validation_profile: receipt.validation.profile,
    validation_sha256: receipt.validation.sha256 };
}
function verifyApproval(evidence, bindings, policy, comparisonEvidence) {
  const candidates = evidence.approvals.filter(item => policy.allowedApprovalIssuerIds.map(String).includes(String(item.actor?.id)));
  if (candidates.length !== 1) throw new Error('Exactly one approval from an authenticated allowed issuer is required');
  const envelope = candidates[0], payload = approvalPayload(envelope, evidence.repository);
  if ((policy.mode ?? 'per-release') === 'utc-calendar-quarter') {
    const keys = ['schema', 'repository', 'decision', 'basis', 'candidate_behavior_directly_compared',
      'candidate', 'quarterly_attestation', 'reports', 'dispositions'];
    const approvalAt = parseTimestamp(envelope.updated_at, 'quarterly approval');
    const quarter = comparisonEvidence?.quarter;
    if (!exactKeys(payload, keys) || payload.schema !== QUARTERLY_RELEASE_APPROVAL_SCHEMA
      || payload.repository !== evidence.repository || payload.decision !== 'approve'
      || payload.basis !== 'quarterly-cross-provider-comparison' || payload.candidate_behavior_directly_compared !== false
      || !same(payload.candidate, expectedCandidateBinding(evidence, true))
      || !same(payload.quarterly_attestation, expectedQuarterlyBinding(comparisonEvidence))
      || approvalAt < Date.parse(quarter.valid_from) || approvalAt >= Date.parse(quarter.valid_through)
      || approvalAt < parseTimestamp(comparisonEvidence.run.completed_at, 'comparison completion')
      || approvalAt > parseTimestamp(comparisonEvidence.observed_at, 'GitHub server')) {
      throw new Error('Quarterly approval is not bound to the exact candidate and current attestation');
    }
  } else if (!exactKeys(payload, ['schema', 'repository', 'decision', 'candidate', 'reports', 'dispositions'])
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
  return { id: envelope.id, url: envelope.html_url, body_sha256: hash(envelope.body),
    issuer: { id: envelope.actor.id, login: envelope.actor.login, type: envelope.actor.type ?? null } };
}

/** Verify approval content while taking issuer identity only from acquired API evidence. */
export function verifyComparisonApprovalReceipt({ evidence, comparisonEvidence, reportBindings, policy } = {}) {
  if (!evidenceReceipts.has(evidence)) throw new Error('Approval requires an acquired GitHub evidence receipt');
  if (!Array.isArray(reportBindings) || !plainObject(policy)
    || !Array.isArray(policy.allowedApprovalIssuerIds) || !policy.allowedApprovalIssuerIds.length
    || new Set(policy.allowedApprovalIssuerIds.map(String)).size !== policy.allowedApprovalIssuerIds.length) {
    throw new Error('Approval verification requires report bindings and allowed issuer IDs');
  }
  return deepFreeze(verifyApproval(evidence, reportBindings, policy, comparisonEvidence));
}

/**
 * Validate complete live comparison reports and an API-authenticated approval.
 * This still cannot publish: a reviewed production API transport and stable
 * publisher integration remain explicit unmet requirements.
 */
export function verifyComparisonApprovalGate({ evidence, comparisonEvidence, reportFiles, policy } = {}) {
  if (!evidenceReceipts.has(evidence)) throw new Error('Comparison approval requires an acquired GitHub evidence receipt');
  const mode = policy?.mode ?? 'per-release';
  if (!plainObject(policy) || !['per-release', 'utc-calendar-quarter'].includes(mode) || policy.repetitions !== 5 || !nonempty(policy.seed)
    || !/^\d{4}\.(?:[1-9]|1[0-2])\.(?:0|[1-9]\d*)$/.test(policy.baselineVersion ?? '')
    || !Array.isArray(policy.expectedBundles) || !policy.expectedBundles.length || new Set(policy.expectedBundles).size !== policy.expectedBundles.length
    || !Array.isArray(policy.allowedApprovalIssuerIds) || !policy.allowedApprovalIssuerIds.length || !plainObject(policy.models)) {
    throw new Error('Trusted comparison policy must fix n=5, seed, baseline, bundles, models, and allowed issuer IDs');
  }
  const runtimeIdentity = policy.runtimeIdentity;
  const runtimeIdentityPolicySatisfied = exactKeys(runtimeIdentity, ['allowUnattestedBackend', 'providers'])
    && runtimeIdentity.allowUnattestedBackend === true
    && exactKeys(runtimeIdentity.providers, REQUIRED_COMPARISON_PROVIDERS)
    && REQUIRED_COMPARISON_PROVIDERS.every(provider => runtimeIdentity.providers[provider] === 'requested-cli-model');
  if (mode === 'utc-calendar-quarter') {
    assertProductionComparisonReports(comparisonEvidence);
    reportFiles = comparisonEvidence.reportFiles;
    if (comparisonEvidence.ancestry.candidate_commit !== evidence.candidate.manifest.commit) throw new Error('Quarterly comparison ancestry is not bound to the exact candidate');
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
    bindings.push(verifyComparisonReport({ file, report, plan,
      candidate: mode === 'utc-calendar-quarter' ? comparisonEvidence.testedCandidate : evidence.candidate,
      baselineVersion: policy.baselineVersion, expectedBundles: policy.expectedBundles,
      trustedSources: mode === 'utc-calendar-quarter' ? resolveQuarterlyComparisonSources(comparisonEvidence, provider) : undefined }));
  }
  const approval = verifyComparisonApprovalReceipt({ evidence, comparisonEvidence, reportBindings: bindings, policy });
  const receipt = deepFreeze({ structural_evidence_complete: true, production_identity_authenticated: false,
    runtime_identity_policy_satisfied: runtimeIdentityPolicySatisfied,
    runtime_identity: REQUIRED_COMPARISON_PROVIDERS.map(provider => ({ provider,
      trust_level: runtimeIdentityPolicySatisfied ? runtimeIdentity.providers[provider] : null,
      backend_attested: false })),
    policy_sha256: hash(JSON.stringify(policy)),
    comparison_mode: mode,
    quarterly_attestation: mode === 'utc-calendar-quarter' ? expectedQuarterlyBinding(comparisonEvidence) : null,
    comparison_reports: bindings, approval, ready_for_publication: false,
    unmet_requirements: unmetRequirements(evidence.archive.extraction_verified) });
  comparisonGateReceipts.set(receipt, { evidence, comparisonEvidence: comparisonEvidence ?? null });
  return receipt;
}

/** Reject serialized or caller-fabricated comparison decisions. */
export function assertVerifiedComparisonApprovalGate(receipt, evidence, comparisonEvidence = null) {
  const capability = comparisonGateReceipts.get(receipt);
  if (capability?.evidence !== evidence || capability.comparisonEvidence !== comparisonEvidence) {
    throw new Error('Stable promotion requires an in-process verified comparison approval gate');
  }
  return receipt;
}
