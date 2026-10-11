import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadProviderModelCapabilities } from '../../../src/models/provider-policy.js';
import { fixtureJson, fixtureRoot } from '../../conformance/mission-v1/worker-contract-fixtures.js';
import { loadInstalledWorkerAdapters, createProvider, hasProvider, ensureProvidersRegistered } from '../../../tools/ralph-external/lib/provider-adapter.mjs';

const roots: string[] = [];
const digest = (source: string) => `sha256:${createHash('sha256').update(source).digest('hex')}`;
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  }
});
async function fixture(id = 'third-fixture') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-installed-worker-'));
  roots.push(root);
  const packageRoot = path.join(root, 'installed');
  const workspace = path.join(root, 'workspace');
  await mkdir(packageRoot, { mode: 0o755 }); await mkdir(workspace);
  const marker = path.join(root, 'imported');
  const source = `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(marker)}, 'imported');\n`
    + (await readFile(path.join(fixtureRoot, 'third-worker-adapter.mjs'), 'utf8')).replaceAll('third-fixture', id);
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'fixture-driver', version: '1.0.0', type: 'module' }), { mode: 0o644 });
  await writeFile(path.join(packageRoot, 'driver.mjs'), source, { mode: 0o644 });
  const adapter = structuredClone(fixtureJson('shared-vectors.json').find((v: any) => v.id === 'adapter-process-shape').value);
  adapter.id = id; adapter.provider = 'synthetic-inference';
  adapter.runtimeDriver = 'installed:third-fixture';
  adapter.catalogAdapter = { kind: 'module', locator: 'installed:third-fixture', parser: 'fixture-v1' };
  const registry = { ...structuredClone(loadProviderModelCapabilities()), workerAdapters: { third: adapter } };
  const entry = { reference: adapter.runtimeDriver, packageRoot, packageName: 'fixture-driver', packageVersion: '1.0.0',
    modulePath: 'driver.mjs', interfaceVersion: 1, sha256: digest(source), adapterIds: [adapter.id], platforms: ['linux'] };
  return { root, packageRoot, marker, source, entry, request: { registry, modules: [entry], workerWritableRoots: [workspace], platform: 'linux' } };
}

