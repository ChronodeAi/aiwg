import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionsHandler } from '../../../../src/cli/handlers/sessions.js';
import * as adapters from '../../../../src/sessions/adapter-registry.js';
import { SessionSourceAdapterRegistry } from '../../../../src/sessions/discovery.js';
import { SESSION_PROVIDER_IDS } from '../../../../src/sessions/contracts.js';
import { itWithSqlite } from '../../../helpers/sqlite.js';
import { main as indexCli } from '../../../../src/artifacts/cli.js';
import { SessionRepository } from '../../../../src/sessions/repository.js';
import { grokbotTranscriptReplicaFilename } from '../../../../src/sessions/adapters/grokbot-locator.js';
import { claudeProjectKey } from '../../../../src/sessions/workspace-discovery.js';

vi.mock('node:os', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:os')>(),
  userInfo: () => ({ homedir: process.env.HOME }),
}));
// Resolve the optional installed backend before each test isolates HOME.
vi.mock('../../../../src/features/runtime.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../src/features/runtime.js')>();
  let sqlite: unknown;
  try { sqlite = original.requireFeaturePackage('better-sqlite3'); } catch { /* optional */ }
  return { ...original, requireFeaturePackage: (name: string) =>
    name === 'better-sqlite3' && sqlite ? sqlite : original.requireFeaturePackage(name) };
});

