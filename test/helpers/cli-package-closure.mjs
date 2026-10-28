// Follow the shipped CLI import graph using checkout sources, without building or packing.
import fs from 'node:fs';
import path from 'node:path';
import { globSync } from 'glob';
import ts from 'typescript';
import { findRelativeImportSpecifiers, isExecutableToolFile } from './packed-relative-imports.mjs';
import { CLI_FILES_LIST, isCliPackageFile } from '../../tools/release/cli-package-files.mjs';

// URL-built paths from the worker graph's existing package regression guard.
const constructedImports = {
  'dist/src/mcp/tools/worker-invoke.mjs': ['tools/_resolve-impl.mjs'],
  'dist/src/mcp/tools/worker-shell-control.mjs': ['tools/ralph-external/lib/systemd-client.mjs'],
  'tools/scripts/resource-preflight.mjs': [
    'dist/src/config/dispatch-thresholds-runtime.mjs', 'dist/src/config/project-artifacts-runtime.mjs',
  ],
};

export function inspectCliPackageClosure(root, entries) {
  // npm pack returns exact paths; avoid glob matching its entire manifest per edge.
  const exactFiles = new Set(entries);
  const hasPatterns = entries.some(entry => entry.endsWith('/') || /[!*?{[]/.test(entry));
  const isShipped = filename => hasPatterns
    ? isCliPackageFile(filename, entries) : exactFiles.has(filename);
  // Map source TS to its installed JS location. Ignore dist entirely so stale
  // builds cannot mask an omission and a clean checkout needs no build first.
  const sources = new Map(globSync(['src/**/*', 'tools/**/*', 'bin/**/*', 'agentic/**/*'], {
    cwd: root, nodir: true, ignore: ['src/**/*.test.ts', 'src/**/*.d.ts', '**/node_modules/**'],
  }).map(filename => [filename.startsWith('src/')
    ? `dist/${filename.replace(/\.ts$/, '.js')}` : filename, filename]));
  const pending = [...sources.keys()].filter(filename => isShipped(filename)
    && isExecutableToolFile(filename));
  const visited = new Set();
  const violations = [];
  while (pending.length) {
    const filename = pending.pop();
    if (visited.has(filename)) continue;
    visited.add(filename);
    const sourceFile = sources.get(filename);
    if (!sourceFile) continue;
    let source = fs.readFileSync(path.join(root, sourceFile), 'utf8');
    // Erase type-only imports, just as the actual TS build does.
    if (sourceFile.endsWith('.ts')) source = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
      fileName: sourceFile,
    }).outputText;
    const imports = findRelativeImportSpecifiers(filename, source)
      .map(({ spec }) => path.posix.join(path.posix.dirname(filename), spec));
    imports.push(...(constructedImports[filename] ?? []));
    const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
    const visit = node => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const arg = node.arguments.at(-1);
        if (arg && ts.isStringLiteralLike(arg)) {
          if (['importImpl', 'resolveImpl'].includes(node.expression.text)) imports.push(`dist/src/${arg.text}`);
          if (node.expression.text === 'loadRalphExternal') imports.push(`tools/ralph-external/${arg.text}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    for (const target of new Set(imports)) {
      if (!/^(tools\/|src\/|dist\/src\/)/.test(target)) continue;
      if (!isShipped(target)) {
        violations.push(`${target} imported by ${filename}: absent from ${CLI_FILES_LIST}`);
      } else if (!sources.has(target)) {
        violations.push(`${target} imported by ${filename}: source missing for ${CLI_FILES_LIST}`);
      }
      if (isExecutableToolFile(target)) pending.push(target);
    }
  }
  return { visited: [...visited].sort(), violations: [...new Set(violations)].sort() };
}
