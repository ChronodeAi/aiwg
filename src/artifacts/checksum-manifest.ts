/**
 * Checksum Manifest — Fast Change Detection
 *
 * Stores `{ path, checksum, mtime, size }` per indexed file to enable
 * two-phase change detection:
 *   Phase 1: stat() comparison (no file read) — filter out unchanged files
 *   Phase 2: content read + checksum — only for candidates where stat differs
 *
 * This avoids reading every file on `aiwg index build` when most haven't
 * changed, reducing rebuild time from O(N reads) to O(N stats + M reads)
 * where M << N on typical projects.
 *
 * @implements #794
 * @source @src/artifacts/index-builder.ts
 */

import fs from 'fs';
import path from 'path';

/**
 * Per-file entry in the checksum manifest
 */
export interface ManifestEntry {
  /** Truncated SHA-256 checksum (matches MetadataEntry.checksum) */
  checksum: string;
  /** File modification time (ISO string for stable serialization) */
  mtime: string;
  /** File size in bytes */
  size: number;
}

/**
 * On-disk manifest format
 */
export interface ChecksumManifest {
  version: 1;
  generated: string;
  entries: Record<string, ManifestEntry>;
  /** A successful build ties these inputs to the unchanged metadata file. */
  receipt?: {
    indexVersion: string;
    extractorVersion: string;
    buildConfigHash: string;
    sourceRoot: string;
    metadataSignature: string;
    /** Framework-only projection identity; absent older receipts must reconcile. */
    relations?: { revision: number; signature: string };
    entriesDigest: string;
  };
}

const MANIFEST_FILENAME = 'checksum-manifest.json';

/**
 * Build a manifest entry from a file's current stat + checksum
 */
export function makeEntry(checksum: string, stat: fs.Stats): ManifestEntry {
  return {
    checksum,
    mtime: stat.mtime.toISOString(),
    size: stat.size,
  };
}

/**
 * Load the checksum manifest from an index directory.
 * Returns an empty manifest if the file is missing or malformed.
 */
export function loadManifest(indexDir: string): ChecksumManifest {
  const manifestPath = path.join(indexDir, MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) {
    return { version: 1, generated: '', entries: {} };
  }
  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw) as ChecksumManifest;
    if (parsed.version !== 1 || !parsed.entries) {
      return { version: 1, generated: '', entries: {} };
    }
    return parsed;
  } catch {
    return { version: 1, generated: '', entries: {} };
  }
}

/**
 * Write the checksum manifest atomically (write to temp, rename).
 */
export function writeManifest(indexDir: string, manifest: ChecksumManifest): void {
  fs.mkdirSync(indexDir, { recursive: true });
  const manifestPath = path.join(indexDir, MANIFEST_FILENAME);
  const tmpPath = `${manifestPath}.tmp`;
  const payload: ChecksumManifest = {
    version: 1,
    generated: new Date().toISOString(),
    entries: manifest.entries,
    ...(manifest.receipt ? { receipt: manifest.receipt } : {}),
  };
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
  fs.renameSync(tmpPath, manifestPath);
}

/**
 * Phase 1 check: can we skip this file based on stat alone?
 *
 * Returns true if the file's current mtime and size match the manifest entry —
 * in which case we presume the content is unchanged and skip the read.
 */
export function statMatches(stat: fs.Stats, entry: ManifestEntry | undefined): boolean {
  if (!entry) return false;
  return stat.mtime.toISOString() === entry.mtime && stat.size === entry.size;
}

/**
 * Remove stale entries (files that no longer exist on disk) from the manifest.
 * Returns the count removed.
 */
export function pruneManifest(manifest: ChecksumManifest, cwd: string): number {
  let removed = 0;
  for (const relativePath of Object.keys(manifest.entries)) {
    const fullPath = path.join(cwd, relativePath);
    if (!fs.existsSync(fullPath)) {
      delete manifest.entries[relativePath];
      removed++;
    }
  }
  return removed;
}

/**
 * Stats collected during a build using the manifest for change detection
 */
export interface ManifestStats {
  /** Files checked (matches total file count) */
  checked: number;
  /** Files skipped entirely (stat matched manifest) */
  statSkipped: number;
  /** Files read and checksum verified as unchanged */
  checksumSkipped: number;
  /** Files that actually changed and were re-indexed */
  reindexed: number;
  /** Files removed from manifest (deleted from disk) */
  pruned: number;
}
