import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allHandlers } from '../../../../src/cli/handlers/index.js';
import { decisionHandler } from '../../../../src/cli/handlers/decision.js';
import { getCommandDefinition, getCommandIds, searchCommandsByKeyword } from '../../../../src/extensions/commands/definitions.js';
import { listProviderDefinitions } from '../../../../src/providers/provider-definitions.js';

// Review r1 finding 10 / review r2 item 14: isolate every credential, session,
// artifact-root-override and harness-detection environment variable the
// decision CLI could read, and fail loudly if any test attempts a real
// network call (there should never be one here — every `ask` test runs with
// Jev unconfigured). The harness-marker list is derived from every provider
// definition's `detection.env` so no provider can be falsely detected
// regardless of which real host/terminal this suite runs under (a
// hand-curated list previously missed WARP_SESSION_ID/WARP_TERMINAL and
// WINDSURF_VERSION).
function allHarnessMarkerEnvKeys(): string[] {
  return [...new Set(listProviderDefinitions().flatMap(definition => definition.detection.env))];
}

const ISOLATED_ENV_KEYS = [
  'HOME', 'AIWG_HOME', 'AIWG_CONFIG', 'AIWG_SESSION_ID', 'CI', 'AIWG_ROOT',
  'AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR',
  'AIWG_PROVIDER', 'CLAUDECODE_PROVIDER', 'AIWG_TEST_PROCESS_PROVIDER', 'AIWG_DISABLE_PROCESS_PROVIDER_DETECTION',
  'AIWG_DECISION_ENABLED', 'JEV_API_KEY', 'AIWG_DECISION_JEV_API_KEY', 'XDG_CONFIG_HOME',
  ...allHarnessMarkerEnvKeys(),
] as const;

