import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SESSION_PROVIDER_IDS, SessionContractError, SessionSourceAdapterRegistry,
  coveragePreflight, createSessionAdapterRegistry, discoverWorkspaceHistories,
  expectedSessionProviders, importDiscoveryManifest, readDiscoveryManifest,
  reconcileCoveragePreflight, sessionRuntimeIdentity, SessionRepository,
  writeDiscoveryManifest, coverageFromBatchRun, previewDiscoveryImport,
  type BatchSourceDisposition, type SessionRuntimeIdentity,
} from '../../../src/sessions/index.js';
import { claudeProjectKey } from '../../../src/sessions/workspace-discovery.js';
import { listProviderDefinitions } from '../../../src/providers/provider-definitions.js';
import { itWithSqlite } from '../../helpers/sqlite.js';

const runtime: SessionRuntimeIdentity = {
  packageName: 'aiwg', version: '2026.10.1', packageRoot: '/synthetic/npm/aiwg',
  executable: '/synthetic/npm/bin/aiwg', nodeVersion: 'v24.12.0',
  installationMethod: 'npm', installationState: 'aligned',
  canonicalRoot: '/synthetic/npm/aiwg', diagnostics: [],
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'session-coverage-'));
  roots.push(root);
  return root;
}

function accepted(provider: string): BatchSourceDisposition {
  return {
    provider, sourceId: provider, status: 'committed', attempts: 1,
    sessionsAccepted: 1, eventsAccepted: 2, errorCode: null, diagnostic: null,
    updatedAt: new Date().toISOString(),
  };
}

function checked(provider: string) {
  return {
    provider, status: 'checked' as const, disposition: 'discoverable' as const,
    sourceCount: 1, dateRange: { earliest: null, latest: null },
    dateRangeBasis: 'source-mtime' as const, reasonCode: null, remediation: null,
  };
}

