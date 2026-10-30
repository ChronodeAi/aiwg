import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveFrameworkCorpusRoot, resolveFrameworkIndexRoot } from './framework-index-paths.js';
import { frameworkSourceDigest } from './framework-source-digest.js';
import { selectPrebuiltRelations } from './relations.js';
import { getFortemiCorePrebuiltStatus } from './fortemi-core-sync.js';
import { loadFortemiCoreMetadataEntries } from './fortemi-core-query-adapter.js';
import type { ArtifactIndex, IndexStats } from './types.js';

/** The shipped search export is usable only while both it and its source-bound
 * relationship projection validate. No local index or receipt is required. */
export function loadPrebuiltDeploymentIndex(root: string, options: { strictRoot?: boolean } = {}): { index: ArtifactIndex; stats: IndexStats } | null {
  if (options.strictRoot && !resolveFrameworkCorpusRoot(root)) return null;
  root = resolveFrameworkIndexRoot(root);
  if (!selectPrebuiltRelations(root).reader) return null;
  const status = getFortemiCorePrebuiltStatus('framework', root);
  if (!status.built || status.stale || !status.generatedAt) return null;
  let stats: IndexStats;
  try {
    const manifest = JSON.parse(fs.readFileSync(status.manifestPath, 'utf8'));
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (manifest.package_version !== pkg.version || manifest.source_digest !== frameworkSourceDigest(root)) return null;
    const text = fs.readFileSync(path.join(path.dirname(status.manifestPath), 'source-stats.json'), 'utf8');
    if (createHash('sha256').update(text).digest('hex') !== manifest.source_stats_checksum) return null;
    stats = JSON.parse(text) as IndexStats;
  } catch { return null; }
  const { entries } = loadFortemiCoreMetadataEntries(root, 'framework');
  const byPath = Object.fromEntries(entries.map(entry => [entry.path, entry]));
  if (!entries.length || entries.length !== status.itemCount || Object.keys(byPath).length !== entries.length) return null;
  const byType: Record<string, number> = {};
  for (const entry of entries) byType[entry.type] = (byType[entry.type] ?? 0) + 1;
  if (stats.totalArtifacts !== entries.length || !stats.byType ||
      Object.keys({ ...stats.byType, ...byType }).some(type => (stats.byType[type] ?? 0) !== (byType[type] ?? 0))) return null;
  return { index: { version: 'prebuilt', builtAt: status.generatedAt, buildTimeMs: 0, entries: byPath }, stats };
}
