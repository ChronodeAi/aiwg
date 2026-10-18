import {
  mkdir, mkdtemp, readFile, rm, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SessionRepository,
  discoverWorkspaceHistories,
  importDiscoveryManifest,
  publicDiscoveryManifest,
  redactSourceLocator,
  readDiscoveryManifest,
  sha256,
  writeDiscoveryManifest,
} from '../../../src/sessions/index.js';
import { itWithSqlite } from '../../helpers/sqlite.js';

const roots: string[] = [];

beforeEach(() => vi.stubEnv('CODEX_HOME', ''));
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('workspace session discovery and batch import', () => {
  it('discovers default, role-profile and CODEX_HOME roots with per-root counts', async () => {
    const fixture = await providerFixture();
    const roleRoot = join(fixture.providerHome, '.codex/roles-runtime/full/.codex/sessions');
    const emptyRoot = join(fixture.providerHome, '.codex/roles-runtime/empty/.codex/sessions');
    const missingRoot = join(fixture.providerHome, '.codex/roles-runtime/missing/.codex/sessions');
    const runtimeHome = join(fixture.root, 'runtime-codex');
    await writeCodexRollout(roleRoot, fixture.workspace, 'role');
    await writeCodexRollout(join(runtimeHome, 'sessions'), fixture.workspace, 'runtime');
    await mkdir(emptyRoot, { recursive: true });
    await mkdir(resolve(missingRoot, '..'), { recursive: true });
    vi.stubEnv('CODEX_HOME', runtimeHome);

    const manifest = await discoverWorkspaceHistories({
      workspace: fixture.workspace, providerHome: fixture.providerHome, expectedProviders: ['codex'],
    });
    expect(manifest.sources).toHaveLength(3);
    expect(manifest.authorizedRoots?.codex).toEqual(expect.arrayContaining([roleRoot, emptyRoot, join(runtimeHome, 'sessions')]));
    expect(manifest.providers[0].rootCounts).toEqual(expect.arrayContaining([
      { ...rootIdentity(roleRoot), status: 'checked', sourceCount: 1, duplicateCount: 0 },
      { ...rootIdentity(join(runtimeHome, 'sessions')), status: 'checked', sourceCount: 1, duplicateCount: 0 },
      { ...rootIdentity(emptyRoot), status: 'checked', sourceCount: 0, duplicateCount: 0 },
      { ...rootIdentity(missingRoot), status: 'unavailable', sourceCount: 0, duplicateCount: 0 },
    ]));
    const output = publicDiscoveryManifest(manifest);
    expect(JSON.stringify(output.providers)).not.toContain(fixture.providerHome);
    expect(JSON.stringify(manifest.providers)).not.toContain(fixture.providerHome);
    expect(new Set(manifest.providers[0].rootCounts?.map((root) => root.rootId)).size).toBe(5);
    expect((output.providers as Array<{ rootCounts: unknown[] }>)[0].rootCounts).toHaveLength(5);
    const path = join(fixture.workspace, 'manifest.json');
    await writeDiscoveryManifest(path, manifest);
    await expect(readDiscoveryManifest(path)).resolves.toEqual(manifest);
    const altered = JSON.parse(await readFile(path, 'utf8'));
    altered.providers[0].rootCounts[0].sourceCount += 1;
    await writeFile(path, JSON.stringify(altered));
    await expect(readDiscoveryManifest(path)).rejects.toThrow('identity does not match');
  });

  it('keeps automatic Codex roots behind provider-home authorization', async () => {
    const fixture = await providerFixture();
    vi.stubEnv('CODEX_HOME', join(fixture.providerHome, '.codex'));
    const manifest = await discoverWorkspaceHistories({
      workspace: fixture.workspace, operatorHome: fixture.providerHome, expectedProviders: ['codex'],
    });
    expect(manifest.sources).toEqual([]);
    expect(manifest.providers[0]).toMatchObject({
      reasonCode: 'SHARED_ROOT_AUTHORIZATION_REQUIRED', rootCounts: [],
    });
  });

  it('finds a role-only store once when CODEX_HOME names the same home', async () => {
    const fixture = await providerFixture();
    await rm(join(fixture.providerHome, '.codex/sessions'), { recursive: true });
    const roleHome = join(fixture.providerHome, '.codex/roles-runtime/full/.codex');
    await writeCodexRollout(join(roleHome, 'sessions'), fixture.workspace, 'role-only');
    vi.stubEnv('CODEX_HOME', roleHome);
    const manifest = await discoverWorkspaceHistories({
      workspace: fixture.workspace, providerHome: fixture.providerHome, expectedProviders: ['codex'],
    });
    expect(manifest.sources).toHaveLength(1);
    expect(manifest.authorizedRoots?.codex).toEqual([join(roleHome, 'sessions')]);
    expect(manifest.providers[0].rootCounts).toEqual([
      { ...rootIdentity(join(fixture.providerHome, '.codex/sessions')), status: 'unavailable', sourceCount: 0, duplicateCount: 0 },
      { ...rootIdentity(join(roleHome, 'sessions')), status: 'checked', sourceCount: 1, duplicateCount: 0 },
    ]);
  });

  it('reports zero per-root counts when every explicit Codex root is missing', async () => {
    const fixture = await providerFixture();
    const missing = join(fixture.root, 'missing');
    const manifest = await discoverWorkspaceHistories({
      workspace: fixture.workspace, codexRoots: [missing], expectedProviders: ['codex'],
    });
    expect(manifest.providers[0]).toMatchObject({
      status: 'unavailable', reasonCode: 'PROVIDER_ROOT_UNAVAILABLE',
      rootCounts: [{ ...rootIdentity(missing), status: 'unavailable', sourceCount: 0, duplicateCount: 0 }],
    });
  });

  it('deduplicates rollout IDs across explicit roots and canonical root aliases', async () => {
    const fixture = await providerFixture();
    const first = join(fixture.root, 'a');
    const second = join(fixture.root, 'b');
    const alias = join(fixture.root, 'alias');
    await writeCodexRollout(first, fixture.workspace, 'shared');
    await writeCodexRollout(second, fixture.workspace, 'shared', 'different-copy.jsonl');
    await writeFile(join(second, 'different-copy.jsonl'), '\n', { flag: 'a' });
    await writeCodexRollout(second, fixture.workspace, 'unique');
    await writeCodexRollout(second, join(fixture.root, 'other'), 'unrelated');
    await symlink(first, alias);
    vi.stubEnv('CODEX_HOME', join(fixture.providerHome, '.codex'));
    const manifest = await discoverWorkspaceHistories({
      workspace: fixture.workspace, providerHome: fixture.providerHome, expectedProviders: ['codex'],
      codexRoots: [first, second, alias, first],
    });
    expect(manifest.sources).toHaveLength(2);
    expect(manifest.authorizedRoots?.codex).toEqual([first, second]);
    expect(manifest.providers[0].rootCounts).toEqual([
      { ...rootIdentity(first), status: 'checked', sourceCount: 1, duplicateCount: 0 },
      { ...rootIdentity(second), status: 'checked', sourceCount: 1, duplicateCount: 1 },
    ]);
  });

  it('deduplicates rollout filename IDs and retains digest fallback for unidentified exports', async () => {
    const fixture = await providerFixture();
    const first = join(fixture.root, 'a');
    const second = join(fixture.root, 'b');
    const id = '00000000-0000-4000-8000-000000000325';
    const record = JSON.stringify({ type: 'turn_context', payload: { cwd: fixture.workspace } });
    await Promise.all([first, second].map((root) => mkdir(root)));
    await writeFile(join(first, `rollout-${id}.jsonl`), record + '\n');
    await writeFile(join(second, `copy-${id}.jsonl`), record + '\n\n');
    await writeFile(join(first, 'export.jsonl'), record + '\n\n\n');
    await writeFile(join(second, 'export.jsonl'), record + '\n\n\n');
    const manifest = await discoverWorkspaceHistories({
      workspace: fixture.workspace, codexRoots: [first, second], expectedProviders: ['codex'],
    });
    expect(manifest.sources).toHaveLength(2);
    expect(manifest.providers[0].rootCounts?.reduce((sum, root) => sum + root.duplicateCount, 0)).toBe(2);
  });

  it('restricts maintenance discovery to saved roots despite new role homes and CODEX_HOME', async () => {
    const fixture = await providerFixture();
    const initial = await discoverWorkspaceHistories({
      workspace: fixture.workspace, providerHome: fixture.providerHome, expectedProviders: ['codex'],
    });
    const roleHome = join(fixture.providerHome, '.codex/roles-runtime/new/.codex');
    await writeCodexRollout(join(roleHome, 'sessions'), fixture.workspace, 'new');
    vi.stubEnv('CODEX_HOME', roleHome);
    const refreshed = await discoverWorkspaceHistories({
      workspace: fixture.workspace, providerHome: fixture.providerHome, expectedProviders: ['codex'],
      authorizedRoots: initial.authorizedRoots,
    });
    expect(refreshed.authorizedRoots).toEqual(initial.authorizedRoots);
    expect(refreshed.sources).toEqual(initial.sources);
    expect((await discoverWorkspaceHistories({
      workspace: fixture.workspace, expectedProviders: ['codex'], authorizedRoots: {},
    })).sources).toEqual([]);
  });

  it('inventories only matching known roots, persists the exact manifest, and exposes export gaps', async () => {
    const fixture = await providerFixture();
    const manifest = await discoverWorkspaceHistories({
      workspace: fixture.workspace,
      providerHome: fixture.providerHome,
      createdAt: '2026-07-28T00:00:00.000Z',
    });
    expect(manifest.sources.map((source) => source.provider))
      .toEqual(['claude', 'codex', 'cursor', 'factory']);
    expect(manifest.sources.every((source) => source.locator.startsWith(fixture.providerHome)))
      .toBe(true);
    expect(manifest.providers.find((provider) => provider.provider === 'codex'))
      .toMatchObject({ status: 'checked', sourceCount: 1 });
    expect(manifest.providers.find((provider) => provider.provider === 'warp'))
      .toMatchObject({
        status: 'export-required',
        disposition: 'manual-export',
        reasonCode: 'EXPLICIT_EXPORT_REQUIRED',
      });
    expect(manifest.providers.find((provider) => provider.provider === 'generic'))
      .toMatchObject({ status: 'export-required' });

    const path = join(fixture.workspace, '.aiwg', 'sessions', 'manifest.json');
    await writeDiscoveryManifest(path, manifest);
    await expect(readDiscoveryManifest(path)).resolves.toEqual(manifest);
  });

  it('checks the account home when an isolated runtime HOME hides provider stores', async () => {
    const fixture = await providerFixture();
    const manifest = await discoverWorkspaceHistories({
      workspace: fixture.workspace,
      operatorHome: fixture.providerHome,
      codexRoot: join(fixture.providerHome, '.codex', 'sessions'),
      createdAt: '2026-07-28T00:00:00.000Z',
    });

    expect(manifest.providers.filter((provider) => provider.status === 'checked')
      .map((provider) => provider.provider))
      .toEqual(['claude', 'codex', 'cursor', 'factory']);
    expect(manifest.sources.map((source) => source.provider).sort())
      .toEqual(['claude', 'codex', 'cursor', 'factory']);
  });

  it('discovers Muse native logs only when --muse-root evidence matches the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-muse-discovery-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const museRoot = join(root, 'muse-sessions');
    const matching = join(museRoot, '2026', '09', '25', '00000000-0000-4000-8000-000000000002');
    const unrelated = join(museRoot, '2026', '09', '25', '00000000-0000-4000-8000-000000000003');
    await Promise.all([workspace, matching, unrelated].map((path) => mkdir(path, { recursive: true })));
    await writeFile(join(matching, 'session.jsonl'), JSON.stringify({
      schema_version: 1,
      id: 'matching',
      stream: { kind: 'session', id: '00000000-0000-4000-8000-000000000002' },
      sequence: 1,
      recorded_at: 1790349213957005,
      record_type: 'event',
      durability: 'durable',
      payload_type: 'runtime.session.metadata',
      payload_schema_version: 1,
      payload: { kind: 'metadata', record: { workspace_root: workspace } },
    }) + '\n');
    await writeFile(join(unrelated, 'session.jsonl'), JSON.stringify({
      schema_version: 1,
      id: 'unrelated',
      stream: { kind: 'session', id: '00000000-0000-4000-8000-000000000003' },
      sequence: 1,
      recorded_at: 1790349213957005,
      record_type: 'event',
      durability: 'durable',
      payload_type: 'runtime.session.metadata',
      payload_schema_version: 1,
      payload: { kind: 'metadata', record: { workspace_root: join(root, 'other-workspace') } },
    }) + '\n');

    const manifest = await discoverWorkspaceHistories({ workspace, museRoot });
    const museSources = manifest.sources.filter((source) => source.provider === 'muse');
    expect(museSources).toHaveLength(1);
    expect(museSources[0]).toMatchObject({
      locatorClass: 'muse-native-session-log',
      locator: join(matching, 'session.jsonl'),
    });
    expect((await discoverWorkspaceHistories({ workspace })).sources.filter(
      (source) => source.provider === 'muse',
    )).toHaveLength(0);
  });

  itWithSqlite('resumes only incomplete sources and reconciles partial coverage', async () => {
    const fixture = await providerFixture();
    const manifest = await discoverWorkspaceHistories({
      workspace: fixture.workspace,
      providerHome: fixture.providerHome,
      createdAt: new Date().toISOString(),
    });
    const repository = new SessionRepository(':memory:');
    try {
      const first = await importDiscoveryManifest({ manifest, repository });
      expect(first.totals).toMatchObject({
        discovered: 4,
        accepted: 4,
        rejected: 0,
        pending: 0,
      });
      expect(first.run.status).toBe('partial');
      expect(first.coverage).toMatchObject({
        status: 'partial',
        providers: { exportRequired: expect.arrayContaining(['warp', 'opencode']) },
        sources: { discovered: 4, accepted: 4 },
      });
      const second = await importDiscoveryManifest({ manifest, repository });
      expect(second.run.sources.every(
        (source) => source.status === 'previously-committed',
      )).toBe(true);
      expect(second.run.sources.every((source) => source.attempts === 1)).toBe(true);
      expect(repository.doctor()).toMatchObject({
        integrity: 'ok',
        indexIntegrity: 'ok',
        sources: 4,
        sessions: 4,
      });
    } finally {
      repository.close();
    }
  });

  itWithSqlite('reports the observed 304-discovered/35-accepted case without claiming completeness', async () => {
    const fixture = await providerFixture();
    const manifest = await discoverWorkspaceHistories({
      workspace: fixture.workspace,
      providerHome: fixture.providerHome,
    });
    const repository = new SessionRepository(':memory:');
    try {
      const run = {
        schemaVersion: '1.0.0' as const,
        runId: 'run-304',
        manifestId: 'manifest-304',
        manifestCreatedAt: new Date().toISOString(),
        workspaceId: manifest.workspaceId,
        status: 'partial' as const,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        providers: manifest.providers,
        sources: Array.from({ length: 304 }, (_, index) => ({
          sourceId: `source-${index}`,
          provider: 'codex',
          status: index < 35 ? 'committed' as const : 'rejected' as const,
          attempts: 1,
          sessionsAccepted: index < 35 ? 1 : 0,
          eventsAccepted: index < 35 ? 2 : 0,
          errorCode: index < 35 ? null : 'MALFORMED_SOURCE',
          diagnostic: index < 35 ? null : `source=source-${index} code=MALFORMED_SOURCE`,
          updatedAt: new Date().toISOString(),
        })),
      };
      repository.saveBatchImportRun(run);
      expect(repository.getCoverage(manifest.workspaceId)).toMatchObject({
        schemaVersion: '1.0.0',
        status: 'partial',
        sources: {
          discovered: 304,
          accepted: 35,
          rejected: 269,
        },
        sessionsAccepted: 35,
        eventsAccepted: 70,
        rejectionCounts: { MALFORMED_SOURCE: 269 },
        coverageRatio: 35 / 304,
      });
    } finally {
      repository.close();
    }
  });

  itWithSqlite.each([
    'run-saved',
    'source-staged',
    'before-publication',
    'after-publication',
  ] as const)('resumes idempotently after failure at the %s boundary', async (boundary) => {
    const fixture = await providerFixture();
    const manifest = await discoverWorkspaceHistories({
      workspace: fixture.workspace,
      providerHome: fixture.providerHome,
    });
    const repository = new SessionRepository(':memory:');
    let injected = false;
    try {
      await expect(importDiscoveryManifest({
        manifest,
        repository,
        fault(candidate) {
          if (!injected && candidate === boundary) {
            injected = true;
            throw new Error(`injected:${boundary}`);
          }
        },
      })).rejects.toThrow(`injected:${boundary}`);
      expect(repository.listSessions({
        workspaceId: manifest.workspaceId,
        limit: 20,
      }).total).toBe(boundary === 'after-publication' ? 4 : 0);
      const interrupted = repository.getBatchImportRunForManifest(
        manifest.manifestId,
        manifest.workspaceId,
      );
      expect(interrupted?.status).toBe('interrupted');

      const resumed = await importDiscoveryManifest({ manifest, repository });
      expect(resumed.totals).toMatchObject({
        discovered: 4,
        rejected: 0,
        pending: 0,
      });
      expect(repository.listSessions({
        workspaceId: manifest.workspaceId,
        limit: 20,
      }).total).toBe(4);
      expect(repository.doctor()).toMatchObject({
        integrity: 'ok',
        indexIntegrity: 'ok',
        sessions: 4,
      });
    } finally {
      repository.close();
    }
  });
});

