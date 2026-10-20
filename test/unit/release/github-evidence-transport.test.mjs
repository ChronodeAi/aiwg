import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createGithubEvidenceTransport } from '../../../tools/release/github-evidence-transport.mjs';

const roots = [];
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-zip-')); roots.push(dir); return dir; };
afterEach(() => roots.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));
const extractor = path.resolve('tools/release/extract-release-archive.py');
function zip(mode) {
  const script = `import sys, zipfile\nz=zipfile.ZipFile(sys.stdout.buffer,'w',zipfile.ZIP_DEFLATED)\nmode=sys.argv[1]\nif mode=='duplicate':\n z.writestr('a','one'); z.writestr('a','two')\nelif mode=='symlink':\n i=zipfile.ZipInfo('link'); i.create_system=3; i.external_attr=0o120777<<16; z.writestr(i,'target')\nelif mode=='bomb':\n z.writestr('a',b'0'*(4*1024*1024))\nelif mode=='traversal':\n z.writestr('../outside','bad')\nelse:\n z.writestr('rc-manifest.json','{}'); z.writestr('aiwg.tgz','package')\nz.close()`;
  const output = spawnSync('python3', ['-c', script, mode], { maxBuffer: 8 * 1024 * 1024 });
  if (output.status !== 0) throw new Error(output.stderr.toString());
  return output.stdout;
}
function extract(bytes, root) { return spawnSync('python3', [extractor, root], { input: bytes, encoding: 'utf8' }); }
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

describe('authenticated GitHub release evidence transport', () => {
  it('pins source to the commit and paginates jobs for the exact attempt and approvals', async () => {
    const calls = [], commit = 'a'.repeat(40);
    const transport = createGithubEvidenceTransport({ token: 'secret', approvalIssue: 3201, fetchImpl: async (url, options) => {
      calls.push({ url, options }); const parsed = new URL(url);
      if (parsed.pathname.endsWith('/jobs')) return json({ total_count: 101, jobs: Array.from({ length: parsed.searchParams.get('page') === '1' ? 100 : 1 }, (_, i) => ({ id: i })) });
      if (parsed.pathname.endsWith('/comments')) return json([{ id: 1, user: { id: 3, login: 'operator' }, body: '{\"schema\":\"aiwg-release-comparison-approval/v1\"}' }, { id: 2, body: 'Ordinary issue comment' }]);
      return json({ type: 'file', path: '.github/workflows/release-candidate.yml', encoding: 'base64', content: Buffer.from('workflow').toString('base64') });
    } });
    expect((await transport.listJobs({ repository: 'owner/repo', runId: 11, attempt: 4 })).items).toHaveLength(101);
    expect(calls[0].url).toContain('/runs/11/attempts/4/jobs');
    expect((await transport.listApprovals({ repository: 'owner/repo' })).items[0].actor.id).toBe(3);
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
});
