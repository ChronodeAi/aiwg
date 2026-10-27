// Host catalog for account-scoped Grok Bot replicas (#3232): two workspaces
// authorizing the same --grokbot-root produce one host copy and two
// references, and aggregates count each conversation once.
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOST_CATALOG_WORKSPACE_ID,
  SessionRepository,
  countUniqueSessionsAcross,
  countUniqueSessionsAcrossCatalogs,
  createSessionAdapterRegistry,
  defaultHostCatalogPath,
  dedupeSessionIdentities,
  discoverWorkspaceHistories,
  importDiscoveryManifest,
  indexIdentitiesBySessionId,
  isAccountScopedAdapter,
  mergeCrossCatalogRows,
  mergeSessionLists,
  resolveHostReferences,
  sha256,
  type HostSessionReference,
  type Session,
  type SessionDiscoveryManifest,
} from '../../../src/sessions/index.js';
import { GrokbotSessionAdapter } from '../../../src/sessions/adapters/grokbot.js';
import { grokbotTranscriptReplicaFilename } from '../../../src/sessions/adapters/grokbot-locator.js';
import { describeWithSqlite } from '../../helpers/sqlite.js';
import { mkdtemp } from '../../helpers/temp-dir.js';

afterEach(() => vi.unstubAllEnvs());

const ACCOUNT = 'synthtest01';
const CONVERSATIONS = [
  'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1',
  'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2',
];

describe('grokbot host catalog helpers (no sqlite required)', () => {
  it('marks the Grok Bot adapter as account-scoped', () => {
    expect(new GrokbotSessionAdapter().scopeClass).toBe('account');
    expect(isAccountScopedAdapter(new GrokbotSessionAdapter())).toBe(true);
    const registry = createSessionAdapterRegistry();
    expect(isAccountScopedAdapter(registry.get('codex'))).toBe(false);
  });

  it('resolves the host catalog path without touching HOME in tests', () => {
    const override = join(tmpdir(), 'aiwg-host-override.sqlite');
    vi.stubEnv('AIWG_SESSIONS_HOST_CATALOG', override);
    expect(defaultHostCatalogPath('/nonexistent-home')).toBe(override);
  });

  it('dedupes cross-catalog identities by provider+session', () => {
    const legacyA = { provider: 'grokbot', nativeSessionId: CONVERSATIONS[0], sessionId: 'legacy-a' };
    const legacyB = { provider: 'grokbot', nativeSessionId: CONVERSATIONS[0], sessionId: 'legacy-b' };
    const other = { provider: 'grokbot', nativeSessionId: CONVERSATIONS[1], sessionId: 'other' };
    expect(dedupeSessionIdentities([legacyA, legacyB, other])).toHaveLength(2);
    expect(countUniqueSessionsAcross([[legacyA], [legacyB], [other]])).toBe(2);
  });

  it('merges local rows with host references without doubling legacy copies', () => {
    const local = { provider: 'grokbot', nativeSessionId: CONVERSATIONS[0], sessionId: 'legacy' };
    const referenced = { provider: 'grokbot', nativeSessionId: CONVERSATIONS[0], sessionId: 'host' };
    expect(mergeSessionLists([local], [referenced])).toHaveLength(1);
    expect(mergeSessionLists([], [referenced])).toHaveLength(1);
  });

  it('counts two referencing workspaces plus a legacy copy as one session', () => {
    const conversation = CONVERSATIONS[0];
    const legacy = { provider: 'grokbot', nativeSessionId: conversation, sessionId: 'legacy-copy' };
    const host = { provider: 'grokbot', nativeSessionId: conversation, sessionId: 'host-copy' };
    const refA: HostSessionReference = {
      provider: 'grokbot', nativeSessionId: conversation,
      sessionId: 'host-copy', sourceId: 'host-source', hostCatalog: '/tmp/host.sqlite',
    };
    const refB: HostSessionReference = { ...refA };
    expect(countUniqueSessionsAcrossCatalogs([
      { identities: [legacy], references: [] },
      { identities: [], references: [refA] },
      { identities: [], references: [refB] },
      { identities: [host], references: [] },
    ])).toBe(1);
  });

  it('merges cross-catalog rows keeping local copies and deduping host repeats', () => {
    const conversation = CONVERSATIONS[0];
    const other = CONVERSATIONS[1];
    const localHit = { provider: 'grokbot', sessionId: 'legacy-session', eventId: 'legacy-event' };
    const hostHit = { provider: 'grokbot', sessionId: 'host-session', eventId: 'host-event' };
    const hostRepeat = { ...hostHit };
    const hostOther = { provider: 'grokbot', sessionId: 'host-other', eventId: 'host-other-event' };
    const localIdentities = indexIdentitiesBySessionId([
      { provider: 'grokbot', nativeSessionId: conversation, sessionId: 'legacy-session', sourceId: 'legacy-source' },
    ]);
    const hostIdentities = indexIdentitiesBySessionId([
      { provider: 'grokbot', nativeSessionId: conversation, sessionId: 'host-session', sourceId: 'host-source' },
      { provider: 'grokbot', nativeSessionId: other, sessionId: 'host-other', sourceId: 'host-source' },
    ]);
    const key = (hit: { provider: string; eventId: string }) => `${hit.provider} ${hit.eventId}`;
    // The legacy local hit wins over the same host session; the host-only
    // session is added once despite the repeated host row.
    const merged = mergeCrossCatalogRows([localHit], [hostHit, hostRepeat, hostOther], localIdentities, hostIdentities, key);
    expect(merged).toEqual([localHit, hostOther]);
    expect(mergeCrossCatalogRows([], [hostHit, hostRepeat], localIdentities, hostIdentities, key))
      .toEqual([hostHit]);
  });

  it('resolves workspace references to host sessions by provider+session', () => {
    const session = {
      provider: 'grokbot', nativeSessionId: CONVERSATIONS[0], sessionId: 'host-session',
    } as Session;
    const reference: HostSessionReference = {
      provider: 'grokbot', nativeSessionId: CONVERSATIONS[0],
      sessionId: 'host-session', sourceId: 'host-source', hostCatalog: '/tmp/host.sqlite',
    };
    const missing: HostSessionReference = {
      ...reference, nativeSessionId: CONVERSATIONS[1], sessionId: 'gone',
    };
    expect(resolveHostReferences([reference, missing], [session])).toEqual([session]);
  });
});

