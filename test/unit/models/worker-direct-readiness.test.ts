import { chmod, lstat, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDirectWorkerDoctorSection,
  diagnoseDirectWorkerReadiness,
  probeDirectWorkerVersion,
} from '../../../src/models/worker-direct-readiness.js';
import { loadProviderModelCapabilities } from '../../../src/models/provider-policy.js';
import type { ParallelismConfig } from '../../../src/config/aiwg-config.js';

// T-OG-12 / #2894 S1: synthetic offline inputs plus fake local CLIs created
// under os.tmpdir() with a temp HOME. No paid calls, no credentials, no real
// provider installs. Probes run only when a prober is passed (opt-in); the
// default config-only path must start no process. Temp dirs are removed in
// afterEach.
const roots: string[] = [];

beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), 'aiwg-direct-home-'));
  roots.push(home);
  vi.stubEnv('HOME', home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

async function scratchDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

// Fake CLI: records argv/cwd/environment into the probe cwd, then prints banner.
async function fakeCli(banner: string): Promise<string> {
  const dir = await scratchDir('aiwg-direct-cli-');
  const filename = join(dir, 'fake-codex');
  await writeFile(filename,
    '#!/usr/bin/env node\n'
    + 'const fs = require(\'node:fs\');\n'
    + 'const path = require(\'node:path\');\n'
    + 'const record = { argv: process.argv.slice(2), cwd: process.cwd(), env: { ...process.env } };\n'
    + 'fs.writeFileSync(path.join(process.cwd(), `probe-record-${process.pid}.json`), JSON.stringify(record));\n'
    + `process.stdout.write(${JSON.stringify(`${banner}\n`)});\n`,
    { mode: 0o755 });
  await chmod(filename, 0o755);
  return filename;
}

function parallelismWith(clis: NonNullable<ParallelismConfig['clis']>, groups?: ParallelismConfig['groups']): ParallelismConfig {
  return { worker_dispatch: true, clis, ...(groups ? { groups } : {}) };
}

const codexCli = (executable: string, extra?: Record<string, unknown>) => ({
  adapter: 'providers:codex', accountScope: 'local-account', quotaScope: 'synthetic-scope', executable, ...extra,
});

const registry = () => structuredClone(loadProviderModelCapabilities());

describe('T-OG-12 direct worker onboarding/readiness (#2894)', () => {
  it('T-OG-12-direct-01 reports installed and in range without claiming qualification', async () => {
    const probeCwd = await scratchDir('aiwg-direct-cwd-');
    const report = await diagnoseDirectWorkerReadiness({
      parallelism: parallelismWith({ codex: codexCli(await fakeCli('codex-cli 0.161.0')) }),
      registry: registry(), probe: probeDirectWorkerVersion, probeCwd,
    });
    expect(report).toMatchObject({ enabled: true, workersConfigured: true, ready: true });
    const install = report.findings.filter(finding => finding.kind === 'install');
    expect(install).toContainEqual(expect.objectContaining({ cli: 'codex',
      code: 'WORKER_DIRECT_READY', status: 'ok', installedVersion: '0.161.0',
      readiness: 'ready', eligibility: null, nextAction: 'run-authenticated-smoke-run' }));
    for (const finding of report.findings) {
      expect(finding.message).toMatch(/unqualified/i);
      expect(finding.message).toContain('#3005');
      expect(finding.message).not.toMatch(/is qualified|now qualified|fully qualified/i);
      expect(finding.configFile).toBe('.aiwg/aiwg.config');
      expect(finding.configKey).toContain('/parallelism/clis/codex');
    }
  });

  it('T-OG-12-direct-02 reports installed but out of range with a pin action', async () => {
    const report = await diagnoseDirectWorkerReadiness({
      parallelism: parallelismWith({ codex: codexCli(await fakeCli('codex-cli 0.999.0')) }),
      registry: registry(), probe: probeDirectWorkerVersion, probeCwd: await scratchDir('aiwg-direct-cwd-'),
    });
    expect(report.ready).toBe(false);
    expect(report.findings).toContainEqual(expect.objectContaining({ cli: 'codex', kind: 'install',
      code: 'WORKER_DIRECT_VERSION_OUT_OF_RANGE', status: 'warn',
      installedVersion: '0.999.0', readiness: 'not-ready', nextAction: 'upgrade-or-pin-cli' }));
  });

  it('T-OG-12-direct-03 reports a banner that misses the version pattern', async () => {
    const report = await diagnoseDirectWorkerReadiness({
      parallelism: parallelismWith({ codex: codexCli(await fakeCli('hello world')) }),
      registry: registry(), probe: probeDirectWorkerVersion, probeCwd: await scratchDir('aiwg-direct-cwd-'),
    });
    expect(report.ready).toBe(false);
    expect(report.findings).toContainEqual(expect.objectContaining({ cli: 'codex', kind: 'install',
      code: 'WORKER_DIRECT_BANNER_UNMATCHED', status: 'error',
      installedVersion: null, readiness: 'not-ready', nextAction: 'reinstall-supported-cli' }));
  });

  it('T-OG-12-direct-04 reports a missing CLI as not installed', async () => {
    const dir = await scratchDir('aiwg-direct-missing-');
    const report = await diagnoseDirectWorkerReadiness({
      parallelism: parallelismWith({ codex: codexCli(join(dir, 'missing-cli')) }),
      registry: registry(), probe: probeDirectWorkerVersion, probeCwd: await scratchDir('aiwg-direct-cwd-'),
    });
    expect(report.ready).toBe(false);
    expect(report.findings).toContainEqual(expect.objectContaining({ cli: 'codex', kind: 'install',
      code: 'WORKER_DIRECT_NOT_INSTALLED', status: 'error', readiness: 'not-ready', nextAction: 'install-cli' }));
  });

  it('T-OG-12-direct-05 skips the probe when cli dispatch is disabled', async () => {
    const probe = vi.fn(() => { throw new Error('probe must not run for a disabled cli'); });
    const parallelism: ParallelismConfig = parallelismWith({
      codex: { ...codexCli('unused'), enabled: false } });
    const report = await diagnoseDirectWorkerReadiness({ parallelism, registry: registry(), probe });
    expect(probe).not.toHaveBeenCalled();
    expect(report).toMatchObject({ enabled: true, ready: true });
    expect(report.findings).toContainEqual(expect.objectContaining({ cli: 'codex', kind: 'install',
      code: 'WORKER_DIRECT_CLI_DISABLED', status: 'info', readiness: 'skipped', nextAction: 'enable-cli-to-onboard' }));
    const dispatch = report.findings.filter(finding => finding.kind === 'dispatch');
    expect(dispatch).toHaveLength(1);
    expect(dispatch[0].eligibility).toBe('blocked');
    expect(dispatch[0].status).toBe('info');
    for (const finding of report.findings) expect(finding.status).not.toBe('error');
  });

  it('T-OG-12-direct-06 skips all probes when group dispatch is disabled', async () => {
    const probe = vi.fn(() => { throw new Error('probe must not run when dispatch is disabled'); });
    const parallelism: ParallelismConfig = { worker_dispatch: false,
      clis: { codex: codexCli('unused') } };
    const report = await diagnoseDirectWorkerReadiness({ parallelism, registry: registry(), probe });
    expect(probe).not.toHaveBeenCalled();
    expect(report).toMatchObject({ enabled: false, ready: true });
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: 'WORKER_DIRECT_DISABLED', status: 'info', kind: 'dispatch', eligibility: 'blocked' }));
  });

  it('T-OG-12-direct-07 honours the configured adapter binding, not the cli key', async () => {
    const probeCwd = await scratchDir('aiwg-direct-cwd-');
    const claudeExe = await fakeCli('2.1.295 (Claude Code)');
    // Key says codex but the binding says claude: the claude banner must match.
    const report = await diagnoseDirectWorkerReadiness({
      parallelism: parallelismWith({ codex: { ...codexCli(claudeExe), adapter: 'providers:claude' } }),
      registry: registry(), probe: probeDirectWorkerVersion, probeCwd,
    });
    expect(report.findings).toContainEqual(expect.objectContaining({ cli: 'codex', kind: 'install',
      code: 'WORKER_DIRECT_READY', status: 'ok', installedVersion: '2.1.295', readiness: 'ready' }));
  });

  it('T-OG-12-direct-08 resolves adapter aliases and non-canonical cli keys', async () => {
    const probeCwd = await scratchDir('aiwg-direct-cwd-');
    const report = await diagnoseDirectWorkerReadiness({
      parallelism: parallelismWith({
        'codex-work': { ...codexCli(await fakeCli('codex-cli 0.161.0')), adapter: 'providers:codex' },
        // 'openai' is a registered alias of the codex provider definition.
        'legacy': { ...codexCli(await fakeCli('codex-cli 0.161.0')), adapter: 'providers:openai' },
      }),
      registry: registry(), probe: probeDirectWorkerVersion, probeCwd,
    });
    for (const cli of ['codex-work', 'legacy']) {
      expect(report.findings).toContainEqual(expect.objectContaining({ cli, kind: 'install',
        code: 'WORKER_DIRECT_READY', status: 'ok', readiness: 'ready' }));
    }
    expect(report.findings).not.toContainEqual(expect.objectContaining({ code: 'WORKER_DIRECT_NO_PROFILE' }));
  });

  it('T-OG-12-direct-09 states resolver refusal plainly despite install readiness', async () => {
    const report = await diagnoseDirectWorkerReadiness({
      parallelism: parallelismWith({ codex: codexCli(await fakeCli('codex-cli 0.161.0')) }),
      registry: registry(), probe: probeDirectWorkerVersion, probeCwd: await scratchDir('aiwg-direct-cwd-'),
    });
    const install = report.findings.find(finding => finding.kind === 'install');
    const dispatch = report.findings.find(finding => finding.kind === 'dispatch');
    expect(install?.readiness).toBe('ready');
    // The shipped registry pins no workerAdapter binding, so the resolver
    // refuses even though the CLI is installed and in range.
    expect(dispatch?.eligibility).toBe('blocked');
    expect(dispatch?.status).toBe('warn');
    expect(dispatch?.eligibilityDetail).toMatch(/OG_ADAPTER_UNQUALIFIED/);
    expect(dispatch?.eligibilityDetail).toContain('#3005');
    expect(dispatch?.message).toMatch(/installed.*in-?range|in-?range.*installed/i);
    expect(dispatch?.message).not.toMatch(/is qualified|now qualified|fully qualified/i);
  });

  it('T-OG-12-direct-10 reports resolver eligibility when a workerAdapter binding exists', async () => {
    const configured = registry();
    const health = configured.providers.codex.workerHealthAdapter;
    configured.providers.codex.workerAdapter = { ...health, id: 'codex' };
    const report = await diagnoseDirectWorkerReadiness({
      parallelism: parallelismWith({ codex: codexCli(await fakeCli('codex-cli 0.161.0')) }),
      registry: configured, probe: probeDirectWorkerVersion, probeCwd: await scratchDir('aiwg-direct-cwd-'),
    });
    const dispatch = report.findings.find(finding => finding.kind === 'dispatch');
    expect(dispatch?.eligibility).toBe('eligible');
    expect(dispatch?.code).toBe('WORKER_DIRECT_DISPATCH_ELIGIBLE');
    expect(dispatch?.eligibilityDetail).toContain('#3005');
  });

  it('T-OG-12-direct-11 default path starts no process and stays config-only', async () => {
    const probe = vi.fn(() => { throw new Error('probe must not run without opt-in'); });
    const report = await diagnoseDirectWorkerReadiness({
      parallelism: parallelismWith({ codex: codexCli('/definitely/not/here') }),
      registry: registry(), probe: undefined, configFile: 'proj/.aiwg/aiwg.config',
    });
    expect(probe).not.toHaveBeenCalled();
    expect(report.findings).toContainEqual(expect.objectContaining({ cli: 'codex', kind: 'install',
      code: 'WORKER_DIRECT_UNPROBED', status: 'info', readiness: 'unprobed',
      configFile: 'proj/.aiwg/aiwg.config', configKey: '/parallelism/clis/codex',
      nextAction: 'rerun-with-probe-workers' }));
    for (const finding of report.findings) {
      expect(['ok', 'info', 'warn']).toContain(finding.status);
    }
  });

  it('T-OG-12-direct-12 carries member context through both facts', async () => {
    const report = await diagnoseDirectWorkerReadiness({
      parallelism: parallelismWith(
        { codex: codexCli(await fakeCli('codex-cli 0.161.0')) },
        { g1: { members: [{ id: 'm1', cli: 'codex', model: 'codex-mini', roles: ['coding'] }] } }),
      registry: registry(), configFile: 'proj/.aiwg/aiwg.config',
    });
    expect(report.findings).toHaveLength(2);
    for (const finding of report.findings) {
      expect(finding.members).toEqual(['g1/m1']);
      expect(finding.message).toContain('g1/m1');
      expect(finding.message).toContain('proj/.aiwg/aiwg.config');
    }
  });

  it('T-OG-12-direct-13 keeps unprobed binding failures advisory', async () => {
    const report = await diagnoseDirectWorkerReadiness({
      parallelism: parallelismWith({ bogus: { adapter: 'providers:nope', accountScope: 'a', quotaScope: 'q' } }),
      registry: registry(),
    });
    expect(report.findings).toContainEqual(expect.objectContaining({ cli: 'bogus', kind: 'install',
      code: 'WORKER_DIRECT_NO_PROFILE', status: 'warn', readiness: 'not-ready' }));
    for (const finding of report.findings) expect(finding.status).not.toBe('error');
  });
});

