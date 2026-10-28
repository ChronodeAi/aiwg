import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GROK_BUILD_ACTIVE_FRESHNESS_MS,
  GROK_BUILD_ADAPTER_VERSION,
  GROK_BUILD_CLI_EXPORT_LOCATOR_CLASS,
  GROK_BUILD_CLI_EXPORT_SCHEMA_VERSION,
  GROK_BUILD_NATIVE_LOCATOR_CLASS,
  GROK_BUILD_NATIVE_SCHEMA_VERSION,
  GrokBuildSessionAdapter,
  discoverWorkspaceHistories,
  grokBuildLiveState,
  IncrementalSessionImporter,
  readGrokBuildActiveRegistry,
  SESSION_CONTRACT_VERSION,
  SessionRepository,
  SessionSourceAdapterRegistry,
  type SelectedSource,
  type SessionSource,
} from '../../../src/sessions/index.js';
import { describeWithSqlite } from '../../helpers/sqlite.js';

const fixturesRoot = resolve('test/fixtures/sessions/grok-build');
const nativeLayoutRoot = resolve(fixturesRoot, 'native-layout');
const roots: string[] = [];

function selected(name: string, locatorClass = GROK_BUILD_CLI_EXPORT_LOCATOR_CLASS): SelectedSource {
  return {
    provider: 'grok-build',
    locator: resolve(fixturesRoot, name),
    locatorClass,
    sourceId: `grok-build-${name}`,
    authorizedScope: { workspaceId: 'workspace-fixture', allowedRoots: [fixturesRoot] },
  };
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Grok Build session adapter', () => {
  const adapter = new GrokBuildSessionAdapter();

  it('registers separately from Grok Bot with native discovery and CLI export ingest', async () => {
    const registry = new SessionSourceAdapterRegistry();
    registry.register(adapter);
    expect(registry.report('grok-build', {
      state: 'available',
      evidence: {
        adapterVersion: GROK_BUILD_ADAPTER_VERSION,
        sourceSchemaVersion: GROK_BUILD_CLI_EXPORT_SCHEMA_VERSION,
        verifiedAt: '2026-09-21',
      },
      reason: null,
      remediation: null,
    })).toMatchObject({
      provider: 'grok-build',
      classification: 'implemented',
      supportedOperations: ['discover', 'inspect', 'stream'],
      acquisitionModes: ['manual-export', 'jsonl'],
    });
    await expect(collect(adapter.discover({
      workspaceId: 'workspace-fixture', allowedRoots: [],
    }))).rejects.toMatchObject({
      code: 'SOURCE_NOT_AUTHORIZED',
      message: expect.stringContaining('--grok-root'),
    });
  });

  it('reports export-required until --grok-root authorizes a sessions root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-grok-build-discovery-'));
    roots.push(root);
    const manifest = await discoverWorkspaceHistories({ workspace: root, providerHome: root });
    expect(manifest.providers.find((entry) => entry.provider === 'grok-build')).toMatchObject({
      status: 'export-required',
      disposition: 'manual-export',
      sourceCount: 0,
      reasonCode: 'SHARED_ROOT_AUTHORIZATION_REQUIRED',
      remediation: expect.stringContaining('--grok-build-root'),
    });
    expect(manifest.sources.some((source) => source.provider === 'grok-build')).toBe(false);
  });

  it('imports prompts, assistant output, and structured tool summaries with stable native identity', async () => {
    const source = selected('0199a111-1111-7111-8111-111111111111.md');
    await expect(adapter.inspect(source)).resolves.toEqual({
      sourceSchemaVersion: '1.0.0', consistency: 'complete', operationalState: 'available',
    });
    const first = await collect(adapter.stream(source));
    const second = await collect(adapter.stream(source));
    expect(second).toEqual(first);
    expect(first.map((record) => [record.kind, record.role, record.toolName])).toEqual([
      ['message', 'user', undefined],
      ['message', 'assistant', undefined],
      ['tool-call', 'tool', 'Read'],
      ['tool-call', 'tool', 'Execute'],
      ['message', 'user', undefined],
      ['message', 'assistant', undefined],
    ]);
    expect(first[0]).toMatchObject({
      nativeSessionId: '0199a111-1111-7111-8111-111111111111',
      occurredAt: undefined,
      extensions: {
        provenance: { product: 'grok-build', nativeStoreInspected: false },
        lossReport: { unavailableInCliExport: expect.arrayContaining([
          'timestamps', 'model', 'grokVersion', 'workingDirectory', 'attachments',
          'fileSnapshots', 'compaction', 'lineage', 'subagents',
        ]) },
      },
    });
  });

  it('rejects unsafe numeric export cursors instead of silently skipping every record', async () => {
    const source = selected('0199a111-1111-7111-8111-111111111111.md');
    for (const value of ['9007199254740992', '9'.repeat(400)]) {
      await expect(collect(adapter.stream(source, { value })))
        .rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
    }
  });

  it('covers documented CLI projections without inventing native mode or lineage data', async () => {
    const manifest = JSON.parse(await readFile(resolve(fixturesRoot, 'coverage.json'), 'utf8')) as {
      status: string;
      releasedBinaryNativeFixtureVersion: string | null;
      cases: Array<{ scenario: string; file: string; evidence: string }>;
    };
    expect(manifest.status).toBe('synthetic-cli-contract-only');
    expect(manifest.releasedBinaryNativeFixtureVersion).toBeNull();
    expect(manifest.cases.map((item) => item.scenario)).toEqual([
      'tui', 'headless', 'acp', 'compaction', 'resumed-forked', 'subagents',
      'attachments-snapshots', 'partial', 'corrupt', 'changed-heading',
    ]);
    for (const item of manifest.cases) {
      if (item.scenario === 'corrupt' || item.scenario === 'changed-heading') continue;
      const records = await collect(adapter.stream(selected(item.file)));
      expect(records.length, item.scenario).toBeGreaterThan(0);
      for (const record of records) {
        expect(record.occurredAt).toBeUndefined();
        expect(record.model).toBeUndefined();
        expect(record.extensions).toMatchObject({
          lossReport: { unavailableInCliExport: expect.arrayContaining([
            'grokVersion', 'workingDirectory', 'compaction', 'lineage',
            'subagents', 'attachments', 'fileSnapshots',
          ]) },
        });
      }
    }
  });

  it('rejects unknown headings after a valid block and oversized tool blocks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-grok-build-drift-'));
    roots.push(root);
    const laterHeading = join(root, '0199abbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb.md');
    await writeFile(laterHeading, '## User\n\nHello.\n\n## System\n\nChanged structure.\n');
    const oversizeTools = join(root, '0199accc-cccc-7ccc-8ccc-cccccccccccc.md');
    await writeFile(oversizeTools, `## User\n\nHello.\n\n## Tools\n\n${'- Read: synthetic\n'.repeat(1001)}`);
    for (const path of [laterHeading, oversizeTools]) {
      await expect(adapter.inspect({
        provider: 'grok-build', locator: path,
        locatorClass: GROK_BUILD_CLI_EXPORT_LOCATOR_CLASS,
        sourceId: path,
        authorizedScope: { workspaceId: 'workspace', allowedRoots: [root] },
      })).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
    }
  });

  it('fails closed for changed headings, native/Cursor locator classes, and missing CLI IDs', async () => {
    await expect(adapter.inspect(selected('0199a444-4444-7444-8444-444444444444.md')))
      .rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
    await expect(adapter.inspect(selected(
      '0199a111-1111-7111-8111-111111111111.md', 'grok-build-native-updates-jsonl',
    ))).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    await expect(adapter.inspect(selected(
      '0199a111-1111-7111-8111-111111111111.md', 'cursor-agent-transcript-jsonl',
    ))).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    await expect(adapter.inspect(selected('README.md')))
      .rejects.toMatchObject({ code: 'MALFORMED_SOURCE' });
  });

  it('rejects symlink escapes before reading the export', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-grok-build-session-'));
    roots.push(root);
    const outside = join(dirname(root), '0199afff-ffff-7fff-8fff-ffffffffffff.md');
    await writeFile(outside, '## User\n\noutside\n');
    roots.push(outside);
    const link = join(root, '0199afff-ffff-7fff-8fff-ffffffffffff.md');
    await symlink(outside, link);
    await expect(adapter.inspect({
      provider: 'grok-build', locator: link,
      locatorClass: GROK_BUILD_CLI_EXPORT_LOCATOR_CLASS,
      sourceId: 'symlink',
      authorizedScope: { workspaceId: 'workspace', allowedRoots: [root] },
    })).rejects.toMatchObject({ code: 'SOURCE_SYMLINK' });
  });
});

