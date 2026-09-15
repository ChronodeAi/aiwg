import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildSessionExportPlan,
  ClaudeSessionAdapter,
  IncrementalSessionImporter,
  reverifySessionExportPlan,
  SESSION_CONTRACT_VERSION,
  SessionRepository,
  stableSessionId,
  type SelectedSource,
  type SessionSource,
} from '../../../src/sessions/index.js';
import { describeWithSqlite } from '../../helpers/sqlite.js';

const fixturesRoot = resolve('test/fixtures/sessions/claude');
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function webExportSource(locator: string): SessionSource {
  return {
    contractVersion: SESSION_CONTRACT_VERSION,
    sourceId: 'export-plan-fixture',
    provider: 'claude',
    providerProfile: 'web-account-export-conversations-json',
    locatorClass: 'claude-web-export-json',
    redactedLocator: '<session-source>/web-export.json',
    adapterVersion: '1.1.0',
    sourceSchemaVersion: '1.0.0',
    disposition: 'implemented',
    operationalState: 'available',
    consistency: 'complete',
    authorizedAt: '2026-08-01T09:00:00.000Z',
    extensions: {},
  };
}

async function seedRepository(): Promise<{ repository: SessionRepository; sessionIds: string[] }> {
  const root = await mkdtemp(resolve(tmpdir(), 'aiwg-export-plan-'));
  temporaryRoots.push(root);
  const { cp } = await import('node:fs/promises');
  const locator = resolve(root, 'web-export.json');
  await cp(resolve(fixturesRoot, 'web-export.json'), locator);
  const adapter = new ClaudeSessionAdapter();
  const selectedSource: SelectedSource = {
    provider: 'claude', locator, locatorClass: 'claude-web-export-json',
    sourceId: 'export-plan-fixture',
    authorizedScope: { workspaceId: 'workspace-fixture', allowedRoots: [root] },
  };
  const source = webExportSource(locator);
  const repository = new SessionRepository();
  await new IncrementalSessionImporter(repository).import({
    source, selectedSource, adapter, workspaceId: 'workspace-fixture', policyVersion: '1.0.0',
  });
  const sessionIds = [
    stableSessionId('claude', source.sourceId, 'web-conversation-1'),
    stableSessionId('claude', source.sourceId, 'web-conversation-2'),
  ];
  return { repository, sessionIds };
}

describeWithSqlite('session export plan (#2564)', () => {
  it('selects requested sessions and records source/event digests for later staleness checks', async () => {
    const { repository, sessionIds } = await seedRepository();
    try {
      const { plan } = buildSessionExportPlan(repository, {
        workspaceId: 'workspace-fixture', sessionIds,
      });
      expect(plan.totals).toEqual({ sessionCount: 2, eventCount: 3, recordCount: 5 });
      expect(plan.sessions).toHaveLength(2);
      expect(plan.sessions[0].eventCount + plan.sessions[1].eventCount).toBe(3);
      expect(plan.preview.recordCount).toBe(5);
      expect(plan.workspaceId).toBe('workspace-fixture');
    } finally {
      repository.close();
    }
  });

  it('rejects an empty selection', async () => {
    const { repository } = await seedRepository();
    try {
      expect(() => buildSessionExportPlan(repository, { workspaceId: 'workspace-fixture', sessionIds: [] }))
        .toThrow(/at least one session/);
    } finally {
      repository.close();
    }
  });

  it('rejects a duplicate selection rather than silently deduplicating', async () => {
    const { repository, sessionIds } = await seedRepository();
    try {
      expect(() => buildSessionExportPlan(repository, {
        workspaceId: 'workspace-fixture', sessionIds: [sessionIds[0], sessionIds[0]],
      })).toThrow(/duplicate session ids/);
    } finally {
      repository.close();
    }
  });

  it('rejects an unknown or cross-workspace session id', async () => {
    const { repository } = await seedRepository();
    try {
      expect(() => buildSessionExportPlan(repository, {
        workspaceId: 'workspace-fixture', sessionIds: ['session_does-not-exist'],
      })).toThrow(/not authorized/);
    } finally {
      repository.close();
    }
  });

  it('re-verifies a plan cleanly when nothing has changed since planning', async () => {
    const { repository, sessionIds } = await seedRepository();
    try {
      const { plan } = buildSessionExportPlan(repository, { workspaceId: 'workspace-fixture', sessionIds });
      const { sessions, eventsBySessionId } = reverifySessionExportPlan(repository, plan);
      expect(sessions).toHaveLength(2);
      expect([...eventsBySessionId.values()].reduce((sum, events) => sum + events.length, 0)).toBe(3);
    } finally {
      repository.close();
    }
  });

  it('rejects a stale plan whose session no longer exists in the workspace', async () => {
    const { repository, sessionIds } = await seedRepository();
    try {
      const { plan } = buildSessionExportPlan(repository, { workspaceId: 'workspace-fixture', sessionIds });
      const forged = { ...plan, sessions: [{ ...plan.sessions[0], sessionId: 'session_never-existed' }] };
      expect(() => reverifySessionExportPlan(repository, forged)).toThrow(/no longer exists/);
    } finally {
      repository.close();
    }
  });

  it('rejects a stale plan whose recorded source digest no longer matches', async () => {
    const { repository, sessionIds } = await seedRepository();
    try {
      const { plan } = buildSessionExportPlan(repository, { workspaceId: 'workspace-fixture', sessionIds });
      const forged = {
        ...plan,
        sessions: plan.sessions.map((entry, index) => index === 0 ? { ...entry, sourceDigest: 'sha256:' + '0'.repeat(64) } : entry),
      };
      expect(() => reverifySessionExportPlan(repository, forged)).toThrow(/source changed since the plan/);
    } finally {
      repository.close();
    }
  });
});
