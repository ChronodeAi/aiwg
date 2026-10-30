#!/usr/bin/env node
// Dispatch-only producer for the authenticated quarterly comparison artifact.
// Importing this module performs no validation, model inference, or network I/O.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { comparisonPlan, comparisonReport, executeComparison, loadScenarios, prepareFixture, runnerAdapter } from '../rules/release-compare.mjs';
import { verifyComparisonReport } from './release-evidence.mjs';
import { RC_LANES } from './release-candidate.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/;
const CALVER = /^\d{4}\.(?:[1-9]|1[0-2])\.(?:0|[1-9]\d*)$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
export const QUARTERLY_WORKFLOW = '.github/workflows/release-comparison.yml';
export const QUARTERLY_JOB = 'Retain comparisons';
export const QUARTERLY_STEPS = Object.freeze(['Assemble and verify comparisons', 'Retain comparison evidence']);
export const QUARTERLY_SHARD_COUNT = 16;
export const QUARTERLY_BUNDLES = Object.freeze(['sdlc', 'security-engineering']);
export const QUARTERLY_PROVIDERS = Object.freeze(['claude', 'codex', 'hermes']);
const SOURCE_PATHS = Object.freeze({
  claude: Object.freeze({ subject: 'tools/rules/release-compare-claude.mjs', judge: 'tools/rules/release-compare-claude.mjs' }),
  codex: Object.freeze({ subject: 'tools/rules/release-compare-codex.mjs', judge: 'tools/rules/release-compare-codex.mjs',
    runtime: 'tools/rules/codex-evaluation-runtime.mjs', parser: 'tools/rules/run-rule-probes.mjs' }),
  hermes: Object.freeze({ subject: 'tools/rules/release-compare-hermes.mjs', judge: 'tools/rules/release-compare-hermes.mjs' }),
});
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');

