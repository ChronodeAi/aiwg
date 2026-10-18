import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { requireFeaturePackage } from '../features/runtime.js';
import { readAiwgConfig } from '../config/aiwg-config.js';
import { createSessionAdapterRegistry } from './adapter-registry.js';
import { resolveImportLimits } from './import-limits.js';
import { acquireImportLease } from './import-lease.js';
import { SessionRepository } from './repository.js';
import { importDiscoveryManifest, type BatchImportReceipt } from './batch-import.js';
import {
  defaultDiscoveryManifestPath,
  discoverWorkspaceHistories,
  readDiscoveryManifest,
  writeDiscoveryManifest,
  type SessionDiscoveryManifest,
} from './workspace-discovery.js';
import type { SessionProviderId } from './contracts.js';

export function sessionRefreshAvailable(): boolean {
  try {
    const Database = requireFeaturePackage('better-sqlite3') as new (file: string) => { close(): void };
    const probe = new Database(':memory:');
    probe.close();
    return true;
  } catch {
    return false;
  }
}

/** Refresh an existing catalog without inferring or granting provider access. */
export async function refreshSessionCatalog(
  workspace: string,
  full: boolean,
  waitMs: number,
  signal?: AbortSignal,
  workspaceAliases: string[] = [],
  flags: { maxRecordBytes?: string | number; maxSourceBytes?: string | number } = {},
): Promise<string | BatchImportReceipt | BatchImportReceipt[] | undefined> {
  const canonicalWorkspace = realpathSync(workspace);
  const config = await readAiwgConfig(canonicalWorkspace);
  const limits = resolveImportLimits(config?.sessions?.import, flags);
  const database = path.join(workspace, '.aiwg/sessions/catalog.sqlite');
  const manifests: Array<{ path: string; manifest: SessionDiscoveryManifest }> = [];
  if (!full) {
    const paths = new Set([
      defaultDiscoveryManifestPath(canonicalWorkspace),
      ...(config?.sessions?.discovery_manifests ?? []).map(file => path.resolve(canonicalWorkspace, file)),
    ]);
    let found = false;
    for (const manifestPath of paths) {
      if (!existsSync(manifestPath)) continue;
      const previous = await readDiscoveryManifest(manifestPath);
      if (previous.workspaceId !== canonicalWorkspace) throw new Error('discovery manifest workspace mismatch');
      found = true;
      const authorizedRoots = previous.authorizedRoots ?? {};
      if (!previous.authorizedRoots) {
        for (const source of previous.sources) {
          const roots = authorizedRoots[source.provider] ??= [];
          if (!roots.includes(source.authorizedRoot)) roots.push(source.authorizedRoot);
        }
      }
      const providers = (Object.keys(authorizedRoots) as SessionProviderId[])
        .filter(provider => authorizedRoots[provider]?.length);
      if (!providers.length) continue;
      const manifest = await discoverWorkspaceHistories({
        workspace: canonicalWorkspace,
        workspaceAliases: [workspace, ...workspaceAliases],
        expectedProviders: providers,
        authorizedRoots,
        registry: createSessionAdapterRegistry(limits),
      });
      manifests.push({ path: manifestPath, manifest });
    }
    if (!found) return 'no authorized discovery manifest';
    if (!manifests.length) return 'no authorized provider roots';
  }
  const lease = await acquireImportLease(database, `index-refresh-${process.pid}`, { waitMs });
  try {
    const repository = new SessionRepository(database);
    try {
      if (full) repository.reindex();
      else {
        const receipts: BatchImportReceipt[] = [];
        for (const entry of manifests) {
          const prior = repository.getBatchImportRunForManifest(entry.manifest.manifestId, canonicalWorkspace);
          if (prior?.status === 'complete') continue;
          // Persist the exact discovered batch before its confirmed import.
          await writeDiscoveryManifest(entry.path, entry.manifest);
          const receipt = await importDiscoveryManifest({ manifest: entry.manifest, repository, signal, limits });
          if (receipt.totals.pending) {
            throw new Error(`session import incomplete: ${receipt.totals.rejected} rejected, ${receipt.totals.pending} pending`);
          }
          receipts.push(receipt);
        }
        if (!receipts.length) return 'unchanged';
        return receipts.length === 1 ? receipts[0] : receipts;
      }
    } finally {
      repository.close();
    }
  } finally {
    await lease.release();
  }
  return undefined;
}