describe('S1 installed factory pre-import gate (T-OG-10/14)', () => {
  it.each(fixtureJson('adapter-loading-vectors.json'))('$pack $id leaves module unexecuted', async vector => {
    const f = await fixture();
    const adapter = f.request.registry.workerAdapters.third;
    switch (vector.mutation) {
      case 'traversal': f.entry.modulePath = '../installed/driver.mjs'; break;
      case 'symlink': await symlink('driver.mjs', path.join(f.packageRoot, 'link.mjs')); f.entry.modulePath = 'link.mjs'; break;
      case 'digest': await writeFile(path.join(f.packageRoot, 'driver.mjs'), `${f.source}\n// tamper`); break;
      case 'package-version': await writeFile(path.join(f.packageRoot, 'package.json'), JSON.stringify({ name: 'fixture-driver', version: '2.0.0' })); break;
      case 'interface': f.entry.interfaceVersion = 2; break;
      case 'adapter-version': adapter.adapterVersion = '2.0.0'; break;
      case 'package-name': f.entry.packageName = 'wrong-package'; break;
      case 'unknown-driver': adapter.runtimeDriver = 'installed:unknown'; break;
      case 'builtin-id': adapter.id = 'claude'; f.entry.adapterIds = ['claude']; break;
      case 'export': {
        const source = f.source.replace('export function register(', 'export function wrong(');
        await writeFile(path.join(f.packageRoot, 'driver.mjs'), source); f.entry.sha256 = digest(source); break;
      }
      case 'version-export': {
        const source = f.source.replace('interfaceVersion = 1', 'interfaceVersion = 2');
        await writeFile(path.join(f.packageRoot, 'driver.mjs'), source); f.entry.sha256 = digest(source); break;
      }
      case 'reassigned-export': {
        const source = `${f.source}\nregister = 0;`;
        await writeFile(path.join(f.packageRoot, 'driver.mjs'), source); f.entry.sha256 = digest(source); break;
      }
      case 'url': adapter.runtimeDriver = 'https://untrusted.invalid/worker.mjs'; break;
      case 'writable': f.request.workerWritableRoots.push(f.packageRoot); break;
      case 'mode': await chmod(path.join(f.packageRoot, 'driver.mjs'), 0o666); break;
      case 'duplicate-id': f.request.registry.workerAdapters.second = structuredClone(adapter); break;
      case 'duplicate-reference': f.request.modules.push({ ...f.entry }); break;
      case 'platform': f.request.platform = 'unsupported-fixture'; break;
      case 'catalog': {
        adapter.catalogAdapter.locator = 'installed:catalog';
        f.request.modules.push({ ...f.entry, reference: 'installed:catalog', adapterIds: [], sha256: `sha256:${'0'.repeat(64)}` }); break;
      }
      default: throw new Error(`Unknown mutation: ${vector.mutation}`);
    }
    await expect(loadInstalledWorkerAdapters(f.request)).rejects.toThrow(new RegExp(vector.error));
    await expect(lstat(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(hasProvider('third-fixture')).toBe(false);
  });

  it.each(['driver.mjs', 'package.json'])('rejects a worker-writable hardlink alias of %s before import', async name => {
    const f = await fixture();
    const installed = path.join(f.packageRoot, name);
    const alias = path.join(f.request.workerWritableRoots[0], name);
    await link(installed, alias);
    expect((await lstat(installed)).nlink).toBe(2);
    // A write through the worker alias changes the installed inode, even when
    // the approved content/digest remains identical.
    await writeFile(alias, await readFile(installed));
    await expect(loadInstalledWorkerAdapters(f.request)).rejects.toThrow('Writable hardlink');
    await expect(lstat(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts read-only hardlinked module and package metadata in a store', async () => {
    const f = await fixture('readonly-store');
    const store = path.join(f.root, 'store');
    await mkdir(store);
    for (const name of ['driver.mjs', 'package.json']) {
      const installed = path.join(f.packageRoot, name);
      await link(installed, path.join(store, name));
      await chmod(installed, 0o444);
      expect((await lstat(installed)).nlink).toBe(2);
    }
    await expect(loadInstalledWorkerAdapters(f.request)).resolves.toEqual(['readonly-store']);
    expect(createProvider('readonly-store').getName()).toBe('readonly-store');
    expect(await readFile(f.marker, 'utf8')).toBe('imported');
  });

  it.each(['package', 'ancestor'])('accepts a symlinked %s and caches its canonical identity', async kind => {
    const id = `symlinked-${kind}`;
    const f = await fixture(id);
    const canonicalRoot = f.packageRoot;
    const alias = path.join(f.root, 'alias');
    await symlink(kind === 'package' ? canonicalRoot : f.root, alias);
    f.entry.packageRoot = kind === 'package' ? alias : path.join(alias, 'installed');
    await expect(loadInstalledWorkerAdapters(f.request)).resolves.toEqual([id]);
    f.entry.packageRoot = canonicalRoot;
    await expect(loadInstalledWorkerAdapters(f.request)).resolves.toEqual([id]);
    expect(createProvider(id).registrationCount).toBe(1);
    expect(await readFile(f.marker, 'utf8')).toBe('imported');
  });

  it('rejects a symlinked package root resolving into a worker-writable directory', async () => {
    const f = await fixture();
    const alias = path.join(f.root, 'alias');
    await symlink(f.packageRoot, alias);
    f.entry.packageRoot = alias;
    f.request.workerWritableRoots.push(f.packageRoot);
    await expect(loadInstalledWorkerAdapters(f.request)).rejects.toThrow('worker-writable');
    await expect(lstat(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['module', 'directory', 'package.json'])('rejects an escaping %s symlink before import', async kind => {
    const f = await fixture();
    const outside = path.join(f.root, 'outside');
    await mkdir(outside);
    if (kind === 'package.json') {
      await writeFile(path.join(outside, 'package.json'), await readFile(path.join(f.packageRoot, 'package.json')));
      await rm(path.join(f.packageRoot, 'package.json'));
      await symlink(path.join(outside, 'package.json'), path.join(f.packageRoot, 'package.json'));
    } else {
      await writeFile(path.join(outside, 'driver.mjs'), f.source);
      f.entry.modulePath = kind === 'module' ? 'escape.mjs' : 'escape/driver.mjs';
      await symlink(kind === 'module' ? path.join(outside, 'driver.mjs') : outside,
        path.join(f.packageRoot, kind === 'module' ? 'escape.mjs' : 'escape'));
    }
    await expect(loadInstalledWorkerAdapters(f.request)).rejects.toThrow(/escapes|Symlink/);
    await expect(lstat(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['driver.mjs', 'package.json'])('caps %s reads at the catalog maxBytes default before import', async name => {
    const f = await fixture();
    const oversized = `${f.source}\n//`.padEnd(5 * 1024 * 1024 + 1, 'x');
    await writeFile(path.join(f.packageRoot, name), oversized);
    f.entry.sha256 = digest(oversized);
    await expect(loadInstalledWorkerAdapters(f.request)).rejects.toThrow('maxBytes');
    await expect(lstat(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts a module exactly at the 5 MiB byte ceiling', async () => {
    const f = await fixture('size-boundary');
    const source = `${f.source}\n//`.padEnd(5 * 1024 * 1024, 'x');
    await writeFile(path.join(f.packageRoot, 'driver.mjs'), source);
    f.entry.sha256 = digest(source);
    await expect(loadInstalledWorkerAdapters(f.request)).resolves.toEqual(['size-boundary']);
    expect(await readFile(f.marker, 'utf8')).toBe('imported');
  });

  it('loads a third adapter/catalog through the existing factory once, rechecking cached digests', async () => {
    const f = await fixture();
    const results = await Promise.all([ensureProvidersRegistered(f.request), loadInstalledWorkerAdapters(f.request)]);
    expect(results).toEqual([['third-fixture'], ['third-fixture']]);
    expect(await readFile(f.marker, 'utf8')).toBe('imported');
    const adapter = createProvider('third-fixture');
    expect(adapter.registrationCount).toBe(1);
    expect(adapter.getName()).toBe('third-fixture');
    expect(adapter.catalog()).toEqual([{ id: 'synthetic-model', provider: 'synthetic-inference' }]);
    expect(adapter.buildSessionArgs({ model: 'exact/model', prompt: 'quoted " λ\n--text' }))
      .toEqual(['--model', 'exact/model', '--prompt', 'quoted " λ\n--text']);
    // A cached import is not cached permission to ignore changed installed bytes.
    await writeFile(path.join(f.packageRoot, 'driver.mjs'), `${f.source}\n// changed`);
    await expect(loadInstalledWorkerAdapters(f.request)).rejects.toThrow('digest');
    await writeFile(path.join(f.packageRoot, 'driver.mjs'), f.source);
    // A different package cannot replace an already registered ID.
    const other = await fixture();
    await expect(loadInstalledWorkerAdapters(other.request)).rejects.toThrow('Duplicate');
    await expect(lstat(other.marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
