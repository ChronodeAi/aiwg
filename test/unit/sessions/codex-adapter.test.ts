import { cp, mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CODEX_ADAPTER_VERSION,
  CodexSessionAdapter,
  IncrementalSessionImporter,
  SESSION_CONTRACT_VERSION,
  SessionRepository,
  SessionSourceAdapterRegistry,
  stableSessionId,
  type SelectedSource,
  type SessionSource,
} from '../../../src/sessions/index.js';
import { describeWithSqlite } from '../../helpers/sqlite.js';

const fixturesRoot = resolve('test/fixtures/sessions/codex');
const temporaryRoots: string[] = [];
const parentId = '019d0000-0000-7000-8000-000000000011';
const childId = '019d0000-0000-7000-8000-000000000012';
const childLineage = {
  forkedFromId: parentId,
  parentThreadId: parentId,
  depth: 1,
  agentPath: 'root/worker',
  agentNickname: 'Worker',
  subagentHistoryStartOrdinal: 106,
  threadSource: 'subagent',
};

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Codex session adapter', () => {
  it('publishes implemented API-first and rollout fallback capabilities', () => {
    const adapter = new CodexSessionAdapter();
    expect(adapter).toMatchObject({
      provider: 'codex',
      adapterVersion: CODEX_ADAPTER_VERSION,
      disposition: 'implemented',
      supportedOperations: ['discover', 'inspect', 'stream'],
      acquisitionModes: ['api', 'jsonl'],
    });
    const registry = new SessionSourceAdapterRegistry();
    registry.register(adapter);
    expect(registry.report('codex', {
      state: 'available',
      evidence: {
        adapterVersion: CODEX_ADAPTER_VERSION,
        sourceSchemaVersion: '1.0.0',
        verifiedAt: '2026-07-27',
        reference: 'docs/providers/codex-sessions.md',
      },
      reason: null,
      remediation: null,
    })).toMatchObject({
      provider: 'codex',
      classification: 'implemented',
      supportedOperations: ['discover', 'inspect', 'stream'],
      acquisitionModes: ['api', 'jsonl'],
    });
  });

  it('discovers authorized JSONL deterministically without following symlinks', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiwg-codex-discovery-'));
    temporaryRoots.push(root);
    await mkdir(resolve(root, 'nested'));
    await cp(resolve(fixturesRoot, 'threads.app-server.jsonl'), resolve(root, 'b.app-server.jsonl'));
    await cp(
      resolve(fixturesRoot, 'rollout-2026-07-27T10-00-00-019d0000-0000-7000-8000-000000000003.jsonl'),
      resolve(root, 'nested', 'a.jsonl'),
    );
    await symlink(resolve(root, 'nested'), resolve(root, 'linked'));
    const found = await collect(new CodexSessionAdapter().discover({
      workspaceId: 'workspace-fixture', allowedRoots: [root],
    }));
    expect(found.map((item) => basename(item.locator))).toEqual(['b.app-server.jsonl', 'a.jsonl']);
    expect(found.map((item) => item.locatorClass))
      .toEqual(['codex-app-server-jsonl', 'codex-rollout-jsonl']);
  });

  it('preserves App Server pagination, status, fork, compaction, archive, and delete evidence', async () => {
    const selected = selectedSource('threads.app-server.jsonl', 'codex-app-fixture');
    const adapter = new CodexSessionAdapter();
    expect(await adapter.inspect(selected)).toMatchObject({
      sourceSchemaVersion: '1.0.0',
      consistency: 'provisional',
    });
    const records = await collect(adapter.stream(selected));
    expect(records).toHaveLength(10);
    expect(records[0].extensions).toMatchObject({
      status: 'active',
      productVersion: '0.145.0',
      workspace: { cwdClass: '<workspace>', git: { branch: 'main', repositoryClass: '<repository>' } },
      pagination: { hasNext: true, hasBackwards: true },
      unknownFields: { futureThreadField: 'preserved' },
    });
    expect(records.find((record) => record.nativeSessionId.endsWith('0002'))?.extensions)
      .toMatchObject({ forkedFromId: expect.stringContaining('0001') });
    expect(records.some((record) => record.kind === 'summary')).toBe(true);
    expect(records.map((record) => record.extensions?.lifecycleEvent).filter(Boolean))
      .toEqual(['status-changed', 'archived', 'deleted']);
    expect(JSON.stringify(records)).not.toContain('/private/');
    expect(records.every((record) => record.extensions?.lineage === undefined
      && record.extensions?.inheritedFromId === undefined
      && record.extensions?.replayed === undefined)).toBe(true);
    expect((await adapter['readSource'](selected)).records).toEqual(records);
  });

  it('reads only complete rollout records and preserves durable replay provenance', async () => {
    const selected = selectedSource(
      'rollout-2026-07-27T10-00-00-019d0000-0000-7000-8000-000000000003.jsonl',
      'codex-rollout-fixture',
    );
    const adapter = new CodexSessionAdapter();
    expect(await adapter.inspect(selected)).toMatchObject({ consistency: 'provisional' });
    const records = await collect(adapter.stream(selected));
    expect(records).toHaveLength(5);
    expect(records.map((record) => record.kind)).toContain('summary');
    expect(records.every((record) =>
      (record.extensions?.provenance as any).durableReplay === true)).toBe(true);
    expect(records[0].extensions).toMatchObject({
      productVersion: '0.145.0',
      workspace: { cwdClass: '<workspace>' },
      unknownFields: { futureMeta: 'preserved' },
    });
    expect(JSON.stringify(records)).not.toContain('/private/');
    expect(new Set(records.map((record) => record.nativeSessionId)))
      .toEqual(new Set(['019d0000-0000-7000-8000-000000000003']));
    expect(records.every((record) => record.extensions?.lineage === undefined
      && record.extensions?.inheritedFromId === undefined
      && record.extensions?.replayed === undefined)).toBe(true);
    expect((await adapter['readSource'](selected)).records).toEqual(records);
  });

  it.each([true, false])('pins child identity and uses the history boundary with explicit ordinals %s', async (explicitOrdinals) => {
    const fixture = childRollout();
    if (!explicitOrdinals) {
      for (const record of fixture) delete record.ordinal;
      fixture[0].payload.subagent_history_start_ordinal = 6;
    }
    const selected = await syntheticRollout(fixture);
    const adapter = new CodexSessionAdapter();
    const records = await collect(adapter.stream(selected));
    expect(records).toHaveLength(9);
    expect(records.every((record) => record.nativeSessionId === childId)).toBe(true);
    for (const record of records) {
      expect(record.extensions?.lineage).toEqual({
        ...childLineage, subagentHistoryStartOrdinal: explicitOrdinals ? 106 : 6,
      });
    }
    expect(records.filter((record) => record.extensions?.replayed).map((record) => record.sequence))
      .toEqual([1, 2, 3, 4, 5]);
    expect(records.slice(1, 6).every((record) => record.extensions?.inheritedFromId === parentId)).toBe(true);
    expect(records[0].extensions?.replayed).toBeUndefined();
    expect(records[6].extensions?.replayed).toBeUndefined();
    expect((await adapter['readSource'](selected)).records).toEqual(records);
    expect(await collect(adapter.stream(selected, { value: '4' }))).toEqual(records.slice(4));
  });

  it.each(['turn_context', 'task_started'])('marks legacy parent replay until the child %s', async (turnStart) => {
    const fixture = [
      { type: 'session_meta', payload: { id: childId, forked_from_id: parentId } },
      { type: 'session_meta', payload: { id: parentId, forked_from_id: 'ancestor' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', text: 'parent' } },
      { type: turnStart === 'turn_context' ? turnStart : 'event_msg', payload: { type: turnStart } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', text: 'child' } },
    ];
    const selected = await syntheticRollout(fixture);
    const adapter = new CodexSessionAdapter();
    const records = await collect(adapter.stream(selected));
    expect(records.every((record) => record.nativeSessionId === childId)).toBe(true);
    expect(records.every((record) => (record.extensions?.lineage as any).forkedFromId === parentId)).toBe(true);
    expect(records.filter((record) => record.extensions?.replayed).map((record) => record.sequence))
      .toEqual([1, 2]);
    expect(records[1].extensions?.inheritedFromId).toBe(parentId);
    expect((await adapter['readSource'](selected)).records).toEqual(records);
    expect(await collect(adapter.stream(selected, { value: '2' }))).toEqual(records.slice(2));
  });

  it('takes lineage from thread-spawn metadata when top-level agent fields are absent', async () => {
    const fixture = childRollout();
    delete fixture[0].payload.agent_path;
    delete fixture[0].payload.agent_nickname;
    delete fixture[0].payload.forked_from_id;
    const records = await collect(new CodexSessionAdapter().stream(await syntheticRollout(fixture)));
    const { forkedFromId: _forkedFromId, ...spawnLineage } = childLineage;
    expect(records[0].extensions?.lineage).toEqual(spawnLineage);
    expect(records[4].extensions).toMatchObject({ inheritedFromId: parentId, replayed: true });
  });

  it('uses replayed metadata as the inherited parent when lineage is absent', async () => {
    const selected = await syntheticRollout([
      { type: 'session_meta', payload: { id: childId } },
      { type: 'session_meta', payload: { id: parentId } },
      { type: 'response_item', payload: { type: 'message', text: 'parent' } },
      { type: 'turn_context', payload: {} },
    ]);
    const records = await collect(new CodexSessionAdapter().stream(selected));
    expect(records.map((record) => record.nativeSessionId)).toEqual(Array(4).fill(childId));
    expect(records.slice(1, 3).every((record) => record.extensions?.inheritedFromId === parentId)).toBe(true);
    expect(records[3].extensions?.replayed).toBeUndefined();
  });

  it.each([
    ['unknown-major.app-server.jsonl', 'UNKNOWN_SCHEMA_MAJOR'],
    ['malformed.app-server.jsonl', 'MALFORMED_SOURCE'],
    ['drift.app-server.jsonl', 'SCHEMA_DRIFT'],
  ])('fails closed for %s', async (fixture, code) => {
    await expect(collect(new CodexSessionAdapter().stream(
      selectedSource(fixture, `codex-${fixture}`),
    ))).rejects.toMatchObject({ code });
  });

  it('rejects sources outside explicitly authorized roots', async () => {
    const selected = selectedSource('threads.app-server.jsonl', 'codex-auth');
    selected.authorizedScope.allowedRoots = [resolve(fixturesRoot, 'elsewhere')];
    await expect(new CodexSessionAdapter().inspect(selected))
      .rejects.toMatchObject({ code: 'SOURCE_NOT_AUTHORIZED' });
  });
});

describeWithSqlite('Codex adapter repository conformance', () => {
  it('imports parent and child rollouts as exactly two sessions with lineage and retained replay', async () => {
    const parent = await syntheticRollout([
      { type: 'session_meta', payload: { id: parentId } },
      { type: 'response_item', payload: { type: 'message', role: 'user', text: 'parent' } },
    ], 'parent-rollout');
    const child = await syntheticRollout(childRollout(), 'child-rollout');
    const repository = new SessionRepository();
    try {
      const importer = new IncrementalSessionImporter(repository);
      for (const selected of [parent, child]) {
        await importer.import({
          source: sourceFor(selected, 'provisional'), selectedSource: selected,
          adapter: new CodexSessionAdapter(), workspaceId: 'workspace-fixture', policyVersion: '1.0.0',
          limits: { batchSize: 1 },
        });
      }
      const sessions = repository.listSessions({ workspaceId: 'workspace-fixture', limit: 10 }).items;
      expect(sessions).toHaveLength(2);
      expect(sessions.map((session) => session.nativeSessionId).sort()).toEqual([parentId, childId]);
      const id = stableSessionId('codex', child.sourceId, childId);
      const lineage = repository.getSession(id)?.extensions['native.codex'];
      expect(lineage).toMatchObject({ lineage: {
        forkedFromId: parentId, parentThreadId: parentId, depth: 1, subagentHistoryStartOrdinal: 106,
        agentPath: '[REDACTED:path]', agentNickname: '[REDACTED:unclassified-field]',
        threadSource: '[REDACTED:content]',
      } });
      expect(lineage).not.toHaveProperty('inheritedFromId');
      expect(lineage).not.toHaveProperty('replayed');
      const events = repository.listEvents(id);
      expect(events).toHaveLength(9);
      expect(events.filter((event) => (event.extensions['native.codex'] as any).replayed)
        .map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
      expect(events[4].extensions['native.codex']).toMatchObject({ inheritedFromId: parentId, replayed: true });
      expect(repository.listEvents(stableSessionId('codex', parent.sourceId, parentId))).toHaveLength(2);
      expect(repository.doctor()).toMatchObject({ sessions: 2, events: 11 });
    } finally {
      repository.close();
    }
  });

  it('resumes a version 1.0.0 checkpoint inside parent replay with child identity and lineage', async () => {
    const selected = await syntheticRollout(childRollout());
    const repository = new SessionRepository();
    try {
      const importer = new IncrementalSessionImporter(repository);
      const request = {
        source: sourceFor(selected, 'provisional'), selectedSource: selected,
        adapter: new CodexSessionAdapter(), workspaceId: 'workspace-fixture', policyVersion: '1.0.0',
      };
      expect(request.adapter.adapterVersion).toBe('1.0.0');
      await expect(importer.import({ ...request, limits: { batchSize: 2, maxRecords: 4 } }))
        .rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED', failureReceipt: {
          resumableCheckpoint: { cursor: '4', recordsRead: 4, adapterVersion: '1.0.0' },
        } });
      const resumed = await importer.import({ ...request, adapter: new CodexSessionAdapter(), limits: { batchSize: 2 } });
      expect(resumed.reduce((sum, receipt) => sum + receipt.eventsInserted, 0)).toBe(5);
      expect(repository.getCheckpoint(selected.sourceId, '1.0.0')).toMatchObject({ cursor: '9', recordsRead: 9 });
      const id = stableSessionId('codex', selected.sourceId, childId);
      expect(repository.getSession(id)?.extensions['native.codex']).toMatchObject({ lineage: {
        forkedFromId: parentId, parentThreadId: parentId, depth: 1, subagentHistoryStartOrdinal: 106,
      } });
      const events = repository.listEvents(id);
      expect(events).toHaveLength(9);
      expect(events[4].extensions['native.codex']).toMatchObject({ inheritedFromId: parentId, replayed: true });
      expect(events[6].extensions['native.codex']).not.toHaveProperty('replayed');
      expect(repository.doctor()).toMatchObject({ sessions: 1, events: 9 });
      expect(await importer.import(request)).toEqual([]);
    } finally {
      repository.close();
    }
  });

  it('imports App Server evidence, redacts content, and replays as a no-op', async () => {
    const selected = selectedSource('threads.app-server.jsonl', 'codex-app-import');
    const source = sourceFor(selected, 'provisional');
    const repository = new SessionRepository();
    const importer = new IncrementalSessionImporter(repository);
    const request = {
      source, selectedSource: selected, adapter: new CodexSessionAdapter(),
      workspaceId: 'workspace-fixture', policyVersion: '1.0.0',
    };
    const first = await importer.import(request);
    expect(first.reduce((sum, receipt) => sum + receipt.eventsInserted, 0)).toBe(10);
    const id = stableSessionId('codex', source.sourceId, '019d0000-0000-7000-8000-000000000001');
    expect(repository.getSession(id)).toMatchObject({ lifecycle: 'active', consistency: 'provisional' });
    expect(repository.listEvents(id).some((event) =>
      event.searchableText.includes('synthetic@example.test'))).toBe(false);
    expect(await importer.import(request)).toEqual([]);
    repository.close();
  });

  it('leaves no partial normalized state for an unknown major', async () => {
    const selected = selectedSource('unknown-major.app-server.jsonl', 'codex-major-import');
    const repository = new SessionRepository();
    await expect(new IncrementalSessionImporter(repository).import({
      source: sourceFor(selected, 'provisional', '2.0.0'),
      selectedSource: selected, adapter: new CodexSessionAdapter(),
      workspaceId: 'workspace-fixture', policyVersion: '1.0.0',
    })).rejects.toMatchObject({ code: 'UNKNOWN_SCHEMA_MAJOR' });
    expect(repository.doctor()).toMatchObject({ sources: 0, sessions: 0, events: 0 });
    repository.close();
  });
});

