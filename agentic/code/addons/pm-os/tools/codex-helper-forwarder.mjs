#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function safeHelperRelativePath(helperRelative) {
  const parts = String(helperRelative).split(/[\\/]+/);
  if (path.isAbsolute(helperRelative) || parts.includes('..')) {
    throw new Error(`refusing unsafe helper path: ${helperRelative}`);
  }
  return parts.join(path.sep);
}

function runtimeInfoExecutable(env) {
  const result = spawnSync(
    'aiwg',
    ['runtime-info', '--check', 'aiwg', '--json'],
    { encoding: 'utf8', env }
  );
  if (result.status !== 0 || !result.stdout) return null;

  try {
    const info = JSON.parse(result.stdout);
    return typeof info.path === 'string' && info.path.length > 0
      ? info.path
      : null;
  } catch {
    return null;
  }
}

function ancestors(startPath) {
  const out = [];
  let current = path.resolve(startPath);
  while (true) {
    out.push(current);
    const parent = path.dirname(current);
    if (parent === current) return out;
    current = parent;
  }
}

/**
 * Resolve a canonical AIWG helper without searching arbitrary filesystem roots.
 * AIWG_ROOT wins. If it is unavailable or invalid, the installed `aiwg`
 * runtime executable is resolved and its ancestors are checked.
 */
export function resolveCanonicalHelper(helperRelative, options = {}) {
  const env = options.env ?? process.env;
  const safeRelative = safeHelperRelativePath(helperRelative);
  const shimPath = options.shimPath
    ? fs.realpathSync(path.resolve(options.shimPath))
    : null;
  const candidates = [];

  if (env.AIWG_ROOT) candidates.push(path.resolve(env.AIWG_ROOT));

  const runtimeExecutable = runtimeInfoExecutable(env);
  if (runtimeExecutable) {
    let runtimePath = path.resolve(runtimeExecutable);
    try {
      runtimePath = fs.realpathSync(runtimePath);
    } catch {
      // A stale runtime-info path is simply not a usable candidate.
    }
    candidates.push(...ancestors(path.dirname(runtimePath)));
  }

  const checked = [];
  for (const candidateRoot of [...new Set(candidates)]) {
    const helperPath = path.join(candidateRoot, safeRelative);
    checked.push(helperPath);
    if (!fs.existsSync(helperPath) || !fs.statSync(helperPath).isFile()) continue;

    const resolved = fs.realpathSync(helperPath);
    if (shimPath && resolved === shimPath) continue;
    return resolved;
  }

  const detail = checked.length > 0
    ? ` Checked: ${checked.join(', ')}`
    : ' No AIWG_ROOT or verified aiwg runtime path was available.';
  throw new Error(`canonical AIWG helper not found for ${safeRelative}.${detail}`);
}

/** Forward the caller's argument vector unchanged to the canonical helper. */
export function forwardCanonicalHelper({ helperRelative, shimUrl, args }) {
  const forwardedArgs = args ?? process.argv.slice(2);
  const shimPath = fileURLToPath(shimUrl);
  let canonical;

  try {
    canonical = resolveCanonicalHelper(helperRelative, { shimPath });
  } catch (error) {
    console.error(`[pm-os codex shim] ${error.message}`);
    return 1;
  }

  const result = spawnSync(
    process.execPath,
    [canonical, ...forwardedArgs],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit'
    }
  );

  if (result.error) {
    console.error(`[pm-os codex shim] failed to start ${canonical}: ${result.error.message}`);
    return 1;
  }
  if (result.signal) {
    console.error(`[pm-os codex shim] ${canonical} terminated by ${result.signal}`);
    return 1;
  }
  return Number.isInteger(result.status) ? result.status : 1;
}
