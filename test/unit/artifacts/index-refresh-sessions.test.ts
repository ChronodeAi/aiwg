import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultDiscoveryManifestPath, discoverWorkspaceHistories, readDiscoveryManifest, writeDiscoveryManifest,
} from '../../../src/sessions/workspace-discovery.js';
import { refreshSessionCatalog, sessionRefreshAvailable } from '../../../src/sessions/refresh.js';
import { acquireImportLease } from '../../../src/sessions/import-lease.js';

const mocks = vi.hoisted(() => ({
  prior: vi.fn(), reindex: vi.fn(), close: vi.fn(), importBatch: vi.fn(), feature: vi.fn(),
}));
vi.mock('../../../src/sessions/repository.js', () => ({
  SessionRepository: class {
    getBatchImportRunForManifest = mocks.prior;
    reindex = mocks.reindex;
    close = mocks.close;
  },
}));
vi.mock('../../../src/sessions/batch-import.js', () => ({ importDiscoveryManifest: mocks.importBatch }));
vi.mock('../../../src/features/runtime.js', () => ({ requireFeaturePackage: mocks.feature }));

let root: string;
let workspace: string;
let authorized: string;
let database: string;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prior.mockReturnValue(null);
  mocks.importBatch.mockResolvedValue({ run: { status: 'complete' }, totals: { rejected: 0, pending: 0 } });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-refresh-sessions-'));
  workspace = path.join(root, 'workspace');
  authorized = path.join(root, 'authorized');
  database = path.join(workspace, '.aiwg/sessions/catalog.sqlite');
  fs.mkdirSync(path.dirname(database), { recursive: true });
  fs.mkdirSync(authorized);
  fs.writeFileSync(database, 'existing catalog');
  fs.writeFileSync(path.join(authorized, 'one.jsonl'), JSON.stringify({
    type: 'user', sessionId: 'one', cwd: workspace, message: { role: 'user', content: 'hello' },
  }) + '\n');
  vi.stubEnv('HOME', path.join(root, 'home'));
  vi.stubEnv('XDG_DATA_HOME', path.join(root, 'data'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

async function saveAuthorization(file = defaultDiscoveryManifestPath(workspace), providerRoot = authorized): Promise<void> {
  const manifest = await discoverWorkspaceHistories({
    workspace, expectedProviders: ['claude'], authorizedRoots: { claude: [providerRoot] },
  });
  await writeDiscoveryManifest(file, manifest);
}

function configureManifests(files: string[]): void {
  fs.writeFileSync(path.join(workspace, '.aiwg/aiwg.config'), JSON.stringify({
    sessions: { discovery_manifests: files },
  }));
}

describe('session refresh integration boundaries', () => {
  it.each([
    [{}, { maxRecordBytes: 67108864, maxTotalBytes: 2147483648, limitOrigins: { maxRecordBytes: 'default', maxTotalBytes: 'default' } }],
    [{ maxRecordBytes: '4096', maxSourceBytes: '0' }, { maxRecordBytes: 4096, maxTotalBytes: 0, limitOrigins: { maxRecordBytes: 'flag', maxTotalBytes: 'flag' } }],
  ])('threads resolved import limits into refresh imports (%j)', async (flags, expected) => {
    await saveAuthorization();
    await refreshSessionCatalog(workspace, false, 0, undefined, [], flags);
    expect(mocks.importBatch.mock.calls[0][0].limits).toEqual(expected);
  });

  it('uses workspace import config and lets flags override individual limits', async () => {
    await saveAuthorization();
    fs.writeFileSync(path.join(workspace, '.aiwg/aiwg.config'), JSON.stringify({
      sessions: { import: { max_record_bytes: 1024, max_source_bytes: 8192 } },
    }));
    await refreshSessionCatalog(workspace, false, 0);
    expect(mocks.importBatch.mock.calls[0][0].limits).toEqual({
      maxRecordBytes: 1024, maxTotalBytes: 8192,
      limitOrigins: { maxRecordBytes: 'config', maxTotalBytes: 'config' },
    });
    await refreshSessionCatalog(workspace, false, 0, undefined, [], { maxSourceBytes: '0' });
    expect(mocks.importBatch.mock.calls[1][0].limits).toEqual({
      maxRecordBytes: 1024, maxTotalBytes: 0,
      limitOrigins: { maxRecordBytes: 'config', maxTotalBytes: 'flag' },
    });
  });

  it('passes env limits ahead of config to session refresh and lets flags override them', async () => {
    await saveAuthorization();
    fs.writeFileSync(path.join(workspace, '.aiwg/aiwg.config'), JSON.stringify({
      sessions: { import: { max_record_bytes: 1024, max_source_bytes: 8192 } },
    }));
    vi.stubEnv('AIWG_SESSIONS_IMPORT_MAX_RECORD_BYTES', '2048');
    vi.stubEnv('AIWG_SESSIONS_IMPORT_MAX_SOURCE_BYTES', '16384');
    await refreshSessionCatalog(workspace, false, 0);
    expect(mocks.importBatch.mock.calls[0][0].limits).toEqual({
      maxRecordBytes: 2048, maxTotalBytes: 16384,
      limitOrigins: { maxRecordBytes: 'env', maxTotalBytes: 'env' },
    });
    await refreshSessionCatalog(workspace, false, 0, undefined, [], { maxSourceBytes: '0' });
    expect(mocks.importBatch.mock.calls[1][0].limits).toEqual({
      maxRecordBytes: 2048, maxTotalBytes: 0,
      limitOrigins: { maxRecordBytes: 'env', maxTotalBytes: 'flag' },
    });
  });

  it.each(['MAX_RECORD_BYTES', 'MAX_SOURCE_BYTES'])('rejects invalid env %s before session refresh', async setting => {
    vi.stubEnv(`AIWG_SESSIONS_IMPORT_${setting}`, 'invalid');
    await expect(refreshSessionCatalog(workspace, false, 0)).rejects.toThrow(/env.*safe integer/);
    expect(mocks.importBatch).not.toHaveBeenCalled();
  });

  it('discovers new files only within saved authorized roots and confirms the exact saved manifest under the import lease', async () => {
    await saveAuthorization();
    fs.writeFileSync(path.join(authorized, 'two.jsonl'), JSON.stringify({
      type: 'user', sessionId: 'two', cwd: workspace, message: { role: 'user', content: 'second' },
    }) + '\n');
    mocks.importBatch.mockImplementationOnce(async ({ manifest }) => {
      expect(fs.existsSync(`${database}.import.lock`)).toBe(true);
      expect(await readDiscoveryManifest(defaultDiscoveryManifestPath(workspace))).toEqual(manifest);
      return { totals: { rejected: 0, pending: 0 } };
    });
    expect(await refreshSessionCatalog(workspace, false, 0)).toEqual({ totals: { rejected: 0, pending: 0 } });
    const imported = mocks.importBatch.mock.calls[0][0].manifest;
    expect(imported.sources).toHaveLength(2);
    expect(imported.authorizedRoots).toEqual({ claude: [authorized] });
    expect(fs.existsSync(`${database}.import.lock`)).toBe(false);
    expect(mocks.close).toHaveBeenCalledOnce();

    mocks.prior.mockReturnValue({ status: 'complete' });
    const before = fs.readFileSync(defaultDiscoveryManifestPath(workspace), 'utf8');
    expect(await refreshSessionCatalog(workspace, false, 0)).toBe('unchanged');
    expect(mocks.importBatch).toHaveBeenCalledOnce();
    expect(fs.readFileSync(defaultDiscoveryManifestPath(workspace), 'utf8')).toBe(before);
  });

  it('skips catalogs with no saved authorization without accessing provider homes', async () => {
    expect(await refreshSessionCatalog(workspace, false, 0)).toBe('no authorized discovery manifest');
    expect(mocks.importBatch).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(fs.existsSync(defaultDiscoveryManifestPath(workspace))).toBe(false);
  });

  it('refreshes a configured non-default manifest without creating a default manifest', async () => {
    const saved = path.join(root, 'custom-manifest.json');
    await saveAuthorization(saved);
    configureManifests([saved]);
    fs.writeFileSync(path.join(authorized, 'two.jsonl'), JSON.stringify({
      type: 'user', sessionId: 'two', cwd: workspace, message: { role: 'user', content: 'second' },
    }) + '\n');
    mocks.importBatch.mockImplementationOnce(async ({ manifest }) => {
      expect(fs.existsSync(`${database}.import.lock`)).toBe(true);
      expect(await readDiscoveryManifest(saved)).toEqual(manifest);
      expect(manifest.sources).toHaveLength(2);
      return { totals: { rejected: 0, pending: 0 } };
    });
    expect(await refreshSessionCatalog(workspace, false, 0)).toEqual({ totals: { rejected: 0, pending: 0 } });
    expect(mocks.importBatch).toHaveBeenCalledOnce();
    expect(fs.existsSync(defaultDiscoveryManifestPath(workspace))).toBe(false);
  });

  it('refreshes default and configured manifests once each with workspace-relative paths', async () => {
    await saveAuthorization();
    const otherRoot = path.join(root, 'other-authorized');
    fs.mkdirSync(otherRoot);
    fs.writeFileSync(path.join(otherRoot, 'two.jsonl'), JSON.stringify({
      type: 'user', sessionId: 'two', cwd: workspace, message: { role: 'user', content: 'second' },
    }) + '\n');
    const saved = path.join(workspace, 'custom.json');
    await saveAuthorization(saved, otherRoot);
    configureManifests(['custom.json', saved, defaultDiscoveryManifestPath(workspace)]);
    const complete = { run: { status: 'complete', manifestId: 'default' }, totals: { rejected: 0, pending: 0 } };
    const partial = { run: { status: 'partial', manifestId: 'custom', sources: [{ status: 'rejected',
      errorCode: 'MALFORMED_SOURCE',
    }] }, totals: { rejected: 1, pending: 0 } };
    mocks.importBatch.mockResolvedValueOnce(complete).mockResolvedValueOnce(partial);
    expect(await refreshSessionCatalog(workspace, false, 0)).toEqual([complete, partial]);
    expect(mocks.importBatch).toHaveBeenCalledTimes(2);
    expect(mocks.importBatch.mock.calls.map(([{ manifest }]) => manifest.authorizedRoots))
      .toEqual([{ claude: [authorized] }, { claude: [otherRoot] }]);

    mocks.importBatch.mockClear();
    mocks.prior.mockReturnValueOnce({ status: 'complete' }).mockReturnValue(null);
    expect(await refreshSessionCatalog(workspace, false, 0)).toEqual({
      run: { status: 'complete' }, totals: { rejected: 0, pending: 0 },
    });
    expect(mocks.importBatch).toHaveBeenCalledOnce();
    expect(mocks.importBatch.mock.calls[0][0].manifest.authorizedRoots).toEqual({ claude: [otherRoot] });

    mocks.prior.mockReturnValue({ status: 'complete' });
    expect(await refreshSessionCatalog(workspace, false, 0)).toBe('unchanged');
    expect(mocks.importBatch).toHaveBeenCalledOnce();
  });

  it.each([{}, { claude: [] }])('skips manifests without authorized provider roots (%j)', async authorizedRoots => {
    const manifest = await discoverWorkspaceHistories({ workspace, expectedProviders: ['claude'], authorizedRoots });
    await writeDiscoveryManifest(defaultDiscoveryManifestPath(workspace), manifest);
    expect(await refreshSessionCatalog(workspace, false, 0)).toBe('no authorized provider roots');
    expect(mocks.importBatch).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();

    const saved = path.join(workspace, 'custom.json');
    await saveAuthorization(saved);
    configureManifests(['custom.json']);
    expect(await refreshSessionCatalog(workspace, false, 0)).toEqual({
      run: { status: 'complete' }, totals: { rejected: 0, pending: 0 },
    });
    expect(mocks.importBatch).toHaveBeenCalledOnce();
  });

  it.each(['pending', 'operational'])('propagates a later manifest import failure (%s) and releases the lease', async failure => {
    await saveAuthorization();
    const otherRoot = path.join(root, 'other-authorized');
    fs.mkdirSync(otherRoot);
    await saveAuthorization(path.join(workspace, 'custom.json'), otherRoot);
    configureManifests(['custom.json']);
    mocks.importBatch.mockResolvedValueOnce({ run: { status: 'complete' }, totals: { rejected: 0, pending: 0 } });
    if (failure === 'pending') mocks.importBatch.mockResolvedValueOnce({ totals: { rejected: 0, pending: 1 } });
    else mocks.importBatch.mockRejectedValueOnce(new Error('catalog write failed'));
    await expect(refreshSessionCatalog(workspace, false, 0))
      .rejects.toThrow(failure === 'pending' ? '1 pending' : 'catalog write failed');
    expect(mocks.importBatch).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(`${database}.import.lock`)).toBe(false);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('reports no manifest when configured files and the default are missing', async () => {
    configureManifests(['missing.json']);
    expect(await refreshSessionCatalog(workspace, false, 0)).toBe('no authorized discovery manifest');
    expect(mocks.importBatch).not.toHaveBeenCalled();
  });

  it('rejects a configured manifest belonging to another workspace before importing any batch', async () => {
    await saveAuthorization();
    const other = path.join(root, 'other');
    fs.mkdirSync(other);
    const manifest = await discoverWorkspaceHistories({
      workspace: other, expectedProviders: ['claude'], authorizedRoots: { claude: [authorized] },
    });
    const saved = path.join(root, 'wrong-workspace.json');
    await writeDiscoveryManifest(saved, manifest);
    configureManifests([saved]);
    await expect(refreshSessionCatalog(workspace, false, 0)).rejects.toThrow('discovery manifest workspace mismatch');
    expect(mocks.importBatch).not.toHaveBeenCalled();
  });

  it('rejects a saved root redirected through a symlink without importing', async () => {
    await saveAuthorization();
    const elsewhere = path.join(root, 'elsewhere');
    fs.renameSync(authorized, elsewhere);
    fs.symlinkSync(elsewhere, authorized, 'dir');
    await expect(refreshSessionCatalog(workspace, false, 0)).rejects.toThrow('previously authorized provider root changed');
    expect(mocks.importBatch).not.toHaveBeenCalled();
  });

  it('accepts logical workspace aliases without authorizing their provider project roots', async () => {
    await saveAuthorization();
    const alias = path.join(root, 'logical-workspace');
    fs.symlinkSync(workspace, alias, 'dir');
    fs.writeFileSync(path.join(authorized, 'logical.jsonl'), JSON.stringify({
      type: 'user', sessionId: 'logical', cwd: alias,
    }) + '\n');
    const unauthorized = path.join(process.env.HOME!, '.claude/projects', alias.replace(/[^A-Za-z0-9-]/g, '-'));
    fs.mkdirSync(unauthorized, { recursive: true });
    fs.writeFileSync(path.join(unauthorized, 'outside.jsonl'), '{}\n');
    expect(await refreshSessionCatalog(workspace, false, 0, undefined, [alias])).toEqual({
      run: { status: 'complete' }, totals: { rejected: 0, pending: 0 },
    });
    const imported = mocks.importBatch.mock.calls[0][0].manifest;
    expect(imported.sources).toHaveLength(2);
    expect(imported.authorizedRoots).toEqual({ claude: [authorized] });
    expect(imported.sources.every((source: { authorizedRoot: string }) => source.authorizedRoot === authorized)).toBe(true);
    await expect(refreshSessionCatalog(workspace, false, 0, undefined, [authorized]))
      .rejects.toThrow('workspace alias resolves to a different workspace');
    expect(mocks.importBatch).toHaveBeenCalledOnce();
  });

  it('passes logical workspace aliases to every configured manifest without expanding authorization', async () => {
    const alias = path.join(root, 'logical-workspace');
    fs.symlinkSync(workspace, alias, 'dir');
    const files = ['first.json', 'second.json'];
    const roots = files.map((_, index) => path.join(root, `authorized-${index}`));
    for (const [index, file] of files.entries()) {
      fs.mkdirSync(roots[index]);
      fs.writeFileSync(path.join(roots[index], 'logical.jsonl'), JSON.stringify({
        type: 'user', sessionId: `logical-${index}`, cwd: alias,
      }) + '\n');
      await saveAuthorization(path.join(workspace, file), roots[index]);
    }
    configureManifests(files);
    const result = await refreshSessionCatalog(workspace, false, 0, undefined, [alias]);
    expect(result).toHaveLength(2);
    for (const [index, [{ manifest }]] of mocks.importBatch.mock.calls.entries()) {
      expect(manifest.sources).toHaveLength(1);
      expect(manifest.authorizedRoots).toEqual({ claude: [roots[index]] });
      expect(manifest.sources[0].authorizedRoot).toBe(roots[index]);
    }
  });

  it('reindexes all catalog workspaces with --full under the existing import lease without discovery', async () => {
    mocks.reindex.mockImplementationOnce(() => {
      expect(fs.existsSync(`${database}.import.lock`)).toBe(true);
    });
    expect(await refreshSessionCatalog(workspace, true, 0)).toBeUndefined();
    expect(mocks.reindex).toHaveBeenCalledWith();
    expect(mocks.importBatch).not.toHaveBeenCalled();
    expect(fs.existsSync(defaultDiscoveryManifestPath(workspace))).toBe(false);
    const lease = await acquireImportLease(database, 'another-writer');
    try {
      await expect(refreshSessionCatalog(workspace, true, 0)).rejects.toThrow(/lease is held/);
      expect(mocks.reindex).toHaveBeenCalledOnce();
    } finally { await lease.release(); }
  });

  it('returns partial import receipts with rejection details and releases the catalog lease', async () => {
    await saveAuthorization();
    const receipt = { run: { status: 'partial', sources: [{ status: 'rejected',
      errorCode: 'RESOURCE_LIMIT_EXCEEDED', detail: { limit: 'maxRecords', configured: 1, observed: 2 },
    }] }, totals: { rejected: 1, pending: 0 } };
    mocks.importBatch.mockResolvedValueOnce(receipt);
    expect(await refreshSessionCatalog(workspace, false, 0)).toEqual(receipt);
    expect(fs.existsSync(`${database}.import.lock`)).toBe(false);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('propagates operational import failures and releases the catalog lease', async () => {
    await saveAuthorization();
    mocks.importBatch.mockRejectedValueOnce(new Error('catalog write failed'));
    await expect(refreshSessionCatalog(workspace, false, 0)).rejects.toThrow('catalog write failed');
    expect(fs.existsSync(`${database}.import.lock`)).toBe(false);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('keeps pending imports as incomplete failures and releases the catalog lease', async () => {
    await saveAuthorization();
    mocks.importBatch.mockResolvedValueOnce({ totals: { rejected: 0, pending: 1 } });
    await expect(refreshSessionCatalog(workspace, false, 0)).rejects.toThrow('1 pending');
    expect(fs.existsSync(`${database}.import.lock`)).toBe(false);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('handles missing packages and broken native bindings as optional-feature unavailability', () => {
    mocks.feature.mockImplementationOnce(() => { throw new Error('missing sqlite'); });
    expect(sessionRefreshAvailable()).toBe(false);
    mocks.feature.mockReturnValueOnce(class { constructor() { throw new Error('binding unavailable'); } });
    expect(sessionRefreshAvailable()).toBe(false);
    mocks.feature.mockReturnValueOnce(class { close = mocks.close; });
    expect(sessionRefreshAvailable()).toBe(true);
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
