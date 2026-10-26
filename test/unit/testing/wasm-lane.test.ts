import { readFileSync } from 'node:fs';
import path from 'node:path';
import { globSync } from 'glob';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import base from '../../../config/vitest.config.js';
import wasm from '../../../config/vitest.wasm.config.js';
import { wasmFiles } from '../../../config/test-lanes.mjs';
import { inspectTestRegistration } from '../../../tools/testing/check-test-registration.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
// Core lazily imports PGlite only through its database factories. Pure shard
// converters/readers do not load WASM; see the reviewed runtime inventory.
const databaseExports = new Set([
  'ArchiveManager', 'createFortemi', 'createPGliteInstance', 'createPGliteBackend',
  'PGliteStorageBackendFactory', 'defaultStorageBackendFactory', 'restoreDbSnapshot',
]);

function imports(file: string, body: string) {
  const source = ts.createSourceFile(file, body, ts.ScriptTarget.Latest, true);
  const dependencies: string[] = [];
  let loadsWasm = false;
  let core = false;
  let database = false;
  function dependency(name: string) {
    dependencies.push(name);
    if (name === '@fortemi/core') core = true;
    if (name.startsWith('@electric-sql/pglite') || name.endsWith('.wasm')) loadsWasm = true;
  }
  function visit(node: ts.Node) {
    // Ignore type-only edges: they cannot instantiate anything at runtime.
    if (ts.isImportDeclaration(node)) {
      if (node.importClause?.isTypeOnly) return;
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings) && !node.importClause?.name
        && bindings.elements.every(element => element.isTypeOnly)) return;
      dependency((node.moduleSpecifier as ts.StringLiteral).text);
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
      dependency((node.moduleSpecifier as ts.StringLiteral).text);
    }
    if (ts.isIdentifier(node) && databaseExports.has(node.text)) database = true;
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const expression = node.expression.getText(source);
      if (/^(?:globalThis\.)?WebAssembly\./.test(expression)) loadsWasm = true;
      if (node.arguments?.[0] && ts.isStringLiteralLike(node.arguments[0])) {
        const name = node.arguments[0].text;
        if (['import', 'require', 'loadFeaturePackage'].includes(expression)) dependency(name);
        if (name.endsWith('.wasm') && /(?:^|\.)(?:fetch|readFile|readFileSync|URL)$/.test(expression)) loadsWasm = true;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { dependencies, loadsWasm: loadsWasm || (core && database) };
}

function wasmUsers(files: string[]) {
  const cache = new Map<string, ReturnType<typeof imports>>();
  function localDependency(name: string, file: string) {
    if (!name.startsWith('.') && !name.startsWith('@/') && !name.startsWith('@global/')) return [];
    const resolved = ts.resolveModuleName(name, file, {
      allowJs: true, moduleResolution: ts.ModuleResolutionKind.Bundler,
      baseUrl: root, paths: { '@/*': ['src/*'], '@global/*': ['src/*'] },
    }, ts.sys).resolvedModule?.resolvedFileName;
    return resolved !== undefined && !resolved.endsWith('.d.ts') ? [resolved] : [];
  }
  function reachesWasm(file: string, seen: Set<string>): boolean {
    if (seen.has(file)) return false;
    seen.add(file);
    if (!cache.has(file)) {
      const info = imports(file, readFileSync(file, 'utf8'));
      cache.set(file, { ...info, dependencies: info.dependencies.flatMap(name => localDependency(name, file)) });
    }
    const info = cache.get(file)!;
    return info.loadsWasm || info.dependencies.some(dependency => reachesWasm(dependency, seen));
  }
  return files.filter(file => reachesWasm(path.join(root, file), new Set())).sort();
}

describe('required WebAssembly forks lane (#3073)', () => {
  it('recognizes direct, aliased and lazy loaders while ignoring type-only imports and prose', () => {
    for (const body of [
      "import { PGlite as Database } from '@electric-sql/pglite';",
      "const { PGlite } = await import('@electric-sql/pglite');",
      "import { ArchiveManager as Manager } from '@fortemi/core';",
      "const core = await import('@fortemi/core'); new core.ArchiveManager('memory');",
      'await WebAssembly.instantiate(bytes);',
      "new URL('./database.wasm', import.meta.url);",
    ]) expect(imports('fixture.ts', body).loadsWasm, body).toBe(true);
    for (const body of [
      "import type { PGlite } from '@electric-sql/pglite';",
      "import { type ArchiveManager } from '@fortemi/core';",
      "import { unpackTarGz } from '@fortemi/core';",
      "const core = await import('@fortemi/core'); core.validateFullV1ShardArchive(bytes);",
      "const documentation = 'WebAssembly.instantiate and @electric-sql/pglite';",
    ]) expect(imports('fixture.ts', body).loadsWasm, body).toBe(false);
  });

  // Parse the full source inventory and its local dependency graph under load.
  it('moves every runtime WASM importer, including transitive local imports, out of threads exactly once', async () => {
    const beforeSplit = globSync(base.test.include, {
      cwd: root, ignore: base.test.exclude.filter((entry: string) => !wasmFiles.includes(entry)),
    }).sort();
    const threaded = globSync(base.test.include, { cwd: root, ignore: base.test.exclude }).sort();
    const forked = globSync(wasm.test.include, { cwd: root, ignore: wasm.test.exclude }).sort();
    const users = wasmUsers(beforeSplit);
    expect(users).toEqual([...wasmFiles].sort());
    expect(users.filter(file => threaded.includes(file))).toEqual([]);
    expect(forked).toEqual([...wasmFiles].sort());
    const combined = [...threaded, ...forked];
    expect(new Set(combined).size).toBe(combined.length);
    expect(combined.sort()).toEqual(beforeSplit);
    const registration = await inspectTestRegistration(root);
    expect(registration.errors).toEqual([]);
    for (const file of wasmFiles) {
      expect(registration.files.find((row: { file: string }) => row.file === file)?.lanes)
        .toEqual([{ id: 'config/vitest.wasm.config.js', live: false }]);
    }
    expect(wasm.test).toMatchObject({ pool: 'forks', maxWorkers: 1, isolate: true });
    expect(wasm.test.reporters).toEqual(base.test.reporters);
    expect(wasm.test.globalSetup).toEqual(base.test.globalSetup);
  }, 90_000);

  it('runs once in required CI through the shared TMPDIR and hang gates', () => {
    const workflow = parseYaml(readFileSync(path.join(root, '.gitea/workflows/ci.yml'), 'utf8'));
    const job = workflow.jobs.wasm;
    const command = 'node tools/ci/run-with-hang-report.mjs --timeout 8m -- npm run test:wasm';
    const steps = Object.values(workflow.jobs).flatMap((value: any) => value.steps ?? []);
    expect(steps.filter((step: any) => step.run?.includes('npm run test:wasm'))).toHaveLength(1);
    expect(job.steps).toContainEqual({ name: 'Run WebAssembly tests in forks with TMPDIR leak gate', run: command });
    expect(job.if).toBeUndefined();
    expect(job['continue-on-error']).toBeUndefined();
    expect(job.strategy).toBeUndefined();
    expect(job.steps.some((step: any) => step.run === 'npm run build:cli')).toBe(true);
    expect(workflow.jobs.build.needs).toContain('wasm');
    const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
    expect(scripts['test:wasm']).toBe('node tools/testing/run-default-lane.mjs --config config/vitest.wasm.config.js');
  });
});
