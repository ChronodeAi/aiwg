import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createGithubEvidenceTransport } from '../../../tools/release/github-evidence-transport.mjs';
import { acquireGithubProductionComparisonReports } from '../../../tools/release/release-evidence.mjs';
import { RC_LANES } from '../../../tools/release/release-candidate.mjs';
import { createHash } from 'node:crypto';

const roots = [];
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-zip-')); roots.push(dir); return dir; };
afterEach(() => roots.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));
const extractor = path.resolve('tools/release/extract-release-archive.py');
function quarterlySources() {
  const identity = sourcePath => ({ path: sourcePath, sha256: fs.existsSync(sourcePath)
    ? createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex') : '8'.repeat(64) });
  return {
    claude: { subject: identity('tools/rules/release-compare-claude.mjs'), judge: identity('tools/rules/release-compare-claude.mjs') },
    codex: { subject: identity('tools/rules/release-compare-codex.mjs'), judge: identity('tools/rules/release-compare-codex.mjs'),
      runtime: identity('tools/rules/codex-evaluation-runtime.mjs'), parser: identity('tools/rules/run-rule-probes.mjs') },
    hermes: { subject: identity('tools/rules/release-compare-hermes.mjs'), judge: identity('tools/rules/release-compare-hermes.mjs') },
  };
}
function zip(mode) {
  const script = `import sys, zipfile\nz=zipfile.ZipFile(sys.stdout.buffer,'w',zipfile.ZIP_DEFLATED)\nmode=sys.argv[1]\nif mode=='duplicate':\n z.writestr('a','one'); z.writestr('a','two')\nelif mode=='symlink':\n i=zipfile.ZipInfo('link'); i.create_system=3; i.external_attr=0o120777<<16; z.writestr(i,'target')\nelif mode=='bomb':\n z.writestr('a',b'0'*(4*1024*1024))\nelif mode=='traversal':\n z.writestr('../outside','bad')\nelse:\n z.writestr('rc-manifest.json','{}'); z.writestr('aiwg.tgz','package')\nz.close()`;
  const output = spawnSync('python3', ['-c', script, mode], { timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 });
  if (output.status !== 0) throw new Error(output.stderr.toString());
  return output.stdout;
}
function comparisonZip({ testedCommit, workflowId, runId, mutateValidation, mutateManifest }) {
  const directory = temp(), reports = {};
  for (const provider of ['claude', 'codex', 'hermes']) {
    const bytes = JSON.stringify({ provider }); fs.writeFileSync(path.join(directory, `${provider}.json`), bytes);
    reports[provider] = createHash('sha256').update(bytes).digest('hex');
  }
  const validation = { version: 2, profile: 'quarterly-full-v1', commit: testedCommit,
    runner: 'quarterly-runner', node: process.version, pass: true,
    lanes: RC_LANES.map(lane => ({ lane, started_at: '2026-10-10T12:05:00.000Z', status: 'success', completed_at: '2026-10-10T12:50:00.000Z' })) };
  mutateValidation?.(validation);
  const validationBytes = JSON.stringify(validation); fs.writeFileSync(path.join(directory, 'validation.json'), validationBytes);
  const manifest = { schema: 'aiwg-quarterly-comparison-attestation/v1', profile: 'quarterly-full-v1', repository: 'jmagly/aiwg',
    quarter: '2026-Q4', valid_from: '2026-10-01T00:00:00.000Z', valid_through: '2027-01-01T00:00:00.000Z',
    tested_commit: testedCommit, workflow_id: workflowId, run_id: runId, run_attempt: 2,
    started_at: '2026-10-10T12:05:00Z', completed_at: '2026-10-10T12:55:00Z', package_version: '2026.10.3',
    package_tarball: 'aiwg-2026.10.3.tgz', package_tarball_sha256: '9'.repeat(64),
    validation_sha256: createHash('sha256').update(validationBytes).digest('hex'), reports, sources: quarterlySources() };
  mutateManifest?.(manifest);
  fs.writeFileSync(path.join(directory, 'quarterly-attestation.json'), JSON.stringify(manifest));
  const script = `import os,sys,zipfile\nz=zipfile.ZipFile(sys.stdout.buffer,'w',zipfile.ZIP_DEFLATED)\nfor n in os.listdir(sys.argv[1]): z.write(os.path.join(sys.argv[1],n),n)\nz.close()`;
  const output = spawnSync('python3', ['-c', script, directory], { timeout: 30000, killSignal: 'SIGKILL' });
  if (output.status !== 0) throw new Error(output.stderr.toString());
  return output.stdout;
}
function perReleaseZip() {
  const directory = temp();
  for (const provider of ['claude', 'codex', 'hermes']) fs.writeFileSync(path.join(directory, `${provider}.json`), JSON.stringify({ provider }));
  const script = `import os,sys,zipfile\nz=zipfile.ZipFile(sys.stdout.buffer,'w',zipfile.ZIP_DEFLATED)\nfor n in os.listdir(sys.argv[1]): z.write(os.path.join(sys.argv[1],n),n)\nz.close()`;
  const output = spawnSync('python3', ['-c', script, directory], { timeout: 30000, killSignal: 'SIGKILL' });
  if (output.status !== 0) throw new Error(output.stderr.toString());
  return output.stdout;
}
function extract(bytes, root) { return spawnSync('python3', [extractor, root], { input: bytes, encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' }); }
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: {
  'content-type': 'application/json', date: 'Tue, 20 Oct 2026 18:00:00 GMT',
} });
function comparisonFetch({ bytes, testedCommit, candidateCommit, workflowId, runId, artifactId,
  serverDate = 'Tue, 20 Oct 2026 18:00:00 GMT', runStartedAt = '2026-10-10T12:00:00Z', runCompletedAt = '2026-10-10T13:00:00Z' }) {
  const digest = createHash('sha256').update(bytes).digest('hex');
  const respond = (data, status = 200) => new Response(JSON.stringify(data), { status,
    headers: { 'content-type': 'application/json', date: serverDate } });
  return async url => {
    const pathname = new URL(url).pathname;
    if (pathname === '/user') return respond({ id: 77, login: 'release-evidence', type: 'User' });
    if (pathname.endsWith(`/actions/workflows/${workflowId}`)) return respond({ id: workflowId, path: '.github/workflows/release-comparison.yml' });
    if (pathname.endsWith(`/actions/runs/${runId}`)) return respond({ id: runId, workflow_id: workflowId, head_sha: testedCommit,
      status: 'completed', conclusion: 'success', run_attempt: 2, run_started_at: runStartedAt, updated_at: runCompletedAt });
    if (pathname.endsWith(`/actions/runs/${runId}/attempts/2/jobs`)) return respond({ total_count: 1,
      jobs: [{ name: 'Retain comparisons', run_id: runId, head_sha: testedCommit, status: 'completed', conclusion: 'success',
        steps: [{ name: 'Run comparisons', status: 'completed', conclusion: 'success' },
          { name: 'Retain comparison evidence', status: 'completed', conclusion: 'success' }] }] });
    if (pathname.endsWith(`/actions/artifacts/${artifactId}`)) return respond({ id: artifactId, expired: false,
      digest: `sha256:${digest}`, workflow_run: { id: runId, head_sha: testedCommit } });
    if (pathname.includes(`/compare/${testedCommit}...`)) {
      const requestedHead = pathname.split('...').at(-1);
      if (requestedHead !== candidateCommit) return respond({ status: 'diverged', ahead_by: 1, behind_by: 1,
        base_commit: { sha: testedCommit }, merge_base_commit: { sha: 'd'.repeat(40) }, commits: [{ sha: requestedHead }] });
      return respond({ status: 'ahead', ahead_by: 400, behind_by: 0,
        base_commit: { sha: testedCommit }, merge_base_commit: { sha: testedCommit },
        commits: [...Array.from({ length: 249 }, () => ({ sha: 'e'.repeat(40) })), { sha: candidateCommit }] });
    }
    if (pathname.endsWith(`/actions/artifacts/${artifactId}/zip`)) return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
    return respond({}, 404);
  };
}

describe('authenticated GitHub release evidence transport', () => {
  it('pins source to the commit and paginates jobs for the exact attempt and approvals', async () => {
    const calls = [], commit = 'a'.repeat(40);
    const transport = createGithubEvidenceTransport({ token: 'secret', approvalIssue: 3201, fetchImpl: async (url, options) => {
      calls.push({ url, options }); const parsed = new URL(url);
      if (parsed.pathname.endsWith('/jobs')) return json({ total_count: 101, jobs: Array.from({ length: parsed.searchParams.get('page') === '1' ? 100 : 1 }, (_, i) => ({ id: i })) });
      if (parsed.pathname.endsWith('/comments')) return json([{ id: 1, user: { id: 3, login: 'operator' }, body: '{\"schema\":\"aiwg-release-comparison-approval/v1\"}' }, { id: 2, body: 'Ordinary issue comment' }, { id: 4, user: { id: 3, login: 'operator' }, body: '{\"schema\":\"aiwg-stable-release-approval/v1\"}' }]);
      return json({ type: 'file', path: '.github/workflows/release-candidate.yml', encoding: 'base64', content: Buffer.from('workflow').toString('base64') });
    } });
    expect((await transport.listJobs({ repository: 'owner/repo', runId: 11, attempt: 4 })).items).toHaveLength(101);
    expect(calls[0].url).toContain('/runs/11/attempts/4/jobs');
    const approvals = await transport.listApprovals({ repository: 'owner/repo' });
    expect(approvals.items[0].actor.id).toBe(3);
    expect(approvals.items.map(item => item.id)).toEqual([1, 4]);
    expect((await transport.getWorkflowSource({ repository: 'owner/repo', path: '.github/workflows/release-candidate.yml', commit })).content).toBe('workflow');
    expect(calls.at(-1).url).toContain(`ref=${commit}`);
    await expect(transport.getWorkflowSource({ repository: 'owner/repo', path: '.github/workflows/release-candidate.yml', commit: 'main' })).rejects.toThrow();
  });
  it('rejects incomplete pagination', async () => {
    const transport = createGithubEvidenceTransport({ token: 'secret', approvalIssue: 1, fetchImpl: async () => json({ total_count: 2, jobs: [{}] }) });
    await expect(transport.listJobs({ repository: 'owner/repo', runId: 1, attempt: 1 })).rejects.toThrow(/Incomplete/);
  });
  it('never forwards credentials to the artifact redirect and rejects untrusted redirects', async () => {
    const requests = [], root = temp();
    const transport = createGithubEvidenceTransport({ token: 'secret', approvalIssue: 1, fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return requests.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://objects.githubusercontent.com/archive' } }) : new Response('archive');
    } });
    const result = await transport.downloadArtifact({ repository: 'owner/repo', artifactId: 4, destination: root });
    expect(fs.readFileSync(result.archivePath, 'utf8')).toBe('archive');
    expect(requests[0].options.headers.Authorization).toBe('Bearer secret');
    expect(requests[1].options.headers.Authorization).toBeUndefined();
    const bad = createGithubEvidenceTransport({ token: 'secret', approvalIssue: 1, fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/archive' } }) });
    await expect(bad.downloadArtifact({ repository: 'owner/repo', artifactId: 4, destination: root })).rejects.toThrow(/Untrusted/);
  });
  it('extracts ordinary files and rejects traversal, duplicates, symlinks and expansion bombs', () => {
    const root = temp(), good = path.join(root, 'good'); fs.mkdirSync(good);
    expect(extract(zip('ok'), good).status).toBe(0);
    expect(fs.readFileSync(path.join(good, 'aiwg.tgz'), 'utf8')).toBe('package');
    for (const kind of ['traversal', 'duplicate', 'symlink', 'bomb']) {
      const destination = path.join(root, kind); fs.mkdirSync(destination);
      expect(extract(zip(kind), destination).status, kind).not.toBe(0);
      expect(fs.readdirSync(destination)).toEqual([]);
    }
    expect(fs.existsSync(path.join(root, 'outside'))).toBe(false);
  });
  it('binds a current-quarter full-validation comparison to its tested ancestor and a distinct candidate', async () => {
    const root = temp(), testedCommit = 'a'.repeat(40), candidateCommit = 'b'.repeat(40), workflowId = 74, runId = 55, artifactId = 66;
    const bytes = comparisonZip({ testedCommit, workflowId, runId });
    const fetchImpl = comparisonFetch({ bytes, testedCommit, candidateCommit, workflowId, runId, artifactId });
    const receipt = await acquireGithubProductionComparisonReports({ token: 'dedicated-user-token', approvalIssue: 3201,
      repository: 'jmagly/aiwg', workflowId, runId, artifactId, candidateCommit, destination: root,
      requiredJobName: 'Retain comparisons', requiredSteps: ['Run comparisons', 'Retain comparison evidence'], fetchImpl });
    expect(receipt.apiCaller.id).toBe(77);
    expect(receipt.run).toEqual({ id: runId, attempt: 2, commit: testedCommit,
      started_at: '2026-10-10T12:00:00Z', completed_at: '2026-10-10T13:00:00Z', job: 'Retain comparisons',
      steps: ['Run comparisons', 'Retain comparison evidence'] });
    expect(receipt.ancestry).toMatchObject({ tested_commit: testedCommit, candidate_commit: candidateCommit, relation: 'ancestor' });
    expect(receipt.validation.lanes).toEqual(RC_LANES);
    expect(receipt.reportFiles.map(file => path.basename(file))).toEqual(['claude.json', 'codex.json', 'hermes.json']);
    await expect(acquireGithubProductionComparisonReports({ token: 'dedicated-user-token', approvalIssue: 3201,
      repository: 'jmagly/aiwg', workflowId, runId, artifactId, candidateCommit: 'c'.repeat(40), destination: temp(),
      requiredJobName: 'Retain comparisons', requiredSteps: ['Run comparisons', 'Retain comparison evidence'], fetchImpl }))
      .rejects.toThrow(/not an ancestor/);
  });
  it('rejects stale/future attestations, incomplete full validation, and digest drift', async () => {
    const testedCommit = '1'.repeat(40), candidateCommit = '2'.repeat(40), workflowId = 81, runId = 82, artifactId = 83;
    const acquire = async (bytes, transport = {}) => acquireGithubProductionComparisonReports({ token: 'dedicated-user-token', approvalIssue: 3201,
      repository: 'jmagly/aiwg', workflowId, runId, artifactId, candidateCommit, destination: temp(),
      requiredJobName: 'Retain comparisons', requiredSteps: ['Run comparisons', 'Retain comparison evidence'],
      fetchImpl: comparisonFetch({ bytes, testedCommit, candidateCommit, workflowId, runId, artifactId, ...transport }) });

    const stale = comparisonZip({ testedCommit, workflowId, runId });
    await expect(acquire(stale, { serverDate: 'Fri, 01 Jan 2027 00:00:01 GMT' })).rejects.toThrow(/UTC quarter/);
    await expect(acquire(stale, { serverDate: 'Mon, 20 Oct 2026 18:00:00 GMT' })).rejects.toThrow(/Invalid UTC quarter timestamp/);

    const leapDay = comparisonZip({ testedCommit, workflowId, runId,
      mutateValidation: validation => { for (const lane of validation.lanes) {
        lane.started_at = '2028-02-29T12:05:00Z'; lane.completed_at = '2028-02-29T12:50:00Z';
      } },
      mutateManifest: manifest => Object.assign(manifest, { quarter: '2028-Q1', valid_from: '2028-01-01T00:00:00.000Z',
        valid_through: '2028-04-01T00:00:00.000Z', started_at: '2028-02-29T12:05:00Z', completed_at: '2028-02-29T12:55:00Z' }) });
    await expect(acquire(leapDay, { serverDate: 'Tue, 29 Feb 2028 18:00:00 GMT',
      runStartedAt: '2028-02-29T12:00:00Z', runCompletedAt: '2028-02-29T13:00:00Z' })).resolves.toMatchObject({ quarter: { id: '2028-Q1' } });

    const future = comparisonZip({ testedCommit, workflowId, runId,
      mutateManifest: manifest => { manifest.completed_at = '2026-10-10T13:00:01Z'; } });
    await expect(acquire(future)).rejects.toThrow(/authenticated run or UTC quarter/);

    const impossibleAttestationDate = comparisonZip({ testedCommit, workflowId, runId,
      mutateManifest: manifest => { manifest.started_at = '2026-11-31T12:05:00Z'; } });
    await expect(acquire(impossibleAttestationDate)).rejects.toThrow(/Invalid quarterly validation start timestamp/);

    const incomplete = comparisonZip({ testedCommit, workflowId, runId,
      mutateValidation: validation => { validation.lanes = validation.lanes.slice(1); } });
    await expect(acquire(incomplete)).rejects.toThrow(/validation profile is incomplete/);

    const digestDrift = comparisonZip({ testedCommit, workflowId, runId,
      mutateManifest: manifest => { manifest.validation_sha256 = '0'.repeat(64); } });
    await expect(acquire(digestDrift)).rejects.toThrow(/attestation does not match/);

    const laneOutsideAttestation = comparisonZip({ testedCommit, workflowId, runId,
      mutateValidation: validation => { validation.lanes[0].completed_at = '2026-10-10T12:56:00Z'; } });
    await expect(acquire(laneOutsideAttestation)).rejects.toThrow(/lane is missing or failed/);

    const impossibleLaneDate = comparisonZip({ testedCommit, workflowId, runId,
      mutateValidation: validation => { validation.lanes[0].completed_at = '2026-11-31T12:50:00Z'; } });
    await expect(acquire(impossibleLaneDate)).rejects.toThrow(/Invalid .* completion timestamp/);

    const escapedSource = comparisonZip({ testedCommit, workflowId, runId,
      mutateManifest: manifest => { manifest.sources.claude.subject.path = '../release-compare-claude.mjs'; } });
    await expect(acquire(escapedSource)).rejects.toThrow(/source identity is invalid/);
  });
  it('retains explicit per-release compatibility only for reports from the exact candidate commit', async () => {
    const testedCommit = '3'.repeat(40), workflowId = 91, runId = 92, artifactId = 93, bytes = perReleaseZip();
    const fetchImpl = comparisonFetch({ bytes, testedCommit, candidateCommit: testedCommit, workflowId, runId, artifactId });
    const receipt = await acquireGithubProductionComparisonReports({ token: 'dedicated-user-token', approvalIssue: 3201,
      repository: 'jmagly/aiwg', workflowId, runId, artifactId, candidateCommit: testedCommit, destination: temp(),
      requiredJobName: 'Retain comparisons', requiredSteps: ['Run comparisons', 'Retain comparison evidence'], mode: 'per-release', fetchImpl });
    expect(receipt.mode).toBe('per-release');
    expect(receipt.reportFiles.map(file => path.basename(file))).toEqual(['claude.json', 'codex.json', 'hermes.json']);
    await expect(acquireGithubProductionComparisonReports({ token: 'dedicated-user-token', approvalIssue: 3201,
      repository: 'jmagly/aiwg', workflowId, runId, artifactId, candidateCommit: '4'.repeat(40), destination: temp(),
      requiredJobName: 'Retain comparisons', requiredSteps: ['Run comparisons', 'Retain comparison evidence'], mode: 'per-release', fetchImpl }))
      .rejects.toThrow(/exact release candidate/);
  });
});
