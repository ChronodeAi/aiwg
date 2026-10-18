import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { requireFeaturePackage } from '../features/runtime.js';
import { readAiwgConfig } from '../config/aiwg-config.js';
import { acquireImportLease } from './import-lease.js';
import { SessionRepository } from './repository.js';
import { importDiscoveryManifest } from './batch-import.js';
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
): Promise<string | undefined> {
  const canonicalWorkspace = realpathSync(workspace);
  const database = path.join(workspace, '.aiwg/sessions/catalog.sqlite');
  const manifests: Array<{ path: string; manifest: SessionDiscoveryManifest }> = [];
  if (!full) {
    const config = await readAiwgConfig(canonicalWorkspace);
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
      const providers = Object.keys(authorizedRoots) as SessionProviderId[];
      if (!providers.length) continue;
      const manifest = await discoverWorkspaceHistories({
        workspace: canonicalWorkspace,
        expectedProviders: providers,
        authorizedRoots,
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
        let imported = false;
        for (const entry of manifests) {
          const prior = repository.getBatchImportRunForManifest(entry.manifest.manifestId, canonicalWorkspace);
          if (prior?.status === 'complete') continue;
          // Persist the exact discovered batch before its confirmed import.
          await writeDiscoveryManifest(entry.path, entry.manifest);
          const receipt = await importDiscoveryManifest({ manifest: entry.manifest, repository, signal });
          if (receipt.totals.rejected || receipt.totals.pending) {
            throw new Error(`session import incomplete: ${receipt.totals.rejected} rejected, ${receipt.totals.pending} pending`);
          }
          imported = true;
        }
        if (!imported) return 'unchanged';
      }
    } finally {
      repository.close();
    }
  } finally {
    await lease.release();
  }
  return undefined;
}
