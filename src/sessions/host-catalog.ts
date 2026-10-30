// Host catalog for account-scoped session providers (#3232).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createSessionAdapterRegistry } from './adapter-registry.js';
import type { Session, SessionSourceAdapter } from './contracts.js';
import type { SessionRepository } from './repository.js';

/** Workspace id used for account-scoped sessions stored in the host catalog. */
export const HOST_CATALOG_WORKSPACE_ID = 'host' as const;

/** DDL for the workspace-catalog reference table (created by SessionRepository). */
export const HOST_REFERENCE_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS session_host_refs (
    provider TEXT NOT NULL, native_session_id TEXT NOT NULL,
    session_id TEXT NOT NULL, source_id TEXT NOT NULL,
    host_catalog TEXT NOT NULL,
    PRIMARY KEY(provider, native_session_id)
  );
  CREATE INDEX IF NOT EXISTS idx_session_host_refs_session
  ON session_host_refs(session_id);
`;

/** A workspace-catalog pointer at one account-scoped session stored in the host catalog. */
export interface HostSessionReference {
  provider: string;
  nativeSessionId: string;
  sessionId: string;
  sourceId: string;
  hostCatalog: string;
}

/** Minimal session identity shared by local rows, host rows, and references. */
export interface SessionIdentity {
  provider: string;
  nativeSessionId: string;
}

const HOST_CATALOG_ENV = 'AIWG_SESSIONS_HOST_CATALOG';

/** User-scope (host) catalog path; the env override exists so tests never touch HOME. */
export function defaultHostCatalogPath(homeDir: string = homedir()): string {
  const override = process.env[HOST_CATALOG_ENV]?.trim();
  if (override) return override;
  return join(homeDir, '.aiwg', 'sessions', 'host-catalog.sqlite');
}

/** Account-scoped adapters (Grok Bot today) route to the host catalog. */
export function isAccountScopedAdapter(adapter: Pick<SessionSourceAdapter, 'scopeClass'>): boolean {
  return adapter.scopeClass === 'account';
}

/**
 * Whether a discovery manifest holds any account-scoped source. Callers use
 * this to avoid creating or opening the host catalog when every source is
 * workspace-scoped. Unknown providers resolve to workspace scope.
 */
export function manifestNeedsHostCatalog(sources: ReadonlyArray<{ provider: string }>): boolean {
  if (sources.length === 0) return false;
  const registry = createSessionAdapterRegistry();
  return sources.some((source) => {
    try {
      return isAccountScopedAdapter(registry.get(source.provider));
    } catch {
      return false;
    }
  });
}

/** Aggregate identity: one account-scoped conversation counts once per provider. */
export function hostReferenceKey(identity: SessionIdentity): string {
  return `${identity.provider}\0${identity.nativeSessionId}`;
}

/** Drop cross-catalog duplicates, keeping the first row for each provider+session. */
export function dedupeSessionIdentities<T extends SessionIdentity>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = hostReferenceKey(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Count sessions across catalogs without doubling account-scoped replicas. */
export function countUniqueSessionsAcross(lists: ReadonlyArray<readonly SessionIdentity[]>): number {
  return dedupeSessionIdentities(lists.flat()).length;
}

/** Host sessions backing a workspace catalog's references (matched by provider+session). */
export function resolveHostReferences(
  references: readonly HostSessionReference[],
  hostSessions: readonly Session[],
): Session[] {
  const byKey = new Map(hostSessions.map((session) => [
    hostReferenceKey({ provider: session.provider, nativeSessionId: session.nativeSessionId }),
    session,
  ]));
  const resolved: Session[] = [];
  for (const reference of references) {
    const session = byKey.get(hostReferenceKey(reference));
    if (session) resolved.push(session);
  }
  return resolved;
}

/**
 * Workspace listing view: local rows plus referenced host sessions, with
 * legacy duplicated copies (same provider+session already stored locally)
 * counted once. Local rows win ties so workspace provenance is preserved.
 */
export function mergeSessionLists<T extends SessionIdentity>(local: readonly T[], referenced: readonly T[]): T[] {
  return dedupeSessionIdentities([...local, ...referenced]);
}

/** Sessions in a repository reduced to aggregate identities (legacy rows included). */
export function collectSessionIdentities(
  repository: SessionRepository,
  workspaceId?: string,
): SessionIdentity[] {
  return repository.listSessionIdentities(workspaceId);
}

/** One catalog's contribution to a cross-catalog aggregate (#3232). */
export interface CatalogSessionView {
  /** Visible session identities, including legacy copied rows. */
  identities: readonly SessionIdentity[];
  /** References at account-scoped sessions stored in a host catalog. */
  references: readonly HostSessionReference[];
}

/**
 * Count sessions across workspace and host catalogs without doubling
 * account-scoped replicas: two workspaces referencing the same host
 * session plus a legacy workspace holding a copied row count once.
 */
export function countUniqueSessionsAcrossCatalogs(views: readonly CatalogSessionView[]): number {
  return dedupeSessionIdentities(
    views.flatMap((view) => [...view.identities, ...view.references]),
  ).length;
}

/** Index visible identities by internal session id for merge lookups. */
export function indexIdentitiesBySessionId<T extends SessionIdentity & { sessionId: string }>(
  identities: readonly T[],
): Map<string, T> {
  return new Map(identities.map((identity) => [identity.sessionId, identity]));
}

/**
 * Merge local rows (search hits, analytics facts) with host-catalog rows,
 * counting each session once by provider + native session id. Every local
 * row is kept; a host row is dropped when the same session already has
 * local rows (a legacy copied row wins over its host reference, mirroring
 * mergeSessionLists, #3232) and host rows repeating across catalogs are
 * deduped by hostRowKey. An unreachable host catalog contributes no rows,
 * so local results are never lost.
 */
export function mergeCrossCatalogRows<T extends { provider: string; sessionId: string }>(
  localRows: readonly T[],
  hostRows: readonly T[],
  localIdentityBySessionId: ReadonlyMap<string, SessionIdentity>,
  hostIdentityBySessionId: ReadonlyMap<string, SessionIdentity>,
  hostRowKey: (row: T) => string,
): T[] {
  const localKeys = new Set<string>();
  for (const row of localRows) {
    const identity = localIdentityBySessionId.get(row.sessionId);
    if (identity) {
      localKeys.add(hostReferenceKey({ provider: row.provider, nativeSessionId: identity.nativeSessionId }));
    }
  }
  const seenHost = new Set<string>();
  const keptHost = hostRows.filter((row) => {
    const identity = hostIdentityBySessionId.get(row.sessionId);
    if (identity
      && localKeys.has(hostReferenceKey({ provider: row.provider, nativeSessionId: identity.nativeSessionId }))) {
      return false;
    }
    const key = hostRowKey(row);
    if (seenHost.has(key)) return false;
    seenHost.add(key);
    return true;
  });
  return [...localRows, ...keptHost];
}

/**
 * Publish staged account-scoped imports in the host catalog and record
 * workspace references instead of copies (#3232). Non-destructive: legacy
 * workspace rows are left untouched and stay readable.
 */
export function publishHostRoutedBatch(input: {
  hostRepository: SessionRepository;
  workspaceRepository: SessionRepository;
  batchRunId: string;
  sourceIds: string[];
  hostCatalogPath: string;
}): void {
  const accepted = new Set(input.sourceIds);
  input.hostRepository.commitStagedBatch(input.batchRunId, [...accepted]);
  for (const identity of input.hostRepository.listSessionIdentities(HOST_CATALOG_WORKSPACE_ID)) {
    if (!accepted.has(identity.sourceId)) continue;
    input.workspaceRepository.recordHostSessionReference({
      provider: identity.provider,
      nativeSessionId: identity.nativeSessionId,
      sessionId: identity.sessionId,
      sourceId: identity.sourceId,
      hostCatalog: input.hostCatalogPath,
    });
  }
}
