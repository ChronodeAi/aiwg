// T-OG-09/10/13 partial: offline receipt projection; no managed-service acceptance claim.
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDirectActivityReceipt, prepareDirectAttemptPaths, settleAttemptDisposition, writeProtectedFile,
  normalizeUsageForReceipt } from '../../../tools/ralph-external/lib/dispatch-evidence.mjs';
import { WorkerReceiptTelemetry, type DecisionTelemetryTrace } from '../../../src/decision/telemetry/index.js';
import receipt from '../../fixtures/decision/worker-telemetry.json';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const fakeCli = fileURLToPath(new URL('../../fixtures/ralph-worker-cli.mjs', import.meta.url));
const remote = { dataPolicy: { allowedProcessing: ['remote' as const] } };
const options = { conductorId: 'conductor', runId: 'run', allowedModels: ['requested-v1', 'served-v2'] };

describe('optional worker receipt projection without MC/Mission services', () => {
  it.each(['saturated', 'hanging', 'outage'] as const)('T-OG-09 T-OG-13 preserves dispatch, completion and retained evidence during %s export', async mode => {
    const root = await mkdtemp(path.join(tmpdir(), 'aiwg-worker-otel-')); roots.push(root);
    const retained: Array<{ path: string; bytes: string }> = [];
    const signals: AbortSignal[] = [];
    const traces: DecisionTelemetryTrace[] = [];
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const observer = new WorkerReceiptTelemetry({ ...options, enabled: true, selection: remote,
      capacity: 1, timeoutMs: mode === 'saturated' ? 5000 : 5, maximumDiagnostics: 3,
      sink: { export: async (trace, signal) => {
        traces.push(trace); signals.push(signal);
        if (mode === 'outage') throw new Error('sk-proj-synthetic-secret collector outage');
        if (mode === 'hanging') return new Promise<void>(() => {}); // Deliberately ignores abort.
        await blocked;
      } } });
    for (let i = 0; i < 4; i++) {
      const invocationId = `inv-2929-${i}`;
      const paths = await prepareDirectAttemptPaths(root, invocationId);
      const recordPath = path.join(paths.evidenceDir, 'fake-cli.json');
      const configPath = path.join(paths.briefDir, 'fixture.json');
      await writeFile(configPath, JSON.stringify({ recordPath, scenario: 'success' }));
      const result = spawnSync(process.execPath, [fakeCli], { cwd: root, input: 'PROMPT-CANARY',
        env: { PATH: process.env.PATH, AIWG_FAKE_WORKER_CONFIG: configPath }, encoding: 'utf8', timeout: 5000 });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).result.status).toBe('completed');
      const final = await writeProtectedFile(path.join(paths.evidenceDir, 'final.json'), result.stdout);
      retained.push({ path: final.path, bytes: result.stdout });
      const fields = { ...receipt, invocationId, usage: normalizeUsageForReceipt(receipt.usage) };
      const baseline = buildDirectActivityReceipt(fields);
      const projected = buildDirectActivityReceipt(fields, observer);
      expect(projected).toEqual(baseline);
      expect(settleAttemptDisposition('completed').removable).toBe(true);
      expect(settleAttemptDisposition('uncertain').removable).toBe(false);
      const stored = await writeProtectedFile(path.join(paths.evidenceDir, 'receipt.json'), JSON.stringify(projected.receipt));
      retained.push({ path: stored.path, bytes: JSON.stringify(baseline.receipt) });
    }
    // Dispatch/completion above finished while a saturated collector was still blocked.
    if (mode === 'saturated') {
      expect(traces).toHaveLength(1);
      expect(observer.diagnostics.some(d => d.type === 'dropped')).toBe(true);
      release();
    }
    await observer.shutdown();
    expect(observer.diagnostics.length).toBeLessThanOrEqual(3);
    if (mode === 'hanging') { expect(signals.every(s => s.aborted)).toBe(true); expect(observer.diagnostics.some(d => d.type === 'timeout')).toBe(true); }
    if (mode === 'outage') expect(observer.diagnostics.some(d => d.type === 'failed')).toBe(true);
    expect(JSON.stringify(observer.diagnostics)).not.toContain('sk-proj-');
    expect(traces.length).toBeLessThanOrEqual(4);
    for (const file of retained) {
      const bytes = await readFile(file.path, 'utf8');
      expect(bytes).toBe(file.bytes);
      if (path.basename(file.path) === 'receipt.json') expect(JSON.parse(bytes)).toMatchObject({ termination: 'confirmed', usage: { quality: 'reported' } });
      else expect(JSON.parse(bytes).result.status).toBe('completed');
    }
  });

  it('T-OG-10 default-off and class-local-only receipts cannot enqueue telemetry', async () => {
    let calls = 0;
    const sink = { export: async () => { calls++; } };
    for (const config of [{ selection: remote }, { enabled: true, selection: { ...remote,
      dataClasses: { private: { allowedProcessing: ['local' as const] } } }, dataClass: 'private' }]) {
      const observer = new WorkerReceiptTelemetry({ ...options, ...config, sink });
      expect(buildDirectActivityReceipt(receipt, observer)).toEqual(buildDirectActivityReceipt(receipt));
      await observer.shutdown();
      expect(observer.diagnostics).toEqual([]);
    }
    expect(calls).toBe(0);
  });

  it('T-OG-09 observer exceptions never become receipt or completion failures', () => {
    const original = buildDirectActivityReceipt(receipt);
    expect(buildDirectActivityReceipt(receipt, { offer() { throw new Error('synthetic projection failure'); } })).toEqual(original);
  });
});
