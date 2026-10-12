import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeExecutable, writeExecutableSync } from '../../helpers/write-executable.js';

let directory: string;
let executable: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'write-executable-'));
  executable = join(directory, 'script with spaces \' $;.sh');
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe.each([
  ['async', writeExecutable], ['sync', writeExecutableSync],
] as const)('writeExecutable (%s)', (_name, write) => {
  it('creates the exact content with executable permissions', async () => {
    const content = '#!/bin/sh\nprintf "héllo\\n"\n';
    await write(executable, content);
    expect(await readFile(executable, 'utf8')).toBe(content);
    if (process.platform !== 'win32') expect((await stat(executable)).mode & 0o777).toBe(0o755);
  });

  it.skipIf(process.platform === 'win32')('runs the created executable', async () => {
    await write(executable, '#!/bin/sh\nprintf "%s" "$1"\n');
    expect(execFileSync(executable, ['hello'], { encoding: 'utf8', timeout: 5_000 })).toBe('hello');
  });

  it('replaces an existing file', async () => {
    await writeFile(executable, 'longer original content', { mode: 0o600 });
    await write(executable, '#!/bin/sh\nexit 0\n');
    expect(await readFile(executable, 'utf8')).toBe('#!/bin/sh\nexit 0\n');
    if (process.platform !== 'win32') expect((await stat(executable)).mode & 0o777).toBe(0o755);
  });

  it.skipIf(process.platform !== 'linux')('leaves no descriptor for the executable in the test process', async () => {
    await write(executable, '#!/bin/sh\nexit 0\n');
    const targets = await Promise.all((await readdir('/proc/self/fd')).map(async fd => {
      try { return await readlink(join('/proc/self/fd', fd)); }
      catch (error) {
        // Descriptors can close between readdir and readlink in other workers.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    }));
    expect(targets.filter(target => target === executable || target === `${executable} (deleted)`)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('reports the path and child failure', async () => {
    const missing = join(directory, 'missing', 'script');
    await expect(Promise.resolve().then(() => write(missing, 'content'))).rejects.toThrow(`Cannot write executable ${JSON.stringify(missing)}: exit`);
  });
});
