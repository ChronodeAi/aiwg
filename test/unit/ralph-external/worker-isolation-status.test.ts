// Unknown kernel containment must never become a forged unit cgroup match.
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { systemdClientFixture } from '../../fixtures/systemd-client.js';
import { readUnitControlGroup, getWorkerIsolationStatus } from '../../../tools/ralph-external/lib/worker-isolation.mjs';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const client = systemdClientFixture(); roots.push(client.root); vi.stubEnv('PATH', client.root);
  return client;
}

describe('trusted unit cgroup reads', () => {
  it('returns the kernel group using the trusted client and a bounded query', () => {
    const client = fixture();
    const spawn = vi.fn(() => ({ status: 0, stdout: ' /user.slice/owned.service\n' }));
    expect(readUnitControlGroup('aiwg-worker-owned', { spawn })).toBe('/user.slice/owned.service');
    expect(spawn).toHaveBeenCalledWith(client.systemctl,
      ['--user', 'show', 'aiwg-worker-owned', '-p', 'ControlGroup', '--value'],
      expect.objectContaining({ timeout: 10000, encoding: 'utf8' }));
  });

  it.each([null, undefined, {}, '', '../foreign', 'unit;command'])('rejects invalid unit %j before querying', unit => {
    const spawn = vi.fn();
    expect(readUnitControlGroup(unit, { spawn })).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    { status: 1, stdout: '/forged/group' },
    { status: 0, stdout: '/forged/group', error: new Error('bus failed') },
    { status: 0, stdout: ' \n' },
    { status: 0 },
  ])('never treats an unavailable or empty response as containment: %j', response => {
    fixture();
    expect(readUnitControlGroup('aiwg-worker-owned', { spawn: () => response })).toBeNull();
  });

  it('keeps containment unknown when the client throws', () => {
    fixture();
    expect(readUnitControlGroup('aiwg-worker-owned', { spawn: () => { throw new Error('client failed'); } })).toBeNull();
  });

  it('leaves retained failures available to polling and termination readers', () => {
    fixture();
    const spawn = vi.fn(() => ({ status: 0,
      stdout: 'ActiveState=failed\nResult=exit-code\nExecMainStatus=7\nMemoryMax=1024\nTasksCurrent=0\n' }));
    expect(getWorkerIsolationStatus('foreign.service', { spawn })).toMatchObject({ result: 'exit-code', execMainStatus: 7 });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][1]).toContain('show');
  });
});
