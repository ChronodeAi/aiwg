import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const probes = vi.hoisted(() => ({ get: vi.fn(), install: vi.fn(), config: vi.fn() }));
vi.mock('https', () => ({ default: { get: probes.get } }));
vi.mock('fs/promises', () => ({ default: { readFile: vi.fn(async () => JSON.stringify({ version: '2026.10.1' })) } }));
vi.mock('../../../src/channel/manager.mjs', () => ({
  getPackageRoot: () => '/fake/package', loadConfig: probes.config, saveConfig: probes.config,
  getChannel: probes.config, updateEdge: probes.install,
}));
vi.mock('../../../src/update/service.mjs', () => ({ updateInstallation: probes.install }));
import { checkUpdateStatus } from '../../../src/update/checker.mjs';

beforeEach(() => {
  probes.get.mockImplementation((_url, _options, callback) => {
    const request = new EventEmitter();
    queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      callback(response);
      response.emit('data', JSON.stringify({ 'dist-tags': { latest: '2026.10.2', next: '2026.11.0-rc.1', nightly: '2026.11.1-nightly' } }));
      response.emit('end');
    });
    return request;
  });
});

describe('check-only update owner', () => {
  it.each([['stable', '2026.10.2'], ['next', '2026.11.0-rc.1'], ['nightly', '2026.11.1-nightly']])('checks %s without install, prompting, or config writes', async (channel, latest) => {
    expect(await checkUpdateStatus({ channel })).toMatchObject({ status: 'ok', channel, current: '2026.10.1', latest, available: true, checkOnly: true });
    expect(probes.install).not.toHaveBeenCalled();
    expect(probes.config).not.toHaveBeenCalled();
  });
  it('defers edge before any remote call or install', async () => {
    expect(await checkUpdateStatus({ channel: 'edge' })).toMatchObject({ status: 'unsupported', checkOnly: true });
    expect(probes.get).not.toHaveBeenCalled();
    expect(probes.install).not.toHaveBeenCalled();
  });
  it('reports a failed registry check instead of claiming no update exists', async () => {
    probes.get.mockImplementation(() => {
      const request = new EventEmitter();
      queueMicrotask(() => request.emit('error', new Error('offline')));
      return request;
    });
    await expect(checkUpdateStatus()).rejects.toThrow('registry probe failed');
  });
});
