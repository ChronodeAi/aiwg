import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  buildSessionExportPlan,
  ClaudeSessionAdapter,
  FilesystemDerivedOutputIndex,
  FilesystemOutputRegistrationStore,
  IncrementalSessionImporter,
  OutputRegistrationCoordinator,
  reverifySessionExportPlan,
  SESSION_CONTRACT_VERSION,
  SessionRepository,
  stableSessionId,
  type OutputRegistrationRequest,
  type SelectedSource,
  type SessionSource,
} from '../../../src/sessions/index.js';
import { mkdtemp } from '../../helpers/temp-dir.js';
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

async function registerOutput(sessionId: string, overrides: Partial<OutputRegistrationRequest> = {}) {
  const projectRoot = await mkdtemp(resolve(tmpdir(), 'aiwg-export-edges-'));
  const outputPath = 'output/reports/result.md';
  const content = '# Derived analysis\n';
  await mkdir(resolve(projectRoot, 'output/reports'), { recursive: true });
  await writeFile(resolve(projectRoot, outputPath), content);
  const index = new FilesystemDerivedOutputIndex(projectRoot);
  const coordinator = new OutputRegistrationCoordinator(
    projectRoot, new FilesystemOutputRegistrationStore(projectRoot), index,
  );
  const request: OutputRegistrationRequest = {
    outputPath, mediaType: 'text/markdown',
    contextPack: {
      id: 'context-pack:edges', digest: 'sha256:' + '1'.repeat(64),
      sources: [{ kind: 'session', ref: sessionId, digest: null, span: null }],
    },
    supersedes: [], conflictsWith: [], ...overrides,
  };
  const preview = coordinator.preview(request);
  await coordinator.register({ request, operationId: preview.operationId });
  return { projectRoot, outputPath: resolve(projectRoot, outputPath), content, index, preview };
}