function entry(seq: number, conversation: string) {
  return {
    kind: 'message', id: `evt-${conversation}-${seq}`, role: 'user',
    content: `synthetic message ${seq} of ${conversation}`,
    timestampMs: 1_790_000_000_000 + seq, seq,
  };
}

async function writeReplica(root: string, conversation: string): Promise<void> {
  await writeFile(
    join(root, grokbotTranscriptReplicaFilename(ACCOUNT, conversation)),
    JSON.stringify({ schemaVersion: 1, value: { entries: [entry(1, conversation), entry(2, conversation)] } }),
  );
}

async function discover(workspace: string, grokbotRoot: string): Promise<SessionDiscoveryManifest> {
  return discoverWorkspaceHistories({
    workspace,
    expectedProviders: ['grokbot'],
    grokbotRoot,
    registry: createSessionAdapterRegistry(),
  });
}

describeWithSqlite('grokbot account-scoped host catalog imports', () => {
  it('imports each replica once into the host catalog and references it from both workspaces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-grokbot-host-'));
    const grokbotRoot = join(root, 'grokbot');
    await mkdir(grokbotRoot, { recursive: true });
    for (const conversation of CONVERSATIONS) await writeReplica(grokbotRoot, conversation);
    const workspaceA = join(root, 'workspace-a');
    const workspaceB = join(root, 'workspace-b');
    await mkdir(workspaceA, { recursive: true });
    await mkdir(workspaceB, { recursive: true });
    const hostPath = join(root, 'host-catalog.sqlite');
    const host = new SessionRepository(hostPath);
    const catalogA = new SessionRepository(join(root, 'catalog-a.sqlite'));
    const catalogB = new SessionRepository(join(root, 'catalog-b.sqlite'));
    try {
      const receiptA = await importDiscoveryManifest({
        manifest: await discover(workspaceA, grokbotRoot),
        repository: catalogA, hostRepository: host, hostCatalogPath: hostPath,
      });
      expect(receiptA.run.status).toBe('complete');
      expect(receiptA.totals.sessionsAccepted).toBe(2);

      const receiptB = await importDiscoveryManifest({
        manifest: await discover(workspaceB, grokbotRoot),
        repository: catalogB, hostRepository: host, hostCatalogPath: hostPath,
      });
      expect(receiptB.run.status).toBe('complete');

      // One host copy: the second workspace import adds no sessions.
      const hostIdentities = host.listSessionIdentities(HOST_CATALOG_WORKSPACE_ID);
      expect(hostIdentities).toHaveLength(2);
      expect(new Set(hostIdentities.map((identity) => identity.nativeSessionId)).size).toBe(2);
      expect(receiptB.totals.sessionsAccepted).toBe(0);

      // No copies in either workspace catalog: references instead.
      expect(catalogA.listSessionIdentities()).toHaveLength(0);
      expect(catalogB.listSessionIdentities()).toHaveLength(0);
      const refsA = catalogA.listHostSessionReferences();
      const refsB = catalogB.listHostSessionReferences();
      expect(refsA).toHaveLength(2);
      expect(refsB).toHaveLength(2);
      for (const reference of [...refsA, ...refsB]) {
        expect(reference.provider).toBe('grokbot');
        expect(reference.hostCatalog).toBe(hostPath);
      }

      // Aggregate counts are not doubled across the three catalogs.
      const aggregate = countUniqueSessionsAcross([
        catalogA.listSessionIdentities(),
        catalogB.listSessionIdentities(),
        hostIdentities,
      ]);
      expect(aggregate).toBe(2);

      // Workspace listing view resolves references through the host catalog.
      const hostSessions = host.listSessions({ limit: 100 });
      const resolved = resolveHostReferences(refsA, hostSessions.items);
      expect(resolved).toHaveLength(2);
      expect(mergeSessionLists([], resolved)).toHaveLength(2);
    } finally {
      catalogA.close();
      catalogB.close();
      host.close();
    }
  });

  it('counts legacy duplicated workspace copies once without deleting them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-grokbot-legacy-'));
    const grokbotRoot = join(root, 'grokbot');
    await mkdir(grokbotRoot, { recursive: true });
    for (const conversation of CONVERSATIONS) await writeReplica(grokbotRoot, conversation);
    const workspaceA = join(root, 'workspace-a');
    const workspaceB = join(root, 'workspace-b');
    await mkdir(workspaceA, { recursive: true });
    await mkdir(workspaceB, { recursive: true });
    const catalogA = new SessionRepository(join(root, 'catalog-a.sqlite'));
    const catalogB = new SessionRepository(join(root, 'catalog-b.sqlite'));
    try {
      // Legacy behavior: no host repository, so each workspace keeps a copy.
      // Rewrite sourceIds the pre-#3232 way so the rows look legacy.
      for (const [catalog, workspace] of [[catalogA, workspaceA], [catalogB, workspaceB]] as const) {
        const manifest = await discover(workspace, grokbotRoot);
        const legacySources = manifest.sources.map((source) => ({
          ...source,
          sourceId: sha256(['grokbot-native-source-v1', workspace, source.nativeSessionId ?? ''].join('\0')),
        }));
        const receipt = await importDiscoveryManifest({
          manifest: { ...manifest, sources: legacySources },
          repository: catalog,
        });
        expect(receipt.run.status).toBe('complete');
      }
      // Both catalogs hold readable copies: four rows for two conversations.
      const identitiesA = catalogA.listSessionIdentities();
      const identitiesB = catalogB.listSessionIdentities();
      expect(identitiesA).toHaveLength(2);
      expect(identitiesB).toHaveLength(2);
      expect(identitiesA[0].sessionId).not.toBe(identitiesB[0].sessionId);

      // Aggregation dedupes by provider+session: counted once, nothing deleted.
      expect(countUniqueSessionsAcross([identitiesA, identitiesB])).toBe(2);
      expect(catalogA.listSessionIdentities()).toHaveLength(2);
      expect(catalogB.listSessionIdentities()).toHaveLength(2);
    } finally {
      catalogA.close();
      catalogB.close();
    }
  });

  it('counts two referencing workspaces plus a legacy copied row as one session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-grokbot-aggregate-'));
    const grokbotRoot = join(root, 'grokbot');
    await mkdir(grokbotRoot, { recursive: true });
    await writeReplica(grokbotRoot, CONVERSATIONS[0]);
    const legacyWorkspace = join(root, 'workspace-legacy');
    const workspaceA = join(root, 'workspace-a');
    const workspaceB = join(root, 'workspace-b');
    await mkdir(legacyWorkspace, { recursive: true });
    await mkdir(workspaceA, { recursive: true });
    await mkdir(workspaceB, { recursive: true });
    const hostPath = join(root, 'host-catalog.sqlite');
    const host = new SessionRepository(hostPath);
    const legacy = new SessionRepository(join(root, 'catalog-legacy.sqlite'));
    const catalogA = new SessionRepository(join(root, 'catalog-a.sqlite'));
    const catalogB = new SessionRepository(join(root, 'catalog-b.sqlite'));
    try {
      // Legacy workspace: no host repository, so it keeps a copied row.
      const legacyReceipt = await importDiscoveryManifest({
        manifest: await discover(legacyWorkspace, grokbotRoot),
        repository: legacy,
      });
      expect(legacyReceipt.run.status).toBe('complete');
      expect(legacy.listSessionIdentities()).toHaveLength(1);
      for (const workspace of [workspaceA, workspaceB]) {
        const catalog = workspace === workspaceA ? catalogA : catalogB;
        const receipt = await importDiscoveryManifest({
          manifest: await discover(workspace, grokbotRoot),
          repository: catalog, hostRepository: host, hostCatalogPath: hostPath,
        });
        expect(receipt.run.status).toBe('complete');
      }
      expect(host.listSessionIdentities(HOST_CATALOG_WORKSPACE_ID)).toHaveLength(1);
      // Two references plus one copied row plus the host copy: one session.
      expect(countUniqueSessionsAcrossCatalogs([
        { identities: legacy.listSessionIdentities(), references: [] },
        { identities: catalogA.listSessionIdentities(), references: catalogA.listHostSessionReferences() },
        { identities: catalogB.listSessionIdentities(), references: catalogB.listHostSessionReferences() },
        { identities: host.listSessionIdentities(HOST_CATALOG_WORKSPACE_ID), references: [] },
      ])).toBe(1);
    } finally {
      legacy.close();
      catalogA.close();
      catalogB.close();
      host.close();
    }
  });
});
