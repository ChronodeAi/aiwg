// Exercise contract diagnostics through the real MCP handler using synthetic CLI output.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { loadRecoveryModuleGraph } from '../../helpers/recovery-module-graph.mjs';
import { workerConfigDigest } from '../../../src/config/aiwg-config.js';
import { assertValidWorkerPayload } from '../../../src/mission-protocol/codecs.js';
import { workerFailureDiagnostics } from '../../../src/mcp/tools/worker-failure-diagnostics.mjs';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.each([false, true])('T-OG-17 MCP run reports the failing claims field with recovery=%s', async recovery => {
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
  const graph = await loadRecoveryModuleGraph();
  graph.launcher.resetInProcessAllowanceLedger();
  const root = await mkdtemp(path.join(tmpdir(), 'aiwg-contract-diagnostic-')); roots.push(root);
  const workdir = path.join(root, 'work'); await mkdir(workdir);
  const brief = path.join(root, 'brief'); await writeFile(brief, 'Synthetic contract task.');
  const f = workerResolutionFixture();
  const adapter = f.snapshot.registry.providers.codex.workerAdapter!;
  const boundary = { kind: 'os' as const, identity: 'fixture:enforcing-boundary', digest: workerConfigDigest('boundary'), controls: ['sandbox'] };
  f.snapshot.installations.codex.boundary = boundary;
  const driver = { qualification: { adapter, adapterId: adapter.id, cliVersion: '1.0.0', boundary }, buildInvocation: async (input: any) => ({
    argv: [process.execPath, path.resolve('test/fixtures/ralph-worker-cli.mjs'), '--model', input.selected.model,
      '--effort', input.selected.effort.value, '--sandbox', input.permissions.sandbox, '--approval', input.permissions.approval,
      '--final-output', input.finalPath], stdin: 'brief-text', envNames: [],
  }) };
  await graph.installation.registerWorkerRecoveryCapabilities(driver, { canVerifyAttempt: recovery });
  const launchShellWorker = vi.fn(async (invocation: any) => {
    await writeFile(invocation.finalPath, JSON.stringify({ type: 'result', result: {
      version: 1, status: 'PRIVATE-PAYLOAD-MARKER', summary: 'Synthetic result.',
      claims: [], artifacts: [], checks: [], limitations: [],
    } }));
    return { launched: true, mode: 'systemd-unit', unit: 'synthetic-contract.service' };
  });
  let call: any;
  await graph.workerInvoke.registerWorkerInvokeToolset({ registerTool(_name: string, _schema: unknown, handler: any) { call = handler; } }, {
    projectRoot: root, workerWorktreesRoot: workdir, stdinRuntimeRoot: path.join(root, 'runtime'),
    // Synthetic fixture workdir: never spawn a real context deploy here (the
    // ensure path has its own dedicated coverage); test the diagnostics.
    ensureWorkerContext: false,
    loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: { codex: driver } }),
    now: () => new Date(f.request.now), launchShellWorker,
    waitForUnitTermination: async () => ({ termination: 'confirmed', exitCode: 0 }),
    isolationStatus: () => ({ active: false, result: 'success', execMainCode: 1, execMainStatus: 0 }),
  });
  const response = await call({ operation: 'run', request_id: `contract-${recovery}`, role: 'coding', task: 'implementation',
    group: 'workers', brief, workdir, final_output: path.join(workdir, 'final.json'), transport: 'shell' });
  const body = JSON.parse(response.content[0].text);
  expect(launchShellWorker, JSON.stringify(body)).toHaveBeenCalledOnce();
  expect(body.status, JSON.stringify(body)).toBe('failed');
  expect(body.diagnostics).toContain('OG_CONTRACT_INVALID');
  expect(body.diagnostics).toContainEqual({ code: 'OG_CONTRACT_INVALID', pointer: '/workerClaims/status',
    message: 'Worker contract validation failed at this field.' });
  expect(JSON.stringify(response)).not.toContain('PRIVATE-PAYLOAD-MARKER');
  graph.launcher.resetInProcessAllowanceLedger();
});

it('T-OG-17 reports missing required fields and keeps parser failures at the payload root', () => {
  let failure: unknown;
  try { assertValidWorkerPayload('workerClaims', { version: 1 }); } catch (error) { failure = error; }
  expect(workerFailureDiagnostics(failure, 'workerClaims', 'OG_WORKER_FINAL_INVALID')).toContainEqual(
    expect.objectContaining({ code: 'OG_CONTRACT_INVALID', pointer: '/workerClaims/status' }));
  expect(workerFailureDiagnostics({ code: 'OG_CONTRACT_INVALID', message: 'PRIVATE-PAYLOAD-MARKER' },
    'workerClaims', 'OG_WORKER_FINAL_INVALID')).toContainEqual(expect.objectContaining({ pointer: '/workerClaims' }));
});

it('T-OG-17 never reflects unknown JSON property names from contract errors', () => {
  const payload = { version: 1, status: 'completed', summary: 'ok', claims: [], checks: [], limitations: [],
    artifacts: [{ 'PRIVATE-PAYLOAD-MARKER': 'secret' }] };
  let failure: unknown;
  try { assertValidWorkerPayload('workerClaims', payload); } catch (error) { failure = error; }
  const diagnostics = workerFailureDiagnostics(failure, 'workerClaims', 'OG_WORKER_FINAL_INVALID');
  expect(JSON.stringify(diagnostics)).not.toContain('PRIVATE-PAYLOAD-MARKER');
  expect(diagnostics).toContainEqual(expect.objectContaining({ pointer: expect.stringMatching(/^\/workerClaims\/artifacts\/0(?:\/\w+)?$/) }));
});

it('T-OG-17 semantic JSON failures do not reuse a prior schema field pointer', () => {
  try { assertValidWorkerPayload('workerClaims', { version: 1, status: 'invalid' }); } catch { /* seed AJV error state */ }
  const cyclic: any = {}; cyclic.self = cyclic;
  let failure: unknown;
  try { assertValidWorkerPayload('workerClaims', cyclic); } catch (error) { failure = error; }
  expect(workerFailureDiagnostics(failure, 'workerClaims', 'OG_WORKER_FINAL_INVALID')).toContainEqual(
    expect.objectContaining({ pointer: '/workerClaims' }));
});
