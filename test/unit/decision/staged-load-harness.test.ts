import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DecisionLoadBudgetGuard, decisionLoadEvidenceFlags, decisionLoadManifestDigest, decisionStagedLoadResultRecord, readDecisionLoadManifest,
  runDecisionStagedLoad, validateDecisionLoadManifestV3, verifyDecisionStagedLoadRecord,
  type DecisionLoadManifestV3, type DecisionLoadStopReason,
} from '../../../src/decision/qualification/load.js';
import { syntheticStagedLoadResult } from './qualification-gate-fixtures.js';
import { JevDecisionAdapter } from '../../../src/decision/adapters/jev.js';
import { canonicalJson } from '../../../src/security/artifact-trust.js';
import { loadQualificationMain } from '../../../tools/decision/load-qualification.mjs';

const { sourceGit } = vi.hoisted(() => ({ sourceGit: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), execFileSync: sourceGit }));

const bytes = readFileSync('docs/decision/load-manifest.v3.json', 'utf8');
const original = JSON.parse(bytes) as DecisionLoadManifestV3;
const commit = 'a'.repeat(40);
const pricing = { source: 'typesafe-snapshot' as const, checked_at: '2026-10-18', jev_model: original.model,
  jev_input_per_mtok: .042, jev_output_per_mtok: 0 };
const success = { status: 'success' as const, reason: 'none' as const, actualModel: original.model, uncertainty: null,
  requestId: null, usage: { inputTokens: 1, outputTokens: 0, costUsd: null } };
const paths: string[] = [];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });

function shortManifest(): DecisionLoadManifestV3 {
  const manifest = structuredClone(original);
  manifest.duration = { loadSeconds: 2, spikeSeconds: 1, soakSeconds: 7, evaluatorSampleSeconds: 1 };
  manifest.arrivalModel.averageRequestsPerSecond = 4;
  manifest.arrivalModel.cancellationRate = .1;
  manifest.rollout.shadowSeconds = 10;
  manifest.rollout.rollbackSeconds = 10;
  manifest.bounds.minimumQuietPrincipalAdmissionRatio = .8;
  return manifest;
}
function runOptions(manifest = shortManifest()) {
  return { manifestBytes: JSON.stringify(manifest), sourceRoot: process.cwd(), sourceCommit: commit, networkPath: 'offline synthetic', pricing,
    env: {}, clock: { now: () => Date.now(), advance: async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); } },
    assertSource: async () => {},
    sampleResources: () => ({ rss: 32 * 1_048_576, heapUsed: 16 * 1_048_576, userCPUTime: 1, systemCPUTime: 1 }) };
}