describe('provider/runtime coverage preflight', () => {
  it('keeps the canonical provider contract in parity with instantiated adapters', () => {
    const adapters = createSessionAdapterRegistry().list();
    expect(adapters.map((adapter) => adapter.provider)).toEqual([...SESSION_PROVIDER_IDS].sort());
    expect(adapters.every((adapter) => adapter.supportedOperations.includes('stream'))).toBe(true);
    expect(adapters.find((adapter) => adapter.provider === 'muse')?.supportedOperations).toContain('discover');
  });

  it('gives every advertised runtime provider a ledger entry, including unsupported collection providers', () => {
    const expected = listProviderDefinitions().map((provider: { id: string }) => provider.id);
    const preflight = coveragePreflight({ expectedProviders: expected, runtime });
    expect(preflight.ledger.map((entry) => entry.provider)).toEqual(expectedSessionProviders(expected));
    expect(preflight.ledger.find((entry) => entry.provider === 'muse')).toBeDefined();
    for (const entry of preflight.ledger) {
      expect(entry.disposition).toBe(entry.adapterVersion
        ? entry.supportedOperations.includes('discover') ? 'not-checked' : 'export-required'
        : 'missing-adapter');
    }
  });

  it('normalizes aliases without dropping unknown expected providers', () => {
    expect(expectedSessionProviders(['windsurf', 'muse', 'future-provider', 'muse', ' dsh ']))
      .toEqual(['deepseek-harness', 'devin-desktop', 'future-provider', 'muse']);
    expect(() => expectedSessionProviders([])).toThrow(SessionContractError);
    expect(() => expectedSessionProviders(['muse', ''])).toThrow(SessionContractError);
  });

  it('records the loaded package identity independently of the workspace', async () => {
    const actual = sessionRuntimeIdentity();
    const pkg = JSON.parse(await readFile(join(actual.packageRoot, 'package.json'), 'utf8'));
    expect(actual).toMatchObject({ packageName: pkg.name, version: pkg.version, nodeVersion: process.version });
  });

  it('retains Muse and unknown scope when a stale registry omits their adapters', async () => {
    const registry = new SessionSourceAdapterRegistry();
    registry.register(createSessionAdapterRegistry().get('claude'));
    const manifest = await discoverWorkspaceHistories({
      workspace: await workspace(), expectedProviders: ['claude', 'muse', 'future-provider'],
      registry, runtime: { ...runtime, version: '2026.9.20' },
      providerHome: await workspace(),
    });
    expect(manifest.providers.map((item) => item.provider)).toEqual(['claude', 'future-provider', 'muse']);
    expect(manifest.preflight?.supportedProviders).toEqual(['claude']);
    expect(manifest.preflight?.ledger.filter((item) => item.disposition === 'missing-adapter')
      .map((item) => item.provider)).toEqual(['future-provider', 'muse']);
    expect(manifest.preflight?.ledger.find((item) => item.provider === 'muse')?.remediation)
      .toContain('2026.9.20 at /synthetic/npm/aiwg');
    expect(manifest.preflight?.status).toBe('partial');
  });

  it('binds provider scope and runtime identity into the saved manifest', async () => {
    const root = await workspace();
    const options = { workspace: root, providerHome: root, runtime };
    const first = await discoverWorkspaceHistories({ ...options, expectedProviders: ['muse'] });
    const second = await discoverWorkspaceHistories({ ...options, expectedProviders: ['muse', 'unknown'] });
    expect(second.manifestId).not.toBe(first.manifestId);
    const path = join(root, 'manifest.json');
    await writeDiscoveryManifest(path, first);
    expect(await readDiscoveryManifest(path)).toEqual(first);
    await writeDiscoveryManifest(path, { ...first, preflight: { ...first.preflight!, expectedProviders: ['claude'] } });
    await expect(readDiscoveryManifest(path)).rejects.toThrow('identity does not match');
  });

  it('separates authorization, unavailable roots, exports and zero matching sources', async () => {
    const root = await workspace();
    const manifest = await discoverWorkspaceHistories({
      workspace: root, providerHome: root, runtime,
      expectedProviders: ['muse', 'warp', 'claude', 'codex'], codexRoot: root,
    });
    expect(Object.fromEntries(manifest.preflight!.ledger.map((entry) => [entry.provider, entry.disposition])))
      .toEqual({ muse: 'authorization-required', warp: 'export-required', claude: 'unavailable', codex: 'no-sources' });
    expect(reconcileCoveragePreflight(manifest.preflight!, []).status).toBe('partial');
  });

  it('requires explicit scope, acquired sources and a compatible runtime for completion', () => {
    const options = { expectedProviders: ['claude'], reports: [checked('claude')], runtime };
    const preflight = coveragePreflight(options);
    expect(reconcileCoveragePreflight(preflight, [accepted('claude')]).status).toBe('complete');
    expect(reconcileCoveragePreflight(preflight, [{ ...accepted('claude'), eventsAccepted: 0 }]).status).toBe('partial');
    expect(reconcileCoveragePreflight({ ...preflight, expectedProviderBasis: 'declared-default' }, [accepted('claude')]).status).toBe('partial');
    for (const installationState of ['mismatch', 'stale', 'unknown'] as const) {
      const mismatched = coveragePreflight({ ...options, runtime: { ...runtime, installationState } });
      expect(reconcileCoveragePreflight(mismatched, [accepted('claude')]).status).toBe('partial');
    }
  });

  it('keeps imported Muse sources scope-incomplete when some sources were not fully inspected (#2865)', () => {
    const report = {
      ...checked('muse'), status: 'not-checked' as const, sourceCount: 1,
      reasonCode: 'MUSE_SOURCE_INSPECTION_INCOMPLETE', remediation: 'Review museSourceInspections.',
    };
    const preflight = coveragePreflight({ expectedProviders: ['muse'], reports: [report], runtime });
    expect(preflight.ledger[0]).toMatchObject({ disposition: 'pending-import', remediation: 'Review museSourceInspections.' });
    expect(preflight.ledger[0].boundaries.join(' ')).toContain('could not be fully inspected');
    const reconciled = reconcileCoveragePreflight(preflight, [accepted('muse')]);
    expect(reconciled.ledger[0].disposition).toBe('scope-incomplete');
    expect(reconciled.status).toBe('partial');
    const empty = coveragePreflight({ expectedProviders: ['muse'], reports: [{ ...report, sourceCount: 0 }], runtime });
    expect(empty.ledger[0].disposition).toBe('not-checked');
  });

  it('keeps freshness and semantic review separate from complete acquisition', () => {
    const preflight = coveragePreflight({ expectedProviders: ['claude'], reports: [checked('claude')], runtime });
    const report = coverageFromBatchRun({
      schemaVersion: '1.0.0', runId: 'test', manifestId: 'test', workspaceId: 'test',
      manifestCreatedAt: '2020-01-01T00:00:00.000Z', startedAt: '', updatedAt: '', completedAt: '',
      status: 'complete', preflight, providers: [checked('claude')], sources: [accepted('claude')],
    });
    expect(report).toMatchObject({ status: 'stale', acquisitionStatus: 'complete', semanticReview: 'not-assessed' });
  });

  it.each(['pending', 'running', 'rejected', 'skipped'] as const)(
    'keeps %s sources partial without explicit provider expectations', (status) => {
      const report = coverageFromBatchRun({
        schemaVersion: '1.0.0', runId: 'test', manifestId: 'test', workspaceId: 'test',
        manifestCreatedAt: new Date().toISOString(), startedAt: '', updatedAt: '', completedAt: null,
        status: 'running', providers: [checked('claude')],
        sources: [{ ...accepted('claude'), status }],
      });
      expect(report.acquisitionStatus).toBe('partial');
    },
  );

  it.each(['committed', 'duplicate', 'previously-committed'] as const)(
    'treats legacy %s sources as acquired while keeping coverage partial', (status) => {
      const report = coverageFromBatchRun({
        schemaVersion: '1.0.0', runId: 'test', manifestId: 'test', workspaceId: 'test',
        manifestCreatedAt: new Date().toISOString(), startedAt: '', updatedAt: '', completedAt: '',
        status: 'partial', providers: [checked('claude'), { ...checked('warp'), status: 'export-required' }],
        sources: [{ ...accepted('claude'), status }],
      });
      expect(report).toMatchObject({
        schemaVersion: '2.0.0', status: 'partial', acquisitionStatus: 'complete', unresolvedProviders: ['warp'],
      });
    },
  );

  it('reports unknown acquisition when no batch run exists', () => {
    expect(coverageFromBatchRun(null)).toMatchObject({
      schemaVersion: '2.0.0', status: 'unknown', acquisitionStatus: 'unknown', unresolvedProviders: [],
    });
  });

  itWithSqlite('completes an explicit acquired scope and rechecks runtime identity on replay', async () => {
    const root = await workspace();
    const history = join(root, '.claude', 'projects', claudeProjectKey(root));
    await mkdir(history, { recursive: true });
    const fixture = await readFile(resolve('test/fixtures/sessions/claude/active-session.jsonl'), 'utf8');
    await writeFile(join(history, 'session.jsonl'), fixture.replaceAll('"cwd":"/private/work/project"', `"cwd":${JSON.stringify(root)}`));
    const manifest = await discoverWorkspaceHistories({
      workspace: root, providerHome: root, expectedProviders: ['claude'], runtime,
    });
    const repository = new SessionRepository(':memory:');
    try {
      const first = await importDiscoveryManifest({ manifest, repository, runtime });
      expect(first.run.status).toBe('complete');
      expect(first.coverage.acquisitionStatus).toBe('complete');
      const currentRuntime = { ...runtime, version: '2026.10.2', installationState: 'mismatch' as const };
      const replay = await importDiscoveryManifest({ manifest, repository, runtime: currentRuntime });
      expect(replay.run.status).toBe('complete');
      expect(replay.run.discoveryRuntime).toEqual(runtime);
      expect(replay.coverage.preflight?.runtime).toEqual(currentRuntime);
      expect(replay.coverage).toMatchObject({ status: 'partial', acquisitionStatus: 'complete', unresolvedProviders: [] });
      expect(replay.coverage.remediation.join(' ')).toContain('deliberately select');
      const legacy = previewDiscoveryImport({ ...manifest, preflight: undefined }, null);
      expect(legacy.coverage.acquisitionStatus).toBe('partial');
      expect(legacy.coverage.preflight?.expectedProviderBasis).toBe('legacy');
    } finally { repository.close(); }
  });

  itWithSqlite('imports Muse parents with native provenance while preserving omitted scope', async () => {
    const root = await workspace();
    const museRoot = join(root, 'muse');
    const id = '00000000-0000-4000-8000-000000000002';
    const parent = join(museRoot, '2026/09/25', id);
    const nested = join(parent, 'subagent', '00000000-0000-4000-8000-000000000003');
    await mkdir(nested, { recursive: true });
    const fixture = await readFile(resolve('test/fixtures/sessions/muse/native/2026/09/25', id, 'session.jsonl'), 'utf8');
    const content = fixture.replaceAll('<redacted-path>', root);
    await writeFile(join(parent, 'session.jsonl'), content);
    await writeFile(join(nested, 'session.jsonl'), content);
    const manifest = await discoverWorkspaceHistories({ workspace: root, museRoot, expectedProviders: ['muse'], runtime });
    expect(manifest.sources).toHaveLength(1);
    const repository = new SessionRepository(':memory:');
    try {
      const receipt = await importDiscoveryManifest({ manifest, repository, runtime });
      expect(receipt.totals).toMatchObject({ discovered: 1, accepted: 1, rejected: 0, eventsAccepted: 14 });
      expect(receipt.coverage).toMatchObject({ acquisitionStatus: 'partial', coverageRatio: 1 });
      expect(receipt.coverage.preflight?.ledger[0]).toMatchObject({ provider: 'muse', disposition: 'scope-incomplete' });
      expect(receipt.run.discoveryRuntime).toEqual(runtime);
      const sessions = repository.listSessions({ workspaceId: root, limit: 20 });
      const events = repository.listEvents(sessions.items[0].sessionId, root);
      // Import policy retains structured provenance while redacting unclassified strings.
      expect(events[0].rawReference.locatorClass).toBe('muse-native-session-log');
      expect(events[0].extensions['native.muse']).toMatchObject({
        'native.muse': {
          retainedChildIndex: 0, streamId: id, envelopeSequence: 1,
          diagnostics: { omitted_records: 1, omitted_live_only: 1, retained_frame_children: 2 },
        },
      });
      expect(repository.doctor()).toMatchObject({ integrity: 'ok', indexIntegrity: 'ok' });
      expect(repository.getCoverage(root).acquisitionStatus).toBe('partial');
    } finally { repository.close(); }
  });
});
