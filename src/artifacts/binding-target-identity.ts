/** Resolve source aliases and bundle ownership before rule-target precedence. */
import fs from 'node:fs';
import path from 'node:path';
import type { MetadataEntry } from './types.js';

export interface BindingTargetIdentityOptions {
  cwd?: string;
  packageRoot?: string;
  bundleRoot?: string;
  /** Translate immutable staged inputs back to their captured source paths. */
  logicalPath?: (file: string) => string;
}

function realpath(file: string): string {
  try { return fs.realpathSync(file); } catch { return path.resolve(file); }
}

function sourcePath(file: string, options: BindingTargetIdentityOptions): string {
  const normalized = file.replace(/\\/g, '/');
  const anchor = normalized.startsWith('agentic/code/') ? options.packageRoot : options.cwd;
  return path.resolve(anchor ?? process.cwd(), normalized);
}

function identity(file: string, options: BindingTargetIdentityOptions): string {
  const absolute = sourcePath(file, options);
  // Realpath handles symlinks; the supplied mapping handles materialized copies.
  return realpath(options.logicalPath?.(realpath(absolute)) ?? absolute);
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export function selectBindingTargetIdentities(
  entries: MetadataEntry[], options: BindingTargetIdentityOptions = {},
): MetadataEntry[] {
  const bundle = options.bundleRoot && identity(options.bundleRoot, options);
  const snapshot = options.bundleRoot && sourcePath(options.bundleRoot, options);
  const preferred = bundle && snapshot ? entries.filter(entry =>
    inside(snapshot, sourcePath(entry.path, options)) || inside(bundle, identity(entry.path, options))) : [];
  const candidates = preferred.length ? preferred : entries;
  const unique = new Map<string, MetadataEntry>();
  for (const entry of candidates) {
    const key = `${entry.type}:${identity(entry.path, options)}`;
    const previous = unique.get(key);
    // The projector must receive the entry in the bundle's current snapshot.
    const inSnapshot = snapshot && inside(snapshot, sourcePath(entry.path, options));
    if (!previous || inSnapshot) unique.set(key, entry);
  }
  return [...unique.values()];
}

/** Retain the existing preference for canonical sources over packaged mirrors. */
export function preferCanonicalBindingTargets(matches: MetadataEntry[]): MetadataEntry[] {
  if (matches.length > 1) {
    const canonical = matches.filter(entry => !/(^|\/)agentic\/code\/plugins\//.test(entry.path.replace(/\\/g, '/')));
    if (canonical.length === 1) return canonical;
  }
  return matches;
}