let root: string;
let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.stubEnv('CODEX_HOME', '');
  root = mkdtempSync(join(tmpdir(), 'sessions-coverage-cli-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('XDG_DATA_HOME', join(root, 'data'));
  vi.stubEnv('XDG_STATE_HOME', join(root, 'state'));
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
async function cli(args: string[]) {
  const result = await sessionsHandler.execute({ args, rawArgs: ['sessions', ...args], cwd: root, frameworkRoot: process.cwd() });
  return { exitCode: result.exitCode, ...JSON.parse(String(log.mock.calls.at(-1)?.[0])) };
}

describe('sessions coverage CLI', () => {
  itWithSqlite('repairs a narrow explicit manifest on refresh and imports all configured providers into a fresh catalog', async () => {
    const claude = join(root, '.claude/projects', claudeProjectKey(root));
    const codex = join(root, '.codex/sessions/2026/10/14');
    const grokbot = join(root, 'grokbot');
    for (const directory of [claude, codex, grokbot, join(root, '.aiwg')]) mkdirSync(directory, { recursive: true });
    const config = join(root, '.aiwg/aiwg.config');
    writeFileSync(config, JSON.stringify({ providers: ['codex', 'claude'] }));
    writeFileSync(join(claude, 'session.jsonl'), JSON.stringify({
      type: 'user', uuid: 'request', sessionId: 'claude-fixture', cwd: root,
      timestamp: '2026-10-14T00:00:00.000Z', message: { role: 'user', content: 'hello' },
    }) + '\n');
    writeFileSync(join(codex, 'rollout.jsonl'), JSON.stringify({
      type: 'session_meta', payload: { id: 'codex-fixture', cwd: root },
    }) + '\n');
    const conversation = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    writeFileSync(join(grokbot, grokbotTranscriptReplicaFilename('synthetic-account', conversation)), JSON.stringify({
      schemaVersion: 1, value: { entries: [{ kind: 'message', id: 'synthetic-message', role: 'user',
        content: 'hello', timestampMs: 1_790_000_000_000, seq: 1 }] },
    }));
    const discovery = await cli(['discover', '--workspace', root, '--provider-home', root,
      '--expected-providers', 'grokbot', '--grokbot-root', grokbot, '--json']);
    expect(discovery.data.manifest.sources.map((source: { provider: string }) => source.provider)).toEqual(['grokbot']);
    expect(discovery.data.warnings).toContainEqual(expect.objectContaining({
      code: 'CONFIGURED_PROVIDERS_OUTSIDE_SCOPE', missingProviders: ['claude', 'codex'],
    }));
    const automatic = await cli(['discover', '--workspace', root, '--provider-home', root,
      '--grokbot-root', grokbot, '--dry-run', '--json']);
    expect(automatic.data.manifest.preflight).toMatchObject({
      expectedProviders: ['claude', 'codex', 'grokbot'], expectedProviderBasis: 'workspace-config',
    });
    expect(automatic.data.manifest.sources).toHaveLength(3);
    const stalePreview = await cli(['import-discovered', '--workspace', root, '--dry-run', '--json']);
    expect(stalePreview.data.warnings[0].missingProviders).toEqual(['claude', 'codex']);
    const catalog = join(root, '.aiwg/sessions/catalog.sqlite');
    new SessionRepository(catalog).close();
    const doctor = await cli(['doctor', '--workspace', root, '--json']);
    expect(doctor.data.warnings[0].missingProviders).toEqual(['claude', 'codex']);
    log.mockClear();
    await indexCli(['refresh', '--workspace', root, '--only', 'sessions', '--json']);
    const refreshed = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(refreshed.jobs[0].sessionImport.run.preflight).toMatchObject({
      expectedProviders: ['claude', 'codex', 'grokbot'], expectedProviderBasis: 'workspace-config',
      scopeWarnings: [expect.objectContaining({ missingProviders: ['claude', 'codex'] })],
    });
    expect(refreshed.messages.join(' ')).toContain('claude, codex');
    const fresh = join(root, 'fresh.sqlite');
    const imported = await cli(['import-discovered', '--workspace', root, '--db', fresh, '--confirm', '--json']);
    expect(imported.data.receipt.totals).toMatchObject({ accepted: 3, rejected: 0 });
    expect(imported.data.warnings[0].missingProviders).toEqual(['claude', 'codex']);
    const repository = new SessionRepository(fresh);
    try {
      expect(repository.listSessions({ workspaceId: root, limit: 10 }).items.map(session => session.provider).sort())
        .toEqual(['claude', 'codex', 'grokbot']);
    } finally { repository.close(); }
    process.exitCode = 0;
  });

  it('combines configured Codex roots with repeated flags and resolves each relative base', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(join(workspace, '.aiwg'), { recursive: true });
    writeFileSync(join(workspace, '.aiwg/aiwg.config'), JSON.stringify({
      sessions: { codex_roots: ['configured'] },
    }));
    const configured = join(workspace, 'configured');
    const first = join(root, 'first');
    const second = join(root, 'second');
    for (const [index, path] of [configured, first, second].entries()) {
      mkdirSync(path);
      writeFileSync(join(path, 'rollout.jsonl'), JSON.stringify({
        type: 'session_meta', payload: { id: `session-${index}`, cwd: workspace },
      }) + '\n');
    }
    const manifestPath = join(root, 'discovery.json');
    const result = await cli(['discover', '--workspace', workspace, '--expected-providers', 'codex',
      '--codex-root', 'first', '--codex-root', 'second', '--codex-root', 'first',
      '--manifest', manifestPath, '--json']);
    expect(result.exitCode).toBe(0);
    expect(result.data.manifest.totals.sources).toBe(3);
    expect(result.data.manifest.providers[0].rootCounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ root: '<session-source>/configured', sourceCount: 1 }),
      expect.objectContaining({ root: '<session-source>/first', sourceCount: 1 }),
      expect.objectContaining({ root: '<session-source>/second', sourceCount: 1 }),
    ]));
    expect(JSON.stringify(result.data.manifest.providers)).not.toContain(root);
    expect(JSON.parse(readFileSync(manifestPath, 'utf8')).authorizedRoots.codex).toEqual([configured, first, second]);

    const configuredOnly = await cli(['discover', '--workspace', workspace, '--expected-providers', 'codex',
      '--dry-run', '--json']);
    expect(configuredOnly.exitCode).toBe(0);
    expect(configuredOnly.data.manifest.totals.sources).toBe(1);
  });

  it('rejects a repeated Codex root flag without its value', async () => {
    const result = await cli(['discover', '--workspace', root, '--codex-root', 'first', '--codex-root', '--json']);
    expect(result.exitCode).toBe(2);
    expect(result.error.code).toBe('MISSING_OPTION_VALUE');
  });

  it('reports actual runtime and every expected provider without requiring SQLite', async () => {
    const result = await cli(['sources', '--expected-providers', 'muse,future-provider', '--json']);
    expect(result.exitCode).toBe(0);
    const preflight = result.data.preflight;
    expect(preflight).toMatchObject({ expectedProviders: ['future-provider', 'muse'], status: 'partial' });
    expect(preflight.ledger[0]).toMatchObject({ provider: 'future-provider', disposition: 'missing-adapter' });
    expect(preflight.supportedProviders).toEqual([...SESSION_PROVIDER_IDS].sort());
    const pkg = JSON.parse(readFileSync(join(preflight.runtime.packageRoot, 'package.json'), 'utf8'));
    expect(preflight.runtime.version).toBe(pkg.version);
  });

  it('keeps public adapter versions and capabilities in registry parity', async () => {
    const result = await cli(['sources', '--json']);
    for (const adapter of adapters.createSessionAdapterRegistry().list()) {
      const report = result.data.providers.find((entry: { provider: string }) => entry.provider === adapter.provider);
      expect(report.evidence.adapterVersion).toBe(adapter.adapterVersion);
      expect(report.supportedOperations).toEqual([...adapter.supportedOperations]);
      expect(report.acquisitionModes).toEqual([...adapter.acquisitionModes]);
    }
  });

  it('does not silently omit Muse from discovery when the active registry lacks it', async () => {
    const registry = new SessionSourceAdapterRegistry();
    registry.register(adapters.createSessionAdapterRegistry().get('claude'));
    vi.spyOn(adapters, 'createSessionAdapterRegistry').mockReturnValue(registry);
    const result = await cli(['discover', '--workspace', root, '--provider-home', root,
      '--expected-providers', 'muse,claude', '--dry-run', '--json']);
    expect(result.exitCode).toBe(0);
    expect(result.data.manifest.preflight.ledger).toContainEqual(expect.objectContaining({
      provider: 'muse', disposition: 'missing-adapter', adapterVersion: null,
    }));
    expect(result.data.manifest.preflight.unresolvedProviders).toContain('muse');
    expect(result.data.manifest.providers).toHaveLength(2);
  });

  it('persists explicit scope and refuses a different import scope', async () => {
    const manifest = join(root, 'manifest.json');
    const discovery = await cli(['discover', '--workspace', root, '--expected-providers', 'muse',
      '--manifest', manifest, '--json']);
    expect(discovery.data.manifest.preflight.ledger[0].disposition).toBe('authorization-required');
    const preview = await cli(['import-discovered', '--workspace', root, '--manifest', manifest, '--dry-run', '--json']);
    expect(preview.data.receipt.coverage).toMatchObject({ acquisitionStatus: 'partial', semanticReview: 'not-assessed' });
    const mismatch = await cli(['import-discovered', '--workspace', root, '--manifest', manifest,
      '--expected-providers', 'claude,muse', '--dry-run', '--json']);
    expect(mismatch.error.code).toBe('INVALID_ARGUMENT');
  });

  itWithSqlite('keeps a healthy catalog partial after a successful parent-only Muse import', async () => {
    const id = '00000000-0000-4000-8000-000000000002';
    const museRoot = join(root, 'muse');
    const parent = join(museRoot, '2026/09/25', id);
    mkdirSync(parent, { recursive: true });
    const fixture = readFileSync(join(process.cwd(), 'test/fixtures/sessions/muse/native/2026/09/25', id, 'session.jsonl'), 'utf8');
    writeFileSync(join(parent, 'session.jsonl'), fixture.replaceAll('<redacted-path>', root));
    const manifest = join(root, 'manifest.json');
    const db = join(root, 'catalog.sqlite');
    await cli(['discover', '--workspace', root, '--expected-providers', 'muse', '--muse-root', museRoot, '--manifest', manifest, '--json']);
    const imported = await cli(['import-discovered', '--workspace', root, '--manifest', manifest, '--db', db, '--confirm', '--json']);
    expect(imported.exitCode, JSON.stringify(imported)).toBe(0);
    expect(imported.data.receipt.totals).toMatchObject({ accepted: 1, eventsAccepted: 14 });
    expect(imported.data.receipt.coverage.preflight.ledger[0].disposition).toBe('scope-incomplete');
    const doctor = await cli(['doctor', '--workspace', root, '--db', db, '--json']);
    expect(doctor.data.health).toMatchObject({ integrity: 'ok', indexIntegrity: 'ok' });
    const listed = await cli(['list', '--workspace', root, '--db', db, '--json']);
    expect(listed.data.coverage.acquisitionStatus).toBe('partial');
  });

  itWithSqlite('reports complete default-scope acquisition and no resume requirement despite provider gaps', async () => {
    const history = join(root, '.claude', 'projects', root.replace(/[/:]+/g, '-'));
    mkdirSync(history, { recursive: true });
    writeFileSync(join(history, 'session.jsonl'), JSON.stringify({
      type: 'user', uuid: 'request', sessionId: 'synthetic-session',
      timestamp: '2026-10-01T00:00:00.000Z', message: { role: 'user', content: 'Test.' },
    }) + '\n');
    const manifest = join(root, 'manifest.json');
    const db = join(root, 'catalog.sqlite');
    await cli(['discover', '--workspace', root, '--provider-home', root, '--manifest', manifest, '--json']);
    const imported = await cli(['import-discovered', '--workspace', root, '--manifest', manifest, '--db', db, '--yes', '--json']);
    expect(imported.exitCode, JSON.stringify(imported)).toBe(0);
    expect(imported.data.resumable).toBe(false);
    expect(imported.data.receipt).toMatchObject({
      schemaVersion: '2.0.0', run: { schemaVersion: '2.0.0', status: 'complete' },
      totals: { discovered: 1, accepted: 1, rejected: 0, pending: 0 },
      coverage: { schemaVersion: '2.0.0', status: 'partial', acquisitionStatus: 'complete', unresolvedProviders: expect.arrayContaining(['warp']) },
    });
    const listed = await cli(['list', '--workspace', root, '--db', db, '--json']);
    expect(listed.data.coverage.acquisitionStatus).toBe('complete');
    expect(listed.data.coverage.unresolvedProviders).toContain('warp');
  });
});
