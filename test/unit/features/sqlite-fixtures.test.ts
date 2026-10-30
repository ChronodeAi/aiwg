import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFeaturesRoot } from '../../../src/features/paths.js';
import { itWithSqlite } from '../../helpers/sqlite.js';

const roots: string[] = [];
const guard = new URL('../../helpers/sqlite-location-guard.mjs', import.meta.url).href;
const runtime = new URL('../../../src/features/runtime.ts', import.meta.url).href;
const graph = new URL('../../../src/artifacts/graph-backend.ts', import.meta.url).href;
const repository = new URL('../../../src/sessions/repository.ts', import.meta.url).href;

afterEach(() => {
  vi.doUnmock('../../../src/features/runtime.js');
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'aiwg-sqlite-fixture-'));
  roots.push(root);
  return root;
}

function run(script: string, featureRoot: string, mode: string) {
  return spawnSync(process.execPath, [
    '--import', guard, '--import', import.meta.resolve('tsx'),
    '--input-type=module', '--eval', script,
  ], {
    timeout: 10_000, encoding: 'utf8',
    env: { ...process.env, AIWG_FEATURES_HOME: featureRoot, AIWG_TEST_SQLITE_LOCATION: mode },
  });
}

describe('SQLite native fixture qualification', () => {
  itWithSqlite('uses real SQLite from a selected feature root while rejecting base-install imports', () => {
    const featureRoot = temporaryRoot();
    const featureRequire = createRequire(join(getFeaturesRoot(), 'package.json'));
    let packageJson: string;
    try { packageJson = featureRequire.resolve('better-sqlite3/package.json'); }
    catch { packageJson = createRequire(import.meta.url).resolve('better-sqlite3/package.json'); }
    mkdirSync(join(featureRoot, 'node_modules'));
    symlinkSync(dirname(packageJson), join(featureRoot, 'node_modules/better-sqlite3'), 'dir');
    const result = run(`
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      assert.throws(() => createRequire(${JSON.stringify(import.meta.url)})('better-sqlite3'), /base-install native peer/);
      const { requireFeaturePackage } = await import(${JSON.stringify(runtime)});
      const Database = requireFeaturePackage('better-sqlite3');
      const raw = new Database(':memory:');
      try { assert.equal(raw.prepare('SELECT 42 AS value').get().value, 42); }
      finally { raw.close(); }
      const { createGraphBackend } = await import(${JSON.stringify(graph)});
      const backend = await createGraphBackend('sqlite');
      try { backend.addNode('synthetic'); assert.equal(backend.hasNode('synthetic'), true); }
      finally { backend.close(); }
      const { SessionRepository } = await import(${JSON.stringify(repository)});
      const catalog = new SessionRepository();
      try { assert.equal(catalog.listSessions({ limit: 1 }).items.length, 0); }
      finally { catalog.close(); }
    `, featureRoot, 'feature-only');
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });

  it('reports factory remediation when SQLite is absent from both supported locations', () => {
    const result = run(`
      import assert from 'node:assert/strict';
      const { createGraphBackend } = await import(${JSON.stringify(graph)});
      await assert.rejects(createGraphBackend('sqlite'), /aiwg features install sqlite/);
      const { SessionRepository } = await import(${JSON.stringify(repository)});
      assert.throws(() => new SessionRepository(), /aiwg features install sqlite/);
    `, temporaryRoot(), 'absent');
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });

  it('fails the required-native lane clearly instead of skipping an absent prerequisite', async () => {
    vi.stubEnv('AIWG_TEST_REQUIRE_SQLITE', '1');
    vi.doMock('../../../src/features/runtime.js', () => ({
      requireFeaturePackage: () => { throw new Error('synthetic absent native prerequisite'); },
    }));
    vi.resetModules();
    await expect(import('../../helpers/sqlite.js')).rejects.toThrow(
      /Required SQLite test prerequisite failed:.*aiwg features install sqlite/,
    );
  });
});
