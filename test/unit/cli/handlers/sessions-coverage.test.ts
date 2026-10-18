import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionsHandler } from '../../../../src/cli/handlers/sessions.js';
import * as adapters from '../../../../src/sessions/adapter-registry.js';
import { SessionSourceAdapterRegistry } from '../../../../src/sessions/discovery.js';
import { SESSION_PROVIDER_IDS } from '../../../../src/sessions/contracts.js';
import { itWithSqlite } from '../../../helpers/sqlite.js';

let root: string;
let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sessions-coverage-cli-'));
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
async function cli(args: string[]) {
  const result = await sessionsHandler.execute({ args, rawArgs: ['sessions', ...args], cwd: root, frameworkRoot: process.cwd() });
  return { exitCode: result.exitCode, ...JSON.parse(String(log.mock.calls.at(-1)?.[0])) };
}

describe('sessions coverage CLI', () => {
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
    expect(imported.exitCode).toBe(0);
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
    expect(imported.exitCode).toBe(0);
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
