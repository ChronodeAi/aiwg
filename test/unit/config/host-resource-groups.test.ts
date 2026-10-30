// Group capacity is independent of unrelated groups and shares the host gate.
import { expect, it } from 'vitest';
import { hostResourceReport } from '../../../src/config/host-resource-report.mjs';
import { healthyHostResources, ownedWorkerReaders } from '../../fixtures/host-resources.js';

const config = { parallelism: { max_parallel_subagents: 10,
  groups: { harness: { maxParallel: 3 }, 'muse-external': { maxParallel: 1 } },
  admission: { cliCaps: { muse: 0 }, memberCaps: { other: 0 }, modelCaps: { other: 0 }, quotaCaps: { other: 0 } },
} } as any;
const report = (extra = {}) => hostResourceReport({ config, live: healthyHostResources(), ...extra });

it('keeps exhausted unrelated groups and tuple caps out of the host verdict', () => {
  const result = report();
  expect(result).toMatchObject({ slots: 4, ok: true, failures: [], groups: [
    { group: 'harness', maxParallel: 3, slots: 2, reason: expect.stringContaining('groups.harness.maxParallel') },
    { group: 'muse-external', maxParallel: 1, slots: 0, reason: expect.stringContaining('groups.muse-external.maxParallel') },
  ] });
  expect(result.limits.map(limit => limit.threshold)).not.toContain('groups.muse-external.maxParallel');
});

it('intersects only the requested group and names its binding threshold', () => {
  expect(report({ group: 'harness' })).toMatchObject({ slots: 2, ok: true, limitingThreshold: 'groups.harness.maxParallel' });
  expect(report({ group: 'muse-external' })).toMatchObject({ slots: 0, ok: false,
    failures: [expect.objectContaining({ signal: 'groups.muse-external.maxParallel' })] });
  expect(report({ group: 'harness', live: { ...healthyHostResources(), availMemGb: 8 } }))
    .toMatchObject({ slots: 1, limitingThreshold: 'min_avail_mem_gb' });
});

it('rejects unknown group names with the configured names', () => {
  expect(() => report({ group: 'missing' })).toThrow(/Unknown group.*missing.*harness.*muse-external/);
  expect(() => hostResourceReport({ group: 'missing' } as any)).toThrow(/configured.*none/i);
});

it('applies groupCaps only to its group and reports disabled groups separately', () => {
  const scoped = structuredClone(config);
  scoped.parallelism.admission.groupCaps = { harness: 2 };
  scoped.parallelism.groups.disabled = { enabled: false, maxParallel: 3 };
  expect(report({ config: scoped })).toMatchObject({ slots: 4, groups: [
    { group: 'harness', slots: 1, reason: expect.stringContaining('admission.groupCaps.harness') },
    { group: 'muse-external', slots: 0 }, { group: 'disabled', slots: 0, reason: expect.stringContaining('disabled') },
  ] });
  expect(report({ config: scoped, group: 'harness' })).toMatchObject({ slots: 1, limitingThreshold: 'admission.groupCaps.harness' });
  expect(report({ config: scoped, group: 'disabled' })).toMatchObject({ slots: 0, ok: false });
});

it.each([
  [undefined, [{ invocation: 'harness-one' }, { invocation: 'harness-one' }, { invocation: 'muse-external-two' }]],
  [['aiwg-worker-harness-one-123.service', 'aiwg-worker-muse-external-two-123.service'], []],
  [['aiwg-worker-harness-one-123.service'], [{ invocation: 'opaque', unit: 'aiwg-worker-harness-one-123.service' },
    { invocation: 'opaque' }, { invocation: 'muse-external-two' }]],
] as const)('attributes existing marker or unit group prefixes exactly (%j)', (units, processes) => {
  const result = hostResourceReport({ config, readers: ownedWorkerReaders(units && [...units], [...processes]) });
  expect(result).toMatchObject({ measured: { workers: 2 }, groups: [
    { group: 'harness', slots: 2 }, { group: 'muse-external', slots: 0 },
  ] });
  expect(result.counting).toContain('unattributed workers count against every group');
});

it('counts unknown workers against every group while retaining exact attribution', () => {
  const result = hostResourceReport({ config, readers: ownedWorkerReaders(undefined, [
    { invocation: 'harness-one' }, { invocation: 'unattributed' }, { invocation: 'harnessish-wrong' },
  ]) });
  expect(result).toMatchObject({ groups: [{ group: 'harness', slots: 0 }, { group: 'muse-external', slots: 0 }] });
});

it('leaves conflicting or overlapping group identities unattributed', () => {
  const scoped = structuredClone(config);
  scoped.parallelism.groups.muse = { maxParallel: 3 };
  const unit = 'aiwg-worker-harness-one-123.service';
  const result = hostResourceReport({ config: scoped, readers: ownedWorkerReaders([unit], [
    { invocation: 'muse-external-two', unit }, { invocation: 'muse-external-ambiguous' },
  ]) });
  expect(result).toMatchObject({ measured: { workers: 2 }, groups: [
    { group: 'harness', slots: 1 }, { group: 'muse-external', slots: 0 }, { group: 'muse', slots: 1 },
  ] });
});

it('fails group capacity closed when worker counts are unavailable', () => {
  expect(report({ live: { ...healthyHostResources(), workers: undefined }, group: 'harness' }))
    .toMatchObject({ slots: 0, groups: [{ slots: 0 }, { slots: 0 }] });
});

it('retains group attribution from unit names when proc enumeration fails', () => {
  const readers = { ...ownedWorkerReaders(['aiwg-worker-harness-one-123.service'], []),
    readDir: () => { throw new Error('proc unavailable'); } };
  expect(hostResourceReport({ config, readers })).toMatchObject({ measured: { workers: 1 },
    groups: [{ group: 'harness', slots: 2 }, { group: 'muse-external', slots: 1 }] });
});

it('preserves inherited group ceilings and rejects invalid template expansion', () => {
  const scoped = structuredClone(config);
  scoped.parallelism.groupTemplates = { base: { maxParallel: 2 } };
  scoped.parallelism.groups.harness = { template: 'base' };
  expect(report({ config: scoped, group: 'harness' })).toMatchObject({ slots: 1,
    groups: [{ group: 'harness', maxParallel: 2, slots: 1 }, { group: 'muse-external', maxParallel: 1, slots: 0 }] });
  scoped.parallelism.groups.harness.template = 'missing';
  expect(() => report({ config: scoped })).toThrow(/Unknown template/);
});

it('retains provider-default project caps when no project cap is specified', () => {
  const live = { ...healthyHostResources(), availMemGb: 128, freeDiskGb: 128, cores: 32, load1: 1, loadRatio: 1 / 32 };
  expect(hostResourceReport({ live, config: { providers: ['muse'], parallelism: { worker_dispatch: true } } as any })).toMatchObject({ slots: 3,
    limitingThreshold: 'max_parallel_subagents' });
});

it('reports an unbounded group separately and still applies the host gate', () => {
  const scoped = { parallelism: { groups: { open: {} } } } as any;
  expect(report({ config: scoped, group: 'open' })).toMatchObject({ slots: 4, groups: [
    { group: 'open', maxParallel: null, slots: null, reason: 'no group ceiling configured' },
  ] });
});