function rootIdentity(root: string): { root: string; rootId: string } {
  return { root: redactSourceLocator(root), rootId: sha256(root) };
}

async function writeCodexRollout(root: string, workspace: string, id: string, filename = `${id}.jsonl`): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, filename), JSON.stringify({ type: 'session_meta', payload: { id, cwd: workspace } }) + '\n');
}

async function providerFixture(): Promise<{ root: string; workspace: string; providerHome: string }> {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-session-discovery-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const providerHome = join(root, 'home');
  await mkdir(workspace, { recursive: true });
  const key = workspace.replace(/\\/g, '/').replace(/[/:]+/g, '-');
  const cursorKey = workspace.replace(/\\/g, '/').replace(/^\/+/, '').replace(/[/:]+/g, '-');

  const claude = join(providerHome, '.claude', 'projects', key, 'claude.jsonl');
  const factory = join(providerHome, '.factory', 'sessions', key, 'factory.jsonl');
  const cursor = join(
    providerHome,
    '.cursor',
    'projects',
    cursorKey,
    'agent-transcripts',
    'cursor-session',
    'cursor-session.jsonl',
  );
  const codex = join(providerHome, '.codex', 'sessions', '2026', '07', 'rollout.jsonl');
  const unrelatedCodex = join(
    providerHome,
    '.codex',
    'sessions',
    '2026',
    '07',
    'unrelated.jsonl',
  );
  await Promise.all([claude, factory, cursor, codex, unrelatedCodex].map(
    (path) => mkdir(resolve(path, '..'), { recursive: true }),
  ));
  await writeFile(claude, [
    JSON.stringify({
      type: 'user',
      uuid: 'claude-user',
      sessionId: 'claude-session',
      timestamp: '2026-07-27T10:00:00.000Z',
      message: { role: 'user', content: 'Synthetic Claude request.' },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'claude-assistant',
      parentUuid: 'claude-user',
      sessionId: 'claude-session',
      timestamp: '2026-07-27T10:00:01.000Z',
      message: { role: 'assistant', content: 'Synthetic Claude response.' },
    }),
  ].join('\n') + '\n');
  await writeFile(factory, [
    JSON.stringify({
      type: 'session_start',
      id: 'factory-session',
      version: 2,
      cwd: workspace,
    }),
    JSON.stringify({
      type: 'message',
      id: 'factory-message',
      timestamp: '2026-07-27T11:00:00.000Z',
      message: { role: 'user', content: 'Synthetic Factory request.' },
    }),
  ].join('\n') + '\n');
  await writeFile(cursor, [
    JSON.stringify({
      role: 'user',
      timestamp: '2026-07-27T12:00:00.000Z',
      message: { content: 'Synthetic Cursor request.' },
    }),
    JSON.stringify({
      type: 'turn_ended',
      status: 'success',
      timestamp: '2026-07-27T12:00:01.000Z',
    }),
  ].join('\n') + '\n');
  await writeFile(codex, [
    JSON.stringify({
      timestamp: '2026-07-27T13:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'codex-session', cwd: workspace },
    }),
    JSON.stringify({
      timestamp: '2026-07-27T13:00:01.000Z',
      type: 'response_item',
      payload: {
        id: 'codex-message',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Synthetic Codex request.' }],
      },
    }),
  ].join('\n') + '\n');
  await writeFile(unrelatedCodex, JSON.stringify({
    timestamp: '2026-07-27T14:00:00.000Z',
    type: 'session_meta',
    payload: { id: 'unrelated-session', cwd: join(root, 'other-workspace') },
  }) + '\n');
  return { root, workspace, providerHome };
}
