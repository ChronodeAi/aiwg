/**
 * #2905 (B-OG-40/Oz) Warp CLI promotion: offline S1 profile work.
 *
 * Loads the production WarpAdapter through the real #2885 installed-module
 * loader (digest-pinned, mirroring #2897 codex-adapter.mjs / #2908
 * antigravity-adapter.mjs), then renders argv through the adapter's own
 * production `buildWorkerArgs` and executes the rendered command against a
 * synthetic `warp-terminal` that records argv/cwd/env names and enforces
 * the exact profile-emitted values. Spawns are plain child processes (no
 * systemd); nothing reaches a network, model, credential or MC state.
 * Fixture qualification here is synthetic and never live qualification:
 * the bundled Warp profile stays unqualified. Per the task's time-box this
 * intentionally does not re-exercise the full `resolveWorkerInvocation`
 * plan-rendering pipeline the way the larger existing provider suites do;
 * that full-plan coverage is a documented follow-up (see report).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadProviderModelCapabilities, qualifyWorkerInvocationProfile, resolveWorkerAdapter } from '../../../src/models/provider-policy.js';
import {
  WARP_DIRECT_SANDBOX_MODES, WARP_SUPPORTED_VERSIONS, buildWarpBriefSkillFile, buildWarpBriefSkillName,
} from '../../../tools/ralph-external/lib/warp-adapter.mjs';
import { createProvider, loadInstalledWorkerAdapters } from '../../../src/models/worker-installation.mjs';

const FAKE = path.resolve('test/fixtures/providers/warp/fake-warp-terminal.mjs');
const OBSERVATION = { transport: 'shell', status: 'completed', termination: 'confirmed', exitCode: 0 };
const VERSION = '0.2026.10.07.08.29.stable_00';
const MODEL = 'synthetic/warp-model';
const INVOCATION_ID = '2905-01234567-89ab-cdef-0123-456789abcdef';
const SKILL_NAME = `aiwg-brief-${INVOCATION_ID}`;
const MODULE = 'tools/ralph-external/lib/warp-adapter.mjs';
const APPROVED = JSON.parse(readFileSync('test/fixtures/providers/warp/approved-module.json', 'utf8'));
const roots: string[] = [];
const installRoots: string[] = [];
const sha256 = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Host-side install of the one approved Warp module into a fresh,
 * read-only package root. The provider base and its imports are copied,
 * while worker-installation itself is
 * bridged back to the source file under test so registration lands in the
 * production loader registry that createProvider reads. */
async function installWarpPackage(bytes: Buffer) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'aiwg-warp-install-')); installRoots.push(base);
  await writeFile(path.join(base, 'package.json'), JSON.stringify({ name: 'aiwg', version: '0.0.0-test-root', type: 'module' }));
  const packageRoot = path.join(base, 'pkg');
  const writable = path.join(base, 'worker-writable');
  await mkdir(path.join(packageRoot, 'lib'), { recursive: true, mode: 0o755 }); await mkdir(writable, { mode: 0o755 });
  await mkdir(path.join(base, 'src', 'models'), { recursive: true, mode: 0o755 });
  await chmod(base, 0o755); await chmod(packageRoot, 0o755); await chmod(path.join(packageRoot, 'lib'), 0o755);
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: APPROVED.entry.packageName,
    version: APPROVED.entry.packageVersion, type: 'module' }), { mode: 0o644 });
  await writeFile(path.join(packageRoot, 'lib', 'warp-adapter.mjs'), bytes, { mode: 0o644 });
  for (const name of ['provider-adapter.mjs', 'worker-health.mjs']) {
    const dest = path.join(packageRoot, 'lib', name);
    await copyFile(path.resolve('tools/ralph-external/lib', name), dest);
    await chmod(dest, 0o644);
  }
  const resolveImpl = path.join(base, '_resolve-impl.mjs');
  await copyFile(path.resolve('tools/_resolve-impl.mjs'), resolveImpl);
  await chmod(resolveImpl, 0o644);
  const target = path.resolve('src/models/worker-installation.mjs');
  const relative = path.relative(path.join(base, 'src', 'models'), target);
  await writeFile(path.join(base, 'src', 'models', 'worker-installation.mjs'),
    `export * from ${JSON.stringify(relative)};\n`);
  await mkdir(path.join(base, 'src', 'mission-protocol'), { recursive: true });
  const protocol = path.relative(path.join(base, 'src', 'mission-protocol'), path.resolve('src/mission-protocol/index.ts'));
  await writeFile(path.join(base, 'src', 'mission-protocol', 'index.js'), `export * from ${JSON.stringify(protocol)};\n`);
  return { packageRoot, writable };
}

