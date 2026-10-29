import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveWorkerPlan } from '../../../src/models/worker-plan.js';
import { createModelsHandler } from '../../../src/cli/handlers/models.js';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { sampleWorkerHostResources } from '../../../src/cli/handlers/models-resource-sample.js';
import { hostResourceReport } from '../../../src/config/host-resource-report.mjs';
import { hostResourceReaders, healthyHostResources, ownedWorkerReaders } from '../../fixtures/host-resources.js';
import { readLiveHostResources } from '../../../src/config/host-resource-runtime.mjs';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = () => {
  const f = workerResolutionFixture();
  f.snapshot.hostResources = healthyHostResources();
  return f;
};
const resolve = (f: ReturnType<typeof fixture>) => resolveWorkerPlan(f.snapshot, f.request);

describe('resolver host capacity', () => {
  it('uses owned workers for project, group, CLI and member caps while retaining raw host process counts', () => {
    const f = fixture();
    const unit = 'aiwg-worker-one.service';
    f.snapshot.hostResources = readLiveHostResources(ownedWorkerReaders([unit],
      Array.from({ length: 14 }, (_, index) => index < 3 ? { invocation: 'one', unit } : {})));
    f.snapshot.config.parallelism!.max_parallel_subagents = 10;
    f.snapshot.config.parallelism!.admission = { cliCaps: { codex: 3 }, memberCaps: { 'workers/primary': 3 } };
    const plan = resolve(f);
    expect(plan).toMatchObject({ status: 'eligible', slots: 1, resources: { ok: true,
      measured: { workers: 1, workerUnits: 1, hostCliProcesses: { codex: 14, muse: 0 } } } });
    f.snapshot.hostResources = readLiveHostResources(ownedWorkerReaders(undefined, [
      { invocation: 'a' }, { invocation: 'a' }, { invocation: 'b' }, { invocation: 'b' },
    ]));
    expect(resolve(f)).toMatchObject({ status: 'blocked', slots: 0, resources: { measured: { workers: 2 } } });
  });
  it('samples the requested worktree and output filesystem rather than only the project cwd', () => {
    const seen: string[] = [];
    const readers = { ...hostResourceReaders(), statfsPath: (filename: string) => {
      seen.push(filename); return { bavail: filename === '/output' ? 1 : 32, bsize: 1024 ** 3 };
    } };
    const live = sampleWorkerHostResources({ cwd: '/project', args: ['resolve', '--role', 'coding', '--task', 'implementation', '--group', 'workers',
      '--brief', '/project/brief.md', '--workdir', '/tree', '--final-output', '/output/final.json'] }, readers);
    expect(seen).toEqual(['/project', '/tree', '/output']);
    expect(hostResourceReport({ live })).toMatchObject({ slots: 0, ok: false });
    seen.length = 0;
    sampleWorkerHostResources({ cwd: '/project', args: [] }, readers);
    expect(seen).toEqual(['/project']);
  });

  it('carries the same normalized report and subtracts running workers from configured caps', () => {
    const f = fixture();
    expect(resolve(f)).toMatchObject({ status: 'eligible', slots: 1, resources: { slots: 1, ok: true } });
    expect(resolve(f).selected!.effectiveMaxParallel).toBe(2);
    f.request.maxParallel = 1;
    expect(resolve(f).slots).toBe(1); // Request capacity is already remaining capacity.
    f.request.maxParallel = 0;
    expect(resolve(f)).toMatchObject({ status: 'blocked', selected: null, slots: 0 });
    expect(resolve(f).diagnostics.at(-1)?.message).toContain('request.maxParallel');
  });

  it.each(['groupCaps', 'memberCaps', 'cliCaps', 'modelCaps', 'quotaCaps'] as const)(
    'blocks exhausted %s and identifies the binding cap', cap => {
      const f = fixture();
      f.snapshot.config.parallelism!.clis = { codex: { adapter: 'providers:codex', accountScope: 'synthetic', quotaScope: 'shared' } };
      const keys = { groupCaps: 'workers', memberCaps: 'workers/primary', cliCaps: 'codex', modelCaps: 'vendor/synthetic%2Fa%25b', quotaCaps: 'shared' };
      // Use the resolver's canonical key, including escaped API model identity.
      const first = resolve(f).selected!;
      const key = cap === 'modelCaps' ? first.modelKey : keys[cap];
      f.snapshot.config.parallelism!.groups!.workers.members.splice(1);
      f.snapshot.config.parallelism!.groups!.workers.fallback = [];
      f.snapshot.config.parallelism!.admission = { [cap]: { [key]: 1 } };
      const plan = resolve(f);
      expect(plan).toMatchObject({ status: 'blocked', selected: null, slots: 0 });
      expect(plan.diagnostics.at(-1)?.message).toContain(`admission.${cap}`);
    });

  it('uses the selected eligible tuple report when an earlier tuple has exhausted capacity', () => {
    const f = fixture();
    f.snapshot.config.parallelism!.admission = { memberCaps: { 'workers/primary': 1 } };
    expect(resolve(f)).toMatchObject({ status: 'eligible', selected: { member: 'alternate' }, slots: 1, resources: { ok: true } });
    f.snapshot.constraints = { maxParallel: 0 };
    expect(resolve(f).slots).toBe(0);
  });

  it.each([
    ['min_avail_mem_gb', { availMemGb: 1 }], ['max_load_ratio', { load1: 8, loadRatio: 1 }],
    ['max_mem_psi_avg10', { memPsiAvg10: 31 }], ['max_mem_psi_avg60', { memPsiAvg60: 11 }],
    ['min_free_disk_gb', { freeDiskGb: 1 }], ['max_workers', { workers: 4 }],
  ])('never renders a shell launch at zero slots (%s)', async (threshold, sample) => {
    const root = await mkdtemp(path.join(tmpdir(), 'aiwg-host-resource-')); roots.push(root);
    const f = fixture();
    f.snapshot.config.parallelism!.admission = { hostResources: { max_workers: 4 } };
    f.snapshot.hostResources = { ...healthyHostResources(), ...sample };
    const brief = path.join(root, 'brief.txt'); await writeFile(brief, 'Synthetic task');
    const workdir = path.join(root, 'tree'); await mkdir(workdir);
    const handler = createModelsHandler({ load: async () => ({ snapshot: f.snapshot, drivers: {} }), now: () => f.request.now });
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const args = ['resolve', '--role', 'coding', '--task', 'implementation', '--group', 'workers', '--brief', brief,
      '--workdir', workdir, '--final-output', path.join(root, 'final.json'), '--format', 'shell'];
    expect((await handler.execute({ args, rawArgs: args, cwd: root, frameworkRoot: process.cwd() })).exitCode).toBe(2);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr.mock.calls.flat().join('\n')).toContain(threshold);
    args[args.length - 1] = 'json';
    await handler.execute({ args, rawArgs: args, cwd: root, frameworkRoot: process.cwd() });
    const plan = JSON.parse(String(stdout.mock.calls.at(-1)![0]));
    expect(plan).toMatchObject({ slots: 0, status: 'blocked', resources: { ok: false } });
    expect(plan.invocation).toBeUndefined();
  });
});