function selectedSource(fixture: string, sourceId: string): SelectedSource {
  return {
    provider: 'codex',
    locator: resolve(fixturesRoot, fixture),
    locatorClass: fixture.endsWith('.app-server.jsonl')
      ? 'codex-app-server-jsonl'
      : 'codex-rollout-jsonl',
    sourceId,
    authorizedScope: { workspaceId: 'workspace-fixture', allowedRoots: [fixturesRoot] },
  };
}

function childRollout(): Array<{ type: string; ordinal?: number; payload: Record<string, any> }> {
  return [
    { type: 'session_meta', ordinal: 100, payload: {
      id: childId, forked_from_id: parentId, subagent_history_start_ordinal: 106,
      agent_path: 'root/worker', agent_nickname: 'Worker', thread_source: 'subagent',
      source: { subagent: { thread_spawn: {
        parent_thread_id: parentId, depth: 1, agent_path: 'root/worker', agent_nickname: 'Worker',
      } } },
    } },
    { type: 'session_meta', ordinal: 101, payload: { id: parentId, forked_from_id: 'ancestor' } },
    { type: 'event_msg', ordinal: 102, payload: { type: 'task_started' } },
    { type: 'turn_context', ordinal: 103, payload: { id: 'parent-turn' } },
    { type: 'response_item', ordinal: 104, payload: { type: 'message', role: 'user', text: 'parent' } },
    { type: 'event_msg', ordinal: 105, payload: { type: 'task_complete' } },
    { type: 'event_msg', ordinal: 106, payload: { type: 'task_started' } },
    { type: 'turn_context', ordinal: 107, payload: { id: 'child-turn' } },
    { type: 'response_item', ordinal: 108, payload: { type: 'message', role: 'assistant', text: 'child' } },
  ];
}

