import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { resolveWorkerInvocation, prepareWorkerInvocation } from '../../../src/serve/worker-invocation.js';
import { MuseAdapter, interfaceVersion, register } from '../../../tools/ralph-external/lib/muse-adapter.mjs';
import { assertOperatorWorkerNativeArgv, inspectWorkerInvocationProfile, loadProviderModelCapabilities,
  WORKER_OPERATOR_APPROVAL } from '../../../src/models/provider-policy.js';

function fixture(sandbox = 'workspace-write') {
  const adapter = structuredClone(loadProviderModelCapabilities().providers.muse.workerHealthAdapter!);
  adapter.qualification = { status: 'qualified', evidenceRef: WORKER_OPERATOR_APPROVAL,
    verifiedAt: '2026-10-23T00:00:00.000Z', fixtureDigest: `sha256:${'a'.repeat(64)}` };
  const selected = { model: 'muse-spark-1.3', effort: { value: 'medium' } };
  const permissions = { sandbox, approval: 'never' };
  const argv = ['muse', ...new MuseAdapter().buildWorkerArgs({ selected, cwd: '/tmp/project',
    briefPath: '/tmp/project/brief.txt', health: { maxSteps: 3 } }, adapter.invocationProfiles!['direct-shell'], permissions)];
  return { adapter, selected, permissions, argv };
}