describe('direct worker doctor section (#2894)', () => {
  it('stays silent when no workers are configured', async () => {
    for (const parallelism of [undefined, {}, { worker_dispatch: true }, { worker_dispatch: true, clis: {} }]) {
      const section = await buildDirectWorkerDoctorSection({
        parallelism: parallelism as ParallelismConfig, registry: registry(), probeWorkers: true,
        probe: () => { throw new Error('no probe without workers'); },
      });
      expect(section).toMatchObject({ lines: [], probed: false, workersConfigured: false });
    }
  });

  it('starts no process by default and keeps lines exit-code neutral', async () => {
    const probe = vi.fn(() => { throw new Error('default doctor must not probe'); });
    const section = await buildDirectWorkerDoctorSection({
      parallelism: parallelismWith({ codex: codexCli('/definitely/not/here') }),
      registry: registry(), probeWorkers: false, probe,
    });
    expect(probe).not.toHaveBeenCalled();
    expect(section.probed).toBe(false);
    expect(section.workersConfigured).toBe(true);
    expect(section.lines.length).toBeGreaterThan(0);
    expect(section.lines[0].message).toMatch(/--probe-workers/);
    for (const line of section.lines) expect(line.status).not.toBe('error');
  });

  it('announces the execution boundary when probes are opted in', async () => {
    const probeCwd = await scratchDir('aiwg-direct-cwd-');
    const section = await buildDirectWorkerDoctorSection({
      parallelism: parallelismWith({ codex: codexCli(await fakeCli('codex-cli 0.161.0')) }),
      registry: registry(), probeWorkers: true,
      probe: (executable, argv, options) => probeDirectWorkerVersion(executable, argv, { ...options, cwd: probeCwd }),
    });
    expect(section.probed).toBe(true);
    expect(section.lines[0].message).toMatch(/opt-in.*--probe-workers/);
    expect(section.lines).toContainEqual(expect.objectContaining({
      name: 'Direct Worker (codex)', status: 'ok' }));
    expect(section.lines).toContainEqual(expect.objectContaining({
      name: 'Direct Worker Dispatch (codex)' }));
    expect(section.lines.map(line => line.message).join('\n')).toContain('#3005');
  });

  it('keeps optional profiles exit-code neutral in the doctor section', async () => {
    const section = await buildDirectWorkerDoctorSection({
      parallelism: parallelismWith({ codex: { ...codexCli('unused'), enabled: false } }),
      registry: registry(), probeWorkers: false,
      probe: () => { throw new Error('optional profile must not probe'); },
    });
    expect(section.lines.length).toBeGreaterThan(0);
    for (const line of section.lines) expect(line.status).not.toBe('error');
  });
});
