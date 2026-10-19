import fs from 'node:fs';
import path from 'node:path';

import { createHash } from 'node:crypto';
import { getGraphIndexDir } from './types.js';
import { acquireDirectoryLock, DirectoryLockContentionError } from './prebuilt-build-lock.js';

function readText(file: string): string {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

/** Resolve HEAD without spawning git, including worktrees and packed refs. */
function gitHead(root: string): string {
  let gitDir = path.join(root, '.git');
  const pointer = readText(gitDir).trim();
  if (pointer.startsWith('gitdir: ')) gitDir = path.resolve(root, pointer.slice(8));
  const head = readText(path.join(gitDir, 'HEAD')).trim();
  if (!head.startsWith('ref: ')) return head;
  const ref = head.slice(5);
  const common = readText(path.join(gitDir, 'commondir')).trim();
  const commonDir = common ? path.resolve(gitDir, common) : gitDir;
  return readText(path.join(gitDir, ref)).trim()
    || readText(path.join(commonDir, ref)).trim()
    || readText(path.join(commonDir, 'packed-refs')).split('\n').find(line => line.endsWith(` ${ref}`))
    || head;
}

/**
 * Bounded source probe: read package/HEAD and immediate bundle manifests only.
 * Never recurse through capability files. Uncommitted capability-only edits
 * require `aiwg refresh` (which forces reconciliation) or an explicit index build.
 */
function sourceFingerprint(root: string): string {
  const hash = createHash('sha256').update('framework-capabilities-v1');
  hash.update(path.resolve(root));
  try { hash.update(JSON.parse(readText(path.join(root, 'package.json'))).version ?? ''); } catch { /* fixture root */ }
  hash.update(gitHead(root));
  for (const kind of ['frameworks', 'addons', 'extensions', 'agents', 'behaviors']) {
    const dir = path.join(root, 'agentic/code', kind);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    hash.update(kind).update(readText(path.join(dir, 'manifest.json')));
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      hash.update(entry.name).update(readText(path.join(dir, entry.name, 'manifest.json')));
    }
  }
  return hash.digest('hex');
}

/** Stat signatures also notice manual rebuilds, deleted caches, and replacement indexes. */
function fileSignature(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch { return ''; }
}

interface CapabilityReceipt {
  source: string;
  index: string;
  fortemi?: string;
}

function readReceipt(file: string): CapabilityReceipt | null {
  try { return JSON.parse(readText(file)) as CapabilityReceipt; } catch { return null; }
}

/**
 * Reconcile only when a cheap source/index receipt changes. Contenders serve an
 * existing index after a short wait; cold starts wait for the first builder.
 * The shared directory lock recovers owners proven dead on this host.
 */
export async function refreshFrameworkCapabilities(
  root: string,
  syncFortemi = true,
  options: { force?: boolean } = {},
): Promise<void> {
  if (!['frameworks', 'addons', 'extensions', 'agents', 'behaviors']
    .some(dir => fs.existsSync(path.join(root, 'agentic/code', dir)))) return;
  const dir = getGraphIndexDir(root, 'framework');
  const receiptPath = path.join(dir, 'capability-sources.json');
  const metadataPath = path.join(dir, 'metadata.json');
  const fortemiDir = path.join(path.dirname(dir), 'fortemi-core', 'framework');
  const fortemiSignature = (): string => [
    'manifest.json', 'aiwg-fortemi-index-v2.json',
  ].map(file => fileSignature(path.join(fortemiDir, file))).join('|');
  const source = sourceFingerprint(root);
  const current = (): CapabilityReceipt => ({
    source, index: fileSignature(metadataPath), ...(syncFortemi ? { fortemi: fortemiSignature() } : {}),
  });
  const matches = (receipt: CapabilityReceipt | null, probe: CapabilityReceipt): boolean =>
    Boolean(!options.force && receipt && probe.index && receipt.source === probe.source
      && receipt.index === probe.index && (!syncFortemi || receipt.fortemi === probe.fortemi));
  if (matches(readReceipt(receiptPath), current())) return;

  let release: () => Promise<void>;
  try {
    release = await acquireDirectoryLock(path.join(dir, 'capability-refresh.lock'), {
      timeoutMs: fs.existsSync(metadataPath) ? 150 : 60_000,
      pollMs: 25,
      reclaimDeadOwner: true,
    });
  } catch (error) {
    if (error instanceof DirectoryLockContentionError && fs.existsSync(metadataPath)) return;
    throw error;
  }
  try {
    // Another process may have completed reconciliation while we waited.
    const receipt = readReceipt(receiptPath);
    const probe = current();
    if (matches(receipt, probe)) return;
    if (options.force || !receipt || !probe.index || receipt.source !== source || receipt.index !== probe.index) {
      const { buildIndex } = await import('./index-builder.js');
      await buildIndex(root, { graph: 'framework', explicit: false, quiet: true });
    }
    if (syncFortemi) {
      const { getFortemiCoreSyncStatus, syncFortemiCoreIndex } = await import('./fortemi-core-sync.js');
      const status = getFortemiCoreSyncStatus(root, 'framework');
      if (!status.built || status.stale) syncFortemiCoreIndex(root, { graph: 'framework' });
    }
    // Publish only after success. A failed rebuild/sync is retried next call.
    const temp = `${receiptPath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(current()));
    fs.renameSync(temp, receiptPath);
  } finally {
    await release();
  }
}

/** Installation is recorded in project config, independently of index coverage. */
export async function isCorpusBundleInstalled(
  cwd: string,
  root: string,
  kind: 'framework' | 'addon' | 'extension' | 'plugin' | null,
  id: string | null,
): Promise<boolean> {
  if (!kind || !id) return false;
  const { readAiwgConfigCandidate } = await import('../config/aiwg-config.js');
  const config = await readAiwgConfigCandidate(cwd);
  if (!config) return false;
  if (config.installed[id] || (kind === 'framework' && config.installed.all)) return true;
  try {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(root, 'agentic/code', `${kind}s`, id, 'manifest.json'), 'utf8',
    )) as { modeAliases?: string[] };
    return (manifest.modeAliases ?? []).some(alias => Boolean(config.installed[alias]));
  } catch {
    return false;
  }
}
