// Exhaustive seeded direct-readiness outcomes and their operator-facing repair context.
import type { diagnoseDirectWorkerReadiness } from '../../../src/models/worker-direct-readiness.js';
import { unqualifiedWorkerRolesFixture, workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { codexCli, parallelismWith, registry } from './worker-direct-readiness.fixtures.js';

type Input = Parameters<typeof diagnoseDirectWorkerReadiness>[0];
interface Hazard {
  name: string;
  kind: 'install' | 'dispatch';
  code: string;
  configKey: string;
  members: string[];
  nextAction: string;
  input: () => Input;
}
const groups = (cli = 'codex') => ({ g1: { members: [{ id: 'm1', cli, model: 'codex-mini', roles: ['coding'] }] } });
const base = (extra: Record<string, unknown> = {}): Input => ({
  parallelism: parallelismWith({ codex: codexCli('synthetic-codex', extra) }, groups()), registry: registry(),
});
const install = (name: string, code: string, nextAction: string, input: () => Input,
  suffix = '', members = ['g1/m1']): Hazard => ({
  name, code, nextAction, input, kind: 'install', configKey: `/parallelism/clis/codex${suffix}`, members,
});
const fromResolver = (unqualified = false): Input => {
  const f = unqualified ? unqualifiedWorkerRolesFixture() : workerResolutionFixture();
  return { parallelism: f.snapshot.config.parallelism!, registry: f.snapshot.registry,
    resolverSnapshot: { config: f.snapshot.config, models: f.snapshot.models, modelDigests: f.snapshot.modelDigests,
      catalog: f.snapshot.catalog, now: f.request.now! } };
};

export const directReadinessHazards: Hazard[] = [
  { name: 'group dispatch disabled', kind: 'dispatch', code: 'WORKER_DIRECT_DISABLED',
    configKey: '/parallelism/worker_dispatch', members: ['g1/m1'], nextAction: 'enable-worker-dispatch-to-onboard',
    input: () => { const input = base(); input.parallelism.worker_dispatch = false; return input; } },
  install('CLI disabled', 'WORKER_DIRECT_CLI_DISABLED', 'enable-cli-to-onboard',
    () => base({ enabled: false }), '/enabled', ['g1/m1 (disabled)']),
  { name: 'disabled CLI dispatch', kind: 'dispatch', code: 'WORKER_DIRECT_DISPATCH_BLOCKED',
    configKey: '/parallelism/clis/codex/enabled', members: ['g1/m1 (disabled)'], nextAction: 'enable-cli-to-onboard',
    input: () => base({ enabled: false }) },
  install('unknown adapter binding', 'WORKER_DIRECT_NO_PROFILE', 'review-worker-configuration',
    () => base({ adapter: 'providers:nope' }), '/adapter'),
  { name: 'noncanonical provider alias', kind: 'install', code: 'WORKER_DIRECT_NO_PROFILE',
    configKey: '/parallelism/clis/legacy/adapter', members: ['g1/m1'], nextAction: 'review-worker-configuration',
    input: () => ({ parallelism: parallelismWith({ legacy: { ...codexCli('unused'), adapter: 'providers:openai' } },
      groups('legacy')), registry: registry() }) },
  install('unknown invocation profile', 'WORKER_DIRECT_PROFILE_UNKNOWN', 'review-worker-configuration',
    () => base({ invocationProfile: 'missing-profile' }), '/invocationProfile'),
  install('ambiguous invocation profile', 'WORKER_DIRECT_PROFILE_UNKNOWN', 'review-worker-configuration', () => {
    const input = base();
    const adapter = input.registry.providers.codex.workerHealthAdapter!;
    const profile = Object.values(adapter.invocationProfiles!)[0];
    adapter.invocationProfiles = { first: profile, second: structuredClone(profile) };
    return input;
  }, '/invocationProfile'),
  install('default config-only install', 'WORKER_DIRECT_UNPROBED', 'rerun-with-probe-workers', () => base()),
  install('missing CLI', 'WORKER_DIRECT_NOT_INSTALLED', 'install-cli',
    () => ({ ...base(), probe: async () => ({ ok: false, reason: 'not-installed' }) }), '/executable'),
  install('required missing CLI', 'WORKER_DIRECT_NOT_INSTALLED', 'install-cli', () => {
    const input = base(); input.parallelism.groups!.g1.requiredRoles = ['coding'];
    return { ...input, probe: async () => ({ ok: false, reason: 'not-installed' }) };
  }, '/executable'),
  install('failed version probe', 'WORKER_DIRECT_PROBE_FAILED', 'retry-version-probe',
    () => ({ ...base(), probe: async () => ({ ok: false, reason: 'probe-failed' }) })),
  install('thrown version probe', 'WORKER_DIRECT_PROBE_FAILED', 'retry-version-probe',
    () => ({ ...base(), probe: async () => { throw new Error('synthetic probe failure'); } })),
  install('unexpected banner', 'WORKER_DIRECT_BANNER_UNMATCHED', 'reinstall-supported-cli',
    () => ({ ...base(), probe: async () => ({ ok: true, rawBanner: 'hello world' }) })),
  ...['0.160.9', '0.200.0', '0.201.0', '0.163.0-rc.1', '0.999.0'].map(version =>
    install(`unsupported codex ${version}`, 'WORKER_DIRECT_VERSION_OUT_OF_RANGE', 'upgrade-or-pin-cli',
      () => ({ ...base(), probe: async () => ({ ok: true, rawBanner: `codex-cli ${version}` }) }))),
  ...['1.4.3', '2.0.0', '2.1.0'].map(version => ({
    name: `unsupported muse ${version}`, kind: 'install' as const, code: 'WORKER_DIRECT_VERSION_OUT_OF_RANGE',
    configKey: '/parallelism/clis/muse', members: ['g1/m1'], nextAction: 'upgrade-or-pin-cli',
    input: (): Input => ({ parallelism: parallelismWith({ muse: { ...codexCli('synthetic-muse'), adapter: 'providers:muse' } },
      groups('muse')), registry: registry(), probe: async () => ({ ok: true, rawBanner: `Muse Code ${version} (${version}-R5018.1)` }) }),
  })),
  { name: 'unqualified binding despite ready installation', kind: 'dispatch', code: 'WORKER_DIRECT_DISPATCH_BLOCKED',
    configKey: '/parallelism/clis/codex', members: ['g1/m1'], nextAction: 'qualify-installed-cli',
    input: () => ({ ...base(), probe: async () => ({ ok: true, rawBanner: 'codex-cli 0.161.0' }) }) },
  { name: 'offline resolver missing installation evidence', kind: 'dispatch', code: 'WORKER_DIRECT_DISPATCH_BLOCKED',
    configKey: '/parallelism/clis/codex', members: ['workers/alternate', 'workers/primary'],
    nextAction: 'review-worker-configuration', input: () => fromResolver() },
  { name: 'offline resolver unqualified members for all required roles', kind: 'dispatch', code: 'WORKER_DIRECT_DISPATCH_BLOCKED',
    configKey: '/parallelism/clis/codex', members: ['workers/coding', 'workers/efficiency', 'workers/reasoning'],
    nextAction: 'review-worker-configuration', input: () => fromResolver(true) },
];
