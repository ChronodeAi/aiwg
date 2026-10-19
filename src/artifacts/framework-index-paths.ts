import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const FRAMEWORK_CORPUS_KINDS = ['frameworks', 'addons', 'extensions', 'agents', 'behaviors'] as const;

function canonicalPath(candidate: string): string {
  try { return fs.realpathSync(candidate); } catch { return path.resolve(candidate); }
}

/** Only an AIWG package/repository owns the corpus, never a project or bundle. */
export function resolveFrameworkCorpusRoot(candidate: string): string | null {
  let root = canonicalPath(candidate);
  while (true) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      if (pkg.name === 'aiwg' && FRAMEWORK_CORPUS_KINDS.every(kind =>
        fs.statSync(path.join(root, 'agentic/code', kind)).isDirectory())) return canonicalPath(root);
    } catch { /* keep looking for the owning package */ }
    const parent = path.dirname(root);
    if (parent === root) return null;
    root = parent;
  }
}

/** Works in both src/ and dist/src/, including corpus-free CLI packages. */
function modulePackageRoot(): string {
  let root = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      if (pkg.name === 'aiwg' || pkg.name === '@aiwg/cli') return canonicalPath(root);
    } catch { /* keep looking for the owning distribution */ }
    const parent = path.dirname(root);
    if (parent === root) throw new Error('Cannot resolve the AIWG package root for the framework index');
    root = parent;
  }
}

/** Builders, readers and reconciliation must select the same owning root. */
export function resolveFrameworkIndexRoot(cwd: string): string {
  return resolveFrameworkCorpusRoot(cwd)
    ?? (process.env.AIWG_ROOT
      ? resolveFrameworkCorpusRoot(process.env.AIWG_ROOT) ?? canonicalPath(process.env.AIWG_ROOT)
      : modulePackageRoot());
}

/**
 * Shared across projects using this package, isolated from other AIWG roots.
 * Keep the key stable across upgrades: the fingerprint receipt handles source
 * changes, avoiding abandoned directories for every version/commit. All graph
 * sidecars (including relationships) belong beneath this root's framework dir.
 * Legacy unkeyed indexes are left alone; reconciliation builds once here.
 */
export function getFrameworkIndexBaseDir(cwd: string): string {
  const key = createHash('sha256').update(resolveFrameworkIndexRoot(cwd)).digest('hex');
  const xdgData = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
  return path.join(xdgData, 'aiwg', 'index', 'roots', key);
}
