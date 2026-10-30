/** Doctor reports native sandbox compatibility separately from installation approval. */
import { mkdtempSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { systemdClientFixture } from '../../fixtures/systemd-client.js';
import { checkWorkerSandboxLaunches } from '../../../tools/cli/worker-qualification.mjs';
import { workerNativeSandboxProbeHooks } from '../../../tools/ralph-external/lib/worker-native-sandbox.mjs';
import { probeWorkerNativeSandbox } from '../../../tools/ralph-external/lib/worker-isolation.mjs';

const repo = process.cwd();
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('doctor namespace compatibility through the launcher unit probe', () => {
  it.each(['codex', 'muse'])('reports the bwrap unit outcome for a %s group', async cli => {
    const clients = systemdClientFixture(); roots.push(clients.root); vi.stubEnv('PATH', clients.root);
    let status = 0;
    const spawn = vi.fn((_binary: string, argv: string[]) => argv.includes('show-environment')
      ? { status: 0, stdout: '' } : { status, stderr: 'bwrap: Operation not permitted' });
    const probeNativeSandbox = options => probeWorkerNativeSandbox({ ...options, spawn,
      probeHooks: { [cli]: options => workerNativeSandboxProbeHooks[cli]({ ...options, executable: () => true }) } });
    const input = { projectDir: repo, config: { parallelism: {
      groups: { workers: { members: [{ cli }], execution: { sandbox: 'workspace-write' } } }
    } }, registry: { providers: { [cli]: { workerAdapter: { provider: cli } } } },
    detectIsolation: () => ({ mode: 'systemd-unit' }), probeNativeSandbox };
    expect(await checkWorkerSandboxLaunches(input)).toMatchObject([{ cli, status: 'passed', probe: { mechanism: 'bwrap', ok: true } }]);
    status = 1;
    const checks = await checkWorkerSandboxLaunches(input);
    expect(checks).toMatchObject([{ cli, status: 'blocked', probe: { mechanism: 'bwrap', code: 'OG_NATIVE_SANDBOX_UNAVAILABLE' } }]);
    expect(checks[0].diagnostics[0].message).toContain('bwrap probe failed');
    expect(checks[0].diagnostics[0].message).not.toMatch(/AppArmor|native-sandbox/);
    expect(spawn).toHaveBeenCalledTimes(4);
  });

  it('reports the unit probe failure as launcher-scoped without failing qualification', async () => {
    const { checkWorkerSandboxLaunches, qualifyProbedWorkers } = await import('../../../tools/cli/worker-qualification.mjs');
    const f = workerResolutionFixture();
    f.snapshot.registry.providers.codex.workerAdapter!.provider = 'codex';
    f.snapshot.config.parallelism!.groups!.workers.execution = { sandbox: 'workspace-write', transport: 'shell' };
    const root = mkdtempSync(path.join(os.tmpdir(), 'doctor-sandbox-probe-')); roots.push(root);
    const projectDir = path.join(root, 'project');
    await mkdir(projectDir);
    vi.stubEnv('HOME', root);
    vi.stubEnv('AIWG_CONFIG', path.join(root, 'config'));
    vi.stubEnv('AIWG_HOME', repo);
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    try {
      const probeNativeSandbox = vi.fn(() => ({ ok: false, code: 'OG_NATIVE_SANDBOX_UNAVAILABLE',
        detail: 'bwrap: namespace creation denied', mechanism: 'bwrap', mode: 'systemd-unit' }));
      const input = { projectDir, config: f.snapshot.config, registry: f.snapshot.registry,
        detectIsolation: () => ({ mode: 'systemd-unit' }), probeNativeSandbox };
      const checks = await checkWorkerSandboxLaunches(input);
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({ status: 'blocked', isolation: 'systemd-unit', scope: 'systemd-launcher',
        diagnostics: [{ code: 'OG_NATIVE_SANDBOX_UNAVAILABLE', message: expect.stringContaining('bwrap probe failed') }] });
      const result = await qualifyProbedWorkers({ ...input, packageRoot: repo, yes: true,
        section: { installFindings: [{ cli: 'codex', readiness: 'ready', executable: '/synthetic/codex', installedVersion: '1.0.0' }] } });
      // The probe is reported with the result, but it no longer short-circuits
      // qualification: the store is prepared and each CLI is evaluated.
      expect(result.sandboxChecks).toEqual(checks);
      expect(result.results.some((entry: { diagnostics?: Array<{ code: string }> }) =>
        entry.diagnostics?.some(diagnostic => diagnostic.code === 'OG_NATIVE_SANDBOX_UNAVAILABLE'))).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });

  it('reports passing probes and skips them for the policy-selected native sandbox', async () => {
    const { checkWorkerSandboxLaunches } = await import('../../../tools/cli/worker-qualification.mjs');
    const f = workerResolutionFixture();
    f.snapshot.registry.providers.codex.workerAdapter!.provider = 'codex';
    f.snapshot.config.parallelism!.groups!.workers.execution = { sandbox: 'read-only', transport: 'shell' };
    const probeNativeSandbox = vi.fn(() => ({ ok: true, mode: 'systemd-unit' }));
    const input = { projectDir: repo, config: f.snapshot.config, registry: f.snapshot.registry,
      detectIsolation: () => ({ mode: 'systemd-unit' }), probeNativeSandbox };
    expect(await checkWorkerSandboxLaunches(input)).toMatchObject([{ status: 'passed', probe: { ok: true } }]);
    probeNativeSandbox.mockClear();
    f.snapshot.config.parallelism!.groups!.workers.execution!.launchMode = 'native-sandbox';
    expect(await checkWorkerSandboxLaunches(input)).toMatchObject([{ status: 'skipped', isolation: 'native-sandbox' }]);
    expect(probeNativeSandbox).not.toHaveBeenCalled();
  });
});