describe('Grok Build native chat_history discovery', () => {
  const native = new GrokBuildSessionAdapter();
  const sessionA = '0199b111-1111-7111-8111-111111111111';
  const sessionALocator = resolve(
    nativeLayoutRoot, '%2Fsynthetic%2Fgrok-workspace', sessionA, 'chat_history.jsonl',
  );

  function nativeSource(locator: string, allowedRoots: string[]): SelectedSource {
    return {
      provider: 'grok-build',
      locator,
      locatorClass: GROK_BUILD_NATIVE_LOCATOR_CLASS,
      sourceId: `grok-build-native-${locator}`,
      authorizedScope: { workspaceId: 'workspace-fixture', allowedRoots },
    };
  }

  async function buildLayout(entries: Array<{ workspace: string; sessionId: string; lines: string[] }>): Promise<string> {
    const { mkdir, writeFile: write } = await import('node:fs/promises');
    const sessionsRoot = await mkdtemp(join(tmpdir(), 'aiwg-grok-build-native-'));
    roots.push(sessionsRoot);
    for (const entry of entries) {
      const directory = join(sessionsRoot, encodeURIComponent(entry.workspace), entry.sessionId);
      await mkdir(directory, { recursive: true });
      await write(join(directory, 'chat_history.jsonl'), entry.lines.join('\n') + '\n');
    }
    return sessionsRoot;
  }

  function nativeLines(sessionId: string, suffix = ''): string[] {
    return [
      `{"schemaVersion":1,"sessionId":"${sessionId}","seq":0,"role":"user","content":"user${suffix}","timestamp":1785153600}`,
      `{"schemaVersion":1,"sessionId":"${sessionId}","seq":1,"role":"assistant","content":"assistant${suffix}","timestamp":1785153601}`,
    ];
  }

  it('discovers only the documented two levels and the exact filename', async () => {
    const sessionsRoot = await buildLayout([]);
    const { mkdir, writeFile: write } = await import('node:fs/promises');
    // Decoys: index database, stray files, non-UUID session dirs, bad encodings.
    await write(join(sessionsRoot, 'session_search.sqlite'), 'decoy');
    await write(join(sessionsRoot, 'notes.txt'), 'decoy');
    await mkdir(join(sessionsRoot, encodeURIComponent('/synthetic/ws'), 'not-a-uuid'), { recursive: true });
    await write(join(sessionsRoot, encodeURIComponent('/synthetic/ws'), 'not-a-uuid', 'chat_history.jsonl'), '{}\n');
    await mkdir(join(sessionsRoot, '%ZZ', sessionA), { recursive: true });
    const encoded = encodeURIComponent('/synthetic/ws');
    await mkdir(join(sessionsRoot, encoded, sessionA), { recursive: true });
    await write(join(sessionsRoot, encoded, sessionA, 'chat_history.jsonl'), nativeLines(sessionA).join('\n') + '\n');
    await write(join(sessionsRoot, encoded, sessionA, 'other.jsonl'), nativeLines(sessionA).join('\n') + '\n');
    const found = await collect(native.discover({ workspaceId: 'ws', allowedRoots: [sessionsRoot] }));
    expect(found).toEqual([{
      provider: 'grok-build',
      locator: join(sessionsRoot, encoded, sessionA, 'chat_history.jsonl'),
      locatorClass: GROK_BUILD_NATIVE_LOCATOR_CLASS,
      nativeSessionId: sessionA,
    }]);
  });

  it('enforces the authorized file limit without reading source content', async () => {
    const sessionsRoot = await buildLayout([
      { workspace: '/synthetic/a', sessionId: sessionA, lines: nativeLines(sessionA) },
      { workspace: '/synthetic/b', sessionId: '0199b222-2222-7222-8222-222222222222', lines: nativeLines('x') },
    ]);
    const limited = new GrokBuildSessionAdapter(undefined, 1);
    await expect(collect(limited.discover({ workspaceId: 'ws', allowedRoots: [sessionsRoot] })))
      .rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
  });

  it('inspects and streams native records with stable identity, timestamps, and cursors', async () => {
    const source = nativeSource(sessionALocator, [nativeLayoutRoot]);
    await expect(native.inspect(source)).resolves.toEqual({
      sourceSchemaVersion: GROK_BUILD_NATIVE_SCHEMA_VERSION,
      consistency: 'complete',
      operationalState: 'available',
    });
    const records = await collect(native.stream(source));
    expect(records.map((record) => [record.kind, record.role, record.toolName])).toEqual([
      ['message', 'user', undefined],
      ['message', 'assistant', undefined],
      ['tool-call', 'tool', 'Read'],
      ['message', 'user', undefined],
    ]);
    expect(records[0]).toMatchObject({
      nativeSessionId: sessionA,
      nativeEventId: `${sessionA}:0`,
      occurredAt: new Date(1785153600 * 1000).toISOString(),
      text: 'Inspect the synthetic project.',
      extensions: {
        provenance: {
          product: 'grok-build',
          acquisition: GROK_BUILD_NATIVE_LOCATOR_CLASS,
          nativeStoreInspected: true,
        },
      },
    });
    expect(records[2]).toMatchObject({ toolName: 'Read', toolCallId: 'call-1' });
    const resumed = await collect(native.stream(source, { value: '2' }));
    expect(resumed.map((record) => record.nativeEventId)).toEqual([`${sessionA}:2`, `${sessionA}:3`]);
    expect(await collect(native.stream(source))).toEqual(records);
  });

  it('fails closed on session mismatch, unknown schemas, unordered, and tool records', async () => {
    const sessionsRoot = await buildLayout([]);
    const { mkdir, writeFile: write } = await import('node:fs/promises');
    const encoded = encodeURIComponent('/synthetic/ws');
    const cases: Array<{ sessionId: string; lines: string[]; code: string }> = [
      {
        sessionId: sessionA,
        lines: [`{"schemaVersion":1,"sessionId":"0199b999-9999-7999-8999-999999999999","seq":0,"role":"user","content":"x"}`],
        code: 'SCHEMA_DRIFT',
      },
      {
        sessionId: sessionA,
        lines: [`{"schemaVersion":999,"sessionId":"${sessionA}","seq":0,"role":"user","content":"x"}`],
        code: 'UNKNOWN_SCHEMA_MAJOR',
      },
      {
        sessionId: sessionA,
        lines: [
          `{"schemaVersion":1,"sessionId":"${sessionA}","seq":1,"role":"user","content":"x"}`,
          `{"schemaVersion":1,"sessionId":"${sessionA}","seq":1,"role":"user","content":"y"}`,
        ],
        code: 'SCHEMA_DRIFT',
      },
      {
        sessionId: sessionA,
        lines: [`{"schemaVersion":1,"sessionId":"${sessionA}","seq":0,"role":"tool","content":"x"}`],
        code: 'SCHEMA_DRIFT',
      },
      { sessionId: sessionA, lines: ['not json'], code: 'MALFORMED_SOURCE' },
    ];
    for (const [index, item] of cases.entries()) {
      const directory = join(sessionsRoot, encoded, `${sessionA.slice(0, 24)}${String(index).padStart(12, '0')}`);
      await mkdir(directory, { recursive: true });
      const locator = join(directory, 'chat_history.jsonl');
      await write(locator, item.lines.join('\n') + '\n');
      await expect(native.inspect(nativeSource(locator, [sessionsRoot])), `case ${index}`)
        .rejects.toMatchObject({ code: item.code });
    }
  });

  it('refuses roots outside the explicit authorization', async () => {
    const source = nativeSource(sessionALocator, [resolve(tmpdir(), 'aiwg-grok-build-nope')]);
    await expect(native.inspect(source)).rejects.toMatchObject({ code: 'SOURCE_NOT_AUTHORIZED' });
    const outside = nativeSource(sessionALocator, [nativeLayoutRoot, resolve('test/fixtures/sessions/codex')].slice(1));
    await expect(native.inspect(outside)).rejects.toMatchObject({ code: 'SOURCE_OUTSIDE_ALLOWED_ROOT' });
  });

  it('discovers only the authorized workspace and never attaches other workspaces', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'aiwg-grok-build-workspace-'));
    roots.push(workspace);
    const other = await mkdtemp(join(tmpdir(), 'aiwg-grok-build-other-'));
    roots.push(other);
    const sessionsRoot = await buildLayout([
      { workspace, sessionId: sessionA, lines: nativeLines(sessionA) },
      { workspace: other, sessionId: '0199b222-2222-7222-8222-222222222222', lines: nativeLines('0199b222-2222-7222-8222-222222222222') },
    ]);
    const manifest = await discoverWorkspaceHistories({
      workspace,
      providerHome: workspace,
      expectedProviders: ['grok-build'],
      grokRoot: sessionsRoot,
    });
    expect(manifest.providers.find((entry) => entry.provider === 'grok-build')).toMatchObject({
      status: 'checked',
      disposition: 'discoverable',
      sourceCount: 1,
    });
    expect(manifest.sources.filter((source) => source.provider === 'grok-build')).toHaveLength(1);
    expect(manifest.sources[0]).toMatchObject({
      provider: 'grok-build',
      locatorClass: GROK_BUILD_NATIVE_LOCATOR_CLASS,
      nativeSessionId: sessionA,
    });
    expect(manifest.sources[0]?.liveEvidence).toMatchObject({ state: 'unknown', basis: 'none' });
  });

  it('feeds live detection only from the explicitly authorized registry file', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'aiwg-grok-build-live-'));
    roots.push(workspace);
    const sessionsRoot = await buildLayout([
      { workspace, sessionId: sessionA, lines: nativeLines(sessionA) },
    ]);
    const { writeFile: write } = await import('node:fs/promises');
    const registryPath = join(workspace, 'active_sessions.json');
    await write(registryPath, JSON.stringify({
      schemaVersion: 1,
      sessions: [{ sessionId: sessionA, cwd: workspace, lastHeartbeatAt: Date.now() }],
    }));
    const manifest = await discoverWorkspaceHistories({
      workspace,
      providerHome: workspace,
      expectedProviders: ['grok-build'],
      grokRoot: sessionsRoot,
      grokActiveSessions: registryPath,
      createdAt: new Date().toISOString(),
    });
    const [source] = manifest.sources.filter((item) => item.provider === 'grok-build');
    expect(source?.liveEvidence).toMatchObject({
      state: 'active',
      basis: 'grok-active-sessions',
      reasonCode: 'FRESH_HEARTBEAT',
    });
    expect(typeof source?.liveEvidence?.observedAt).toBe('string');
    expect(typeof source?.liveEvidence?.expiresAt).toBe('string');
    // The sessions root alone never grants its parent: a sibling registry is unread.
    const sibling = join(sessionsRoot, 'active_sessions.json');
    await write(sibling, JSON.stringify({
      schemaVersion: 1,
      sessions: [{ sessionId: sessionA, lastHeartbeatAt: Date.now() }],
    }));
    const without = await discoverWorkspaceHistories({
      workspace,
      providerHome: workspace,
      expectedProviders: ['grok-build'],
      grokRoot: sessionsRoot,
    });
    expect(without.sources.find((item) => item.provider === 'grok-build')?.liveEvidence)
      .toMatchObject({ state: 'unknown', basis: 'none' });
  });

  it('validates the synthetic active registry shape and heartbeat states without disk reads', async () => {
    const registry = await readGrokBuildActiveRegistry(
      resolve(fixturesRoot, 'native-active-sessions.json'), [fixturesRoot],
    );
    expect(registry.sessions).toHaveLength(2);
    // Fixture heartbeats are fixed synthetic timestamps, long stale by now.
    expect(grokBuildLiveState(registry, sessionA)).toMatchObject({ state: 'unknown', reasonCode: 'STALE_HEARTBEAT' });
    expect(grokBuildLiveState(registry, '0199b999-9999-7999-8999-999999999999'))
      .toMatchObject({ state: 'unknown', reasonCode: 'SESSION_NOT_LISTED' });
    expect(grokBuildLiveState(null, sessionA))
      .toMatchObject({ state: 'unknown', basis: 'none' });
    const fresh = {
      schemaVersion: 1 as const,
      sessions: [{ sessionId: sessionA, lastHeartbeatAt: Date.now() }],
    };
    expect(grokBuildLiveState(fresh, sessionA).state).toBe('active');
    expect(grokBuildLiveState(
      { schemaVersion: 1 as const, sessions: [{ sessionId: sessionA, lastHeartbeatAt: Date.now() + 60_000 }] },
      sessionA,
    )).toMatchObject({ state: 'unknown', reasonCode: 'FUTURE_HEARTBEAT' });
    expect(GROK_BUILD_ACTIVE_FRESHNESS_MS).toBe(120_000);
  });
});

