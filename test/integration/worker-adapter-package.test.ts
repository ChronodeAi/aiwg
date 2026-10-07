import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCliPackage } from '../../tools/release/build-cli-package.mjs';
import { fixtureJson, fixtureRoot } from '../conformance/mission-v1/worker-contract-fixtures.js';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

describe('T-OG-14 published package installed adapter paths', () => {
  it.each(['aiwg', '@aiwg/cli'])('%s loads a third module and catalog outside the checkout', async target => {
    // Build prerequisite: npx tsc && npm run build:copy-mjs. No paid services or npm install.
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-worker-package-'));
    roots.push(root);
    const stage = path.join(root, 'stage');
    const source = target === 'aiwg' ? process.cwd() : stage;
    if (target === '@aiwg/cli') await buildCliPackage({ outputDir: stage });
    const { stdout } = await exec('npm', ['pack', source, '--ignore-scripts', '--json', '--pack-destination', root], {
      cwd: root, timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, npm_config_cache: path.join(root, 'cache'), npm_config_update_notifier: 'false' },
    });
    const packed = JSON.parse(stdout)[0];
    expect(packed.name).toBe(target);
    const files = new Set(packed.files.map((file: any) => file.path));
    for (const required of ['tools/ralph-external/lib/provider-adapter.mjs', 'tools/_resolve-impl.mjs',
      'dist/src/models/provider-policy.js', 'schemas/models/provider-model-capabilities.v1.schema.json']) expect(files.has(required), required).toBe(true);
    await exec('tar', ['-xzf', path.join(root, packed.filename), '-C', root], { timeout: 30_000 });
    const installed = path.join(root, 'package');
    // Reuse only already-installed dependencies; production source must come from tarball.
    await symlink(path.resolve('node_modules'), path.join(installed, 'node_modules'));
    await expect(lstat(path.join(installed, 'src'))).rejects.toMatchObject({ code: 'ENOENT' });
    const driverRoot = path.join(root, 'fixture-driver');
    await mkdir(driverRoot, { mode: 0o755 });
    await cp(path.join(fixtureRoot, 'third-worker-adapter.mjs'), path.join(driverRoot, 'driver.mjs'));
    await chmod(path.join(driverRoot, 'driver.mjs'), 0o644);
    const driver = await readFile(path.join(driverRoot, 'driver.mjs'));
    await writeFile(path.join(driverRoot, 'package.json'), JSON.stringify({ name: 'fixture-driver', version: '1.0.0', type: 'module' }), { mode: 0o644 });
    const metadata = structuredClone(fixtureJson('shared-vectors.json').find((v: any) => v.id === 'adapter-process-shape').value);
    metadata.id = 'third-fixture'; metadata.runtimeDriver = 'installed:third-fixture';
    metadata.catalogAdapter = { kind: 'module', locator: 'installed:third-fixture', parser: 'fixture-v1' };
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    const request = {
      metadata, modules: [{ reference: metadata.runtimeDriver, packageRoot: driverRoot, packageName: 'fixture-driver', packageVersion: '1.0.0',
        modulePath: 'driver.mjs', interfaceVersion: 1, sha256: `sha256:${createHash('sha256').update(driver).digest('hex')}`,
        adapterIds: [metadata.id], platforms: ['linux'] }], workerWritableRoots: [workspace],
    };
    await writeFile(path.join(root, 'request.json'), JSON.stringify(request));
    await writeFile(path.join(installed, 'probe.mjs'), `
import { readFileSync } from 'node:fs';
import { loadProviderModelCapabilities, resolveWorkerInstallation } from './dist/src/models/provider-policy.js';
import { createProvider, ensureProvidersRegistered } from './tools/ralph-external/lib/provider-adapter.mjs';
const { metadata, ...trusted } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const registry = { ...loadProviderModelCapabilities(), workerAdapters: { fixture: metadata } };
await ensureProvidersRegistered({ registry, ...trusted });
const adapter = createProvider(metadata.id);
console.log(JSON.stringify({ name: adapter.getName(), catalog: adapter.catalog(), executable: resolveWorkerInstallation(registry, { adapter: 'workerAdapters:fixture' }).executable }));
`);
    const result = await exec(process.execPath, [path.join(installed, 'probe.mjs'), path.join(root, 'request.json')], {
      cwd: workspace, timeout: 10_000, maxBuffer: 65536,
      env: { PATH: process.env.PATH, AIWG_RESOLVE_IMPL_FROM: 'dist' },
    });
    expect(JSON.parse(result.stdout)).toEqual({ name: 'third-fixture', catalog: [{ id: 'synthetic-model', provider: 'synthetic-inference' }], executable: 'fixture-worker' });
  }, 120_000);
});
