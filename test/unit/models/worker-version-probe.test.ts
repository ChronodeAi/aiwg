import { chmod, lstat, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  boundedVersionProbe,
  normalizeWorkerVersionBanner,
  workerVersionProbeDefaults,
  workerVersionProbeEnvironment,
  workerVersionProbeEnvAllowlist,
  workerVersionRangeMismatch,
} from '../../../src/models/worker-installation.mjs';

// T-OG-12 / #2894 S1: the shared bounded probe owns execution safety —
// exact argv, explicit cwd, credential-free environment, time/output bounds,
// process-group cleanup. Fake CLIs record what they observed into the probe
// cwd; sentinel credentials set in the parent must never reach the child.
// Temp HOME keeps the suite hermetic; temp dirs are removed in afterEach.
const SENTINEL = 'AIWG_TEST_SENTINEL_CREDENTIAL';
const PROVIDER_KEY = 'AIWG_TEST_FAKE_PROVIDER_API_KEY';

const roots: string[] = [];

beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), 'aiwg-probe-home-'));
  roots.push(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv(SENTINEL, 'sentinel-value');
  vi.stubEnv(PROVIDER_KEY, 'provider-key-value');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

async function probeCwd(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aiwg-probe-cwd-'));
  roots.push(dir);
  return dir;
}

// Fake CLI: records argv/cwd/environment into the probe cwd, then prints banner.
async function fakeRecordingCli(banner: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aiwg-probe-cli-'));
  roots.push(dir);
  const filename = join(dir, 'fake-cli');
  await writeFile(filename,
    '#!/usr/bin/env node\n'
    + 'const fs = require(\'node:fs\');\n'
    + 'const path = require(\'node:path\');\n'
    + 'const record = { argv: process.argv.slice(2), cwd: process.cwd(), env: { ...process.env } };\n'
    + `fs.writeFileSync(path.join(process.cwd(), \`probe-record-\${process.pid}.json\`), JSON.stringify(record));\n`
    + `process.stdout.write(${JSON.stringify(`${banner}\n`)});\n`,
    { mode: 0o755 });
  await chmod(filename, 0o755);
  return filename;
}

async function readRecords(cwd: string): Promise<Array<{ argv: string[]; cwd: string; env: Record<string, string> }>> {
  const names = (await readdir(cwd)).filter(name => name.startsWith('probe-record-'));
  expect(names.length).toBeGreaterThan(0);
  return Promise.all(names.map(async name =>
    JSON.parse(await readFile(join(cwd, name), 'utf8'))));
}

describe('shared bounded version probe (#2894)', () => {
  it('runs the exact argv in the explicit cwd with sentinel variables absent', async () => {
    const cwd = await probeCwd();
    const executable = await fakeRecordingCli('codex-cli 0.161.0');
    const environment = workerVersionProbeEnvironment();
    const { rawBanner, version } = await boundedVersionProbe(
      executable, ['--version'], environment, cwd, 5000, 64 * 1024, '^codex-cli ([0-9A-Za-z.+-]{1,128})$');
    expect(rawBanner).toBe('codex-cli 0.161.0\n');
    expect(version).toBe('0.161.0');
    const [record] = await readRecords(cwd);
    expect(record.argv).toEqual(['--version']);
    expect(record.cwd).toBe(cwd);
    expect(record.env.PATH).toEqual(process.env.PATH);
    expect(record.env[SENTINEL]).toBeUndefined();
    expect(record.env[PROVIDER_KEY]).toBeUndefined();
    expect(record.env.HOME).toBeUndefined();
  });

  it('builds a fresh credential-free environment from the allowlist only', () => {
    expect([...workerVersionProbeEnvAllowlist]).toEqual(['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR']);
    const environment = workerVersionProbeEnvironment({
      PATH: '/usr/bin', OPENAI_API_KEY: 'secret', HOME: '/real/home', [SENTINEL]: 'x', NUL: 'a\0b',
    } as Record<string, string>);
    expect(environment).toEqual({ PATH: '/usr/bin' });
    environment.PATH = '/mutated';
    expect(workerVersionProbeEnvironment({ PATH: '/usr/bin' } as Record<string, string>).PATH).toBe('/usr/bin');
  });

  it('rejects a child that hangs past the timeout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiwg-probe-hang-'));
    roots.push(dir);
    const executable = join(dir, 'hang-cli');
    await writeFile(executable, '#!/usr/bin/env node\nsetInterval(() => {}, 25);\n', { mode: 0o755 });
    await chmod(executable, 0o755);
    const cwd = await probeCwd();
    await expect(boundedVersionProbe(
      executable, ['--version'], workerVersionProbeEnvironment(), cwd, 200, 64 * 1024, undefined,
    )).rejects.toThrow('Bounded version probe failed');
  });

  it('rejects a child that floods output past the byte bound', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiwg-probe-flood-'));
    roots.push(dir);
    const executable = join(dir, 'flood-cli');
    await writeFile(executable,
      '#!/usr/bin/env node\nfor (let i = 0; i < 10000; i += 1) process.stdout.write(\'x\'.repeat(1024) + \'\\n\');\n',
      { mode: 0o755 });
    await chmod(executable, 0o755);
    const cwd = await probeCwd();
    await expect(boundedVersionProbe(
      executable, ['--version'], workerVersionProbeEnvironment(), cwd, 5000, 1024, undefined,
    )).rejects.toThrow('Bounded version probe failed');
  });

  it('reports a missing CLI as unavailable with the ENOENT cause preserved', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiwg-probe-missing-'));
    roots.push(dir);
    const cwd = await probeCwd();
    const error = await boundedVersionProbe(
      join(dir, 'missing-cli'), ['--version'], workerVersionProbeEnvironment(), cwd, 5000, 64 * 1024, undefined,
    ).then(() => null, (cause: unknown) => cause as NodeJS.ErrnoException);
    expect(error?.message).toBe('Version probe unavailable');
    expect(error?.code).toBe('ENOENT');
  });

  it('rejects invalid probe bounds without spawning', () => {
    expect(() => boundedVersionProbe('x', ['--version'], {}, tmpdir(), 0, 1024, undefined))
      .toThrow('Invalid probe bounds');
    expect(() => boundedVersionProbe('x', ['--version'], {}, tmpdir(), 5000, 0, undefined))
      .toThrow('Invalid probe bounds');
    expect(() => boundedVersionProbe('x', ['--\0bad'], {}, tmpdir(), 5000, 1024, undefined))
      .toThrow('Invalid probe bounds');
    expect(workerVersionProbeDefaults).toEqual({ timeoutMs: 10_000, maxBytes: 64 * 1024 });
  });

  it('shares banner normalization and the range check with readiness', () => {
    expect(normalizeWorkerVersionBanner('codex-cli 0.161.0', '^codex-cli ([0-9A-Za-z.+-]{1,128})$')).toBe('0.161.0');
    expect(workerVersionRangeMismatch('0.161.0', ['0.161.0', '>=0.160.0'])).toBeNull();
    expect(workerVersionRangeMismatch('0.999.0', ['0.161.0'])).toBe('0.161.0');
    expect(workerVersionRangeMismatch('0.161.0', ['not-a-range'])).toBe('Unsupported version range \'not-a-range\'');
  });

  it.each([
    ['0.161.1', '>=0.161.0 <0.200.0', true],
    ['0.163.0', '>=0.161.0 <0.200.0', true],
    ['0.200.0', '>=0.161.0 <0.200.0', false],
    ['0.201.0', '>=0.161.0 <0.200.0', false],
    ['0.160.9', '>=0.161.0 <0.200.0', false],
    ['1.4.4-R5419.1', '>=1.4.4-R5419.1 <2.0.0', true],
    ['1.4.4-R5419.0', '>=1.4.4-R5419.1 <2.0.0', false],
    ['1.4.4', '>=1.4.4-R5419.1 <2.0.0', true],
    ['1.4.10', '>=1.4.4-R5419.1 <2.0.0', true],
    ['1.5.0', '>=1.4.4-R5419.1 <2.0.0', true],
    ['1.4.10-R6427.1', '>=1.4.4-R5419.1 <2.0.0', false],
    ['1.4.10+build.1', '>=1.4.4-R5419.1 <2.0.0', true],
    ['2.0.0', '>=1.4.4-R5419.1 <2.0.0', false],
  ])('checks comparator bounds and semver suffix ordering: %s in %s is %s', (version, range, supported) => {
    expect(workerVersionRangeMismatch(version, [range])).toBe(supported ? null : range);
  });

  it('requires both adapter and profile ranges to match, in either order', () => {
    const broad = '>=0.161.0 <0.200.0';
    const narrow = '>=0.161.0 <0.163.0';
    expect(workerVersionRangeMismatch('0.163.0', [broad, narrow])).toBe(narrow);
    expect(workerVersionRangeMismatch('0.163.0', [narrow, broad])).toBe(narrow);
  });
});