function loadingRegistry() {
  const registry = structuredClone(loadProviderModelCapabilities());
  registry.providers.warp.workerAdapter = structuredClone(registry.providers.warp.workerHealthAdapter);
  return registry;
}

let installed: { owner: any; ids: string[] };
beforeAll(async () => {
  const saved = process.env.AIWG_RESOLVE_IMPL_FROM;
  process.env.AIWG_RESOLVE_IMPL_FROM = 'src';
  try {
    const { packageRoot, writable } = await installWarpPackage(readFileSync(MODULE));
    const ids = await loadInstalledWorkerAdapters({ registry: loadingRegistry(),
      modules: [{ ...APPROVED.entry, packageRoot }], workerWritableRoots: [writable], platform: 'linux' });
    installed = { owner: createProvider('warp'), ids };
  } finally {
    if (saved === undefined) delete process.env.AIWG_RESOLVE_IMPL_FROM;
    else process.env.AIWG_RESOLVE_IMPL_FROM = saved;
  }
});
afterAll(async () => { for (const root of installRoots.splice(0)) await rm(root, { recursive: true, force: true }); });

const children = new Set<ReturnType<typeof spawn>>();
afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  children.clear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface Run { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

function run(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<Run> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 10_000);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

async function scratch() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-warp-')); roots.push(root);
  const workdir = path.join(root, 'work'); await mkdir(workdir);
  return { root, workdir };
}

async function fakeConfig(root: string, scenario: string, extra: Record<string, unknown> = {}) {
  const file = path.join(root, `fake-${scenario}.json`);
  const recordPath = path.join(root, `record-${scenario}.json`);
  await writeFile(file, JSON.stringify({ scenario, recordPath, knownModels: [MODEL], ...extra }));
  return { file, recordPath };
}

function argvFor(workdir: string) {
  const owner = installed.owner;
  const input = { invocationId: INVOCATION_ID, brief: 'synthetic brief', cwd: workdir, selected: { model: MODEL } };
  return owner.buildWorkerArgs(input, null, {});
}

describe('Warp (Oz / warp-terminal) version-bound profile (#2905)', () => {
  it('WP01 pins the evidenced release, driver, catalog and argv template; unknown controls stay unqualified', () => {
    const adapter = loadProviderModelCapabilities().providers.warp.workerHealthAdapter!;
    expect(WARP_SUPPORTED_VERSIONS).toEqual([VERSION]);
    expect(adapter).toMatchObject({ supportedVersions: VERSION, adapterVersion: APPROVED.entry.packageVersion,
      runtimeDriver: APPROVED.entry.reference,
      catalogAdapter: { kind: 'file', locator: 'agentic/code/providers/model-catalog.v1.json' },
      invocation: { executable: 'warp-terminal', stdin: 'closed' },
      qualification: { status: 'unqualified' } });
    expect(adapter.invocation.argv).toEqual(['agent', 'run', '--output-format', 'json', '--model', '${model}',
      '--cwd', '${workspace}', '--skill', 'aiwg-brief-${invocationId}', '--no-snapshot']);
    expect(adapter.capabilities.sandboxModes).toEqual([...WARP_DIRECT_SANDBOX_MODES]);
    const profile = adapter.invocationProfiles!['direct-shell'];
    expect(profile.supportedVersions).toBe(VERSION);
    for (const [name, control] of Object.entries<any>(profile.controls)) {
      expect(control.support, name).toBe('unqualified');
      expect(control.evidence, name).toMatch(/^(H|D|R): /);
    }
  });

  it('WP01a pins the one approved module digest and loads it through the production installed loader', () => {
    expect(APPROVED.source).toBe(MODULE);
    expect(sha256(readFileSync(MODULE))).toBe(APPROVED.entry.sha256);
    expect(APPROVED.entry).toMatchObject({ reference: 'installed:warp', interfaceVersion: 1,
      adapterIds: ['warp'], platforms: ['linux'] });
    expect(installed.ids).toEqual(['warp']);
    expect(installed.owner.getName()).toBe('warp');
    expect(installed.owner.getBinary()).toBe('warp-terminal');
    expect(installed.owner.constructor.name).toBe('WarpAdapter');
  });

  it('WP01b a tampered copy is refused and the bundled registry stays undispatchable', async () => {
    const tampered = Buffer.concat([readFileSync(MODULE), Buffer.from('\n// tampered\n')]);
    const bad = await installWarpPackage(tampered);
    await expect(loadInstalledWorkerAdapters({ registry: loadingRegistry(), modules: [{ ...APPROVED.entry, packageRoot: bad.packageRoot }],
      workerWritableRoots: [bad.writable], platform: 'linux' })).rejects.toThrow('Installed module digest mismatch');
    const registry = structuredClone(loadProviderModelCapabilities());
    expect(() => resolveWorkerAdapter(registry, 'providers:warp')).toThrow();
    registry.providers.warp.workerAdapter = structuredClone(registry.providers.warp.workerHealthAdapter);
    const adapter = resolveWorkerAdapter(registry, 'providers:warp');
    expect(() => qualifyWorkerInvocationProfile(adapter, { profile: 'direct-shell', transport: 'shell', cliVersion: VERSION }))
      .toThrow('Worker transport/profile is unqualified');
  });
});

