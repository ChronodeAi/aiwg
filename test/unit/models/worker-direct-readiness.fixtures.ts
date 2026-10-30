// Shared temp-HOME lifecycle and fake CLI fixtures for direct readiness tests.
import { chmod, lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import type { ParallelismConfig } from '../../../src/config/aiwg-config.js';
import { loadProviderModelCapabilities } from '../../../src/models/provider-policy.js';

// T-OG-12 / #2894 S1: synthetic offline inputs plus fake local CLIs created
// under os.tmpdir() with a temp HOME. No paid calls, no credentials, no real
// provider installs. Probes run only when a prober is passed (opt-in); the
// default config-only path must start no process. Temp dirs are removed in
// afterEach.
const roots: string[] = [];

export function installDirectWorkerFixtures(): void {
  beforeEach(async () => {
    const home = await mkdtemp(join(tmpdir(), 'aiwg-direct-home-'));
    roots.push(home);
    vi.stubEnv('HOME', home);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) {
      await rm(root, { recursive: true, force: true });
      await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
}

export async function scratchDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

// Fake CLI: records argv/cwd/environment into the probe cwd, then prints banner.
export async function fakeCli(banner: string): Promise<string> {
  const dir = await scratchDir('aiwg-direct-cli-');
  const filename = join(dir, 'fake-codex');
  await writeFile(filename,
    '#!/usr/bin/env node\n'
    + 'const fs = require(\'node:fs\');\n'
    + 'const path = require(\'node:path\');\n'
    + 'const record = { argv: process.argv.slice(2), cwd: process.cwd(), env: { ...process.env } };\n'
    + 'fs.writeFileSync(path.join(process.cwd(), `probe-record-${process.pid}.json`), JSON.stringify(record));\n'
    + `process.stdout.write(${JSON.stringify(`${banner}\n`)});\n`,
    { mode: 0o755 });
  await chmod(filename, 0o755);
  return filename;
}

export function parallelismWith(clis: NonNullable<ParallelismConfig['clis']>, groups?: ParallelismConfig['groups']): ParallelismConfig {
  return { worker_dispatch: true, clis, ...(groups ? { groups } : {}) };
}

export const codexCli = (executable: string, extra?: Record<string, unknown>) => ({
  adapter: 'providers:codex', accountScope: 'local-account', quotaScope: 'synthetic-scope', executable, ...extra,
});

export const registry = () => structuredClone(loadProviderModelCapabilities());

