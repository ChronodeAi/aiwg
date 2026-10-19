import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from '../../helpers/temp-dir.js';
import { trackTemporaryDirectory } from '../../../src/utils/temporary-directory.js';

const implementation = pathToFileURL(path.resolve(import.meta.dirname,
  '../../../dist/src/utils/temporary-directory.js')).href;

describe('owned temporary directories', () => {
  it('cleans a thrown operation and removes lifecycle listeners', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'aiwg-temp-owner-'));
    const before = ['exit', 'SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal));
    const remove = trackTemporaryDirectory(directory);
    expect(() => { try { throw new Error('deployment failed'); } finally { remove(); } }).toThrow('deployment failed');
    expect(existsSync(directory)).toBe(false);
    expect(['exit', 'SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal))).toEqual(before);
  });

  it.each(['exit-success', 'exit-failure', 'SIGTERM', 'SIGINT'])('cleans on %s without swallowing termination', mode => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'aiwg-temp-owner-'));
    const secondDirectory = mkdtempSync(path.join(os.tmpdir(), 'aiwg-temp-owner-'));
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      const { trackTemporaryDirectory } = await import(${JSON.stringify(implementation)});
      trackTemporaryDirectory(${JSON.stringify(directory)});
      trackTemporaryDirectory(${JSON.stringify(secondDirectory)});
      ${mode.startsWith('exit') ? `process.exit(${mode === 'exit-success' ? 0 : 1});`
        : `process.kill(process.pid, ${JSON.stringify(mode)}); setTimeout(() => {}, 5000);`}
    `], { timeout: 10_000 });
    expect(result.error).toBeUndefined();
    if (mode.startsWith('exit')) expect(result.status).toBe(mode === 'exit-success' ? 0 : 1);
    else expect(result.signal).toBe(mode);
    expect(existsSync(directory)).toBe(false);
    expect(existsSync(secondDirectory)).toBe(false);
  });
});