describe('T-OG-15 Warp direct command contract (render via production buildWorkerArgs)', () => {
  it('WP02 renders the explicit template; refuses guessed/unsafe/cloud/bypass controls', () => {
    const owner = installed.owner;
    const input = { invocationId: INVOCATION_ID, brief: 'synthetic brief', cwd: '/w', selected: { model: MODEL } };
    expect(owner.buildWorkerArgs(input, null, {})).toEqual(['agent', 'run', '--output-format', 'json',
      '--model', MODEL, '--cwd', '/w', '--skill', SKILL_NAME, '--no-snapshot']);
    // Brief text never rides argv: the rendered template never contains the
    // brief string itself, --prompt, or any cloud/harness/bypass flag.
    const rendered = owner.buildWorkerArgs(input, null, {});
    expect(rendered).not.toContain('--prompt');
    expect(rendered).not.toContain('synthetic brief');
    expect(rendered).not.toContain('--environment');
    expect(rendered).not.toContain('--harness');
    expect(rendered).not.toContain('--dangerously-skip-permissions');
    // Option-like value refusal: a model that looks like a flag can never
    // ride through as an argv value.
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: '--dangerously-skip-permissions' } }, null, {}))
      .toThrow(/option/);
    for (const value of ['auto', 'AUTO', 'default', 'DEFAULT']) {
      expect(() => owner.buildWorkerArgs({ ...input, selected: { model: value } }, null, {})).toThrow(/explicit model/);
    }
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: '' } }, null, {})).toThrow(/explicit model/);
    expect(() => owner.buildWorkerArgs({ ...input, cwd: 'relative' }, null, {})).toThrow(/absolute/);
    expect(() => owner.buildWorkerArgs({ ...input, brief: '' }, null, {})).toThrow(/non-empty brief/);
    // No evidenced effort control: supplying one is refused, never silently dropped.
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: MODEL, effort: { value: 'high' } } }, null, {}))
      .toThrow(/no evidenced reasoning-effort control/);
    expect(owner.getAbortInput()).toBeNull();
    expect(() => owner.buildSessionArgs({})).toThrow(/no qualified Ralph loop session/);
    expect(() => owner.buildAnalysisArgs({})).toThrow(/no qualified Ralph loop session/);
  });

  it('WP02a skill generation and argv resolution stay pure and use distinct invocation paths', async () => {
    const { workdir } = await scratch();
    const before = await readdir(workdir);
    const { relativePath, content } = buildWarpBriefSkillFile('a synthetic brief body', INVOCATION_ID);
    expect(relativePath).toBe(`.agents/skills/${SKILL_NAME}/SKILL.md`);
    expect(content).toContain('a synthetic brief body');
    expect(content).toContain(`---\nname: ${SKILL_NAME}\n`);
    const secondId = `${INVOCATION_ID}-2`;
    const second = buildWarpBriefSkillFile('a synthetic brief body', secondId);
    expect(second.relativePath).not.toBe(relativePath);
    const argv = argvFor(workdir);
    expect(argv[argv.indexOf('--skill') + 1]).toBe(SKILL_NAME);
    const secondArgv = installed.owner.buildWorkerArgs({ invocationId: secondId, brief: 'a synthetic brief body',
      cwd: workdir, selected: { model: MODEL } }, null, {});
    expect(secondArgv[secondArgv.indexOf('--skill') + 1]).toBe(buildWarpBriefSkillName(secondId));
    expect(await readdir(workdir)).toEqual(before);
    expect(() => buildWarpBriefSkillFile('', INVOCATION_ID)).toThrow(/non-empty brief/);
    expect(buildWarpBriefSkillName('a'.repeat(52))).toHaveLength(63);
  });

  it.each([undefined, '', '../other', 'a/b', '-option', 'a b', 'a\n', 'a\0', 'UPPER', 'é', 'a'.repeat(53)])(
    'WP02b refuses an invocation ID that cannot map safely: %j', invocationId => {
      expect(() => buildWarpBriefSkillFile('brief', invocationId as string)).toThrow(/invocation id cannot be mapped safely/);
      expect(() => installed.owner.buildWorkerArgs({ invocationId, brief: 'brief', cwd: '/w', selected: { model: MODEL } }, null, {}))
        .toThrow(/invocation id cannot be mapped safely/);
    });

  it('WP02c refuses a requested sandbox other than the declared external mode in the adapter', () => {
    const input = { invocationId: INVOCATION_ID, brief: 'brief', cwd: '/w', selected: { model: MODEL } };
    expect(installed.owner.buildWorkerArgs(input, null, { sandbox: 'external' })).toContain('--no-snapshot');
    for (const sandbox of ['read-only', 'workspace-write', 'danger-full-access', 'auto']) {
      expect(() => installed.owner.buildWorkerArgs(input, null, { sandbox })).toThrow(/sandbox is not a qualified direct mode/);
    }
  });

  it('WP03 executes the rendered argv against the fake: argv/env stay clean, model/cwd/skill match exactly', async () => {
    const { root, workdir } = await scratch();
    const { file, recordPath } = await fakeConfig(root, 'success');
    const argv = argvFor(workdir);
    const result = await run([FAKE, ...argv], { cwd: workdir,
      env: { PATH: process.env.PATH!, AIWG_FAKE_WORKER_CONFIG: file, WARP_UNRELATED_SECRET: 'fk-synthetic-should-not-pass' } });
    expect(result.code, result.stderr).toBe(0);
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(record).toMatchObject({ outputFormat: 'json', model: MODEL, cwd: workdir, skill: SKILL_NAME, noSnapshot: true });
    expect(record.argv).toEqual(argv);
    expect(record.argv).not.toContain('--prompt');
    // Neither structural JSON validity nor schema-valid claims establish
    // an Oz terminal answer; exercise both installed production hooks.
    expect(installed.owner.parseOutput(result.stdout)).toBeNull();
    await expect(installed.owner.parseWorkerFinal(result.stdout, { format: 'json', observation: OBSERVATION }))
      .rejects.toMatchObject({ name: 'WorkerContractError', code: 'OG_CONTRACT_UNSUPPORTED' });

    const { file: claimsFile } = await fakeConfig(root, 'claims');
    const claimsResult = await run([FAKE, ...argv], { cwd: workdir, env: { PATH: process.env.PATH!, AIWG_FAKE_WORKER_CONFIG: claimsFile } });
    expect(claimsResult.code, claimsResult.stderr).toBe(0);
    expect(installed.owner.parseOutput(claimsResult.stdout)).toBeNull();
    await expect(installed.owner.parseWorkerFinal(claimsResult.stdout, { format: 'json', observation: OBSERVATION }))
      .rejects.toThrow(/Oz output envelope.*authenticated run/);
  });

  it('WP04 the fixture refuses never-emitted cloud/bypass flags (regression guard)', async () => {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, 'success');
    const env = { PATH: process.env.PATH!, AIWG_FAKE_WORKER_CONFIG: file };
    const withEnv = await run([FAKE, ...argvFor(workdir), '--environment', 'cloud-1'], { cwd: workdir, env });
    expect(withEnv.code).not.toBe(0);
    expect(withEnv.stderr).toMatch(/refused/);
    const withHarness = await run([FAKE, ...argvFor(workdir), '--harness', 'codex'], { cwd: workdir, env });
    expect(withHarness.code).not.toBe(0);
    expect(withHarness.stderr).toMatch(/refused/);
    const withPromptText = await run([FAKE, 'agent', 'run', '--output-format', 'json', '--model', MODEL,
      '--cwd', workdir, '--prompt', 'inline brief text'], { cwd: workdir, env });
    expect(withPromptText.code).not.toBe(0);
    expect(withPromptText.stderr).toMatch(/refused/);
    for (const team of [['--team'], ['--team', 'team-1'], ['--team=team-1']]) {
      const withTeam = await run([FAKE, ...argvFor(workdir), ...team], { cwd: workdir, env });
      expect(withTeam.code).not.toBe(0);
      expect(withTeam.stderr).toMatch(/refused: --team/);
    }
  });

  it('WP04a the fake refuses a run missing the required --no-snapshot flag', async () => {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, 'success');
    const args = argvFor(workdir).filter((arg: string) => arg !== '--no-snapshot');
    const result = await run([FAKE, ...args], { cwd: workdir, env: { PATH: process.env.PATH!, AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/--no-snapshot is required/);
  });
});

