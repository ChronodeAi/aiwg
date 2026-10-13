#!/usr/bin/env node
/**
 * aiwg clean:providers
 *
 * Resets provider-deployed state between builds/tests. `.claude/` is shared
 * with Claude Desktop/Code, which keeps its own session and workspace state
 * there — `worktrees/`, `settings.local.json`, `settings.json` (and its
 * `.bak.*` backups), `launch.json`, and anything else AIWG never wrote.
 * `rm -rf .claude` destroys that state along with the AIWG-deployed
 * artifacts; none of it is recoverable from source.
 *
 * AIWG only needs to remove what it itself deployed into `.claude/`. The
 * provider definition registry (`getProviderArtifactPathStrings` /
 * `getProviderKernelSkillPath`) already records exactly those subpaths —
 * reuse it instead of hand-maintaining a parallel list here.
 *
 * Every other target below keeps the previous whole-directory/whole-file
 * removal behavior unchanged. The audit for #2626 confirmed `.claude` as
 * the destructive case; widening the narrower removal to the remaining
 * provider directories is a separate, unverified change (see the issue
 * report for directories that look like they share the same problem).
 *
 * @implements #2626
 */

import { rm } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { importImpl } from '../_resolve-impl.mjs';

// The registry lives in TypeScript sources, so it is only importable after a
// build. Cleaning has to work on a tree with no build output, so fall back to
// the same subpaths written out by hand. The fallback never widens to the
// whole directory.
const FALLBACK_SCOPED_PATHS = [
  '.claude/agents',
  '.claude/commands',
  '.claude/.aiwg/skills',
  '.claude/rules',
  '.claude/hooks',
  '.claude/skills',
];

let registry = null;
try {
  registry = await importImpl(import.meta.url, 'providers/provider-definitions.js');
} catch {
  registry = null;
}

// Unchanged from the previous `rm -rf` list — no confirmed shared/merge-owned
// state found for these during the #2626 audit (see tool report).
export const WHOLE_REMOVE_TARGETS = [
  '.agents',
  '.codex',
  '.cursor',
  '.factory',
  '.opencode',
  '.warp',
  '.windsurf',
  '.hermes',
  '.hermes.md',
  '.devin',
  'opencode.json',
];

// Claude Code/Desktop shares `.claude/` with AIWG; only the subpaths AIWG
// itself deploys are removed there.
export const SCOPED_PROVIDER = 'claude';

export function resolveScopedProviderManagedPaths(source = registry) {
  if (!source) return [...FALLBACK_SCOPED_PATHS];
  const artifactPaths = source.getProviderArtifactPathStrings(SCOPED_PROVIDER);
  const kernelSkills = source.getProviderKernelSkillPath(SCOPED_PROVIDER);
  const managed = [
    ...(artifactPaths ? Object.values(artifactPaths) : []),
    kernelSkills,
  ].filter(Boolean);
  return [...new Set(managed)];
}

async function removePath(absPath) {
  await rm(absPath, { recursive: true, force: true });
}

/**
 * Remove provider-deployed state under `projectRoot`. Returns the list of
 * relative paths that were targeted for removal (present or not).
 */
export async function cleanProviders(projectRoot = process.cwd()) {
  const removed = [];

  for (const target of WHOLE_REMOVE_TARGETS) {
    await removePath(path.join(projectRoot, target));
    removed.push(target);
  }

  for (const relPath of resolveScopedProviderManagedPaths()) {
    await removePath(path.join(projectRoot, relPath));
    removed.push(relPath);
  }

  return removed;
}

async function main() {
  const projectRoot = process.cwd();
  const removed = await cleanProviders(projectRoot);
  console.log('Removed provider-deployed state:');
  for (const target of removed) {
    console.log(`  ${target}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
