import { describe, expect, it } from 'vitest';
import {
  buildSessionAiwgFortemiIndexExport,
  sessionEventToAiwgFortemiRecord,
  sessionToAiwgFortemiRecord,
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
    intent: { status: 'unknown', eventId: null, sequence: null, title: null, summary: null },
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
    entities: [],
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
    rawReference: { locatorClass: 'claude-web-export-json' },
    adapterVersion: '1.1.0',
    consistency: 'complete',
    sensitivity: { classification: 'none', classes: [] },
    opaque: false,
    extensions: {},
    ...overrides,
  };
}

describe('session -> AiwgFortemiRecord mapping (#2564)', () => {
  it('maps a session to a record with a synthetic locator and required title/text', () => {
    const record = sessionToAiwgFortemiRecord(session());
    expect(record).toMatchObject({
      schema_version: 'aiwg.fortemi.index.record.v2',
      id: 'session-1',
      type: 'aiwg.session',
      source: {
        path: 'aiwg-session://claude/session-1',
        locator: 'aiwg-session://claude/session-1',
        origin: 'aiwg-session-catalog',
        generated: true,
        checksum: session().sourceDigest,
      },
      facets: {},
      tags: ['provider:claude', 'lifecycle:complete'],
      privacy: { classification: 'public', pii: false },
      provenance_events: [{
        activity: 'aiwg.session',
        agent: 'claude',
        attributes: { nativeSessionId: 'native-session-1', sourceId: 'source-1', workspaceId: 'workspace-fixture' },
      }],
    });
    expect(record.title).toBeTruthy();
    expect(record.text).toBeTruthy();
  });

  it('falls back to a synthetic title/summary when session intent was never extracted', () => {
    const record = sessionToAiwgFortemiRecord(session({ intent: { status: 'absent', eventId: null, sequence: null, title: null, summary: null } }));
    expect(record.title).toContain('claude');
    expect(record.text).toContain('session-1');
  });

  it('uses the recorded intent title/summary when present', () => {
    const record = sessionToAiwgFortemiRecord(session({
      intent: { status: 'selected', eventId: 'event-1', sequence: 0, title: 'Refactor auth', summary: 'Reviewed token refresh' },
    }));
    expect(record.title).toBe('Refactor auth');
    expect(record.text).toBe('Reviewed token refresh');
  });

  it('maps an event to a record linked to its parent session with sensitivity-derived privacy', () => {
    const record = sessionEventToAiwgFortemiRecord(session(), event({
      sensitivity: { classification: 'sensitive', classes: ['email'] },
    }));
    expect(record).toMatchObject({
      schema_version: 'aiwg.fortemi.index.record.v2',
      id: 'event-1',
      type: 'aiwg.session-event',
      text: 'Can you review src/auth/token.ts?',
      relationships: [{
        type: 'parent-session', target_id: 'session-1', direction: 'upstream', privacy: 'private',
      }],
      privacy: { classification: 'private', pii: true },
      provenance_events: [{
        activity: 'aiwg.session-event.message',
        attributes: { sessionId: 'session-1', sourceId: 'source-1', nativeId: 'native-event-1', sequence: 0 },
      }],
    });
  });

  it('produces a placeholder text value rather than an empty required field', () => {
    const record = sessionEventToAiwgFortemiRecord(session(), event({ searchableText: '' }));
    expect(record.text).toBe('[message: no text content]');
  });

  it('builds a deterministically sorted index export from multiple sessions and events', () => {
    const sessionB = session({ sessionId: 'session-b', provider: 'codex' });
    const eventsBySessionId = new Map([
      ['session-1', [event()]],
      ['session-b', [event({ eventId: 'event-b', sessionId: 'session-b' })]],
    ]);
    const index = buildSessionAiwgFortemiIndexExport('workspace-fixture', [session(), sessionB], eventsBySessionId);
    expect(index.schema_version).toBe('aiwg.fortemi.index.export.v2');
    expect(index.source).toMatchObject({ repo: 'workspace-fixture', privacy: 'private', graph: 'aiwg-sessions' });
    expect(index.compatibility).toEqual({
      previous_schema_version: 'aiwg.fortemi.index.export.v1', strategy: 'supported',
    });
    expect(index.items.map((item) => item.id)).toEqual([...index.items.map((item) => item.id)].sort());
    expect(index.items.map((item) => item.id)).toContain('session-1');
    expect(index.items.map((item) => item.id)).toContain('session-b');
    expect(index.items.map((item) => item.id)).toContain('event-b');
  });

  it('validates against the real @fortemi/core shard schema and round-trips through build/recover', async () => {
    const { aiwgFortemiIndexToKnowledgeShard, aiwgFortemiIndexFromKnowledgeShard } = await import('@fortemi/core');
    const index = buildSessionAiwgFortemiIndexExport('workspace-fixture', [session()], new Map([
      ['session-1', [event(), event({ eventId: 'event-2', sequence: 1, searchableText: 'Second message' })]],
    ]));
    const bytes = await aiwgFortemiIndexToKnowledgeShard(index);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
    const recovered = aiwgFortemiIndexFromKnowledgeShard(bytes);
    // core-v1's own recovery reads the whole index back verbatim, so the
    // synthetic export-manifest record (#2564) round-trips through it too.
    expect(recovered.items).toHaveLength(4);
    expect(recovered.items.map((item) => item.id).sort()).toEqual([
      'event-1', 'event-2', 'session-1', 'zzz-aiwg-session-catalog-export-manifest',
    ]);
  });
});