describeWithSqlite('Grok Build adapter repository conformance', () => {
  it('is idempotent and keeps resumed/fork lineage unknown when the CLI export omits it', async () => {
    const adapter = new GrokBuildSessionAdapter();
    const selectedSource = selected('0199a222-2222-7222-8222-222222222222.md');
    const source: SessionSource = {
      contractVersion: SESSION_CONTRACT_VERSION,
      sourceId: selectedSource.sourceId,
      provider: 'grok-build',
      providerProfile: 'documented-cli-markdown-export',
      locatorClass: selectedSource.locatorClass,
      redactedLocator: '<session-source>/0199a222.md',
      adapterVersion: GROK_BUILD_ADAPTER_VERSION,
      sourceSchemaVersion: GROK_BUILD_CLI_EXPORT_SCHEMA_VERSION,
      disposition: 'implemented', operationalState: 'available', consistency: 'complete',
      authorizedAt: '2026-09-21T00:00:00.000Z',
      extensions: { 'native.grok-build': { nativeParsing: false } },
    };
    const repository = new SessionRepository();
    try {
      const importer = new IncrementalSessionImporter(repository);
      const request = {
        source, selectedSource, adapter, workspaceId: 'workspace-fixture', policyVersion: '1.0.0',
      };
      expect((await importer.import(request)).reduce((sum, receipt) => sum + receipt.eventsInserted, 0)).toBe(2);
      expect(await importer.import(request)).toEqual([]);
      const sessions = repository.listSessions({ workspaceId: 'workspace-fixture', limit: 10 });
      expect(sessions.total).toBe(1);
      expect(sessions.items[0]?.extensions).toMatchObject({
        'native.grok-build': { lifecycleEvidence: { state: 'unknown' } },
      });
    } finally {
      repository.close();
    }
  });

  it('imports a native chat_history source with stable identity and idempotent replay', async () => {
    const adapter = new GrokBuildSessionAdapter();
    const locator = resolve(
      nativeLayoutRoot, '%2Fsynthetic%2Fgrok-workspace',
      '0199b111-1111-7111-8111-111111111111', 'chat_history.jsonl',
    );
    const selectedSource: SelectedSource = {
      provider: 'grok-build',
      locator,
      locatorClass: GROK_BUILD_NATIVE_LOCATOR_CLASS,
      sourceId: 'grok-build-native-import',
      authorizedScope: { workspaceId: 'workspace-fixture', allowedRoots: [nativeLayoutRoot] },
    };
    const source: SessionSource = {
      contractVersion: SESSION_CONTRACT_VERSION,
      sourceId: selectedSource.sourceId,
      provider: 'grok-build',
      providerProfile: 'grok-build-native-chat-history-v1',
      locatorClass: selectedSource.locatorClass,
      redactedLocator: '<session-source>/chat_history.jsonl',
      adapterVersion: GROK_BUILD_ADAPTER_VERSION,
      sourceSchemaVersion: GROK_BUILD_NATIVE_SCHEMA_VERSION,
      disposition: 'implemented', operationalState: 'available', consistency: 'complete',
      authorizedAt: '2026-10-18T00:00:00.000Z',
      extensions: { 'native.grok-build': { acquisition: GROK_BUILD_NATIVE_LOCATOR_CLASS } },
    };
    const repository = new SessionRepository();
    try {
      const importer = new IncrementalSessionImporter(repository);
      const request = {
        source, selectedSource, adapter, workspaceId: 'workspace-fixture', policyVersion: '1.0.0',
      };
      const receipts = await importer.import(request);
      expect(receipts.reduce((sum, receipt) => sum + receipt.eventsInserted, 0)).toBe(4);
      expect(await importer.import(request)).toEqual([]);
      const sessions = repository.listSessions({ workspaceId: 'workspace-fixture', limit: 10 });
      expect(sessions.total).toBe(1);
      expect(sessions.items[0]).toMatchObject({ nativeSessionId: '0199b111-1111-7111-8111-111111111111' });
      const search = repository.search({ workspaceId: 'workspace-fixture', query: 'deterministic', limit: 20 });
      expect(search.items.length).toBeGreaterThan(0);
    } finally {
      repository.close();
    }
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
