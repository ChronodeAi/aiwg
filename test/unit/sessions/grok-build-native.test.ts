// Exercise synthetic native fixtures only with the experimental opt-in.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GROK_BUILD_ACTIVE_FRESHNESS_MS, GROK_BUILD_NATIVE_LOCATOR_CLASS,
  GROK_BUILD_NATIVE_SCHEMA_VERSION, GrokBuildSessionAdapter,
  discoverWorkspaceHistories, grokBuildLiveState, readGrokBuildActiveRegistry,
  type SelectedSource,
} from '../../../src/sessions/index.js';

const fixturesRoot = resolve('test/fixtures/sessions/grok-build');
const nativeLayoutRoot = resolve(fixturesRoot, 'native-layout');
const roots: string[] = [];
beforeEach(() => vi.stubEnv('AIWG_GROK_BUILD_NATIVE_EXPERIMENTAL', '1'));
afterEach(async () => {
  vi.unstubAllEnvs();
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Grok Build native chat_history discovery', () => {
  const native = new GrokBuildSessionAdapter();
  const sessionA = '0199b111-1111-7111-8111-111111111111';
  const sessionALocator = resolve(
    nativeLayoutRoot, '%2Fsynthetic%2Fgrok-workspace', sessionA, 'chat_history.jsonl',
  );

  it('still requires an authorized sessions root after opting in', async () => {
    await expect(collect(native.discover({ workspaceId: 'synthetic', allowedRoots: [] })))
      .rejects.toMatchObject({ code: 'SOURCE_NOT_AUTHORIZED', message: expect.stringContaining('--grok-root') });
    const workspace = await mkdtemp(join(tmpdir(), 'aiwg-grok-root-required-'));
    roots.push(workspace);
    const manifest = await discoverWorkspaceHistories({
      workspace, providerHome: workspace, expectedProviders: ['grok-build'],
    });
    expect(manifest.providers[0]).toMatchObject({
      reasonCode: 'SHARED_ROOT_AUTHORIZATION_REQUIRED', remediation: expect.stringContaining('--grok-root'),
    });
  });

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

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
