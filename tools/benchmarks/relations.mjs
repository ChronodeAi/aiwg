#!/usr/bin/env node
/**
 * Relationship build and read benchmark. Run build then read in separate Node processes:
 * TMPDIR=<isolated-scratch> HOME=<isolated> XDG_DATA_HOME=<isolated> node tools/benchmarks/relations.mjs build
 * TMPDIR=<isolated-scratch> HOME=<isolated> XDG_DATA_HOME=<same> node tools/benchmarks/relations.mjs read
 * Requires npm run build:cli. read imports no builder/query engine or metadata.
 */
import fs from 'node:fs';
import path from 'node:path';
import { importImpl } from '../_resolve-impl.mjs';

const mode = process.argv[2];
if (!['build', 'read', 'precompute'].includes(mode)) throw new Error('Usage: relations.mjs build|read|precompute (with isolated HOME/XDG_DATA_HOME)');
const cwd = process.cwd();
if (mode === 'build') {
  const { buildIndex } = await importImpl(import.meta.url, 'artifacts/index-builder.js');
  for (const force of [true, false]) {
    const start = performance.now();
    await buildIndex(cwd, { graph: 'framework', force, quiet: true });
    console.log(JSON.stringify({ mode: force ? 'cold' : 'warm', ms: performance.now() - start, peakRssKiB: process.resourceUsage().maxRSS }));
  }
} else if (mode === 'precompute') {
  const { getGraphIndexDir } = await importImpl(import.meta.url, 'artifacts/types.js');
  const { buildPrebuiltRelations } = await importImpl(import.meta.url, 'artifacts/prebuilt-relations.js');
  const metadata = JSON.parse(fs.readFileSync(path.join(getGraphIndexDir(cwd, 'framework'), 'metadata.json'), 'utf8'));
  const start = performance.now();
  const tables = buildPrebuiltRelations(cwd, Object.values(metadata.entries));
  console.log(JSON.stringify({ mode, ms: performance.now() - start, bytes: Object.fromEntries(
    Object.entries(tables).map(([file, text]) => [file, Buffer.byteLength(text)])), peakRssKiB: process.resourceUsage().maxRSS }));
} else {
  const start = performance.now();
  const { loadRelations } = await importImpl(import.meta.url, 'artifacts/relations.js');
  const reader = loadRelations(cwd);
  if (!reader) throw new Error('Missing or unsupported framework relationship sidecar');
  const targets = Object.entries(reader.index.targets).filter(([, target]) => target.rules.length).slice(0, 50);
  if (targets.length !== 50) throw new Error(`Expected 50 bound targets, got ${targets.length}`);
  let rules = 0;
  for (const [key] of targets) {
    const separator = key.indexOf(':');
    rules += reader.rulesForTarget(key.slice(0, separator), key.slice(separator + 1)).length;
  }
  const { getGraphIndexDir } = await importImpl(import.meta.url, 'artifacts/types.js');
  const built = path.join(getGraphIndexDir(cwd, 'framework'), 'relations.json');
  const prebuilt = path.join(cwd, 'prebuilt/framework-relations/relations.json');
  console.log(JSON.stringify({ mode, targets: targets.length, rules, bytes: fs.statSync(fs.existsSync(prebuilt) ? prebuilt : built).size,
    ms: performance.now() - start, peakRssKiB: process.resourceUsage().maxRSS }));
}
