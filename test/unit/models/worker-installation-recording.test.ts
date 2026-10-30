// Exercise signed approval replacement and pruning through the shared recording owner.
import { mkdir, mkdtemp, readFile, writeFile, stat, access, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyNode } from '../../helpers/copy-node.js';
import { workerSigningFixture } from '../../helpers/worker-qualification-signing.js';
import { fixtureJson } from '../../conformance/mission-v1/worker-contract-fixtures.js';
import { qualificationDigest } from '../../../src/models/qualification-digest.mjs';
import { requiredWorkerControls } from '../../../src/models/provider-policy.js';
import { inspectWorkerInstallation, recordWorkerInstallation, workerNegativeFixtureDigest,
  workerNegativeFixtureSuite } from '../../../src/models/worker-installation.mjs';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'aiwg-model-recording-')); roots.push(root);
  const cwd = path.join(root, 'workspace');
  const installed = path.join(root, 'installed');
  const config = path.join(root, 'config');
  await Promise.all([mkdir(cwd), mkdir(installed, { mode: 0o755 }), mkdir(config, { mode: 0o700 })]);
  vi.stubEnv('AIWG_CONFIG', config);
  await workerSigningFixture(root, cwd);
  const executable = await copyNode(installed);
  const cli = path.join(installed, 'cli.mjs');
  await writeFile(cli, "console.log('1.0.0');\n", { mode: 0o644 });
  const source = 'export const interfaceVersion = 1; export function register(factory) {}';
  await writeFile(path.join(installed, 'driver.mjs'), source, { mode: 0o644 });
  await writeFile(path.join(installed, 'package.json'), JSON.stringify({ name: 'fixture-driver', version: '1.0.0', type: 'module' }), { mode: 0o644 });
  const adapter = structuredClone(fixtureJson('shared-vectors.json').find((v: any) => v.id === 'adapter-process-shape').value);
  adapter.provider = 'codex';
  adapter.qualification = { status: 'qualified', fixtureDigest: qualificationDigest('synthetic'),
    verifiedAt: new Date().toISOString(), evidenceRef: 'fixture:only' };
  adapter.invocation.versionArgv = [cli];
  adapter.invocation.envAllowlist = ['SYNTHETIC_SETTING'];
  const profile = adapter.invocationProfiles['fixture-shell'];
  profile.envAllowlist = ['SYNTHETIC_SETTING'];
  for (const control of Object.values(profile.controls) as any[]) {
    control.support = 'external'; control.mapping = 'fixture runner'; control.evidence = 'fixture:only';
  }
  const controls = requiredWorkerControls({});
  const installation: any = { adapter, profile: 'fixture-shell', cliVersion: '1.0.0', requiredControls: controls,
    executable, platform: 'linux', cwd, workerWritableRoots: [cwd], runtimeFiles: [cli],
    modules: [{ reference: adapter.runtimeDriver, packageRoot: installed, packageName: 'fixture-driver', packageVersion: '1.0.0',
      modulePath: 'driver.mjs', interfaceVersion: 1, sha256: qualificationDigestRaw(source), adapterIds: ['fixture'], platforms: ['linux'] }],
    effectiveConfigDigest: qualificationDigest('fixture-config'), accountScope: 'synthetic-account',
    boundary: { kind: 'os', identity: 'synthetic-runner', digest: qualificationDigest('boundary'), controls },
    environment: { SYNTHETIC_SETTING: 'fixture-value' }, endpoints: [], allowedEndpoints: [] };
  const instance = { getName: () => adapter.id };
  installation.evidence = { scopeDigest: (await inspectWorkerInstallation(instance, installation)).scopeDigest,
    fixtureDigest: await workerNegativeFixtureDigest(), verifiedAt: new Date().toISOString(), evidenceRef: 'fixture:synthetic-only',
    cases: Object.fromEntries(Object.keys(workerNegativeFixtureSuite.cases).map(id => [id, 'passed'])) };
  const binding = { profile: installation.profile, cliVersion: installation.cliVersion, accountScope: installation.accountScope };
  return { root, cwd, config, installation, instance, binding };
}

function qualificationDigestRaw(value: string) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }

describe('recorded approval maintenance', () => {
  it('signs and stores canonical approvals, prunes deleted workspaces and replaces an existing exact key', async () => {
    const f = await fixture();
    const alias = path.join(f.root, 'workspace-alias');
    await symlink(f.cwd, alias);
    f.installation.cwd = alias;
    const filename = path.join(f.config, 'worker-installations.json');
    const live = { cli: 'peer', installation: { cwd: f.cwd } };
    const deleted = { cli: 'old', installation: { cwd: path.join(f.root, 'deleted') } };
    await writeFile(filename, JSON.stringify({ version: 1, registrations: [live, deleted] }), { mode: 0o600 });
    const options = { cli: 'fixture', binding: f.binding, installation: f.installation };
    expect(await recordWorkerInstallation(f.instance, options)).toMatchObject({ status: 'ENABLED', cliVersion: '1.0.0' });
    let stored = JSON.parse(await readFile(filename, 'utf8'));
    expect(stored.registrations).toHaveLength(2);
    expect(stored.registrations[0]).toEqual(live);
    expect(stored.registrations[1]).toMatchObject({ cli: 'fixture', signature: { projectDir: f.cwd },
      installation: { cwd: f.cwd, environmentNames: ['SYNTHETIC_SETTING'] } });
    expect(stored.registrations[1].installation).not.toHaveProperty('environment');
    expect(await recordWorkerInstallation(f.instance, options)).toMatchObject({ status: 'ENABLED' });
    stored = JSON.parse(await readFile(filename, 'utf8'));
    expect(stored.registrations.map((record: any) => record.cli)).toEqual(['peer', 'fixture']);
    expect((await stat(filename)).mode & 0o777).toBe(0o600);
    await expect(access(`${filename}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
