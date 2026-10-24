import { describe, it, expect, vi, beforeEach } from 'vitest';

const owners = vi.hoisted(() => ({
  probeIndexStatus: vi.fn(), runIndexRefresh: vi.fn(), cleanWebResourceCache: vi.fn(), checkUpdateStatus: vi.fn(),
}));
vi.mock('../../../tools/_resolve-impl.mjs', () => ({
  importImpl: vi.fn(async (_caller, owner) => {
    const modules = {
      'artifacts/index-status.js': { probeIndexStatus: owners.probeIndexStatus },
      'artifacts/index-refresh.js': { runIndexRefresh: owners.runIndexRefresh },
      'resources/cache-cleanup.js': { cleanWebResourceCache: owners.cleanWebResourceCache },
      'update/checker.mjs': { checkUpdateStatus: owners.checkUpdateStatus },
    };
    if (!modules[owner]) throw new Error(`Unexpected owner: ${owner}`);
    return modules[owner];
  }),
}));
import { invokeOwner } from '../../../tools/daemon/maintenance-owner.mjs';

beforeEach(() => {
  owners.probeIndexStatus.mockResolvedValue({ summary: { built: 2, missing: 0, warnings: 0 } });
  owners.runIndexRefresh.mockResolvedValue({ status: 'ok', totals: { errors: 0, deferred: 0 } });
  owners.cleanWebResourceCache.mockReturnValue({ removed: [], preserved: ['protected'] });
  owners.checkUpdateStatus.mockResolvedValue({ status: 'ok', available: false, checkOnly: true });
});

describe('deterministic owner routing', () => {
  it.each(['index.verify', 'index.freshness'])('%s calls the existing status owner', async kind => {
    expect((await invokeOwner({ kind })).exitStatus).toBe(0);
    expect(owners.probeIndexStatus).toHaveBeenCalledWith(process.cwd(), undefined);
    expect(owners.runIndexRefresh).not.toHaveBeenCalled();
  });
  it('forwards named selection and reports per-index freshness', async () => {
    const detail = { summary: { built: 2, missing: 8, warnings: 0 }, indices: [{ name: 'project', status: 'fresh' }] };
    owners.probeIndexStatus.mockResolvedValue(detail);
    const result = await invokeOwner({ kind: 'index.verify', args: { index: 'project', workspace: '/workspace' } });
    expect(owners.probeIndexStatus).toHaveBeenCalledWith('/workspace', 'project');
    expect(result).toMatchObject({ exitStatus: 0, detail });
  });
  it.each(['stale', 'degraded', 'unavailable'])('reports %s indices without claiming fresh', async status => {
    owners.probeIndexStatus.mockResolvedValue({ summary: { built: 1, missing: 0, warnings: 0 }, indices: [{ name: 'project', status }] });
    expect((await invokeOwner({ kind: 'index.verify', args: { index: 'project' } })).exitStatus).toBe(1);
  });
  it('defers unsupported owners explicitly', async () => {
    owners.probeIndexStatus.mockResolvedValue({ summary: { built: 1, missing: 0, warnings: 0 }, indices: [{ name: 'datasets', status: 'unsupported' }] });
    expect(await invokeOwner({ kind: 'index.verify', args: { index: 'datasets' } })).toMatchObject({ exitStatus: null, state: 'deferred' });
  });
  it('records a failed verify for missing indices', async () => {
    owners.probeIndexStatus.mockResolvedValue({ summary: { built: 0, missing: 2, warnings: 0 } });
    expect((await invokeOwner({ kind: 'index.verify' })).exitStatus).toBe(1);
  });
  it.each(['index.reconcile', 'index.refresh'])('%s translates only supported owner flags', async kind => {
    await invokeOwner({ kind, args: { index: 'sessions', workspace: '/workspace', root: '/root', dryRun: true, install: true } });
    expect(owners.runIndexRefresh).toHaveBeenCalledWith(['--json', '--only', 'sessions', '--workspace', '/workspace', '--root', '/root', '--dry-run'], process.cwd());
  });
  it('preserves owner refresh deferral', async () => {
    owners.runIndexRefresh.mockResolvedValue({ status: 'deferred', totals: { errors: 0, deferred: 1 } });
    expect((await invokeOwner({ kind: 'index.reconcile' })).state).toBe('deferred');
  });
  it.each(['cache.retention', 'cache.prune'])('%s preserves protected cleanup authority', async kind => {
    await invokeOwner({ kind, args: { cacheRoot: '/cache', dryRun: true, force: true } });
    expect(owners.cleanWebResourceCache).toHaveBeenCalledWith(process.cwd(), { cacheRoot: '/cache', dryRun: true });
  });
  it('update.check calls only the check-only API', async () => {
    await invokeOwner({ kind: 'update.check', args: { channel: 'next', install: true } });
    expect(owners.checkUpdateStatus).toHaveBeenCalledWith({ channel: 'next' });
  });
  it('unsupported channels defer without a success claim', async () => {
    owners.checkUpdateStatus.mockResolvedValue({ status: 'unsupported' });
    expect(await invokeOwner({ kind: 'update.check', args: { channel: 'edge' } })).toMatchObject({ state: 'deferred', exitStatus: null });
  });
  it('rejects arbitrary actions instead of constructing a prompt or command', async () => {
    await expect(invokeOwner({ kind: 'shell', args: { command: 'anything' } })).rejects.toThrow('Unsupported maintenance kind');
  });
});
