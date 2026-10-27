import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SpawnSyncReturns } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { formatNpmInstallFailure } from '../../helpers/npm-install-diagnostics.js';

describe('npm install failure diagnostics', () => {
  let root: string;
  const failed: SpawnSyncReturns<string> = {
    pid: 42, status: null, signal: 'SIGTERM', stdout: '', stderr: '', output: [null, '', ''],
    error: Object.assign(new Error('spawnSync npm ETIMEDOUT'), { code: 'ETIMEDOUT' }),
  };

  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-npm-diagnostics-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('explains an empty-output timeout and includes only the last 80 lines of the newest debug log', async () => {
    const latest = path.join(root, '2026-10-26T12_00_00_000Z-debug-0.log');
    // Write the older log last so directory order cannot accidentally select it.
    await writeFile(latest, Array.from({ length: 100 }, (_, index) => `fetch detail ${index}`).join('\r\n') + '\r\n');
    await writeFile(path.join(root, '2026-10-25T12_00_00_000Z-debug-0.log'), 'stale log');
    await writeFile(path.join(root, 'unrelated.log'), 'unrelated log');

    const message = await formatNpmInstallFailure(failed, 240_012, root);

    expect(message).toContain('npm install failed after 240012 ms: status=null, signal=SIGTERM');
    expect(message).toContain('error=Error: spawnSync npm ETIMEDOUT (code=ETIMEDOUT)');
    expect(message).toContain('stdout:\n(empty)\nstderr:\n(empty)');
    expect(message).toContain(`npm debug log ${latest} (last 80 lines):\n`);
    expect(message.split('(last 80 lines):\n')[1]?.split('\n')).toEqual(
      Array.from({ length: 80 }, (_, index) => `fetch detail ${index + 20}`),
    );
    expect(message).not.toContain('stale log');
    expect(message).not.toContain('unrelated log');
  });

  it('reports a nonzero exit and captured output when no debug log was written', async () => {
    const message = await formatNpmInstallFailure({
      ...failed, status: 1, signal: null, error: undefined, stdout: 'install output', stderr: 'E503 registry unavailable',
    }, 1234, root);

    expect(message).toContain('after 1234 ms: status=1, signal=none, error=none');
    expect(message).toContain('stdout:\ninstall output\nstderr:\nE503 registry unavailable');
    expect(message).toContain(`npm debug log unavailable: no debug logs in ${root}`);
  });

  it('retains the original failure when the log directory cannot be read', async () => {
    const message = await formatNpmInstallFailure(failed, 12, path.join(root, 'missing'));

    expect(message).toContain('status=null, signal=SIGTERM');
    expect(message).toContain('ETIMEDOUT');
    expect(message).toContain('npm debug log unavailable');
    expect(message).toContain('ENOENT');
  });
});
