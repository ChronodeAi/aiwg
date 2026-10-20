import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
vi.mock('../../../src/artifacts/framework-index-paths.js', () => ({ resolveFrameworkIndexRoot: (root: string) => root, resolveFrameworkCorpusRoot: (root: string) => root }));
vi.mock('../../../src/artifacts/framework-source-digest.js', () => ({ frameworkSourceDigest: () => 'source-digest' }));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prebuilt-deploy-test-'));
const manifestPath = path.join(root, 'manifest.json');
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

vi.mock('../../../src/artifacts/relations.js', () => ({ selectPrebuiltRelations: vi.fn() }));
vi.mock('../../../src/artifacts/fortemi-core-sync.js', () => ({ getFortemiCorePrebuiltStatus: vi.fn() }));
vi.mock('../../../src/artifacts/fortemi-core-query-adapter.js', () => ({ loadFortemiCoreMetadataEntries: vi.fn() }));
import { selectPrebuiltRelations } from '../../../src/artifacts/relations.js';
import { getFortemiCorePrebuiltStatus } from '../../../src/artifacts/fortemi-core-sync.js';
import { loadFortemiCoreMetadataEntries } from '../../../src/artifacts/fortemi-core-query-adapter.js';
import { loadPrebuiltDeploymentIndex } from '../../../src/artifacts/prebuilt-deployment.js';

const relations = vi.mocked(selectPrebuiltRelations);
const status = vi.mocked(getFortemiCorePrebuiltStatus);
const entries = vi.mocked(loadFortemiCoreMetadataEntries);

describe('packaged deployment index selection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1' }));
    const stats = JSON.stringify({ version: '1', totalArtifacts: 2, byType: { skill: 1, rule: 1 }, builtAt: '1970-01-01T00:00:00.000Z' });
    fs.writeFileSync(path.join(root, 'source-stats.json'), stats);
    fs.writeFileSync(manifestPath, JSON.stringify({ package_version: '1', source_digest: 'source-digest', source_stats_checksum: createHash('sha256').update(stats).digest('hex') }));
    relations.mockReturnValue({ reader: {} as never });
    status.mockReturnValue({ built: true, stale: false, generatedAt: '1970-01-01T00:00:00.000Z', itemCount: 2, manifestPath } as never);
    entries.mockReturnValue({ entries: [{ path: 'agentic/code/frameworks/sdlc-complete/skills/a', type: 'skill' }, { path: 'agentic/code/frameworks/sdlc-complete/rules/a', type: 'rule' }] as never });
  });
  it('derives the complete inventory and bundle paths from the validated export', () => {
    const result = loadPrebuiltDeploymentIndex(root);
    expect(result?.stats).toMatchObject({ totalArtifacts: 2, byType: { skill: 1, rule: 1 }, builtAt: '1970-01-01T00:00:00.000Z' });
    expect(Object.keys(result!.index.entries)).toHaveLength(2);
  });
  it('rejects a stale source digest or corrupted relationship tables', () => {
    relations.mockReturnValue({ reader: null, reason: 'source digest differs' });
    expect(loadPrebuiltDeploymentIndex(root)).toBeNull();
    expect(status).not.toHaveBeenCalled();
  });
  it('rejects mismatched or missing export source identity', () => {
    fs.writeFileSync(manifestPath, JSON.stringify({ package_version: '1', source_digest: 'old' }));
    expect(loadPrebuiltDeploymentIndex(root)).toBeNull();
    fs.writeFileSync(manifestPath, '{}');
    expect(loadPrebuiltDeploymentIndex(root)).toBeNull();
  });
  it('rejects a tampered statistics payload', () => {
    fs.appendFileSync(path.join(root, 'source-stats.json'), ' ');
    expect(loadPrebuiltDeploymentIndex(root)).toBeNull();
  });
  it('rejects a stale export, wrong count, or duplicate paths', () => {
    status.mockReturnValueOnce({ built: true, stale: true } as never);
    expect(loadPrebuiltDeploymentIndex(root)).toBeNull();
    entries.mockReturnValueOnce({ entries: [{ path: 'same', type: 'skill' }, { path: 'same', type: 'rule' }] as never });
    expect(loadPrebuiltDeploymentIndex(root)).toBeNull();
    entries.mockReturnValueOnce({ entries: [{ path: 'one', type: 'skill' }] as never });
    expect(loadPrebuiltDeploymentIndex(root)).toBeNull();
  });
});
