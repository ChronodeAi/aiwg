#!/usr/bin/env node

/**
 * esbuild PoC — bundle src/cli/router.ts + all eagerly-imported code into a
 * single `dist/cli/aiwg.mjs`. Lazy-loaded handlers (via dynamic `import()`
 * calls inside router.ts) stay as separate files.
 *
 * This is a **proof-of-concept** for spike #927, not a production build.
 * The goal is to measure cold-start impact before/after so the spike can
 * decide whether the bundle approach is worth pursuing.
 *
 * Usage:
 *   node tools/cli/build-bundle.mjs
 *
 * Output:
 *   dist/cli/aiwg.mjs         — bundled entry (ESM)
 *   dist/cli/aiwg.mjs.map     — source map
 *
 * Externalizes all runtime deps (hono, chalk, commander, etc.) — they
 * get resolved from node_modules at runtime as normal.
 */

import { build } from 'esbuild';
import { readFileSync, mkdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
const runtimeDeps = Object.keys(pkg.dependencies ?? {});
// Node built-ins that esbuild should leave alone. We also externalize
// anything with a `node:` prefix or that looks like a Node builtin.
const nodeBuiltins = [
  'fs', 'path', 'os', 'child_process', 'url', 'crypto', 'util',
  'events', 'stream', 'readline', 'http', 'https', 'net', 'tls',
  'zlib', 'buffer', 'process', 'module',
];
// `node:*` prefix form matched via a regex externalization.
const externals = [...runtimeDeps, ...nodeBuiltins];

mkdirSync(path.join(REPO_ROOT, 'dist', 'cli'), { recursive: true });

const start = Date.now();
const result = await build({
  entryPoints: [path.join(REPO_ROOT, 'src', 'cli', 'router.ts')],
  outfile: path.join(REPO_ROOT, 'dist', 'cli', 'aiwg.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  sourcemap: true,
  // Preserve the `import()` boundaries that the router uses to lazy-load
  // handlers. esbuild keeps them as runtime dynamic imports when we mark
  // the handler paths as external… but for a first pass, let's let esbuild
  // bundle everything eagerly and measure. If cold-start doesn't improve,
  // splitting is premature optimization.
  splitting: false,
  // Externalize node builtins and runtime deps.
  external: [
    ...externals,
    // `node:*` prefix
    'node:*',
  ],
  // Keep names readable for stack traces.
  keepNames: true,
  // Tree-shake unused code.
  treeShaking: true,
  // Emit metafile for analysis.
  metafile: true,
  // Don't fail on CJS interop warnings — we have plenty.
  logLevel: 'warning',
});
const elapsed = Date.now() - start;

const bundlePath = path.join(REPO_ROOT, 'dist', 'cli', 'aiwg.mjs');
const bundleSize = statSync(bundlePath).size;

console.log(`bundle built in ${elapsed}ms`);
console.log(`output:  ${bundlePath}`);
console.log(`size:    ${(bundleSize / 1024).toFixed(1)} KB`);
if (result.warnings.length > 0) {
  console.log(`warnings: ${result.warnings.length}`);
}
if (result.errors.length > 0) {
  console.error(`errors:   ${result.errors.length}`);
  for (const err of result.errors) console.error('  ', err.text);
  process.exit(1);
}