describeWithSqlite('session export plan (#2564)', () => {
  it('selects requested sessions and records source/event digests for later staleness checks', async () => {
    const { repository, sessionIds } = await seedRepository();
    try {
      const { plan } = buildSessionExportPlan(repository, {
        workspaceId: 'workspace-fixture', sessionIds,
      });
      expect(plan.totals).toEqual({ sessionCount: 2, eventCount: 3, outputCount: 0, attachmentCount: 0, recordCount: 6 });
      expect(plan.outputs).toEqual([]);
      expect(plan.sessions).toHaveLength(2);
      expect(plan.sessions[0].eventCount + plan.sessions[1].eventCount).toBe(3);
      expect(plan.preview.recordCount).toBe(6);
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

  it('discovers a registered output associated with a selected session (#2566)', async () => {
    const { repository, sessionIds } = await seedRepository();
    const projectRoot = await mkdtemp(resolve(tmpdir(), 'aiwg-export-plan-outputs-'));
    temporaryRoots.push(projectRoot);
    try {
      await mkdir(resolve(projectRoot, 'output/reports'), { recursive: true });
      await writeFile(resolve(projectRoot, 'output/reports/result.md'), '# Derived analysis\n');
      const coordinator = new OutputRegistrationCoordinator(
        projectRoot,
        new FilesystemOutputRegistrationStore(projectRoot),
        new FilesystemDerivedOutputIndex(projectRoot),
      );
      const request = {
        outputPath: 'output/reports/result.md',
        mediaType: 'text/markdown',
        contextPack: {
          id: 'context-pack:test-1',
          digest: 'sha256:' + '1'.repeat(64),
          sources: [{ kind: 'session' as const, ref: sessionIds[0], digest: null, span: null }],
        },
        supersedes: [], conflictsWith: [],
      };
      const preview = coordinator.preview(request);
      await coordinator.register({ request, operationId: preview.operationId });

      const { plan } = buildSessionExportPlan(repository, {
        workspaceId: 'workspace-fixture', sessionIds, projectRoot,
      });
      expect(plan.outputs).toHaveLength(1);
      expect(plan.outputs[0]).toMatchObject({
        sessionId: sessionIds[0],
        outputLocator: 'output/reports/result.md',
        mediaType: 'text/markdown',
        lineage: 'registered',
        matchReason: 'ref equals the stable session id',
      });
      expect(plan.totals.outputCount).toBe(1);
    } finally {
      repository.close();
    }
  });

  it('finds no outputs when the project has none registered', async () => {
    const { repository, sessionIds } = await seedRepository();
    const projectRoot = await mkdtemp(resolve(tmpdir(), 'aiwg-export-plan-no-outputs-'));
    temporaryRoots.push(projectRoot);
    try {
      const { plan } = buildSessionExportPlan(repository, {
        workspaceId: 'workspace-fixture', sessionIds, projectRoot,
      });
      expect(plan.outputs).toEqual([]);
    } finally {
      repository.close();
    }
  });

  it('plans and verifies a matched output with a populated conflictsWith (#2568)', async () => {
    const { repository, sessionIds } = await seedRepository();
    try {
      const { projectRoot, content, preview, index } = await registerOutput(sessionIds[0], {
        conflictsWith: ['output:alternative-analysis'],
      });
      expect(index.registrations()[0].conflictsWith).toEqual(['output:alternative-analysis']);
      const { plan } = buildSessionExportPlan(repository, {
        workspaceId: 'workspace-fixture', sessionIds, projectRoot,
      });
      expect(plan.outputs).toHaveLength(1);
      expect(plan.outputs[0]).toMatchObject({ registrationId: preview.registrationId, lineage: 'registered' });
      const verified = reverifySessionExportPlan(repository, plan, { projectRoot });
      expect(Buffer.from(verified.outputBytesByRegistrationId.get(preview.registrationId)!))
        .toEqual(Buffer.from(content));
    } finally {
      repository.close();
    }
  });

  it('rejects a registered output whose source session was tombstoned before planning or building (#2568)', async () => {
    const { repository, sessionIds } = await seedRepository();
    try {
      const { projectRoot, index } = await registerOutput(sessionIds[0]);
      const { plan } = buildSessionExportPlan(repository, {
        workspaceId: 'workspace-fixture', sessionIds, projectRoot,
      });
      expect(plan.outputs).toHaveLength(1);
      expect(repository.tombstoneSession(sessionIds[0], 'workspace-fixture')).toBe(true);
      expect(index.registrations()).toHaveLength(1);
      expect(() => buildSessionExportPlan(repository, {
        workspaceId: 'workspace-fixture', sessionIds: [sessionIds[0]], projectRoot,
      })).toThrow(expect.objectContaining({ code: 'SOURCE_NOT_AUTHORIZED' }));
      expect(() => reverifySessionExportPlan(repository, plan, { projectRoot }))
        .toThrow(expect.objectContaining({ code: 'SOURCE_NOT_AUTHORIZED' }));
      const remaining = buildSessionExportPlan(repository, {
        workspaceId: 'workspace-fixture', sessionIds: [sessionIds[1]], projectRoot,
      });
      expect(remaining.plan.outputs).toEqual([]);
    } finally {
      repository.close();
    }
  });

  it('rejects a real cross-workspace session reference during planning and build reverification (#2568)', async () => {
    const { repository, sessionIds } = await seedRepository();
    try {
      const { projectRoot } = await registerOutput(sessionIds[0]);
      const { plan } = buildSessionExportPlan(repository, {
        workspaceId: 'workspace-fixture', sessionIds, projectRoot,
      });
      expect(plan.outputs).toHaveLength(1);
      expect(() => buildSessionExportPlan(repository, {
        workspaceId: 'workspace-other', sessionIds: [sessionIds[0]], projectRoot,
      })).toThrow(expect.objectContaining({ code: 'SOURCE_NOT_AUTHORIZED' }));
      expect(() => reverifySessionExportPlan(repository, { ...plan, workspaceId: 'workspace-other' }, { projectRoot }))
        .toThrow(expect.objectContaining({ code: 'SOURCE_NOT_AUTHORIZED' }));
    } finally {
      repository.close();
    }
  });

  it.each(['missing', 'different size', 'same size'] as const)(
    'rejects %s registered output bytes during build reverification (#2568)', async (change) => {
      const { repository, sessionIds } = await seedRepository();
      try {
        const { projectRoot, outputPath, content, preview } = await registerOutput(sessionIds[0]);
        const { plan } = buildSessionExportPlan(repository, {
          workspaceId: 'workspace-fixture', sessionIds, projectRoot,
        });
        expect(plan.outputs).toHaveLength(1);
        expect(reverifySessionExportPlan(repository, plan, { projectRoot }).outputBytesByRegistrationId
          .has(preview.registrationId)).toBe(true);
        if (change === 'missing') await rm(outputPath);
        else {
          const changed = change === 'same size' ? content.replace('Derived', 'Altered') : 'changed';
          expect(Buffer.byteLength(changed) === plan.outputs[0].outputByteLength).toBe(change === 'same size');
          await writeFile(outputPath, changed);
        }
        expect(() => reverifySessionExportPlan(repository, plan, { projectRoot }))
          .toThrow(expect.objectContaining({
            code: 'SCHEMA_DRIFT',
            message: expect.stringContaining(change === 'missing' ? 'output is missing' : 'output changed'),
          }));
      } finally {
        repository.close();
      }
    },
  );

  it('does not infer output lineage from catalog labels or sources of unknown provenance (#2568)', async () => {
    const { repository, sessionIds } = await seedRepository();
    try {
      const { projectRoot } = await registerOutput(sessionIds[0], {
        contextPack: {
          id: sessionIds[0], digest: 'sha256:' + '1'.repeat(64),
          sources: [
            { kind: 'note', ref: sessionIds[0], digest: null, span: null },
            { kind: 'session', ref: 'unknown-origin', digest: null, span: null },
          ],
        },
      });
      expect(repository.tagSession(sessionIds[0], 'output/reports/result.md', 'workspace-fixture')).toBe(true);
      const { plan } = buildSessionExportPlan(repository, {
        workspaceId: 'workspace-fixture', sessionIds, projectRoot,
      });
      expect(plan.sessions[0].catalogTags).toContain('output/reports/result.md');
      expect(plan.outputs).toEqual([]);
      expect(reverifySessionExportPlan(repository, plan, { projectRoot }).outputBytesByRegistrationId.size).toBe(0);
    } finally {
      repository.close();
    }
  });
});