async function syntheticRollout(records: unknown[], sourceId = 'child-rollout'): Promise<SelectedSource> {
  const root = await mkdtemp(resolve(tmpdir(), 'aiwg-codex-rollout-'));
  temporaryRoots.push(root);
  // The first metadata ID takes precedence over the filename fallback.
  const locator = resolve(root, 'rollout-019d0000-0000-7000-8000-000000000099.jsonl');
  await writeFile(locator, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  return {
    provider: 'codex', locator, locatorClass: 'codex-rollout-jsonl', sourceId,
    authorizedScope: { workspaceId: 'workspace-fixture', allowedRoots: [root] },
  };
}

function sourceFor(
  selected: SelectedSource,
  consistency: 'provisional' | 'complete',
  sourceSchemaVersion = '1.0.0',
): SessionSource {
  return {
    contractVersion: SESSION_CONTRACT_VERSION,
    sourceId: selected.sourceId,
    provider: 'codex',
    providerProfile: 'app-server-v2-rollout-fallback',
    locatorClass: selected.locatorClass,
    redactedLocator: '<session-source>/fixture.jsonl',
    adapterVersion: CODEX_ADAPTER_VERSION,
    sourceSchemaVersion,
    disposition: 'implemented',
    operationalState: 'available',
    consistency,
    authorizedAt: '2026-07-27T00:00:00.000Z',
    extensions: { 'native.codex': {} },
  };
}


async function collect<T>(input: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = [];
  for await (const item of input) output.push(item);
  return output;
}
