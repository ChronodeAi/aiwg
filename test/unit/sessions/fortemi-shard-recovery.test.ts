import { describe, expect, it } from 'vitest';
import {
  buildSessionAiwgFortemiIndexExport,
  FortemiShardRecoveryError,
  recoverAiwgFortemiIndexFromFullV1Shard,
  SESSION_CONTRACT_VERSION,
  sha256,
  type Session,
  type SessionEvent,
} from '../../../src/sessions/index.js';

function session(overrides: Partial<Session> = {}): Session {
  return {
    contractVersion: SESSION_CONTRACT_VERSION,
    sessionId: 'session-1',
    sourceId: 'source-1',
    provider: 'claude',
    nativeSessionId: 'native-session-1',
    workspaceId: 'workspace-fixture',
    startedAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:05:00.000Z',
    consistency: 'complete',
    lifecycle: 'complete',
    intent: { status: 'selected', eventId: 'event-1', sequence: 0, title: 'Refactor auth', summary: 'Reviewed token refresh' },
    sourceDigest: sha256('fixture-source'),
    extensions: {},
    ...overrides,
  };
}

function event(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    contractVersion: SESSION_CONTRACT_VERSION,
    eventId: 'event-1',
    sessionId: 'session-1',
    sourceId: 'source-1',
    importRunId: 'run-1',
    nativeId: 'native-event-1',
    sequence: 0,
    kind: 'message',
    role: 'user',
    participant: null,
    toolName: null,
    toolCallId: null,
    model: null,
    entities: ['acme-corp'],
    extractionState: null,
    occurredAt: '2026-08-01T09:00:00.000Z',
    activityBoundary: null,
    activityBoundaryBasis: null,
    activityBoundaryConfidence: null,
    origin: 'unknown',
    originRule: 'legacy:unknown',
    originClassifierVersion: '1.0.0',
    searchableText: 'Can you review src/auth/token.ts?',
    digest: sha256('Can you review src/auth/token.ts?'),
    rawReference: { locatorClass: 'claude-transcript-jsonl' },
    adapterVersion: '1.1.0',
    consistency: 'complete',
    sensitivity: { classification: 'none', classes: [] },
    opaque: false,
    extensions: {},
    ...overrides,
  };
}

describe('recoverAiwgFortemiIndexFromFullV1Shard (#2564)', () => {
  it('recovers session and event records with identifiers, tags, relationships, and provenance intact', async () => {
    const { aiwgFortemiIndexToKnowledgeShardWithReport } = await import('@fortemi/core');
    const index = buildSessionAiwgFortemiIndexExport('workspace-fixture', [session()], new Map([
      ['session-1', [event(), event({ eventId: 'event-2', sequence: 1, searchableText: 'Second message' })]],
    ]));
    const result = await aiwgFortemiIndexToKnowledgeShardWithReport(index);
    expect(result.success).toBe(true);
    expect(result.lossless).toBe(true);
    expect(result.losses).toEqual([]);

    const recovered = recoverAiwgFortemiIndexFromFullV1Shard(result.archive!);
    expect(recovered.items).toHaveLength(3);
    const recoveredSession = recovered.items.find((item) => item.id === 'session-1')!;
    expect(recoveredSession).toMatchObject({
      type: 'aiwg.session',
      title: 'Refactor auth',
      text: 'Reviewed token refresh',
      tags: expect.arrayContaining(['provider:claude', 'lifecycle:complete']),
      source: { checksum: session().sourceDigest, origin: 'aiwg-session-catalog' },
      privacy: { classification: 'public', pii: false },
    });
    expect(recoveredSession.provenance_events).toContainEqual(expect.objectContaining({
      activity: 'aiwg.session',
      attributes: expect.objectContaining({
        nativeSessionId: 'native-session-1', sourceId: 'source-1', workspaceId: 'workspace-fixture',
      }),
    }));

    const recoveredEvent = recovered.items.find((item) => item.id === 'event-1')!;
    expect(recoveredEvent).toMatchObject({
      type: 'aiwg.session-event',
      text: 'Can you review src/auth/token.ts?',
      tags: expect.arrayContaining(['kind:message', 'role:user', 'entity:acme-corp']),
      relationships: [expect.objectContaining({ type: 'parent-session', target_id: 'session-1', confidence: 1 })],
    });
    expect(recoveredEvent.provenance_events).toContainEqual(expect.objectContaining({
      activity: 'aiwg.session-event.message',
      attributes: expect.objectContaining({ sessionId: 'session-1', sourceId: 'source-1', nativeId: 'native-event-1', sequence: 0 }),
    }));
    expect(recoveredEvent.provenance).toContainEqual(expect.objectContaining({ field: 'text', source: 'aiwg-session-catalog' }));
  });

  it('rejects a shard with no notes', async () => {
    const { packTarGz } = await import('@fortemi/core');
    const empty = packTarGz(new Map([['manifest.json', new TextEncoder().encode('{}')]]));
    expect(() => recoverAiwgFortemiIndexFromFullV1Shard(empty)).toThrow(FortemiShardRecoveryError);
    expect(() => recoverAiwgFortemiIndexFromFullV1Shard(empty)).toThrow(/no notes to recover/);
  });

  it('rejects a completely invalid archive rather than crashing uncontrolled', () => {
    expect(() => recoverAiwgFortemiIndexFromFullV1Shard(new Uint8Array())).toThrow();
  });

  it('rejects a shard whose notes have no aiwg_source metadata (not produced by this mapping)', async () => {
    const { aiwgFortemiIndexToKnowledgeShard } = await import('@fortemi/core');
    // core-v1 path embeds `aiwg_fortemi_index`, not `aiwg_source` -- a shard
    // built by the OTHER converter should not be silently misread as ours.
    const index = buildSessionAiwgFortemiIndexExport('workspace-fixture', [session()], new Map());
    const bytes = await aiwgFortemiIndexToKnowledgeShard(index);
    expect(() => recoverAiwgFortemiIndexFromFullV1Shard(bytes)).toThrow(FortemiShardRecoveryError);
    expect(() => recoverAiwgFortemiIndexFromFullV1Shard(bytes)).toThrow(/no aiwg_source metadata/);
  });
});