function parseTimestamp(value, label) {
  const http = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
  if (typeof value !== 'string' || (!ISO.test(value) && !http.test(value))) throw new Error(`Invalid ${label} timestamp`);
  const milliseconds = Date.parse(value);
  const canonical = ISO.test(value) ? value.replace(/(?<!\.\d{3})Z$/, '.000Z') : value;
  const roundTrip = ISO.test(value) ? new Date(milliseconds).toISOString() : new Date(milliseconds).toUTCString();
  if (!Number.isFinite(milliseconds) || roundTrip !== canonical) throw new Error(`Invalid ${label} timestamp`);
  return milliseconds;
}
function sha256(file) {
  const digest = createHash('sha256'), fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(65536);
  try { let size; while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, size)); }
  finally { fs.closeSync(fd); }
  return digest.digest('hex');
}
function regularFile(file, label, max = 384 * 1024 * 1024) {
  let stat; try { stat = fs.lstatSync(file); } catch { throw new Error(`${label} is missing`); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > max) throw new Error(`${label} must be a bounded regular file`);
  return path.resolve(file);
}
function readJson(file, label, max) {
  regularFile(file, label, max);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`${label} must contain JSON`); }
}
function canonicalSource(root, sourcePath) {
  const canonicalRoot = fs.realpathSync(root), file = path.resolve(canonicalRoot, sourcePath);
  const relative = path.relative(canonicalRoot, file);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('Quarterly source escapes the tested checkout');
  regularFile(file, `Quarterly source ${sourcePath}`, 16 * 1024 * 1024);
  if (fs.realpathSync(file) !== file) throw new Error(`Quarterly source must not traverse symlinks: ${sourcePath}`);
  return { path: sourcePath, file, sha256: sha256(file) };
}
export function quarterlySourceInventory(root = ROOT) {
  return Object.fromEntries(QUARTERLY_PROVIDERS.map(provider => [provider,
    Object.fromEntries(Object.entries(SOURCE_PATHS[provider]).map(([kind, sourcePath]) => {
      const source = canonicalSource(root, sourcePath); return [kind, { path: source.path, sha256: source.sha256 }];
    }))]));
}
function adapter(root, provider) { return canonicalSource(root, SOURCE_PATHS[provider].subject).file; }
function pairKey(pair) { return `${pair.id}\0${pair.repetition}`; }
function plannedPairKey(pair) { return `${pair.scenario.id}\0${pair.repetition}`; }
function selectedPlan(fullPlan, shardIndex, shardCount) {
  const pairs = fullPlan.pairs.filter((_pair, index) => index % shardCount === shardIndex);
  if (!pairs.length) throw new Error('Quarterly comparison shard has no assigned pairs');
  return { ...fullPlan, pairs, call_counts: { subject: pairs.length * 2, judge: pairs.length, total: pairs.length * 3 } };
}
export function quarterlyShardPlan({ provider, model, judgeModel, seed, shardIndex, shardCount = QUARTERLY_SHARD_COUNT,
  scenarios = loadScenarios() } = {}) {
  if (!QUARTERLY_PROVIDERS.includes(provider) || !Number.isSafeInteger(shardIndex) || !Number.isSafeInteger(shardCount)
    || shardCount < 1 || shardCount > 64 || shardIndex < 0 || shardIndex >= shardCount) throw new Error('Invalid quarterly shard identity');
  const full = comparisonPlan(scenarios, { provider, model, judgeModel, n: 5, seed });
  return { full, selected: selectedPlan(full, shardIndex, shardCount) };
}
function writeShard(file, metadata, report) {
  const results = report.scenarios.flatMap(scenario => scenario.evidence);
  const shard = { schema: 'aiwg-quarterly-comparison-shard/v1', provider: metadata.provider,
    shard_index: metadata.shardIndex, shard_count: metadata.shardCount, full_plan: metadata.fullPlan,
    fixture_inputs: metadata.fixtureInputs, bundles: metadata.bundles, sources: metadata.sources,
    fixtures: report.fixtures, results };
  fs.writeFileSync(file, `${JSON.stringify(shard, null, 2)}\n`, { mode: 0o600 });
  return shard;
}
export function runQuarterlyShard({ root = ROOT, output, provider, model, judgeModel, seed, baselineVersion,
  candidateTarball, shardIndex, shardCount = QUARTERLY_SHARD_COUNT, bundles = QUARTERLY_BUNDLES,
  scenarios = loadScenarios(), prepare = prepareFixture, execute = executeComparison } = {}) {
  if (!path.isAbsolute(output ?? '') || !CALVER.test(baselineVersion ?? '') || !TOKEN.test(seed ?? '')
    || !same(bundles, QUARTERLY_BUNDLES)) throw new Error('Invalid quarterly shard configuration');
  candidateTarball = regularFile(candidateTarball, 'Quarterly candidate tarball', 256 * 1024 * 1024);
  const { full, selected } = quarterlyShardPlan({ provider, model, judgeModel, seed, shardIndex, shardCount, scenarios });
  const partial = path.join(path.dirname(output), `.${path.basename(output)}.${process.pid}.partial`);
  if (fs.existsSync(output) || fs.existsSync(partial)) throw new Error('Quarterly shard output already exists');
  const sourceAdapter = adapter(root, provider), sources = quarterlySourceInventory(root);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-quarterly-shard-'));
  try {
    const fixtureInputs = { A: `aiwg@${baselineVersion}`, B: `tarball:${candidateTarball}` };
    const fixtures = {
      A: prepare(fixtureInputs.A, { root: path.join(temporary, 'A'), provider, bundles, allowNetwork: true }),
      B: prepare(fixtureInputs.B, { root: path.join(temporary, 'B'), provider, bundles, allowNetwork: true }),
    };
    const metadata = { provider, shardIndex, shardCount, fullPlan: { version: full.version, provider: full.provider,
      model: full.model, judge_model: full.judge_model, n: full.n, seed: full.seed, corpus_digest: full.corpus_digest,
      call_counts: full.call_counts, planned_pairs: full.pairs.length }, fixtureInputs, bundles: [...bundles], sources };
    const checkpoint = report => writeShard(partial, metadata, report);
    const report = execute(selected, fixtures, { subject: runnerAdapter(sourceAdapter), judge: runnerAdapter(sourceAdapter), checkpoint });
    if (!same(sources, quarterlySourceInventory(root))) throw new Error('Quarterly comparison source changed during shard execution');
    const shard = writeShard(partial, metadata, report);
    if (report.completed_pairs !== selected.pairs.length || report.summary?.invalid !== 0) {
      throw new Error('Quarterly comparison shard is incomplete or invalid');
    }
    fs.copyFileSync(partial, output, fs.constants.COPYFILE_EXCL); fs.chmodSync(output, 0o600);
    return shard;
  } finally { fs.rmSync(partial, { force: true }); fs.rmSync(temporary, { recursive: true, force: true }); }
}

