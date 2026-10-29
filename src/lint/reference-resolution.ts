// Resolve lint references using exact corpus identities.
import path from 'node:path';
import { refFilesForId } from '../artifacts/corpus-tools/ref-files.js';
import { isRefId, refIdFromFilename } from '../research/identity.js';

/**
 * Build a target-wide artifact ID index once per lint run.
 *
 * Reference documents may use either an exact filename (`REF-001.md`) or the
 * canonical slugged form (`REF-001-some-title.md`). Indexing the exact ID token also
 * makes resolution independent of a particular corpus directory layout.
 */
export function buildReferenceIndex(allFiles: string[]): Set<string> {
  const references = new Set<string>();

  for (const file of allFiles) {
    if (path.extname(file).toLowerCase() !== '.md') continue;

    const basename = path.basename(file, '.md');
    if (['-citations.md', '-radar.md'].some(ext => isRefId(path.basename(file).slice(0, -ext.length)) && file.endsWith(ext))) continue;
    references.add(basename);

    const ref = refIdFromFilename(path.basename(file));
    if (ref) references.add(ref);
    if (/^REF-/.test(basename)) continue;
    const artifactId = basename.match(/^(.+?-\d+)(?:-|$)/);
    if (artifactId) references.add(artifactId[1]);
  }

  return references;
}

/**
 * Preserve support for references stored outside the lint target when a rule
 * explicitly supplies basePath. Accept both exact and slugged filenames.
 */
export function resolvesFromBasePath(refId: string, targetDir: string, basePath: string, projectRoot: string): boolean {
  const candidateDirs = new Set([
    path.resolve(projectRoot, basePath),
    path.resolve(targetDir, basePath),
    path.resolve(process.cwd(), basePath),
  ]);

  for (const dir of candidateDirs) {
    try {
      if (refFilesForId(dir, refId).length > 0) {
        return true;
      }
    } catch {
      // Missing or unreadable candidate directories do not resolve the ID.
    }
  }

  return false;
}