describe('D05 staged load harness (offline only)', () => {
  it('CNC-LOAD-V3-001 reads v1/v2 without rewriting and validates every required v3 scope and budget', () => {
    for (const version of [1, 2, 3]) expect(readDecisionLoadManifest(readFileSync(`docs/decision/load-manifest.v${version}.json`, 'utf8')).schema)
      .toBe(`decision-load-manifest/v${version}`);
    for (const scope of ['workspace', 'provider', 'principal']) {
      const m = structuredClone(original);
      const limits = scope === 'workspace' ? m.workspace : scope === 'provider' ? m.providers.jev! : m.principals[0]!.limits;
      delete limits.maxRetainedWork;
      expect(() => validateDecisionLoadManifestV3(m)).toThrow(/Every v3 scope/);
    }
    const m = structuredClone(original);
    delete (m.budget as Partial<typeof m.budget>).maxUsd;
    expect(() => validateDecisionLoadManifestV3(m)).toThrow(/maxUsd/);
  });

  it('CNC-LOAD-V3-002 stops at 80% and never dispatches a reservation crossing the USD ceiling', () => {
    let now = 0;
    const m = structuredClone(original); m.budget.maxUsd = 1;
    const stopped = vi.fn(); const guard = new DecisionLoadBudgetGuard(m, () => now, 0, stopped);
    expect(guard.reserve('one', 10, .4)).toBe(true);
    guard.observe('jev', success, 10, .4);
    expect(guard.reserve('two', 10, .4)).toBe(true);
    guard.observe('jev', success, 10, .4);
    expect(guard.usage).toEqual({ calls: 2, tokens: 20, usd: .8 });
    expect(guard.stop?.reason).toBe('budget-usd-80-percent');
    now = 1;
    expect(guard.reserve('three', 10, .1)).toBe(false);
    expect(stopped).toHaveBeenCalledTimes(1);
    const projected = new DecisionLoadBudgetGuard(m, () => 0, 0);
    expect(projected.reserve('one', 10, .81)).toBe(false);
    expect(projected.usage.calls).toBe(0);
  });

  it.each(['breaker-open', 'retry-amplification', '429-storm', 'cross-principal-quota', 'max-calls', 'max-tokens', 'max-wall-clock', 'usage-exceeds-reservation'] as const)(
    'CNC-LOAD-V3-003 emits a terminal reason for %s', reason => {
      let now = 0;
      const m = structuredClone(original); m.budget.maxCalls = 2; m.budget.maxTokens = 100;
      const guard = new DecisionLoadBudgetGuard(m, () => now, 0);
      if (reason === 'breaker-open') {
        guard.transition({ providerId: 'jev', from: 'closed', to: 'open', atEpochMs: 0, failures: 3 });
        now = m.stopConditions.maximumBreakerOpenMs + 1; guard.tick();
      } else if (reason === '429-storm') {
        guard.observe('jev', { ...success, status: 'error', reason: 'rate-limited', httpStatus: 429 }, 10, 1);
        now = m.stopConditions.maximum429StormMs + 1; guard.tick();
      } else if (reason === 'retry-amplification') {
        expect(guard.reserve('same', 10, .1)).toBe(true);
        expect(guard.reserve('same', 10, .1)).toBe(false);
      } else if (reason === 'cross-principal-quota') guard.quotaViolation();
      else if (reason === 'max-calls') { guard.reserve('one', 10, 0); guard.reserve('two', 10, 0); guard.reserve('three', 10, 0); }
      else if (reason === 'max-tokens') guard.reserve('one', 101, 0);
      else if (reason === 'max-wall-clock') { now = m.budget.maxWallClockSeconds * 1000; guard.tick(); }
      else guard.observe('jev', { ...success, usage: { inputTokens: 101, outputTokens: 0, costUsd: null } }, 100, 1);
      expect(guard.stop).toEqual({ reason, atMs: now });
      expect(guard.reserve('after-stop', 1, 0)).toBe(false);
    });

  it('CNC-LOAD-V3-004 uses the real controller and fixed sampling, then restores the previous profile with receipts', async () => {
    vi.useFakeTimers();
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'));
    const result = await runDecisionStagedLoad(runOptions());
    expect(result.stop).toBeNull();
    expect(result.stages.map(s => s.phase)).toEqual(['shadow', 'canary', 'rollback']);
    expect(result.profileHistory.map(h => h.kind)).toEqual(['initial', 'change', 'rollback']);
    expect(result.profileHistory[0]!.digest).toBe(result.profileHistory[2]!.digest);
    expect(result.receipts.length).toBeGreaterThan(20);
    expect(result.receipts.every(r => r.admission.decision === 'admit')).toBe(true);
    expect(result.samples.slice(1, -1).every((sample, i) => sample.atMs - result.samples[i]!.atMs === 1000)).toBe(true);
    expect(result.samples.every(s => s.residentMemoryMiB === 32 && s.heapUsedMiB === 16)).toBe(true);
    expect(result.queueWaitDistribution.count).toBe(result.receipts.length);
    expect(result.comparisons.some(c => c.bound.includes('.principal.quiet-reserved.requestsPerMinute'))).toBe(true);
    expect(result.execution).toBe('offline-fake-provider');
    expect(verifyDecisionStagedLoadRecord(result, commit)).toBe(false);
    expect(network).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports sourced provider usage separately from reservations through a fake live adapter', async () => {
    vi.useFakeTimers();
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'));
    const backend = vi.spyOn(JevDecisionAdapter.prototype, 'evaluate').mockImplementation(async request => ({
      ...success, requestId: request.invocationId, usage: { inputTokens: 17, outputTokens: 3, costUsd: null },
    }));
    const manifest = shortManifest(); manifest.arrivalModel.cancellationRate = 0;
    const sourcedPricing = { ...pricing, jev_output_per_mtok: .084 };
    const result = await runDecisionStagedLoad({ ...runOptions(manifest), live: true,
      env: { AIWG_JEV_LOAD_API_KEY: 'synthetic-test-credential' }, pricing: sourcedPricing });
    const calls = backend.mock.calls.length;
    expect(result.stop).toBeNull();
    expect(result.schemaVersion).toBe('decision-load-result/v2');
    expect(calls).toBeGreaterThan(20);
    expect(result.reservedUsage).toEqual({ calls, tokens: result.receipts.reduce((sum, r) => sum + r.tokens, 0),
      usd: result.receipts.reduce((sum, r) => sum + r.costUsd, 0) });
    expect(result.reportedUsage).toMatchObject({ calls, inputTokens: calls * 17, outputTokens: calls * 3, tokens: calls * 20 });
    expect(result.reportedUsage.usd).toBeCloseTo(calls * (17 * .042 + 3 * .084) / 1e6, 12);
    expect(result.reportedUsage.incompleteCalls).toBe(0);
    expect(result.reservedUsage.tokens).toBeGreaterThan(result.reportedUsage.tokens!);
    expect(result.reservedUsage.usd).toBeGreaterThan(result.reportedUsage.usd!);
    expect(result.receipts.every(r => r.servedModel === original.model && r.requestId?.startsWith('d05-'))).toBe(true);
    expect(result.comparisons.find(c => c.bound === 'budget.maxTokens')?.observed).toBe(result.reservedUsage.tokens);
    expect(result.comparisons.find(c => c.bound === 'budget.maxUsd.stopAtFraction')?.observed).toBe(result.reservedUsage.usd);
    expect(network).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps incomplete reported totals unknown and never substitutes a reservation or unsourced price', () => {
    const record = syntheticStagedLoadResult(commit);
    const partial = decisionStagedLoadResultRecord({ ...record, receipts: record.receipts.map((receipt, index) => ({ ...receipt,
      usage: { inputTokens: 17, outputTokens: index === 0 ? null : 3, costUsd: 0 },
    })) });
    expect(partial.reportedUsage).toEqual({ calls: record.receipts.length, inputTokens: 17 * record.receipts.length,
      outputTokens: null, tokens: null, usd: null, incompleteCalls: 1, knownSubtotal: {
        inputTokens: 17 * record.receipts.length, outputTokens: 3 * (record.receipts.length - 1),
        tokens: 20 * (record.receipts.length - 1), usd: expect.any(Number),
      } });
    expect(partial.reportedUsage.knownSubtotal.usd).toBeCloseTo((record.receipts.length - 1) * 17 * .042 / 1e6, 12);
    expect(verifyDecisionStagedLoadRecord(partial, commit)).toBe(true);
    const absent = decisionStagedLoadResultRecord({ ...record, receipts: record.receipts.map(receipt => ({ ...receipt,
      usage: { inputTokens: null, outputTokens: null, costUsd: null },
    })) });
    expect(absent.reportedUsage).toEqual({ calls: record.receipts.length, inputTokens: null, outputTokens: null, tokens: null, usd: null,
      incompleteCalls: record.receipts.length, knownSubtotal: { inputTokens: null, outputTokens: null, tokens: null, usd: null } });
    const differentModel = decisionStagedLoadResultRecord({ ...record, receipts: record.receipts.map(receipt => ({ ...receipt, servedModel: 'jev-9.9.9' })) });
    expect(differentModel.reportedUsage.tokens).toBe(record.reservedUsage.tokens);
    expect(differentModel.reportedUsage.usd).toBeNull();
    const zero = decisionStagedLoadResultRecord({ ...record, receipts: record.receipts.map(receipt => ({ ...receipt,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
    })) });
    expect(zero.reportedUsage).toMatchObject({ inputTokens: 0, outputTokens: 0, tokens: 0, usd: 0 });
  });

  it('verifies original v1 records without changing their schema or digest, and rejects forged v2 totals', () => {
    const record = syntheticStagedLoadResult(commit);
    const { reservedUsage, reportedUsage: _, digest: __, ...fields } = record;
    const body = { ...fields, schemaVersion: 'decision-load-result/v1' as const, usage: reservedUsage };
    const legacy = { ...body, digest: decisionLoadManifestDigest(canonicalJson(body)) };
    const retained = JSON.stringify(legacy);
    expect(verifyDecisionStagedLoadRecord(legacy, commit)).toBe(true);
    expect(decisionLoadEvidenceFlags([legacy], legacy.manifestDigest, commit)['load-manifest-qualified']).toBe(true);
    expect(JSON.stringify(legacy)).toBe(retained);
    for (const change of [
      { reservedUsage: { ...record.reservedUsage, tokens: 1 } },
      { reportedUsage: { ...record.reportedUsage, tokens: 1 } },
      { reportedUsage: { ...record.reportedUsage, usd: null } },
    ]) {
      const { digest, ...tampered } = { ...record, ...change };
      expect(verifyDecisionStagedLoadRecord({ ...tampered, digest: decisionLoadManifestDigest(canonicalJson(tampered)) }, commit)).toBe(false);
    }
    const overBudget = decisionStagedLoadResultRecord({ ...record, manifestBytes: JSON.stringify({ ...record.manifest,
      budget: { ...record.manifest.budget, maxTokens: 1 } }),
      receipts: record.receipts.map(receipt => ({ ...receipt, usage: { inputTokens: 1, outputTokens: 0, costUsd: null } })),
    });
    expect(overBudget.reportedUsage.tokens).toBeLessThan(overBudget.reservedUsage.tokens);
    expect(overBudget.comparisons.find(c => c.bound === 'budget.maxTokens')?.pass).toBe(false);
    expect(verifyDecisionStagedLoadRecord(overBudget, commit)).toBe(false);
    const underReserved = decisionStagedLoadResultRecord({ ...record, receipts: record.receipts.map(receipt => ({ ...receipt,
      usage: { inputTokens: receipt.tokens + 1, outputTokens: 0, costUsd: null },
    })) });
    expect(verifyDecisionStagedLoadRecord(underReserved, commit)).toBe(false);
  });

  it.each(['budget-usd-80-percent', '429-storm', 'breaker-open', 'retry-amplification', 'usage-exceeds-reservation'] as DecisionLoadStopReason[])(
    'CNC-LOAD-V3-005 retains a failed record and rollback after %s in the fake driver', async reason => {
      vi.useFakeTimers();
      const manifest = shortManifest();
      if (reason === 'budget-usd-80-percent') manifest.budget.maxUsd = .0002;
      if (reason === 'breaker-open') manifest.providers.jev!.circuitBreaker = { failureThreshold: 1, openMs: 20000, halfOpenMaxCalls: 1 };
      if (reason === 'retry-amplification') manifest.arrivalModel.retryableFailureRate = 1;
      if (reason === 'breaker-open' || reason === '429-storm') manifest.arrivalModel.maxRetries = 0;
      const opts = runOptions(manifest);
      const result = await runDecisionStagedLoad({ ...opts,
        ...(reason === '429-storm' ? { fakeBackend: async () => ({ ...success, status: 'error' as const, reason: 'rate-limited' as const, httpStatus: 429, retryAfterMs: 100 }) } : {}),
        ...(reason === 'breaker-open' ? { fakeBackend: async () => ({ ...success, status: 'error' as const, reason: 'service-error' as const }) } : {}),
        ...(reason === 'usage-exceeds-reservation' ? { fakeBackend: async () => ({ ...success, usage: { inputTokens: 999999, outputTokens: 1, costUsd: null } }) } : {}),
      });
      expect(result.stop?.reason).toBe(reason);
      expect(result.passed).toBe(false);
      expect(result.profileHistory.at(-1)?.profileVersion).toBe(manifest.rollout.previousProfileVersion);
      expect(result.profileHistory.at(-1)?.kind).toBe('rollback');
      const { digest, ...payload } = result;
      const { canonicalJson } = await import('../../../src/security/artifact-trust.js');
      expect(digest).toBe(decisionLoadManifestDigest(canonicalJson(payload)));
      expect(vi.getTimerCount()).toBe(0);
    });

  it('CNC-LOAD-V3-008 runs the entire 900-second soak on injected time and qualifies all measured bounds offline', async () => {
    vi.useFakeTimers();
    const result = await runDecisionStagedLoad(runOptions(structuredClone(original)));
    expect(result.stop).toBeNull();
    expect(result.comparisons.filter(c => !c.pass)).toEqual([]);
    expect(result.passed).toBe(true);
    // A synthetic copy exercises the live-shaped verifier without selecting live execution.
    expect(verifyDecisionStagedLoadRecord(decisionStagedLoadResultRecord({ ...result, execution: 'live' }), commit)).toBe(true);
    expect(result.stages[1]!.windowSeconds).toBe(990);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(1_010_000);
    expect(result.samples.length).toBeGreaterThanOrEqual(1011);
    expect(verifyDecisionStagedLoadRecord(result, commit)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('CNC-LOAD-V3-009 rejects incomplete windows, bad samples, queue overruns and unreconciled schedules', () => {
    const record = syntheticStagedLoadResult(commit);
    const jittered = decisionStagedLoadResultRecord({ ...record, samples: record.samples.map((sample, index) => ({ ...sample, atMs: sample.atMs + (index % 2 ? 3 : 0) })) });
    expect(verifyDecisionStagedLoadRecord(jittered, commit)).toBe(true);
    for (const changed of [
      { samples: record.samples.filter((_, index) => index % 3 === 0) },
      { elapsedMs: 1, samples: [{ ...record.samples[0]!, atMs: 0 }, { ...record.samples[0]!, atMs: 1 }] },
      { samples: record.samples.map(sample => ({ ...sample, active: 999, queued: 999 })) },
      { stages: record.stages.map(stage => ({ ...stage, scopes: { ...stage.scopes, workspace: { active: 1, queued: 999 } } })) },
      { stages: record.stages.map(stage => ({ ...stage, observations: { ...stage.observations, arrivals: 2 } })) },
    ]) expect(verifyDecisionStagedLoadRecord(decisionStagedLoadResultRecord({ ...record, ...changed }), commit)).toBe(false);
  });

  it('CNC-LOAD-V3-010 stops and cleans up when registration, sampling or backend hooks fail', async () => {
    vi.useFakeTimers();
    const manifest = shortManifest();
    manifest.rollout.workspace.concurrency = 1;
    manifest.principals[0]!.limits.reservedConcurrency = 1;
    const refused = await runDecisionStagedLoad(runOptions(manifest));
    expect(refused.stop?.reason).toBe('driver-error');
    expect(vi.getTimerCount()).toBe(0);
    let sampled = 0;
    const sampleFailure = await runDecisionStagedLoad({ ...runOptions(), sampleResources: () => {
      if (++sampled > 2) throw new Error('sample failed');
      return { rss: 1, heapUsed: 1, userCPUTime: 1, systemCPUTime: 1 };
    } });
    expect(sampleFailure.stop?.reason).toBe('driver-error');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('CNC-LOAD-V3-006 binds every byte, measurement and exact source; refuses a dirty tree before backend dispatch', async () => {
    const record = syntheticStagedLoadResult(commit);
    expect(verifyDecisionStagedLoadRecord(record, commit)).toBe(true);
    expect(decisionLoadEvidenceFlags([record], record.manifestDigest, commit)['load-manifest-qualified']).toBe(true);
    expect(decisionLoadEvidenceFlags([record], `sha256:${'0'.repeat(64)}`, commit)['load-manifest-qualified']).toBe(false);
    expect(verifyDecisionStagedLoadRecord(record, 'b'.repeat(40))).toBe(false);
    expect(verifyDecisionStagedLoadRecord({ ...record, manifestBytes: `${record.manifestBytes} ` }, commit)).toBe(false);
    const dirty = decisionStagedLoadResultRecord({ ...record, dirty: true });
    expect(verifyDecisionStagedLoadRecord(dirty, commit)).toBe(false);
    const changed = decisionStagedLoadResultRecord({ ...record, stages: record.stages.map(stage => ({ ...stage,
      observations: { ...stage.observations, maximumActiveCalls: 20 } })) });
    expect(verifyDecisionStagedLoadRecord(changed, commit)).toBe(false);
    const fakeBackend = vi.fn(async () => success);
    await expect(runDecisionStagedLoad({ ...runOptions(), fakeBackend, assertSource: async () => { throw new Error('dirty tree'); } })).rejects.toThrow('dirty tree');
    expect(fakeBackend).not.toHaveBeenCalled();
    // Exact HEAD matches, but porcelain reports a dirty tree; no git mutations are needed.
    sourceGit.mockImplementation((_command: string, args: string[]) => args[0] === 'rev-parse' ? commit : ' M synthetic-file');
    await expect(runDecisionStagedLoad({ ...runOptions(), assertSource: undefined, fakeBackend })).rejects.toThrow(/clean exact source commit/);
    expect(fakeBackend).not.toHaveBeenCalled();
  });

  it('CNC-LOAD-V3-007 --live refuses missing environment credentials and maxUsd before any backend or config read', async () => {
    const fakeBackend = vi.fn(async () => success);
    await expect(runDecisionStagedLoad({ ...runOptions(), live: true, fakeBackend })).rejects.toThrow(/environment credential/);
    const manifest = structuredClone(original);
    delete (manifest.budget as Partial<typeof manifest.budget>).maxUsd;
    await expect(runDecisionStagedLoad({ ...runOptions(manifest), live: true })).rejects.toThrow(/maxUsd/);
    const dir = mkdtempSync(join(tmpdir(), 'd05-load-cli-')); paths.push(dir);
    const manifestPath = join(dir, 'manifest.json');
    const args = ['--live', '--manifest', manifestPath, '--commit', commit, '--network-path', 'offline', '--output', join(dir, 'result.json')];
    writeFileSync(manifestPath, bytes);
    await expect(loadQualificationMain(args, {})).rejects.toThrow(/environment credential/);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(loadQualificationMain(args, {})).rejects.toThrow(/maxUsd/);
    expect(fakeBackend).not.toHaveBeenCalled();
    writeFileSync(manifestPath, bytes);
    const existing = join(dir, 'existing.json'); writeFileSync(existing, 'retained');
    await expect(loadQualificationMain(args.filter(arg => arg !== '--live').map(arg => arg === join(dir, 'result.json') ? existing : arg), {})).rejects.toThrow(/EEXIST/);
    expect(readFileSync(existing, 'utf8')).toBe('retained');
  });
});
