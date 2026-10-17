import { spawn as mockSpawn, spawnSync as mockSpawnSync } from 'child_process';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionLauncher, terminateChildWithGrace } from '../../../tools/ralph-external/session-launcher.mjs';

import { signalChild } from '../../../src/process/signal-child.mjs';
import { ChildProcessTransport, __testOnlyDefaultCallMcpWorker as callMcpWorker } from '../../../src/mcp/tools/worker-invoke.mjs';
import { buildShellStopControl } from '../../../src/mcp/tools/worker-shell-control.mjs';
import { stopOverflowWorker } from '../../../tools/ralph-external/lib/worker-overflow.mjs';
import * as isolation from '../../../tools/ralph-external/lib/worker-isolation.mjs';
import * as launcherModule from '../../../tools/ralph-external/session-launcher.mjs';
import { isSafeWorkerGroupTarget } from '../../../tools/ralph-external/process-monitor.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

vi.mock('child_process', async importOriginal => {
  const original = await importOriginal();
  return { ...original, spawn: vi.fn(), spawnSync: vi.fn(original.spawnSync) };
});
const { spawn } = await vi.importActual('node:child_process');
const roots = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function failedChild(pid = undefined) {
  return Object.assign(new EventEmitter(), { pid, killed: false, exitCode: null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
}

const launcherUrl = new URL('../../../tools/ralph-external/session-launcher.mjs', import.meta.url).href;

describe('single-child stop signal authority', () => {
  it.each([undefined, 0, -1, NaN, 1.5])('never calls kill with an invalid child PID (%s)', async pid => {
    const child = Object.assign(new EventEmitter(), {
      pid, exitCode: null, signalCode: null, kill: vi.fn(),
    });
    expect(await terminateChildWithGrace(child, { graceMs: 1 })).toEqual({ terminated: false });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('never signals a real failed spawn before its ENOENT event arrives', async () => {
    const child = spawn(fileURLToPath(new URL('missing-worker-binary', import.meta.url)), [], { stdio: 'ignore' });
    const closed = new Promise(resolve => child.once('close', resolve));
    const errors = [];
    child.on('error', error => errors.push(error.code));
    // Prevent the unsafe native call even when this regression fails.
    const kill = vi.spyOn(child, 'kill').mockReturnValue(false);
    try {
      expect(child.pid).toBeUndefined();
      expect(await terminateChildWithGrace(child, { graceMs: 1 })).toEqual({ terminated: false });
      expect(kill).not.toHaveBeenCalled();
      await closed;
      expect(errors).toEqual(['ENOENT']);
    } finally { kill.mockRestore(); }
  });

  it.skipIf(process.platform !== 'linux')('survives the native zero-PID failed-spawn window in an isolated group', async () => {
    // Zero freshly allocated native memory so the failed handle selects PID
    // zero consistently. detached confines the pre-fix group SIGTERM to this
    // subprocess; it must never reach Vitest's shared thread-pool process.
    const script = `
      import { spawn } from 'node:child_process';
      import { SessionLauncher, terminateChildWithGrace } from ${JSON.stringify(launcherUrl)};
      const keepAlive = setInterval(() => {}, 1000);
      const child = spawn('/nonexistent-aiwg-fixture-2915', [], { stdio: 'ignore' });
      child.on('error', () => {});
      const result = await terminateChildWithGrace(child, { graceMs: 1 });
      clearInterval(keepAlive);
      if (result.terminated !== false) process.exitCode = 1;
    `;
    const probe = spawn(process.execPath, ['--input-type=module', '-e', script], {
      detached: true, stdio: 'ignore',
      env: { ...process.env, GLIBC_TUNABLES: 'glibc.malloc.tcache_count=0', MALLOC_PERTURB_: '255' },
    });
    const watchdog = setTimeout(() => probe.kill('SIGKILL'), 10_000);
    try {
      const result = await new Promise((resolve, reject) => {
        probe.once('error', reject);
        probe.once('close', (code, signal) => resolve({ code, signal }));
      });
      expect(result).toEqual({ code: 0, signal: null });
    } finally { clearTimeout(watchdog); }
  });
});


describe('shared ChildProcess signal guard', () => {
  it.each([undefined, null, 0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, '123'])('refuses PID %s without entering the native handle', pid => {
    const child = failedChild(pid);
    expect(signalChild(child, 'SIGTERM')).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('preserves delivered, refused and throwing native results for a positive PID', () => {
    const child = failedChild(123);
    expect(signalChild(child, 'SIGTERM')).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.kill.mockReturnValue(false);
    expect(signalChild(child, 'SIGKILL')).toBe(false);
    child.kill.mockImplementation(() => { throw new Error('signal failure'); });
    expect(() => signalChild(child)).toThrow('signal failure');
    expect(signalChild(null)).toBe(false);
    expect(signalChild(undefined)).toBe(false);
  });

  it('retains escalation when a valid-PID child refuses TERM delivery', async () => {
    vi.useFakeTimers();
    const child = failedChild(123);
    child.kill.mockReturnValue(false);
    const stopping = terminateChildWithGrace(child, { graceMs: 10 });
    await vi.advanceTimersByTimeAsync(110);
    expect(await stopping).toEqual({ terminated: false });
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
  });

  it('rechecks PID before escalation', async () => {
    vi.useFakeTimers();
    const child = failedChild(123);
    const stopping = terminateChildWithGrace(child, { graceMs: 10 });
    child.pid = undefined;
    await vi.advanceTimersByTimeAsync(110);
    expect(await stopping).toEqual({ terminated: false });
    expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
  });
});

describe.each([undefined, 0, -1, NaN])('failed-spawn signal paths (PID %s)', pid => {
  it('MCP default overflow termination remains uncertain', async () => {
    const child = failedChild(pid);
    const transport = new ChildProcessTransport(child);
    await transport.start();
    transport._overflow('OG_WORKER_MCP_FRAME_TOO_LARGE');
    expect(await transport._termination).toEqual({ termination: 'uncertain', diagnostic: 'OG_WORKER_MCP_STOP_UNCONFIRMED' });
    expect(child.kill).not.toHaveBeenCalled();
    expect(transport._closed).toBe(true);
  });

  it('MCP close refuses both TERM and KILL while retaining bounded completion', async () => {
    vi.useFakeTimers();
    const child = failedChild(pid);
    const transport = new ChildProcessTransport(child);
    const closing = transport.close();
    await vi.advanceTimersByTimeAsync(4000);
    await closing;
    expect(child.kill).not.toHaveBeenCalled();
    expect(transport._buffer).toBeUndefined();
  });

  it.each([false, true])('MCP cancellation fallback reports not delivered (recovery gated: %s)', async gated => {
    const child = failedChild(pid);
    const launch = { launched: true, mode: 'degraded', child };
    vi.spyOn(isolation, 'checkWorkerDispatch').mockReturnValue({ ok: true });
    vi.spyOn(isolation, 'launchIsolatedWorker').mockResolvedValue(launch);
    vi.spyOn(launcherModule, 'planDirectWorkerLaunch').mockResolvedValue(launch);
    const notification = vi.spyOn(Client.prototype, 'notification').mockRejectedValue(new Error('not connected'));
    vi.spyOn(Client.prototype, 'close').mockResolvedValue();
    let delivered;
    vi.spyOn(Client.prototype, 'connect').mockRejectedValue(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    const stopping = [];
    const result = await callMcpWorker({ serverRef: 'failed-spawn', tool: 'worker', timeoutSeconds: 1 }, { type: 'stdio', command: '/missing' }, {
      sessionIsolation: 'per-call', ...(gated ? { admission: { gated: true } } : {}),
      registerControl: control => { if (control) stopping.push(control.stop().then(value => { delivered = value; })); },
    });
    await Promise.all(stopping);
    expect(notification).toHaveBeenCalled();
    expect(delivered).toBe(false);
    expect(result.outcome).toBe('error');
    expect(result.error.code).toBe('ENOENT');
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each([false, true])('shell stop refuses delivery and remains uncertain without exit proof (owned group: %s)', async ownedGroup => {
    vi.useFakeTimers();
    const child = failedChild(pid);
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const control = buildShellStopControl({ launched: true, mode: 'degraded', child, ownedGroup }, {
      graceMs: 10, platform: 'darwin', recheckMaxAttempts: 0,
    });
    try {
      expect(await control.stop()).toBe(false);
      const result = control.stopAndConfirm();
      await vi.advanceTimersByTimeAsync(20);
      expect(await result).toMatchObject({ termination: 'uncertain' });
      expect(child.kill).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
    } finally { control.dispose(); }
  });

  it.each(['darwin', 'win32', 'linux'])('overflow stop reports no delivery on %s', async platform => {
    const child = failedChild(pid);
    expect(await stopOverflowWorker({ mode: 'degraded', child }, { platform })).toEqual({
      termination: 'uncertain', delivered: false,
      diagnostic: platform === 'linux' ? 'OG_WORKER_MCP_STOP_UNCONFIRMED' : 'OG_WORKER_MCP_STOP_FAILED',
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each(['claude', 'omp'])('session timeout, escalation, close and explicit kill refuse the failed %s spawn', async provider => {
    const root = await mkdtemp(path.join(tmpdir(), 'failed-spawn-signals-'));
    roots.push(root);
    const child = failedChild(pid);
    mockSpawn.mockReturnValue(child);
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const launcher = new SessionLauncher();
    launcher.setProviderAdapter({ getName: () => provider, getBinary: () => '/missing',
      getEnvOverrides: () => ({}), buildSessionArgs: () => [], parseOutput: () => ({ success: false }) });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = launcher._launchSession({ prompt: 'test', workingDir: root,
      stdoutPath: path.join(root, 'stdout'), stderrPath: path.join(root, 'stderr'), timeoutMs: 10 });
    launcher.kill();
    await vi.advanceTimersByTimeAsync(6010);
    child.emit('close', -2);
    expect(await pending).toMatchObject({ exitCode: -2, timedOut: true });
    expect(child.kill).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(launcher.currentProcess).toBeNull();
    expect(isSafeWorkerGroupTarget(pid, { pgid: 123 })).toBe(false);
  });
});

describe('additional ChildProcess cleanup paths with failed spawns', () => {
  function fixture() {
    const child = failedChild();
    child.unref = vi.fn();
    mockSpawn.mockReturnValue(child);
    return child;
  }
  const enoent = () => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });

  it.each(['overflow', 'timeout'])('model catalog %s keeps its failure status without signaling', async trigger => {
    const { runModelDiscoveryCommand } = await import('../../../src/models/model-discovery.ts');
    vi.useFakeTimers();
    const child = fixture();
    const pending = runModelDiscoveryCommand('/missing', [], { timeoutMs: 10 });
    if (trigger === 'overflow') child.stdout.emit('data', Buffer.alloc(8 * 1024 * 1024 + 1));
    else await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toMatchObject({ exitCode: trigger === 'overflow' ? 1 : 124 });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('Codex discovery handles ENOENT without signaling its failed child', async () => {
    const { discoverCodexModels } = await import('../../../src/models/model-discovery.ts');
    const child = fixture();
    const pending = discoverCodexModels('/missing', 10, async () => ({ stdout: 'v1', stderr: '', exitCode: 0 }));
    // Version qualification is asynchronous; the app-server spawn follows it.
    await vi.waitFor(() => expect(child.listenerCount('error')).toBeGreaterThan(0));
    child.emit('error', enoent());
    expect(await pending).toMatchObject({ provider: 'codex', models: [] });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('credential command output limit keeps the failing exit result', async () => {
    const { defaultCommandRunner } = await import('../../../src/auth/credential-store.ts');
    const child = fixture();
    const pending = defaultCommandRunner('/missing', []);
    child.stdout.emit('data', Buffer.alloc(1024 * 1024 + 1));
    child.emit('close', -2);
    expect(await pending).toMatchObject({ exitCode: -2 });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('forge CLI output limit reports oversized without signaling', async () => {
    const { cliForgeTransport } = await import('../../../src/tracker/forge-http.ts');
    const child = fixture();
    const pending = cliForgeTransport({ provider: 'github', hostname: 'fixture.invalid', binary: '/missing', maxResponseBytes: 1 })('/repos/fixture');
    const checked = expect(pending).rejects.toMatchObject({ code: 'oversized' });
    child.stdout.emit('data', Buffer.alloc(65_538));
    child.emit('close', -2);
    await checked;
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('git verifier output limit reports malformed without signaling', async () => {
    const { gitCommitVerifier } = await import('../../../src/effects/verifiers/git.ts');
    const child = fixture();
    const pending = gitCommitVerifier({ repoDir: process.cwd(), gitBinary: '/missing' }).verify({
      target: `git:${'a'.repeat(40)}`, expected: {}, context: {}, signal: new AbortController().signal,
    });
    const checked = expect(pending).rejects.toMatchObject({ reason: 'malformed-response' });
    child.stdout.emit('data', Buffer.alloc(4 * 1024 * 1024 + 1));
    child.emit('close', -2);
    await checked;
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('MCP CLI timeout refuses both cleanup signals and still rejects on time', async () => {
    const { runAiwgCli } = await import('../../../src/mcp/helpers.mjs');
    vi.useFakeTimers();
    const child = fixture();
    const checked = expect(runAiwgCli(['fixture'], { timeoutMs: 10 })).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(1010);
    await checked;
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('script timeout refuses TERM and KILL and retains the failed handler result', async () => {
    const { DefaultScriptRunner } = await import('../../../src/cli/handlers/script-runner.ts');
    vi.useFakeTimers();
    const child = fixture();
    const pending = new DefaultScriptRunner(process.cwd()).run('missing.mjs', [], { timeout: 10 });
    await vi.advanceTimersByTimeAsync(5010);
    expect(await pending).toMatchObject({ exitCode: 124 });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('Grok headless launch failure refuses child and group signals', async () => {
    const { runGrokHeadless } = await import('../../../src/providers/grok-build-headless.ts');
    const child = fixture();
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const checked = expect(runGrokHeadless({ prompt: 'fixture', command: '/missing' })).rejects.toThrow('launch failed');
    child.emit('error', enoent());
    await checked;
    expect(child.kill).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it('Grok ACP refuses close delivery and does not arm force-kill', async () => {
    const { GrokAcpClient } = await import('../../../src/providers/grok-build-acp.ts');
    vi.useFakeTimers();
    const child = fixture();
    const client = new GrokAcpClient({ cwd: process.cwd(), command: '/missing' });
    client.close();
    await vi.advanceTimersByTimeAsync(2000);
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('Grok ACP rechecks PID at its force-kill timer', async () => {
    const { GrokAcpClient } = await import('../../../src/providers/grok-build-acp.ts');
    vi.useFakeTimers();
    const child = fixture(); child.pid = 123;
    const client = new GrokAcpClient({ cwd: process.cwd(), command: '/missing' });
    client.close(); child.pid = undefined;
    await vi.advanceTimersByTimeAsync(2000);
    expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
  });

  it('DeepSeek RPC abort refuses both signals and rejects pending requests', async () => {
    const { DshJsonRpcClient } = await import('../../../tools/providers/deepseek-harness-transport.mjs');
    vi.useFakeTimers();
    const child = fixture();
    const client = new DshJsonRpcClient({ cwd: process.cwd(), dshHome: process.cwd(), projectPatch: '/missing', routePatch: '/missing' });
    client.start();
    const checked = expect(client.request('fixture', {})).rejects.toThrow('closed');
    client.abort();
    await vi.advanceTimersByTimeAsync(1000);
    await checked;
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('DeepSeek headless timeout refuses TERM and KILL and retains timeout error', async () => {
    const { runDshHeadless } = await import('../../../tools/providers/deepseek-harness-transport.mjs');
    vi.useFakeTimers();
    const child = fixture();
    const checked = expect(runDshHeadless({ prompt: 'fixture', cwd: process.cwd(), dshHome: process.cwd(), projectPatch: '/missing', routePatch: '/missing',
      version: '0.1.1-rc.2', timeoutMs: 10, terminateGraceMs: 10 })).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(20);
    child.emit('close', -2);
    await checked;
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('Antigravity timeout refuses delivery and retains timeout error', async () => {
    const { runAntigravity } = await import('../../../tools/providers/antigravity-transport.mjs');
    vi.useFakeTimers();
    const child = fixture();
    const checked = expect(runAntigravity('fixture', { timeoutMs: 10 })).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10);
    await checked;
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('OMP RPC failed spawn rejects readiness without child or group signaling', async () => {
    const { OmpRpcClient } = await import('../../../tools/providers/omp-transport.mjs');
    const child = fixture();
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const client = new OmpRpcClient({ binary: '/missing' });
    const checked = expect(client.ready).rejects.toMatchObject({ code: 'ENOENT' });
    child.emit('error', enoent());
    client.kill('SIGTERM'); client.kill('SIGKILL');
    child.emit('close', -2);
    await checked;
    expect(child.kill).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it.each(['stop', 'cancel'])('REPL %s clears its failed child without signaling', async operation => {
    const { REPLChat } = await import('../../../tools/daemon/repl-chat.mjs');
    const child = fixture();
    const repl = new REPLChat({ outputHandler: () => {} });
    repl.running = true;
    repl.activeProcess = child;
    if (operation === 'stop') repl.stop(); else repl._handleCommand('/cancel');
    expect(repl.activeProcess).toBe(operation === 'stop' ? null : child);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('daemon task cancel reports refused delivery; shutdown clears the task without signaling', async () => {
    const { AgentSupervisor } = await import('../../../tools/daemon/agent-supervisor.mjs');
    vi.useFakeTimers();
    const child = fixture();
    const supervisor = new AgentSupervisor();
    supervisor.running.set('fixture', { process: child, task: {} });
    expect(supervisor.cancel('fixture')).toBe(false);
    const pending = supervisor.shutdown(10);
    await vi.advanceTimersByTimeAsync(110);
    await pending;
    expect(supervisor.runningCount).toBe(0);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('daemon task timeout clears its failed task without signaling', async () => {
    const { AgentSupervisor } = await import('../../../tools/daemon/agent-supervisor.mjs');
    vi.useFakeTimers();
    const child = fixture();
    const supervisor = new AgentSupervisor({ taskTimeout: 10 });
    const timeout = vi.fn(); supervisor.on('task:timeout', timeout);
    supervisor.submit('fixture');
    await vi.advanceTimersByTimeAsync(10);
    expect(timeout).toHaveBeenCalledOnce();
    expect(supervisor.runningCount).toBe(0);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('chat handler timeout returns its error response without signaling', async () => {
    const { ChatHandler } = await import('../../../tools/messaging/chat-handler.mjs');
    vi.useFakeTimers();
    const child = fixture();
    const pending = new ChatHandler({ timeoutMs: 10 }).processMessage('fixture', { platform: 'fixture', chatId: 'fixture' });
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toMatchObject({ response: 'Error: AI response timed out' });
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe('remaining bounded cleanup boundaries', () => {
  function fixture() {
    const child = failedChild();
    mockSpawn.mockReturnValue(child);
    return child;
  }
  async function root() {
    const directory = await mkdtemp(path.join(tmpdir(), 'signal-boundary-'));
    roots.push(directory);
    return directory;
  }

  it('Codex login child error rejects without signaling its failed spawn', async () => {
    const directory = await root();
    vi.stubEnv('CODEX_HOME', directory);
    const { loginInProfile } = await import('../../../src/mcp/adapters/codex-runtime.ts');
    const child = fixture();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const checked = expect(loginInProfile('failed-spawn', { apiKey: 'synthetic-fixture-key' })).rejects.toThrow('ENOENT');
    await vi.waitFor(() => expect(child.listenerCount('error')).toBeGreaterThan(0));
    child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    await checked;
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('hang reporter refuses group and child delivery for a failed spawn at both deadlines', async () => {
    const { run } = await import('../../../tools/ci/run-with-hang-report.mjs');
    vi.useFakeTimers();
    const child = fixture();
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    // Diagnostic ps itself is stubbed, so this test never samples other users' processes.
    mockSpawnSync.mockReturnValue({ stdout: '', status: 0 });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const pending = run({ timeoutMs: 10, graceMs: 10, command: ['/missing'] });
      await vi.advanceTimersByTimeAsync(20);
      child.emit('error', new Error('spawn ENOENT'));
      expect(await pending).toBe(124);
      expect(child.kill).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
    } finally { mockSpawnSync.mockReset(); }
  });

  it('sandbox self-test timeout refuses signaling, then reports failed startup', async () => {
    const loader = await import('../../../src/gates/providers/loader.ts');
    loader.configureIsolationSandboxForTests({ bwrapPath: process.execPath });
    vi.useFakeTimers();
    const child = fixture();
    try {
      const pending = loader.probeIsolationSandbox();
      expect(mockSpawn).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10_000);
      child.emit('error', new Error('spawn ENOENT'));
      expect(await pending).toMatchObject({ ok: false, reason: expect.stringContaining('failed to start') });
      expect(child.kill).not.toHaveBeenCalled();
    } finally { loader.configureIsolationSandboxForTests(null); }
  });

  it.each(['timeout', 'abort', 'overflow'])('isolated provider %s retains refusal status without signaling a failed spawn', async trigger => {
    const loader = await import('../../../src/gates/providers/loader.ts');
    const { readFile } = await import('node:fs/promises');
    const bundleRoot = path.resolve('test/fixtures/gates-example-extension');
    const manifest = JSON.parse(await readFile(path.join(bundleRoot, 'manifest.json'), 'utf8'));
    const review = JSON.parse(await readFile(path.join(bundleRoot, 'gate-providers/example-review.json'), 'utf8'));
    loader.configureIsolationSandboxForTests({ bwrapPath: process.execPath });
    // Only the prerequisite sandbox capability observation is synthetic. The
    // real provider loader, digest/allowlist checks and rejection path run.
    mockSpawnSync.mockImplementation((_binary, _args, options) => ({ status: 0,
      stdout: JSON.stringify({ env: {}, visible: [], ns: Object.fromEntries(JSON.parse(options.input).namespaces.map(name => [name, 'fixture-private-namespace'])) }),
    }));
    vi.useFakeTimers();
    const child = fixture();
    const abort = new AbortController();
    try {
      const pending = loader.loadGateBundleProviders(bundleRoot, manifest, { allowBundleProviders: true,
        allowlist: [{ bundleId: manifest.id, providerId: manifest.gateProviders[0].id, ...review }],
        timeoutMs: 10, maxOutputBytes: 1, signal: abort.signal,
      });
      const checked = expect(pending).rejects.toMatchObject({ code: trigger === 'timeout' ? 'timeout' : trigger === 'abort' ? 'cancelled' : 'invalid-module' });
      expect(child.listenerCount('error')).toBeGreaterThan(0);
      if (trigger === 'timeout') await vi.advanceTimersByTimeAsync(10);
      else if (trigger === 'abort') abort.abort();
      else child.stdout.emit('data', Buffer.from('too much output'));
      await checked;
      expect(child.kill).not.toHaveBeenCalled();
    } finally { loader.configureIsolationSandboxForTests(null); mockSpawnSync.mockReset(); }
  });

  it('context validation timeout refuses signaling and reports a failed fixture run', async () => {
    const { main } = await import('../../../tools/validation/claude-context-repro.mjs');
    const directory = await root();
    const child = fixture();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const pending = main(['--skip-copy', '--workdir', directory, '--claude-bin', '/missing', '--timeout-ms', '10']);
    await vi.waitFor(() => expect(child.listenerCount('error')).toBeGreaterThan(0));
    await new Promise(resolve => setTimeout(resolve, 20));
    child.emit('close', -2);
    expect(await pending).toBe(1);
    expect(child.kill).not.toHaveBeenCalled();
  });
});

it('channel command timeout refuses TERM and KILL and retains its failed update status', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'signal-channel-')); roots.push(directory);
  vi.stubEnv('AIWG_CONFIG', directory);
  vi.stubEnv('AIWG_GIT_TIMEOUT_MS', '10');
  await writeFile(path.join(directory, 'channel.json'), JSON.stringify({ channel: 'edge', edgePath: directory }));
  const { updateEdge } = await import('../../../src/channel/manager.mjs');
  const child = failedChild();
  mockSpawn.mockReturnValue(child);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {});
  vi.useFakeTimers();
  const pending = updateEdge();
  await vi.waitFor(() => expect(child.listenerCount('error')).toBeGreaterThan(0));
  await vi.advanceTimersByTimeAsync(5010);
  await pending;
  expect(exit).toHaveBeenCalledWith(1);
  expect(child.kill).not.toHaveBeenCalled();
});

it('keeps the native ChildProcess kill boundary confined to the shared guard throughout src and tools', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const bypasses = [];
  // PTYs and the launcher/client facade methods are different APIs. Every
  // ChildProcess call, including standalone executable tools, shares the guard.
  const otherApis = new Set(['process', 'this._pty', 'session.pty', 's.pty', 'this', 'this.sessionLauncher']);
  for (const directory of ['src', 'tools']) {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(?:ts|mjs)$/.test(entry.name) || /\.test\./.test(entry.name)) continue;
      const filename = path.join(entry.parentPath, entry.name);
      if (path.resolve(filename) === path.resolve('src/process/signal-child.mjs')) continue;
      const source = await readFile(filename, 'utf8');
      for (const match of source.matchAll(/([\w.]+)(?:\?\.|\.)kill\s*\(/g)) {
        if (!otherApis.has(match[1])) bypasses.push(`${filename}: ${match[0]}`);
      }
    }
  }
  expect(bypasses).toEqual([]);
});

it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('import lease refuses malformed owner PID %s before its liveness probe', async pid => {
  const { hostname } = await import('node:os');
  const { mkdir, readFile } = await import('node:fs/promises');
  const { acquireImportLease, importLeasePath } = await import('../../../src/sessions/import-lease.ts');
  const directory = await mkdtemp(path.join(tmpdir(), 'signal-lease-')); roots.push(directory);
  const database = path.join(directory, 'catalog.sqlite');
  const lock = importLeasePath(database);
  await mkdir(lock);
  const bytes = JSON.stringify({ contractVersion: '1.0.0', runId: 'malformed', pid, host: hostname(),
    startedAt: '2000-01-01T00:00:00.000Z', heartbeatAt: '2000-01-01T00:00:00.000Z' });
  await writeFile(path.join(lock, 'owner.json'), bytes);
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  await expect(acquireImportLease(database, 'contender', { waitMs: 0, staleMs: 1 })).rejects.toMatchObject({ code: 'IMPORT_LOCKED' });
  expect(kill).not.toHaveBeenCalled();
  expect(await readFile(path.join(lock, 'owner.json'), 'utf8')).toBe(bytes);
});