describe('Muse installed direct dispatch contract', () => {
  it.each(['workspace-write', 'external'] as const)('resolves a Muse %s member through the real renderer with a fake installed driver', async sandbox => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'muse-direct-resolve-'));
    try {
      const f = workerResolutionFixture();
      const { adapter } = fixture();
      adapter.qualification.verifiedAt = f.observation.verifiedAt;
      const profile = adapter.invocationProfiles!['direct-shell'];
      const brief = path.join(root, 'brief.txt');
      await writeFile(brief, 'Synthetic brief');
      delete f.snapshot.registry.providers.codex.workerAdapter;
      f.snapshot.registry.providers.muse.workerAdapter = adapter;
      const group = f.snapshot.config.parallelism!.groups!.workers;
      group.execution = { sandbox };
      group.members = [{ ...group.members[0], cli: 'muse', model: 'muse-spark-1.3' }];
      group.fallback = [];
      f.snapshot.models.defaults.workerSelection!.guards!.denySelfDelegation = false;
      const discovery = f.snapshot.catalog.discovery!.instances!.codex;
      discovery.provider = 'muse'; discovery.runtimeVersion = '1.4.12';
      discovery.models = discovery.models.slice(0, 1);
      Object.assign(discovery.models[0], { id: 'muse-spark-1.3', apiModelId: 'muse-spark-1.3' });
      Object.assign(discovery.models[0].worker!, { cliId: 'muse', runtimeVersion: '1.4.12' });
      f.snapshot.catalog.discovery!.instances = { muse: discovery };
      f.snapshot.installations = { muse: { ...f.snapshot.installations.codex, profile: 'direct-shell', cliVersion: '1.4.12' } };
      const drivers: any = { muse: { qualification: { adapter, adapterId: 'muse', cliVersion: '1.4.12' },
        prepareWorkerInvocation: (invocation: any, qualification: any) => prepareWorkerInvocation(invocation, qualification),
        buildInvocation: async (input: any) => ({ argv: ['/synthetic/muse', ...new MuseAdapter().buildWorkerArgs(input, profile, input.permissions)],
          stdin: 'closed', envNames: [] }) } };
      const plan = await resolveWorkerInvocation(f.snapshot, { role: 'coding', group: 'workers', task: 'implementation',
        brief, workdir: root, final_output: path.join(root, 'result.json'), transport: 'shell' }, drivers, f.request.now);
      expect(plan.invocation, JSON.stringify(plan.diagnostics)).toMatchObject({ readiness: 'launchable',
        selected: { cli: 'muse', model: 'muse-spark-1.3', effort: { value: 'medium' } } });
      expect(plan.invocation!.shellCommand).toContain('/synthetic/muse');
      expect(plan.invocation!.shellCommand).toContain('< /dev/null');
      expect(plan.invocation!.argv).not.toContain('--output-schema');
      expect(plan.invocation!.argv).not.toContain('${schema}');
      expect(plan.invocation!.argv.includes('--disable-sandbox')).toBe(sandbox === 'external');
      expect(plan.diagnostics.filter(item => item.code === 'OG_SANDBOX_EXTERNAL')).toEqual(sandbox === 'external'
        ? [expect.objectContaining({ blocking: false, message: expect.stringContaining("muse CLI's own sandbox is disabled") })] : []);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('exports the installed-module factory and preserves Muse identity', () => {
    const approved = JSON.parse(readFileSync('test/fixtures/providers/muse/approved-module.json', 'utf8'));
    expect(approved.source).toBe('tools/ralph-external/lib/muse-adapter.mjs');
    expect(approved.entry.sha256).toBe(`sha256:${createHash('sha256').update(readFileSync(approved.source)).digest('hex')}`);
    expect(approved.entry.adapterIds).toEqual(['muse']);
    expect(interfaceVersion).toBe(1);
    let instance: MuseAdapter | undefined;
    register((id: string, create: () => MuseAdapter) => {
      expect(id).toBe('muse');
      instance = create();
    });
    expect(instance).toBeInstanceOf(MuseAdapter);
    expect(instance!.getName()).toBe('muse');
  });

  it.each(['read-only', 'workspace-write', 'external'])('checks exact native %s argv', sandbox => {
    const f = fixture(sandbox);
    expect(() => assertOperatorWorkerNativeArgv(f.adapter, f.argv, f.selected, f.permissions)).not.toThrow();
    expect(f.argv.includes('--disable-sandbox')).toBe(sandbox === 'external');
    expect(f.argv.includes('--disable-write')).toBe(sandbox === 'read-only');
    expect(f.argv.includes('--disable-shell')).toBe(sandbox === 'read-only');
    expect(f.argv).toEqual(expect.arrayContaining(['--approval-mode', 'never', '--approval-judge', 'off']));
    if (sandbox === 'external') {
      expect(() => assertOperatorWorkerNativeArgv(f.adapter, f.argv.filter(x => x !== '--disable-sandbox'),
        f.selected, f.permissions)).toThrow('sandbox');
      for (const other of ['read-only', 'workspace-write']) {
        expect(() => assertOperatorWorkerNativeArgv(f.adapter, f.argv, f.selected, { ...f.permissions, sandbox: other })).toThrow('sandbox');
      }
    }
    if (sandbox === 'read-only') {
      expect(() => assertOperatorWorkerNativeArgv(f.adapter, f.argv.filter(x => x !== '--disable-shell'),
        f.selected, f.permissions)).toThrow('read-only');
    }
    for (const extra of [['--yolo'], ['--disable-sandbox'], ['--config', 'sandbox=false'], ['--model', 'other'],
      ['--approval-mode', 'on-request'], ['--permission-profile', 'other']]) {
      expect(() => assertOperatorWorkerNativeArgv(f.adapter, [...f.argv, ...extra], f.selected, f.permissions)).toThrow();
    }
    expect(() => assertOperatorWorkerNativeArgv(f.adapter, f.argv, { ...f.selected, model: 'other' }, f.permissions)).toThrow('--model');
    expect(() => assertOperatorWorkerNativeArgv(f.adapter, f.argv, { ...f.selected, effort: { value: 'high' } }, f.permissions)).toThrow('--reasoning-effort');
  });

  it.each(['children', 'fallback', 'structuredOutput'])('blocks explicitly requested unsupported %s control', control => {
    const f = fixture();
    expect(() => inspectWorkerInvocationProfile(f.adapter, { profile: 'direct-shell', transport: 'shell',
      cliVersion: '1.4.12', requiredControls: [control], permissions: f.permissions })).toThrow(`unqualified: ${control}`);
  });
});