describe('T-OG-03/20/21/23 Warp run identity and terminal signals', () => {
  it('WP05 missing executable is ENOENT, never a synthesized exit zero', async () => {
    const { workdir } = await scratch();
    await expect(new Promise((resolve, reject) => {
      const child = spawn(path.join(workdir, 'warp-terminal'), ['--help'], { cwd: workdir });
      child.on('error', reject);
      child.on('exit', resolve);
    })).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('WP06 fixture assumption: a missing skill fails; real missing-skill behavior is UNVERIFIED behind login', async () => {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, 'success', { skillFileExists: false });
    const result = await run([FAKE, ...argvFor(workdir)], { cwd: workdir, env: { PATH: process.env.PATH!, AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/skill not found/);
    expect(installed.owner.parseOutput(result.stdout)).toBeNull();
  });

  it.each(['claims', 'error-output', 'array-output', 'plain-text', 'malformed', 'empty-output'])(
    'WP07 both installed final hooks refuse output without an authenticated envelope: %s', async scenario => {
      const { root, workdir } = await scratch();
      const { file } = await fakeConfig(root, scenario);
      const result = await run([FAKE, ...argvFor(workdir)], { cwd: workdir, env: { PATH: process.env.PATH!, AIWG_FAKE_WORKER_CONFIG: file } });
      expect(result.code).toBe(0);
      expect(installed.owner.parseOutput(result.stdout), scenario).toBeNull();
      for (const format of ['json', 'text', 'mcp']) {
        await expect(installed.owner.parseWorkerFinal(result.stdout, { format, observation: OBSERVATION }), scenario)
          .rejects.toMatchObject({ name: 'WorkerContractError', code: 'OG_CONTRACT_UNSUPPORTED',
            message: expect.stringMatching(/Oz output envelope.*authenticated run/) });
      }
    });

  it('WP08 crash mid-run exits non-zero and leaves no candidate final', async () => {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, 'crash-mid');
    const result = await run([FAKE, ...argvFor(workdir)], { cwd: workdir, env: { PATH: process.env.PATH!, AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code).not.toBe(0);
    expect(installed.owner.parseOutput(result.stdout)).toBeNull();
  });

  it('WP09 hang after start needs an owned stop; TERM/KILL honored by the fixture, no synthesized success', async () => {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, 'hang');
    const result = await run([FAKE, ...argvFor(workdir)],
      { cwd: workdir, env: { PATH: process.env.PATH!, AIWG_FAKE_WORKER_CONFIG: file }, timeoutMs: 500 });
    expect(result.code).toBeNull();
    expect(result.signal).toBe('SIGKILL');
  });

  it('WP10 the auth gate (no login) stops before scenario output, matching the live noodle probes', async () => {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, 'success', { simulateAuthGate: true });
    const result = await run([FAKE, ...argvFor(workdir)], { cwd: workdir, env: { PATH: process.env.PATH!, AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/not logged in/);
    expect(installed.owner.parseOutput(result.stdout)).toBeNull();
  });

  it('WP11 the sole reportable sandbox contract is external; no CLI sandbox flag is invented', () => {
    expect(WARP_DIRECT_SANDBOX_MODES).toEqual(['external']);
    const adapter = loadProviderModelCapabilities().providers.warp.workerHealthAdapter!;
    expect((adapter.capabilities as any).sandboxModes).toEqual([...WARP_DIRECT_SANDBOX_MODES]);
  });
});