describe('decisionHandler', () => {
  const cleanup: string[] = [];
  let savedEnv: Record<string, string | undefined> = {};
  let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ISOLATED_ENV_KEYS) { savedEnv[key] = process.env[key]; delete process.env[key]; }
    // Process-tree provider detection walks /proc on the real host; disable it so
    // resolution is driven only by the explicit --provider/env this file sets.
    process.env.AIWG_DISABLE_PROCESS_PROVIDER_DETECTION = '1';
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('decisionHandler test attempted a real network call');
    });
  });

  afterEach(async () => {
    fetchSpy?.mockRestore();
    await Promise.all(cleanup.map(directory => rm(directory, { recursive: true, force: true })));
    cleanup.length = 0;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('is registered with command metadata', () => {
    expect(decisionHandler.id).toBe('decision');
    expect(decisionHandler.category).toBe('utility');
    expect(allHandlers.filter(handler => handler.id === 'decision')).toHaveLength(1);
    expect(getCommandDefinition('decision')).toMatchObject({
      id: 'decision',
      description: expect.stringMatching(/classification/i),
    });
    expect(getCommandIds()).toContain('decision');
    expect(searchCommandsByKeyword('classification').map(command => command.id)).toContain('decision');
  });

  it('returns machine-readable capabilities', async () => {
    const result = await decisionHandler.execute({
      args: ['capabilities'],
      rawArgs: ['decision', 'capabilities'],
      cwd: process.cwd(),
      frameworkRoot: process.cwd(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.rawOutput).toBe(true);
    expect(JSON.parse(result.message ?? '{}')).toMatchObject({ offlineReady: true, backend: { status: 'not-probed' } });
  });

  it('evaluates through the CLI handler with an operator-selected trusted host policy module', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-cli-'));
    cleanup.push(dir);
    const setup = await decisionHandler.execute({
      args: ['setup', 'synthetic-classification', '--output-dir', dir],
      rawArgs: ['decision', 'setup', 'synthetic-classification', '--output-dir', dir],
      cwd: process.cwd(),
      frameworkRoot: process.cwd(),
    });
    expect(setup.exitCode).toBe(0);
    const modulePath = path.join(dir, 'trusted-host-policies.mjs');
    await writeFile(modulePath, 'export default {};\n');
    process.env.AIWG_DECISION_ENABLED = '1';
    const result = await decisionHandler.execute({
      args: ['evaluate', '--request', path.join(dir, 'dispatcher-request.json'), '--host-policy-module', modulePath],
      rawArgs: ['decision', 'evaluate', '--request', path.join(dir, 'dispatcher-request.json'), '--host-policy-module', modulePath],
      cwd: process.cwd(),
      frameworkRoot: process.cwd(),
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.message ?? '{}')).toMatchObject({ exitCode: 0, result: { kind: 'RulesetResult' } });
  });

  it('returns ask fallback JSON without configured Jev, resolving provider to "unknown" under a missing/unreadable project config', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-cli-'));
    cleanup.push(dir);
    process.env.XDG_CONFIG_HOME = dir;
    const result = await decisionHandler.execute({
      args: ['ask', '--question', 'Proceed?', '--yes-no', '--json'],
      rawArgs: ['decision', 'ask', '--question', 'Proceed?', '--yes-no', '--json'],
      // Isolated project root (not process.cwd()): `ask` now appends a decision-ledger
      // record (#2946) and must never write into this repository's own .aiwg/. It also
      // has no .aiwg/aiwg.config at all, so provider auto-detection degrades with no
      // signal — exercising the same "attribution resolution found nothing usable"
      // path as review r1 finding 3's probe, end to end through the real resolver.
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.message ?? '{}')).toMatchObject({ schema: 'aiwg-decision-ask/v1', status: 'fallback', reason: 'not-configured' });
    const ledger = await readFile(path.join(dir, '.aiwg', 'decision', 'ledger.jsonl'), 'utf8');
    expect(JSON.parse(ledger.trim())).toMatchObject({ provider: 'unknown' });
  });

  it('records a ledger entry for ask, honoring --provider, --session, --caller and --record-text', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-cli-'));
    cleanup.push(dir);
    process.env.XDG_CONFIG_HOME = dir;
    const result = await decisionHandler.execute({
      args: [
        'ask', '--question', 'Proceed?', '--yes-no', '--json',
        '--provider', 'codex', '--session', 'sess-123', '--caller', 'worker-pick', '--record-text',
      ],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.message ?? '{}')).toMatchObject({ status: 'fallback', reason: 'not-configured' });

    const ledger = await readFile(path.join(dir, '.aiwg', 'decision', 'ledger.jsonl'), 'utf8');
    const record = JSON.parse(ledger.trim().split('\n')[0]);
    expect(record).toMatchObject({
      schema: 'aiwg-decision-ledger-record/v1',
      transport: 'cli',
      provider: 'codex',
      sessionId: 'sess-123',
      caller: 'worker-pick',
      decisionKind: 'yes-no',
      status: 'fallback',
      fallbackReason: 'not-configured',
      questionText: 'Proceed?',
    });
    expect(record.questionDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('review r1 finding 1 — rejects a malformed --session or --caller with exit 2, before any Jev call', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-cli-'));
    cleanup.push(dir);
    const badSession = await decisionHandler.execute({
      args: ['ask', '--question', 'Proceed?', '--yes-no', '--session', 'has spaces', '--json'],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(badSession.exitCode).toBe(2);
    expect(JSON.parse(badSession.message ?? '{}')).toMatchObject({ reason: 'invalid-session' });

    const badCaller = await decisionHandler.execute({
      args: ['ask', '--question', 'Proceed?', '--yes-no', '--caller', 'not allowed!', '--json'],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(badCaller.exitCode).toBe(2);
    expect(JSON.parse(badCaller.message ?? '{}')).toMatchObject({ reason: 'invalid-caller' });

    // Rejected before askDecision ever runs: no ledger file was created at all.
    await expect(readFile(path.join(dir, '.aiwg', 'decision', 'ledger.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('review r2 item 11 — accepts the documented --caller "address-issues:worker-pick" form', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-cli-'));
    cleanup.push(dir);
    process.env.XDG_CONFIG_HOME = dir;
    const result = await decisionHandler.execute({
      args: ['ask', '--question', 'Proceed?', '--yes-no', '--json', '--caller', 'address-issues:worker-pick'],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(result.exitCode).toBe(0);
    const ledger = await readFile(path.join(dir, '.aiwg', 'decision', 'ledger.jsonl'), 'utf8');
    expect(JSON.parse(ledger.trim())).toMatchObject({ caller: 'address-issues:worker-pick' });
  });

  it('a ledger write failure leaves the ask result and exit code unchanged, and warns once on stderr', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-cli-'));
    cleanup.push(dir);
    process.env.XDG_CONFIG_HOME = dir;
    // Pre-create .aiwg/decision as a *file* so the ledger append fails deterministically.
    await mkdir(path.join(dir, '.aiwg'), { recursive: true });
    await writeFile(path.join(dir, '.aiwg', 'decision'), 'not a directory');

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = await decisionHandler.execute({
        args: ['ask', '--question', 'Proceed?', '--yes-no', '--json'],
        rawArgs: [],
        cwd: dir,
        frameworkRoot: process.cwd(),
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.message ?? '{}')).toMatchObject({ schema: 'aiwg-decision-ask/v1', status: 'fallback', reason: 'not-configured' });
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(String(stderrSpy.mock.calls[0]?.[0])).toMatch(/decision ledger/i);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('history and stats read the ledger offline, with --json, filters and --group-by', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-cli-'));
    cleanup.push(dir);
    process.env.XDG_CONFIG_HOME = dir;

    for (const [question, provider, caller] of [
      ['Proceed?', 'claude', 'worker-a'],
      ['Pick?', 'codex', 'worker-b'],
    ] as const) {
      const execResult = await decisionHandler.execute({
        args: ['ask', '--question', question, '--yes-no', '--json', '--provider', provider, '--caller', caller],
        rawArgs: [],
        cwd: dir,
        frameworkRoot: process.cwd(),
      });
      expect(execResult.exitCode).toBe(0);
    }

    const history = await decisionHandler.execute({
      args: ['history', '--provider', 'codex', '--json'],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(history.exitCode).toBe(0);
    const historyBody = JSON.parse(history.message ?? '{}');
    expect(historyBody).toMatchObject({ schema: 'aiwg-decision-ledger-history/v1', count: 1, skipped: 0 });
    expect(historyBody.records[0]).toMatchObject({ provider: 'codex', caller: 'worker-b' });

    const stats = await decisionHandler.execute({
      args: ['stats', '--group-by', 'caller', '--json'],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(stats.exitCode).toBe(0);
    const statsBody = JSON.parse(stats.message ?? '{}');
    expect(statsBody.schema).toBe('aiwg-decision-ledger-stats/v1');
    expect(statsBody.groupBy).toBe('caller');
    expect(statsBody.groups.map((group: { key: string }) => group.key).sort()).toEqual(['worker-a', 'worker-b']);

    const emptyDir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-cli-'));
    cleanup.push(emptyDir);
    const emptyHistory = await decisionHandler.execute({
      args: ['history', '--json'],
      rawArgs: [],
      cwd: emptyDir,
      frameworkRoot: process.cwd(),
    });
    expect(JSON.parse(emptyHistory.message ?? '{}')).toMatchObject({ count: 0, skipped: 0, records: [] });
  });

  it('review r1 finding 9 — stats honors the same provider/session/kind/status filters as history, not just since/group-by', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-cli-'));
    cleanup.push(dir);
    process.env.XDG_CONFIG_HOME = dir;

    await decisionHandler.execute({ args: ['ask', '--question', 'A', '--yes-no', '--json', '--provider', 'claude'], rawArgs: [], cwd: dir, frameworkRoot: process.cwd() });
    await decisionHandler.execute({ args: ['ask', '--question', 'B', '--yes-no', '--json', '--provider', 'codex'], rawArgs: [], cwd: dir, frameworkRoot: process.cwd() });

    const filtered = await decisionHandler.execute({
      args: ['stats', '--provider', 'codex', '--json'],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    const body = JSON.parse(filtered.message ?? '{}');
    // Before the finding-9 fix, --provider was silently dropped and this totalled both calls.
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].totalCalls).toBe(1);
  });

  it('review r1 finding 11 — rejects an invalid calendar date and a non-ISO --since with exit 2', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-cli-'));
    cleanup.push(dir);
    const badCalendarDate = await decisionHandler.execute({
      args: ['history', '--since', '2026-02-30', '--json'],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(badCalendarDate.exitCode).toBe(2);
    expect(JSON.parse(badCalendarDate.message ?? '{}')).toMatchObject({ reason: 'invalid-since' });

    const badFormat = await decisionHandler.execute({
      args: ['history', '--since', '10/01/2026', '--json'],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(badFormat.exitCode).toBe(2);
    expect(JSON.parse(badFormat.message ?? '{}')).toMatchObject({ reason: 'invalid-since' });

    // Review r2 item 12: an impossible calendar date must be rejected even with an explicit offset.
    const badOffsetDate = await decisionHandler.execute({
      args: ['history', '--since', '2026-02-30T00:00:00+01:00', '--json'],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(badOffsetDate.exitCode).toBe(2);
    expect(JSON.parse(badOffsetDate.message ?? '{}')).toMatchObject({ reason: 'invalid-since' });
  });

  it('rejects an invalid --kind, --status or --group-by with exit 2', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-cli-'));
    cleanup.push(dir);
    const badKind = await decisionHandler.execute({
      args: ['history', '--kind', 'bogus', '--json'],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(badKind.exitCode).toBe(2);
    expect(JSON.parse(badKind.message ?? '{}')).toMatchObject({ reason: 'invalid-kind' });

    const badGroupBy = await decisionHandler.execute({
      args: ['stats', '--group-by', 'bogus', '--json'],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(badGroupBy.exitCode).toBe(2);
    expect(JSON.parse(badGroupBy.message ?? '{}')).toMatchObject({ reason: 'invalid-group-by' });
  });

  it('returns usage errors with exit 2', async () => {
    const result = await decisionHandler.execute({
      args: ['ask', '--question', 'Proceed?', '--yes-no', '--choices', 'a,b', '--json'],
      rawArgs: ['decision', 'ask', '--question', 'Proceed?', '--yes-no', '--choices', 'a,b', '--json'],
      cwd: process.cwd(),
      frameworkRoot: process.cwd(),
    });
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.message ?? '{}')).toMatchObject({ reason: 'invalid-mode' });
  });

  it('reports context-too-large as exit 2', async () => {
    const result = await decisionHandler.execute({
      args: ['ask', '--question', 'Proceed?', '--yes-no', '--context', 'x'.repeat(32 * 1024 + 1), '--json'],
      rawArgs: ['decision', 'ask', '--question', 'Proceed?', '--yes-no', '--context', 'x'.repeat(32 * 1024 + 1), '--json'],
      cwd: process.cwd(),
      frameworkRoot: process.cwd(),
    });
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.message ?? '{}')).toMatchObject({ reason: 'context-too-large' });
  });
});
