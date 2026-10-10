/**
 * #2910 (B-OG-45) Pi promotion: offline S1 profile work.
 *
 * T-OG-15 renders the version-bound Pi direct-shell profile through the real
 * resolver and #2887 renderer, then executes the rendered shell command
 * against a synthetic `pi` that records argv, cwd, stdin and environment
 * names using Pi's own event grammar (session, agent_start, agent_end,
 * agent_settled). The brief travels on stdin, never argv. T-OG-20/21 drive
 * the same fake through the #2896 health observer via the production
 * PiAdapter owner, loaded through the #2885 installed-module path. Spawns
 * are plain child processes (no systemd); nothing reaches a network, model,
 * credential or MC state. Fixture qualification here is synthetic and never
 * live qualification: the bundled Pi profile stays unqualified.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { workerConfigDigest } from '../../../src/config/aiwg-config.js';
import { loadProviderModelCapabilities } from '../../../src/models/provider-policy.js';
import { resolveWorkerInvocation, prepareWorkerInvocation } from '../../../src/serve/worker-invocation.js';
import { createProvider, loadInstalledWorkerAdapters } from '../../../src/models/worker-installation.mjs';
import { PiAdapter, PI_DIRECT_STDIN, PI_DIRECT_VERSION } from '../../../tools/ralph-external/lib/pi-adapter.mjs';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';

const FAKE = path.resolve('test/fixtures/providers/pi/fake-pi.mjs');
const MODULE = 'tools/ralph-external/lib/pi-adapter.mjs';
const APPROVED = JSON.parse(readFileSync('test/fixtures/providers/pi/approved-module.json', 'utf8'));
const sha256 = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const roots: string[] = [];
const installRoots: string[] = [];

async function installPiPackage(bytes: Buffer) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'aiwg-pi-install-')); installRoots.push(base);
  const packageRoot = path.join(base, 'pkg');
  const writable = path.join(base, 'worker-writable');
  await mkdir(path.join(packageRoot, 'lib'), { recursive: true, mode: 0o755 });
  await mkdir(writable, { mode: 0o755 });
  await chmod(base, 0o755); await chmod(packageRoot, 0o755); await chmod(path.join(packageRoot, 'lib'), 0o755);
  await writeFile(path.join(base, 'package.json'), JSON.stringify({ name: 'aiwg', version: '0.0.0-test-root', type: 'module' }));
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: APPROVED.entry.packageName,
    version: APPROVED.entry.packageVersion, type: 'module' }), { mode: 0o644 });
  await writeFile(path.join(packageRoot, 'lib', 'pi-adapter.mjs'), bytes, { mode: 0o644 });
  for (const name of ['provider-adapter.mjs', 'worker-health.mjs']) {
    const dest = path.join(packageRoot, 'lib', name);
    await copyFile(path.resolve('tools/ralph-external/lib', name), dest);
    await chmod(dest, 0o644);
  }
  // Mirrors the repo layout (tools/ralph-external/lib -> tools/): from
  // pkg/lib, '../../_resolve-impl.mjs' resolves to the install base.
  const resolveImpl = path.join(base, '_resolve-impl.mjs');
  await copyFile(path.resolve('tools/_resolve-impl.mjs'), resolveImpl);
  await chmod(resolveImpl, 0o644);
  await mkdir(path.join(base, 'src', 'models'), { recursive: true, mode: 0o755 });
  const target = path.resolve('src/models/worker-installation.mjs');
  const relative = path.relative(path.join(base, 'src', 'models'), target);
  await writeFile(path.join(base, 'src', 'models', 'worker-installation.mjs'),
    `export * from ${JSON.stringify(relative)};\n`);
  return { packageRoot, writable };
}

function loadingRegistry() {
  const registry = structuredClone(loadProviderModelCapabilities());
  registry.providers.pi.workerAdapter = structuredClone(registry.providers.pi.workerHealthAdapter!);
  return registry;
}

let installed: { owner: any; ids: string[] };
beforeAll(async () => {
  const saved = process.env.AIWG_RESOLVE_IMPL_FROM;
  process.env.AIWG_RESOLVE_IMPL_FROM = 'src';
  try {
    const { packageRoot, writable } = await installPiPackage(readFileSync(MODULE));
    const ids = await loadInstalledWorkerAdapters({ registry: loadingRegistry(),
      modules: [{ ...APPROVED.entry, packageRoot }], workerWritableRoots: [writable], platform: 'linux' });
    installed = { owner: createProvider('pi'), ids };
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

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 5000, stdinData = ''): Promise<any> {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.stdin.on('error', () => {}); child.stdin.end(stdinData);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const finish = (value: object) => { clearTimeout(timer); resolve({ code: null, signal: null, stdout, stderr, ...value }); };
    child.on('error', error => finish({ error }));
    child.on('close', (code, signal) => finish({ code, signal }));
  });
}

async function fixture(options: { qualified?: boolean; model?: string; effort?: string; version?: string } = {}) {
  const f = workerResolutionFixture();
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-pi-direct-')); roots.push(root);
  const cwd = path.join(root, "work '雪"); await mkdir(cwd);
  const brief = path.join(root, "brief '雪\n.md");
  const payload = `--leading 雪\n'quotes' "double" $(touch ${root}/injected); \`echo dangerous\``;
  await writeFile(brief, payload, { mode: 0o600 });
  const adapter: any = structuredClone(loadProviderModelCapabilities().providers.pi.workerHealthAdapter!);
  const profile = adapter.invocationProfiles['direct-shell'];
  if (options.qualified !== false) {
    adapter.qualification = { status: 'qualified', fixtureDigest: workerConfigDigest('synthetic-pi'),
      verifiedAt: f.observation.verifiedAt, evidenceRef: 'fixture:synthetic-only' };
    for (const [name, control] of Object.entries(profile.controls) as any) {
      if (name === 'stepCap') continue;
      control.support = 'native'; control.evidence = 'fixture:synthetic-only';
    }
    profile.envAllowlist = adapter.invocation.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
    Object.assign(adapter.capabilities, { modelPin: 'requested', effort: 'explicit',
      nestedAgentsControllable: true, nativeFallbackControllable: true,
      sandboxModes: ['read-only', 'workspace-write'] });
  }
  delete f.snapshot.registry.providers.codex.workerAdapter;
  f.snapshot.registry.providers.pi.workerAdapter = adapter;
  const model = options.model ?? 'synthetic/pi-model';
  const group = f.snapshot.config.parallelism!.groups!.workers;
  group.members = [{ ...group.members[0], cli: 'pi', model }]; group.fallback = [];
  const discovery = f.snapshot.catalog.discovery!.instances!.codex;
  discovery.provider = 'pi'; discovery.runtimeVersion = options.version ?? PI_DIRECT_VERSION;
  discovery.models = discovery.models.slice(0, 1);
  Object.assign(discovery.models[0], { id: model, apiModelId: model });
  Object.assign(discovery.models[0].worker!, { cliId: 'pi', runtimeVersion: options.version ?? PI_DIRECT_VERSION });
  f.snapshot.catalog.discovery!.instances = { pi: discovery };
  f.snapshot.installations = { pi: { ...f.snapshot.installations.codex, profile: 'direct-shell', cliVersion: options.version ?? PI_DIRECT_VERSION } };
  if (options.effort) f.snapshot.models.defaults.workerSelection!.roleGuidance!.coding!.initialEffort = options.effort;
  let builds = 0;
  const drivers: any = { pi: { qualification: { adapter, adapterId: 'pi', cliVersion: options.version ?? PI_DIRECT_VERSION },
    prepareWorkerInvocation: (invocation: any, qualification: any) => prepareWorkerInvocation(invocation, qualification),
    buildInvocation: async (input: any) => { builds++; return { argv: [process.execPath, FAKE, ...installed.owner.buildWorkerArgs(input, profile, input.permissions)],
      stdin: PI_DIRECT_STDIN, envNames: ['AIWG_FAKE_WORKER_CONFIG'] }; } } };
  const request = { role: 'coding' as const, group: 'workers', task: 'implementation', brief, workdir: cwd,
    final_output: path.join(cwd, "final '雪.json"), transport: 'shell' as const };
  const plan = await resolveWorkerInvocation(f.snapshot, request, drivers, f.request.now);
  return { root, cwd, payload, adapter, profile, plan, request, snapshot: f.snapshot, drivers, builds };
}

async function execute(f: Awaited<ReturnType<typeof fixture>>, scenario: string) {
  const config = path.join(f.root, `config-${scenario}.json`), record = path.join(f.root, `record-${scenario}.json`);
  await writeFile(config, JSON.stringify({ scenario, recordPath: record }), { mode: 0o600 });
  const invocation = f.plan.invocation!;
  const result = await run(invocation.argv[0], invocation.argv.slice(1), f.cwd, { AIWG_FAKE_WORKER_CONFIG: config },
    ['hang', 'no-handshake'].includes(scenario) ? 500 : 5000, f.payload);
  const { existsSync } = await import('node:fs');
  return { ...result, record: existsSync(record) ? JSON.parse(await readFile(record, 'utf8')) : null };
}

describe('Pi S1 offline direct-shell profile (#2910)', () => {
  it('PD01 pins the evidenced release, driver and health grammar; every control stays unqualified', () => {
    const adapter = loadProviderModelCapabilities().providers.pi.workerHealthAdapter!;
    expect(adapter.runtimeDriver).toBe('installed:pi');
    expect(adapter.supportedVersions).toBe(PI_DIRECT_VERSION);
    expect(adapter.qualification.status).toBe('unqualified');
    expect(adapter.invocation.stdin).toBe('brief-text');
    expect(adapter.invocation.argv).toEqual(['--mode', 'json', '--no-approve', '--no-context-files', '--no-extensions', '--no-skills', '--no-mcp', '--model', '${model}', '--thinking', '${effort}']);
    expect(adapter.invocation.argv.join(' ')).not.toMatch(/(?<!no-)--approve\b|bypass|dangerous|yolo/);
    const profile = adapter.invocationProfiles!['direct-shell'];
    for (const [name, control] of Object.entries(profile.controls) as any) {
      expect(control.support, name).toBe('unqualified');
      expect(control.evidence, name).toMatch(/^(H|R):/);
    }
    expect(profile.controls.trust.mapping).toContain('--no-approve');
    expect(profile.controls.sandbox.mapping).toMatch(/unavailable/);
    expect(profile.controls.stdin.mapping).toMatch(/brief-text/);
    expect(profile.health.fixtureRef && typeof profile.health.fixtureRef).toBe('string');
    expect(profile.health.qualification.status).toBe('unqualified');
  });

  it('PD01a loads the one approved module by digest through the production installed loader', async () => {
    expect(APPROVED.source).toBe(MODULE);
    expect(sha256(readFileSync(MODULE))).toBe(APPROVED.entry.sha256);
    expect(installed.ids).toEqual(['pi']);
    expect(installed.owner.getName()).toBe('pi');
    expect(installed.owner.constructor.name).toBe('PiAdapter');
    expect(installed.owner.buildWorkerArgs(
      { selected: { model: 'synthetic/a', effort: { value: 'medium' } }, cwd: '/w', brief: 'b' }, null, {}))
      .toEqual(['--mode', 'json', '--no-approve', '--no-context-files', '--no-extensions', '--no-skills', '--no-mcp', '--model', 'synthetic/a', '--thinking', 'medium']);
    // Legacy Ralph-loop contract (test/unit/ralph/pi-adapter.test.mjs): the
    // settlement-only shape is settlement-only -- no `text` key, no answer
    // requirement. Only parseDirectFinal() adds that for the direct profile.
    const noAnswer = [{ type: 'agent_start' }, { type: 'agent_end', willRetry: false }, { type: 'agent_settled' }]
      .map(event => JSON.stringify(event)).join('\n');
    expect(installed.owner.parseOutput(noAnswer)).toEqual({ events: JSON.parse(`[${noAnswer.split('\n').join(',')}]`), settled: true });
    expect(Object.keys(installed.owner.parseOutput(noAnswer))).toEqual(['events', 'settled']);
  });

  it('PD02 renders and executes exact argv with the brief on stdin only; no argv flags carry it', async () => {
    const f = await fixture();
    expect(f.plan.invocation, JSON.stringify(f.plan)).toBeDefined();
    const invocation = f.plan.invocation!;
    expect(invocation.stdin).toBe('brief-text');
    expect(invocation.argv.slice(2)).toEqual(['--mode', 'json', '--no-approve', '--no-context-files', '--no-extensions', '--no-skills', '--no-mcp',
      '--model', 'synthetic/pi-model', '--thinking', 'medium']);
    expect(JSON.stringify(invocation.argv)).not.toContain(f.payload);
    const result = await execute(f, 'success');
    expect(result.code, result.stderr).toBe(0);
    expect(result.record).toMatchObject({ argv: invocation.argv.slice(2), cwd: f.cwd, brief: f.payload.trim() });
    const { existsSync } = await import('node:fs');
    expect(existsSync(path.join(f.root, 'injected'))).toBe(false);
    const parsed = installed.owner.parseDirectFinal(result.stdout);
    expect(parsed?.settled).toBe(true);
    expect(parsed?.text).toBeTruthy();
  });

  it.each([{ qualified: false }, { model: 'team-contributor/x' }, { effort: 'ultra' }, { version: '0.86.0' }])
    ('PD03 blocked tuple %j produces no launch command', async options => {
      const f = await fixture(options as any);
      expect(f.plan.invocation).toBeUndefined();
      expect(f.builds).toBe(0);
    });

  it('PD04 the driver argv never carries the brief and refuses a missing model/thinking or relative workspace', () => {
    const owner = installed.owner;
    const input = { selected: { model: 'synthetic/a', effort: { value: 'medium' } }, cwd: '/w', brief: 'secret-brief-text' };
    const argv = owner.buildWorkerArgs(input, null, {});
    expect(JSON.stringify(argv)).not.toContain('secret-brief-text');
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: '', effort: { value: 'medium' } } }, null, {})).toThrow(/explicit model/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: 'synthetic/a', effort: { value: null } } }, null, {})).toThrow(/thinking level/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: 'synthetic/a', effort: { value: 'off' } } }, null, {})).toThrow(/thinking level/);
    expect(() => owner.buildWorkerArgs({ ...input, cwd: 'relative' }, null, {})).toThrow(/absolute workspace/);
    expect(() => owner.buildWorkerArgs({ ...input, brief: '   \n  ' }, null, {})).toThrow(/non-empty brief/);
    expect(owner.getAbortInput()).toBeNull();
  });

  it.each(['error', 'malformed', 'missing-final', 'exit-zero-error'])('PD05 %s never establishes a healthy settled final', async scenario => {
    const f = await fixture();
    const result = await execute(f, scenario);
    const observer = installed.owner.createHealthObserver({ profile: f.profile, invocationId: 'synthetic' });
    observer.feed(Buffer.from(result.stdout), { kind: 'stdout', id: 'stdout', generation: 0, offset: 0 });
    const parsed = installed.owner.parseDirectFinal(result.stdout);
    // Settlement alone (an agent_settled event) is never sufficient: a
    // missing/empty assistant answer or any error signal (standalone
    // `error`, willRetry or a stopReason of error/aborted) must also fail,
    // even when the process itself exits zero (exit-zero-error).
    expect(parsed?.settled ?? false).toBe(false);
    expect(parsed?.text ?? null).toBeNull();
    expect(observer.finish({ exitCode: result.code, termination: 'confirmed', finalValid: parsed?.settled === true }).state).not.toBe('completed');
  });

  it('PD05a final extraction takes the LAST assistant message; an empty final never falls back to earlier text', () => {
    const adapter = new PiAdapter();
    const stream = (finalText: string) => [
      { type: 'agent_start' },
      { type: 'agent_end', messages: [
        { role: 'user', content: [{ type: 'text', text: 'brief' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Working on it' }], stopReason: 'toolUse' },
        { role: 'toolResult', content: [{ type: 'text', text: 'ok' }] },
        { role: 'assistant', content: [{ type: 'text', text: finalText }], stopReason: 'stop' },
      ] },
      { type: 'agent_settled' },
    ].map(event => JSON.stringify(event)).join('\n');
    const good = adapter.parseDirectFinal(stream('FINAL ANSWER'));
    expect(good?.settled).toBe(true);
    expect(good?.text).toBe('FINAL ANSWER');
    const empty = adapter.parseDirectFinal(stream('   '));
    expect(empty?.settled).toBe(false);
    expect(empty?.text).toBeNull();
  });

  it('PD06 health observer classifies Pi\'s own event grammar: setup, accepted, progress, terminal', async () => {
    const f = await fixture();
    const result = await execute(f, 'success');
    const source = { kind: 'stdout' as const, id: 'stdout', generation: 0, offset: 0 };
    const binding = { invocationId: 'pd06', sessionId: 'synthetic-session' };
    const kinds = result.stdout.trim().split('\n').map((line: string) =>
      installed.owner.observeHealthEvent(JSON.parse(line), source, binding)?.kind ?? null);
    expect(kinds).toEqual(['setup', 'accepted', 'progress', 'terminal']);
  });

  it('PD07 missing executable is ENOENT, never a synthesized exit zero', async () => {
    const f = await fixture();
    const result = await run(path.join(f.cwd, 'pi'), ['--version'], f.cwd, {});
    expect(result.error?.code).toBe('ENOENT');
    expect(result.code).toBeNull();
  });

  it('PD08 a silent hang after the handshake never reports a clean terminal', async () => {
    const f = await fixture();
    const result = await execute(f, 'hang');
    expect(result.signal).toBe('SIGKILL');
    expect(result.code).toBeNull();
  });

  it('PD09 the rendered shell command carries no secret through its env allowlist', async () => {
    const f = await fixture();
    const secret = '[REDACTED]';
    expect(JSON.stringify(f.plan)).not.toContain(secret);
    const invocation = f.plan.invocation!;
    expect(invocation.shellCommand).not.toContain(secret);
    const config = path.join(f.root, 'config-secret.json'), record = path.join(f.root, 'record-secret.json');
    await writeFile(config, JSON.stringify({ scenario: 'success', recordPath: record }));
    const result = await run('/bin/sh', ['-c', invocation.shellCommand!], f.root,
      { PATH: process.env.PATH, AIWG_FAKE_WORKER_CONFIG: config, PI_UNRELATED_SECRET: secret });
    expect(result.code, result.stderr).toBe(0);
    const rec = JSON.parse(await readFile(record, 'utf8'));
    expect(rec.envNames).not.toContain('PI_UNRELATED_SECRET');
    const stdout = await readFile(invocation.stdoutPath, 'utf8');
    expect(stdout).not.toContain(secret);
  });
});