function validateValidation(file, commit) {
  const evidence = readJson(file, 'Quarterly full validation', 8 * 1024 * 1024);
  const keys = ['version', 'profile', 'commit', 'runner', 'node', 'lanes', 'pass'];
  if (!exactKeys(evidence, keys) || evidence.version !== 2 || evidence.profile !== 'quarterly-full-v1'
    || evidence.commit !== commit || evidence.pass !== true || typeof evidence.runner !== 'string' || !evidence.runner.trim()
    || typeof evidence.node !== 'string' || !evidence.node.trim() || !Array.isArray(evidence.lanes)
    || evidence.lanes.length !== RC_LANES.length) throw new Error('Quarterly full validation is incomplete');
  let startedAt = Infinity, completedAt = -Infinity;
  for (const lane of RC_LANES) {
    const matches = evidence.lanes.filter(item => exactKeys(item, ['lane', 'started_at', 'status', 'completed_at'])
      && item.lane === lane && item.status === 'success');
    if (matches.length !== 1) throw new Error(`Quarterly validation lane is missing or failed: ${lane}`);
    const started = parseTimestamp(matches[0].started_at, `${lane} start`), completed = parseTimestamp(matches[0].completed_at, `${lane} completion`);
    if (started > completed) throw new Error(`Quarterly validation lane has inverted timestamps: ${lane}`);
    startedAt = Math.min(startedAt, started); completedAt = Math.max(completedAt, completed);
  }
  return { evidence, startedAt, completedAt };
}
function validateRunMetadata(metadata, env, commit) {
  const runId = Number(env.GITHUB_RUN_ID), attempt = Number(env.GITHUB_RUN_ATTEMPT);
  if (!Number.isSafeInteger(runId) || runId < 1 || !Number.isSafeInteger(attempt) || attempt < 1
    || !exactKeys(metadata, ['id', 'workflow_id', 'run_attempt', 'head_sha', 'event', 'status', 'conclusion', 'path',
      'run_started_at', 'server_date', 'repository', 'head_repository'])
    || metadata.id !== runId || !Number.isSafeInteger(metadata.workflow_id) || metadata.workflow_id < 1
    || metadata.run_attempt !== attempt || metadata.head_sha !== commit || metadata.event !== 'workflow_dispatch'
    || metadata.status !== 'in_progress' || metadata.conclusion !== null
    || metadata.path !== QUARTERLY_WORKFLOW
    || metadata.repository?.full_name !== env.GITHUB_REPOSITORY || metadata.head_repository?.full_name !== env.GITHUB_REPOSITORY) {
    throw new Error('Authenticated GitHub run metadata does not match the quarterly producer');
  }
  return { runId, attempt, workflowId: metadata.workflow_id,
    startedAt: parseTimestamp(metadata.run_started_at, 'GitHub run start'), observedAt: parseTimestamp(metadata.server_date, 'GitHub server') };
}
function loadShards(directory, provider, fullPlan, model, judgeModel, seed, baselineVersion, candidateTarball, bundles, sources, shardCount) {
  const expectedNames = Array.from({ length: shardCount }, (_, index) => `${provider}-${String(index).padStart(2, '0')}.json`);
  const available = fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.startsWith(`${provider}-`)).map(entry => entry.name).sort();
  if (!same(available, expectedNames)) throw new Error(`Quarterly ${provider} shard inventory is incomplete`);
  const results = [], seen = new Set(); let fixtures = null;
  const expectedPlan = { version: fullPlan.version, provider, model, judge_model: judgeModel, n: 5, seed,
    corpus_digest: fullPlan.corpus_digest, call_counts: fullPlan.call_counts, planned_pairs: fullPlan.pairs.length };
  for (let index = 0; index < shardCount; index += 1) {
    const shard = readJson(path.join(directory, expectedNames[index]), `Quarterly ${provider} shard`, 384 * 1024 * 1024);
    const keys = ['schema', 'provider', 'shard_index', 'shard_count', 'full_plan', 'fixture_inputs', 'bundles', 'sources', 'fixtures', 'results'];
    if (!exactKeys(shard, keys) || shard.schema !== 'aiwg-quarterly-comparison-shard/v1' || shard.provider !== provider
      || shard.shard_index !== index || shard.shard_count !== shardCount || !same(shard.full_plan, expectedPlan)
      || shard.fixture_inputs?.A !== `aiwg@${baselineVersion}` || path.basename(String(shard.fixture_inputs?.B).replace(/^tarball:/, '')) !== path.basename(candidateTarball)
      || !same(shard.bundles, bundles) || !same(shard.sources, sources)
      || !Array.isArray(shard.results) || !shard.results.length) throw new Error(`Quarterly ${provider} shard identity is invalid`);
    if (fixtures === null) fixtures = shard.fixtures; else if (!same(fixtures, shard.fixtures)) throw new Error(`Quarterly ${provider} fixture identities differ across shards`);
    for (const pair of shard.results) {
      const key = pairKey(pair);
      if (seen.has(key)) throw new Error(`Quarterly ${provider} comparison pair is duplicated`);
      seen.add(key); results.push(pair);
    }
  }
  const expected = new Set(fullPlan.pairs.map(plannedPairKey));
  if (seen.size !== expected.size || [...seen].some(key => !expected.has(key))) throw new Error(`Quarterly ${provider} comparison coverage is incomplete`);
  return { results, fixtures };
}
function quarterAt(milliseconds) {
  const date = new Date(milliseconds), quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  return { id: `${date.getUTCFullYear()}-Q${quarter}`,
    from: new Date(Date.UTC(date.getUTCFullYear(), (quarter - 1) * 3, 1)).toISOString(),
    through: new Date(Date.UTC(date.getUTCFullYear(), quarter * 3, 1)).toISOString() };
}
function copyExact(source, destination) {
  regularFile(source, 'Quarterly artifact input');
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, 0o600);
}
export function assembleQuarterlyArtifact({ root = ROOT, output, validationFile, candidateTarball, shardsDirectory,
  baselineVersion, seed, models, runMetadata, env = process.env, completedAt = new Date().toISOString(),
  bundles = QUARTERLY_BUNDLES, shardCount = QUARTERLY_SHARD_COUNT, scenarios = loadScenarios(),
  verifyReport = verifyComparisonReport, gitCommit } = {}) {
  if (!path.isAbsolute(output ?? '') || fs.existsSync(output) || !path.isAbsolute(shardsDirectory ?? '')
    || !CALVER.test(baselineVersion ?? '') || !TOKEN.test(seed ?? '') || !same(bundles, QUARTERLY_BUNDLES)
    || !exactKeys(models, QUARTERLY_PROVIDERS) || QUARTERLY_PROVIDERS.some(provider => !exactKeys(models[provider], ['subject', 'judge'])
      || !TOKEN.test(models[provider].subject ?? '') || !TOKEN.test(models[provider].judge ?? '')
      || models[provider].subject.toLowerCase() === models[provider].judge.toLowerCase())) throw new Error('Invalid quarterly assembly configuration');
  const repository = env.GITHUB_REPOSITORY, commit = gitCommit;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !SHA.test(commit ?? '') || env.GITHUB_SHA !== commit
    || env.GITHUB_REF !== 'refs/heads/main') throw new Error('Quarterly producer must run at the exact main commit');
  const run = validateRunMetadata(runMetadata, env, commit);
  const validation = validateValidation(validationFile, commit);
  candidateTarball = regularFile(candidateTarball, 'Quarterly candidate tarball', 256 * 1024 * 1024);
  const packageVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const packageName = `aiwg-${packageVersion}.tgz`;
  if (!CALVER.test(packageVersion) || path.basename(candidateTarball) !== packageName) throw new Error('Quarterly candidate package identity is invalid');
  const candidate = { manifest: { package_version: packageVersion }, package_tarball: packageName,
    package_tarball_sha256: sha256(candidateTarball) };
  const completion = parseTimestamp(completedAt, 'quarterly completion');
  const quarter = quarterAt(run.observedAt);
  if (run.startedAt < Date.parse(quarter.from) || run.observedAt >= Date.parse(quarter.through)
    || run.startedAt > validation.startedAt || completion < validation.completedAt || completion > run.observedAt
    || quarterAt(completion).id !== quarter.id) throw new Error('Quarterly timestamps fall outside the authenticated current run and UTC quarter');
  const sources = quarterlySourceInventory(root);
  const expectedShards = QUARTERLY_PROVIDERS.flatMap(provider => Array.from({ length: shardCount }, (_unused, index) =>
    `${provider}-${String(index).padStart(2, '0')}.json`)).sort();
  const shardEntries = fs.readdirSync(shardsDirectory, { withFileTypes: true });
  if (shardEntries.some(entry => !entry.isFile()) || !same(shardEntries.map(entry => entry.name).sort(), expectedShards)) {
    throw new Error('Quarterly shard directory inventory is invalid');
  }
  const staging = fs.mkdtempSync(path.join(path.dirname(output), '.quarterly-comparison-'));
  try {
    const reportDigests = {};
    for (const provider of QUARTERLY_PROVIDERS) {
      const fullPlan = comparisonPlan(scenarios, { provider, model: models[provider].subject, judgeModel: models[provider].judge, n: 5, seed });
      const { results, fixtures } = loadShards(shardsDirectory, provider, fullPlan, models[provider].subject,
        models[provider].judge, seed, baselineVersion, candidateTarball, bundles, sources, shardCount);
      const report = { ...comparisonReport(fullPlan, results, fixtures), fixture_inputs: { A: `aiwg@${baselineVersion}`, B: `tarball:${candidateTarball}` },
        bundles: [...bundles], adapters: { subject: adapter(root, provider), judge: adapter(root, provider) } };
      const reportFile = path.join(staging, `${provider}.json`); fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
      const proof = verifyReport({ file: reportFile, report, plan: fullPlan, candidate, baselineVersion, expectedBundles: bundles });
      if (proof.provider !== provider || !Array.isArray(proof.regressions)) throw new Error(`Quarterly ${provider} comparison evidence is invalid`);
      reportDigests[provider] = sha256(reportFile);
    }
    copyExact(validationFile, path.join(staging, 'validation.json'));
    if (!same(sources, quarterlySourceInventory(root))) throw new Error('Quarterly comparison source changed during assembly');
    const manifest = { schema: 'aiwg-quarterly-comparison-attestation/v1', profile: 'quarterly-full-v1', repository,
      quarter: quarter.id, valid_from: quarter.from, valid_through: quarter.through, tested_commit: commit,
      workflow_id: run.workflowId, run_id: run.runId, run_attempt: run.attempt,
      started_at: new Date(validation.startedAt).toISOString(), completed_at: new Date(completion).toISOString(),
      package_version: packageVersion, package_tarball: packageName, package_tarball_sha256: candidate.package_tarball_sha256,
      validation_sha256: sha256(path.join(staging, 'validation.json')), reports: reportDigests, sources };
    fs.writeFileSync(path.join(staging, 'quarterly-attestation.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const expected = ['quarterly-attestation.json', 'validation.json', ...QUARTERLY_PROVIDERS.map(provider => `${provider}.json`)].sort();
    if (!same(fs.readdirSync(staging).sort(), expected)) throw new Error('Quarterly artifact staging inventory is invalid');
    fs.renameSync(staging, output);
    return manifest;
  } catch (error) { fs.rmSync(staging, { recursive: true, force: true }); throw error; }
}

export async function authenticatedRunMetadata(env = process.env, fetchImpl = fetch) {
  const repository = env.GITHUB_REPOSITORY, runId = Number(env.GITHUB_RUN_ID), token = env.GITHUB_TOKEN;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !Number.isSafeInteger(runId) || runId < 1 || typeof token !== 'string' || !token) {
    throw new Error('GitHub run metadata credentials are unavailable');
  }
  const response = await fetchImpl(`${env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${repository}/actions/runs/${runId}`, {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' }, redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  if (!response.ok || !String(response.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) throw new Error('Authenticated GitHub run metadata request failed');
  const data = await response.json();
  return { id: data.id, workflow_id: data.workflow_id, run_attempt: data.run_attempt, head_sha: data.head_sha,
    event: data.event, status: data.status, conclusion: data.conclusion, path: data.path,
    run_started_at: data.run_started_at, server_date: response.headers.get('date'),
    repository: { full_name: data.repository?.full_name }, head_repository: { full_name: data.head_repository?.full_name } };
}
function modelInputs(values) {
  return Object.fromEntries(QUARTERLY_PROVIDERS.map(provider => [provider,
    { subject: values[`${provider}-model`], judge: values[`${provider}-judge-model`] }]));
}
async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    output: { type: 'string' }, provider: { type: 'string' }, 'shard-index': { type: 'string' }, 'shard-count': { type: 'string' },
    baseline: { type: 'string' }, candidate: { type: 'string' }, seed: { type: 'string' }, validation: { type: 'string' }, shards: { type: 'string' },
    'claude-model': { type: 'string' }, 'claude-judge-model': { type: 'string' }, 'codex-model': { type: 'string' },
    'codex-judge-model': { type: 'string' }, 'hermes-model': { type: 'string' }, 'hermes-judge-model': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help || !['shard', 'assemble'].includes(positionals[0])) {
    console.log('Usage: quarterly-comparison-producer.mjs shard|assemble --output PATH --baseline VERSION --candidate FILE --seed ID --*-model ID --*-judge-model ID'); return;
  }
  const models = modelInputs(values);
  if (positionals[0] === 'shard') {
    const provider = values.provider;
    const result = runQuarterlyShard({ output: path.resolve(values.output ?? ''), provider, model: models[provider]?.subject,
      judgeModel: models[provider]?.judge, seed: values.seed, baselineVersion: values.baseline,
      candidateTarball: path.resolve(values.candidate ?? ''), shardIndex: Number(values['shard-index']), shardCount: Number(values['shard-count']) });
    console.log(JSON.stringify({ provider: result.provider, shard_index: result.shard_index, pairs: result.results.length })); return;
  }
  const metadata = await authenticatedRunMetadata();
  const commit = (await import('node:child_process')).spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
  if (commit.error || commit.status !== 0) throw new Error('Could not resolve tested commit');
  const manifest = assembleQuarterlyArtifact({ output: path.resolve(values.output ?? ''), validationFile: path.resolve(values.validation ?? ''),
    candidateTarball: path.resolve(values.candidate ?? ''), shardsDirectory: path.resolve(values.shards ?? ''), baselineVersion: values.baseline,
    seed: values.seed, models, runMetadata: metadata, gitCommit: commit.stdout.trim(), shardCount: Number(values['shard-count']) });
  console.log(JSON.stringify({ output: path.resolve(values.output), quarter: manifest.quarter, tested_commit: manifest.tested_commit }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
