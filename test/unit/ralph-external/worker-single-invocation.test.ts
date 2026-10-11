import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, symlink, readdir, open, rename } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { resolveWorkerInvocation, revalidateWorkerInvocationPlan } from '../../../src/serve/worker-invocation.js';
import { SessionLauncher, signalOwnedWorker, publishWorkerRecord, beneath, realBeneath } from '../../../tools/ralph-external/session-launcher.mjs';
import { parseWorkerLaunchArgs, workerExitCode } from '../../../tools/ralph-external/index.mjs';
import { sampleWorkerIdentity } from '../../../tools/ralph-external/process-monitor.mjs';
import { stopWorkerUnit, detectWorkerIsolation, launchIsolatedWorker } from '../../../tools/ralph-external/lib/worker-isolation.mjs';
import { qualificationDigest } from '../../../src/models/qualification-digest.mjs';
import { workerStdinDocument } from '../../../src/serve/worker-stdin-frame.mjs';
import { CodexAdapter } from '../../../tools/ralph-external/lib/codex-adapter.mjs';
import { FactoryDirectAdapter } from '../../../tools/ralph-external/lib/factory-adapter.mjs';
import { PiDirectAdapter } from '../../../tools/ralph-external/lib/pi-adapter.mjs';
import { GrokBuildAdapter } from '../../../tools/ralph-external/lib/grok-build-adapter.mjs';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture({ stdin = 'closed', scenario = 'success', stdoutOnly = false, forgeRealExitCode, semanticHealth = false, artifacts = [] }: any = {}) {
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
  const f = workerResolutionFixture();
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-one-shot-')); roots.push(root);
  const runDir = path.join(root, 'run');
  const cwd = path.join(root, 'work tree'); await mkdir(cwd);
  const brief = path.join(root, 'brief.json');
  const prompt = `secret-prompt '" 雪\n$(touch ${root}/injected) --leading`;
  await writeFile(brief, prompt);
  const final = path.join(root, 'final.json');
  const configPath = path.join(root, 'fake.json');
  const recordPath = path.join(cwd, 'record.json');
  await writeFile(configPath, JSON.stringify({ scenario, recordPath, ...(stdoutOnly ? { outputFlags: [] } : {}),
    ...(scenario === 'forge-exit' ? { forgeRunDir: runDir, forgeRealExitCode: forgeRealExitCode ?? 7 } : {}) }));
  vi.stubEnv('AIWG_FAKE_WORKER_CONFIG', configPath);
  vi.stubEnv('AIWG_SYNTHETIC_ALLOWED', 'secret-environment-value');
  vi.stubEnv('AIWG_UNRELATED_SECRET', 'unrelated-value');
  const adapter = f.snapshot.registry.providers.codex.workerAdapter!;
  const profile = adapter.invocationProfiles!['fixture-shell'];
  profile.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG', 'AIWG_SYNTHETIC_ALLOWED'];
  profile.health = { version: 1, handshake: semanticHealth ? 'semantic' : 'process-only', outputFraming: 'jsonl', signalParser: 'fixture:jsonl',
    sessionLogLocator: null, progressEvidence: semanticHealth ? ['item.completed'] : [], stopEvidence: 'fixture:wait-only', fixtureRef: 'fixture:one-shot', qualifiedAt: f.request.now,
    statusOperation: null, cancelOperation: null };
  f.snapshot.config.parallelism!.health = { hardTimeoutSeconds: 1, terminateGraceSeconds: 1 };
  const driver: any = { qualification: { adapter, adapterId: adapter.id, cliVersion: '1.0.0',
    boundary: { kind: 'os', identity: 'fixture:boundary', digest: qualificationDigest('boundary'), controls: ['sandbox'] } },
    buildInvocation: async (input: any) => ({ argv: [process.execPath, path.resolve('test/fixtures/ralph-worker-cli.mjs'),
      '--model', input.selected.model, '--final-output', input.finalPath,
      ...(artifacts.length ? ['--generated-artifact', '${artifact:patch}'] : []), '--', prompt], stdin,
      ...(artifacts.length ? { artifacts } : {}),
      envNames: profile.envAllowlist }),
    extractFinal: (text: string) => { try { const rows = text.trim().split('\n').map(line => JSON.parse(line));
      return rows.length === 1 && rows[0].type === 'result' ? rows[0].result : null; } catch { return null; } },
  };
  const drivers = { codex: driver };
  f.snapshot.installations.codex.boundary = driver.qualification.boundary;
  const request: any = { role: 'coding', task: 'implementation', group: 'workers', brief, workdir: cwd, final_output: final };
  const plan = await resolveWorkerInvocation(f.snapshot, request, drivers, f.request.now);
  expect(plan.invocation, JSON.stringify({ diagnostics: plan.diagnostics, exclusions: plan.exclusions })).toBeDefined();
  const invocationPath = path.join(root, 'plan.json'); await writeFile(invocationPath, JSON.stringify(plan));
  const launchSpy = vi.fn();
  const options: any = { invocationPath, runDir, inputs: { snapshot: f.snapshot, drivers }, now: f.request.now,
    checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
    isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true };
  const launcher = new SessionLauncher();
  const launch = (extra: any = {}) => launcher.launchWorker({ ...options, ...extra });
  return { ...f, root, cwd, brief, prompt, final, recordPath, runDir, invocationPath, plan, drivers, options, launcher, launch, launchSpy };
}

describe('T-OG-15/20 one attached invocation without managed state', () => {
  it('projects semantic health from the adapter while consuming strict finals separately', async () => {
    const f = await fixture({ semanticHealth: true });
    const adapter = new CodexAdapter();
    (f.drivers.codex as any).createHealthObserver = (options: any) => adapter.createHealthObserver(options);
    (f.drivers.codex as any).parseWorkerFinal = (output: any, options: any) => adapter.parseWorkerFinal(output, options);
    const claims = { version: 1, status: 'completed', summary: 'synthetic only', claims: [], artifacts: [], checks: [], limitations: [] };
    (f.drivers.codex as any).extractFinal = () => claims;
    const events = [
      { type: 'thread.started', thread_id: 'synthetic-thread' }, { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'synthetic-step', type: 'agent_message', text: 'synthetic' } }, { type: 'turn.completed' },
    ].map(item => JSON.stringify(item)).join('\n') + '\n';
    const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.unref = () => {};
    child.pid = 2147483646;
    const launched = vi.fn(); const started = vi.fn(); f.launcher.on('launched', launched); f.launcher.on('started', started);
    const result = await f.launch({ launchIsolated: () => {
      queueMicrotask(() => {
        writeFileSync(f.final, JSON.stringify(claims));
        child.stdout.end(events); child.stderr.end(); child.emit('exit', 0, null); child.emit('close', 0, null);
      });
      return { mode: 'systemd-unit', child, unit: 'aiwg-worker-synthetic-health' };
    }, isolationStatus: () => ({ active: false, execMainCode: 1, execMainStatus: 0, result: 'success' }) });
    expect(result.health).toMatchObject({ handshake: 'semantic', state: 'completed', termination: 'confirmed', lastProgressAt: expect.any(String) });
    expect(result.healthEvidence.events.map((item: any) => item.kind)).toContain('progress');
    expect(launched).toHaveBeenCalledOnce(); expect(started).toHaveBeenCalledOnce();
    expect(started.mock.calls[0]).toEqual(launched.mock.calls[0]);
    expect(JSON.parse(await readFile(path.join(f.runDir, 'health.json'), 'utf8')).origin).toBe('observer');
    expect(JSON.parse(await readFile(path.join(f.runDir, 'exit.json'), 'utf8')).health.state).toBe('completed');
  });

  it('legacy extraction cannot erase duplicate final keys and authorize completed health', async () => {
    const f = await fixture({ stdoutOnly: true });
    const adapter = new CodexAdapter();
    (f.drivers.codex as any).parseWorkerFinal = (bytes: any, options: any) => adapter.parseWorkerFinal(bytes, options);
    const forged = '{"type":"result","result":{"version":1,"status":"failed","status":"completed","summary":"synthetic","claims":[],"artifacts":[],"checks":[],"limitations":[]}}\n';
    const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.unref = () => {}; child.pid = 2147483646;
    const result = await f.launch({ launchIsolated: () => {
      queueMicrotask(() => { child.stdout.end(forged); child.stderr.end(); child.emit('exit', 0, null); child.emit('close', 0, null); });
      return { mode: 'systemd-unit', child, unit: 'aiwg-worker-synthetic-duplicate' };
    }, isolationStatus: () => ({ active: false, execMainCode: 1, execMainStatus: 0, result: 'success' }) });
    expect(result.exitCode).toBe(0);
    expect(result.health.state).not.toBe('completed');
    expect(await readFile(path.join(f.runDir, 'stdout.events.jsonl'), 'utf8')).toBe(forged);
  });

  // #2995: Factory (droid) keeps its final answer inside its own
  // `stream-json` stdout stream and writes no separate final-output file
  // (finalStat.size === 0, the realistic case for this profile). This
  // drives the SAME production hook (worker-installation.mjs ~l.733,
  // session-launcher.mjs ~l.459-480) through the real `FactoryDirectAdapter`
  // (round 2: `parseOutput` on this `-direct` subclass IS the strict
  // `parseDirectFinal` rule, not the legacy regex `FactoryAdapter` keeps —
  // the legacy regex fails closed on a realistic multi-event stream before
  // `parseWorkerFinal` is ever reached, which is why this stream below is a
  // REALISTIC multi-event one: assistant/tool_call/tool_result lines before
  // the terminal `result` line), with no hand-fed finalValid.
  function factoryStream(resultText: string) {
    return [
      { type: 'assistant', session_id: 'synthetic-session', text: 'synthetic reply' },
      { type: 'tool_call', session_id: 'synthetic-session', id: 'fixture-call-1', name: 'Read' },
      { type: 'tool_result', session_id: 'synthetic-session', tool_call_id: 'fixture-call-1' },
      { type: 'result', session_id: 'synthetic-session', subtype: 'success', is_error: false, duration_ms: 1, num_turns: 1, result: resultText },
    ].map(event => JSON.stringify(event)).join('\n') + '\n';
  }
  async function launchFactoryStream(f: any, stream: string, unit: string) {
    const adapter = new FactoryDirectAdapter();
    (f.drivers.codex as any).extractFinal = (text: string) => adapter.parseOutput(text);
    (f.drivers.codex as any).parseWorkerFinal = (output: any, options: any) => adapter.parseWorkerFinal(output, options);
    const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.unref = () => {};
    child.pid = 2147483646;
    return f.launch({ launchIsolated: () => {
      queueMicrotask(() => {
        writeFileSync(f.final, ''); // no separate final file: finalStat.size === 0
        child.stdout.end(stream); child.stderr.end(); child.emit('exit', 0, null); child.emit('close', 0, null);
      });
      return { mode: 'systemd-unit', child, unit };
    }, isolationStatus: () => ({ active: false, execMainCode: 1, execMainStatus: 0, result: 'success' }) });
  }

  it('a realistic multi-event Factory stream reaches completed health through the real -direct adapter hook, with no hand-fed finalValid', async () => {
    const f = await fixture();
    const claims = { version: 1, status: 'completed', summary: 'synthetic only', claims: [], artifacts: [], checks: [], limitations: [] };
    const result = await launchFactoryStream(f, factoryStream(JSON.stringify(claims)), 'aiwg-worker-synthetic-factory');
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.health).toMatchObject({ state: 'completed', termination: 'confirmed' });
    expect(JSON.parse(await readFile(path.join(f.runDir, 'final-evidence.json'), 'utf8')))
      .toMatchObject({ source: 'adapter-extraction', terminalSuccess: true });
    expect(JSON.parse(await readFile(path.join(f.runDir, 'exit.json'), 'utf8')).health.state).toBe('completed');
  });

  it('the same realistic Factory stream with a plain-text (non-claims) final never reaches completed health', async () => {
    const f = await fixture();
    const result = await launchFactoryStream(f, factoryStream('synthetic plain reply, not a claims document'), 'aiwg-worker-synthetic-factory-plain');
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.health.state).not.toBe('completed');
  });

  it('a realistic multi-event Factory stream with no terminal result (failed run) never reaches completed health', async () => {
    const f = await fixture();
    const stream = [
      { type: 'assistant', session_id: 'synthetic-session', text: 'synthetic reply' },
      { type: 'tool_call', session_id: 'synthetic-session', id: 'fixture-call-1', name: 'Read' },
      { type: 'error', session_id: 'synthetic-session', message: 'synthetic failure' },
    ].map(event => JSON.stringify(event)).join('\n') + '\n';
    const result = await launchFactoryStream(f, stream, 'aiwg-worker-synthetic-factory-failed');
    expect(result.exitCode, JSON.stringify(result)).toBe(0); // exit zero is exactly the trap this guards against
    expect(result.health.state).not.toBe('completed');
  });

  // #2995 round 2: the same proof for Pi, whose legacy `parseOutput` is
  // settlement-only (no answer requirement) and whose `-direct` subclass
  // (`PiDirectAdapter`) requires a settled, non-empty answer instead.
  function piStream(resultText: string | null) {
    const events: unknown[] = [{ type: 'session', id: 'synthetic-session' }, { type: 'agent_start' }];
    if (resultText !== null) {
      events.push({ type: 'agent_end', willRetry: false, messages: [{ role: 'assistant', content: [{ type: 'text', text: resultText }] }] });
    } else {
      events.push({ type: 'agent_end', willRetry: false, messages: [{ role: 'assistant', stopReason: 'error' }] });
    }
    events.push({ type: 'agent_settled' });
    return events.map(event => JSON.stringify(event)).join('\n') + '\n';
  }
  async function launchPiStream(f: any, stream: string, unit: string) {
    const adapter = new PiDirectAdapter();
    (f.drivers.codex as any).extractFinal = (text: string) => adapter.parseOutput(text);
    (f.drivers.codex as any).parseWorkerFinal = (output: any, options: any) => adapter.parseWorkerFinal(output, options);
    const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.unref = () => {};
    child.pid = 2147483646;
    return f.launch({ launchIsolated: () => {
      queueMicrotask(() => {
        writeFileSync(f.final, '');
        child.stdout.end(stream); child.stderr.end(); child.emit('exit', 0, null); child.emit('close', 0, null);
      });
      return { mode: 'systemd-unit', child, unit };
    }, isolationStatus: () => ({ active: false, execMainCode: 1, execMainStatus: 0, result: 'success' }) });
  }

  it('a realistic multi-event Pi stream reaches completed health through the real -direct adapter hook, with no hand-fed finalValid', async () => {
    const f = await fixture();
    const claims = { version: 1, status: 'completed', summary: 'synthetic only', claims: [], artifacts: [], checks: [], limitations: [] };
    const result = await launchPiStream(f, piStream(JSON.stringify(claims)), 'aiwg-worker-synthetic-pi');
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.health).toMatchObject({ state: 'completed', termination: 'confirmed' });
    expect(JSON.parse(await readFile(path.join(f.runDir, 'final-evidence.json'), 'utf8')))
      .toMatchObject({ source: 'adapter-extraction', terminalSuccess: true });
  });

  it('the same realistic Pi stream with a plain-text (non-claims) final never reaches completed health', async () => {
    const f = await fixture();
    const result = await launchPiStream(f, piStream('synthetic plain reply, not a claims document'), 'aiwg-worker-synthetic-pi-plain');
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.health.state).not.toBe('completed');
  });

  it('a realistic multi-event Pi stream that fails to settle never reaches completed health', async () => {
    const f = await fixture();
    const result = await launchPiStream(f, piStream(null), 'aiwg-worker-synthetic-pi-failed');
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.health.state).not.toBe('completed');
  });

  // #2995 round 3: Grok Build's parseOutput was already the strict
  // ACP-derived direct rule (`parseDirectFinal`); this proves the newly
  // added `parseWorkerFinal` override is what lets a realistic multi-event
  // ACP stream (tool_call/tool_call_update/text, then the terminal `end`)
  // reach `completed`, through the real adapter and no hand-fed finalValid.
  function grokStream(resultText: string | null) {
    const events: unknown[] = [
      { type: 'tool_call', toolCallId: 'call_1', title: 'Read', kind: 'read', status: 'in_progress' },
      { type: 'tool_call_update', toolCallId: 'call_1', status: 'completed' },
    ];
    if (resultText !== null) events.push({ type: 'text', data: resultText });
    events.push({ type: 'end', stopReason: 'end_turn', sessionId: 'synthetic-session' });
    return events.map(event => JSON.stringify(event)).join('\n') + '\n';
  }
  async function launchGrokStream(f: any, stream: string, unit: string) {
    const adapter = new GrokBuildAdapter();
    (f.drivers.codex as any).extractFinal = (text: string) => adapter.parseOutput(text);
    (f.drivers.codex as any).parseWorkerFinal = (output: any, options: any) => adapter.parseWorkerFinal(output, options);
    const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.unref = () => {};
    child.pid = 2147483646;
    return f.launch({ launchIsolated: () => {
      queueMicrotask(() => {
        writeFileSync(f.final, '');
        child.stdout.end(stream); child.stderr.end(); child.emit('exit', 0, null); child.emit('close', 0, null);
      });
      return { mode: 'systemd-unit', child, unit };
    }, isolationStatus: () => ({ active: false, execMainCode: 1, execMainStatus: 0, result: 'success' }) });
  }

  it('a realistic multi-event Grok Build stream reaches completed health through the real adapter hook, with no hand-fed finalValid', async () => {
    const f = await fixture();
    const claims = { version: 1, status: 'completed', summary: 'synthetic only', claims: [], artifacts: [], checks: [], limitations: [] };
    const result = await launchGrokStream(f, grokStream(JSON.stringify(claims)), 'aiwg-worker-synthetic-grok');
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.health).toMatchObject({ state: 'completed', termination: 'confirmed' });
    expect(JSON.parse(await readFile(path.join(f.runDir, 'final-evidence.json'), 'utf8')))
      .toMatchObject({ source: 'adapter-extraction', terminalSuccess: true });
  });

  it('the same realistic Grok Build stream with a plain-text (non-claims) final never reaches completed health', async () => {
    const f = await fixture();
    const result = await launchGrokStream(f, grokStream('synthetic plain reply, not a claims document'), 'aiwg-worker-synthetic-grok-plain');
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.health.state).not.toBe('completed');
  });

  it.each(['closed', 'brief-text', 'brief-json'])('preserves exact argv, %s EOF, private metadata and captures', async stdin => {
    const f = await fixture({ stdin });
    const result = await f.launch();
    expect(result).toMatchObject({ exitCode: 0, signal: null, workerTermination: 'confirmed',
      termination: 'uncertain', descendants: 'unknown', captureCoverage: 'complete', isolation: 'degraded' });
    const record = JSON.parse(await readFile(f.recordPath, 'utf8'));
    expect(record.argv).toEqual(f.plan.invocation!.argv!.slice(2));
    expect(record.cwd).toBe(f.cwd);
    // brief-json delivers the conductor-framed params document, never the raw brief (#2911).
    expect(record.stdin).toBe(stdin === 'closed' ? '' : stdin === 'brief-json'
      ? workerStdinDocument({ brief: f.prompt, model: f.plan.invocation!.selected.model, cwd: f.cwd }) : f.prompt);
    expect(record.envNames).toContain('AIWG_SYNTHETIC_ALLOWED');
    expect(record.envNames).not.toContain('AIWG_UNRELATED_SECRET');
    expect(record.argv).not.toContain('--dangerously-skip-permissions');
    expect((await lstat(f.runDir)).mode & 0o777).toBe(0o700);
    for (const filename of await readdir(f.runDir)) expect((await lstat(path.join(f.runDir, filename))).mode & 0o777).toBe(0o600);
    const metadata = await readFile(path.join(f.runDir, 'invocation.json'), 'utf8');
    expect(metadata).not.toContain(f.prompt);
    expect(metadata).not.toContain('secret-environment-value');
    expect(metadata).not.toContain('unrelated-value');
    const invocation = JSON.parse(metadata);
    expect(invocation.envNames).toEqual(f.plan.invocation!.envNames);
    expect(invocation.prompt.path).toBe(f.brief);
    expect(invocation.invocationDigest).toBe(qualificationDigest(f.plan.invocation));
    expect(invocation.planDigest).toBe(qualificationDigest(f.plan));
    const processRecord = JSON.parse(await readFile(path.join(f.runDir, 'process.json'), 'utf8'));
    expect(processRecord.supervisor.pid).toBe(process.pid);
    expect(processRecord.worker.pid).not.toBe(process.pid);
    expect(processRecord.worker.pgid).toBe(processRecord.worker.pid);
    expect(processRecord.worker).toMatchObject({ uid: process.getuid!(), bootId: expect.any(String), startTicks: expect.any(String), parentPid: processRecord.nativeSupervisor.pid });
    expect(await readFile(path.join(f.runDir, 'stdout.events.jsonl'), 'utf8')).toBe(await readFile(f.plan.invocation!.stdoutPath!, 'utf8'));
    expect(JSON.parse(await readFile(path.join(f.runDir, 'final-evidence.json'), 'utf8'))).toMatchObject({ invocationId: result.invocationId, candidate: true, verified: false });
    expect(await readdir(f.root)).not.toContain('.aiwg');
    await expect(lstat(path.join(f.root, 'injected'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(f.launch()).rejects.toThrow(/fresh|empty/);
  });

  it('extracts stdout-only final separately while retaining the original event stream', async () => {
    const f = await fixture({ stdoutOnly: true });
    const result = await f.launch();
    expect(result.exitCode, await readFile(f.plan.invocation!.stderrPath!, 'utf8')).toBe(0);
    expect(result.errorCode).toBeNull();
    const final = JSON.parse(await readFile(f.final, 'utf8'));
    expect(final).toMatchObject({ invocationId: result.invocationId, source: 'adapter-extraction', verified: false });
    const stdout = await readFile(f.plan.invocation!.stdoutPath!, 'utf8');
    expect(JSON.parse(stdout).type).toBe('result');
    expect(stdout).not.toContain('adapter-extraction');
  });

  it('preserves a synthetic event stream and separates a digest-associated final candidate', async () => {
    const f = await fixture({ stdoutOnly: true });
    const claims = { version: 1, status: 'completed', summary: 'synthetic only', claims: [], artifacts: [], checks: [], limitations: [] };
    const events = `${JSON.stringify({ type: 'result', result: claims })}\n`;
    const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.unref = () => {};
    child.pid = 2147483646;
    const result = await f.launch({ launchIsolated: (options: any) => {
      queueMicrotask(() => {
        writeFileSync(path.join(f.runDir, 'worker-exit.json'), JSON.stringify({ invocationId: options.name, exitCode: 0, signal: null }), { mode: 0o600 });
        child.stdout.end(events); child.stderr.end('synthetic diagnostic\n'); child.emit('exit', 0, null); child.emit('close', 0, null);
      });
      return { mode: 'systemd-unit', child, unit: 'aiwg-worker-synthetic' };
    }, isolationStatus: () => ({ active: false, execMainCode: 1, execMainStatus: 0, result: 'success' }) });
    expect(result).toMatchObject({ exitCode: 0, termination: 'confirmed', descendants: 'stopped', errorCode: null, captureCoverage: 'complete' });
    expect(await readFile(f.plan.invocation!.stdoutPath!, 'utf8')).toBe(events);
    expect(await readFile(path.join(f.runDir, 'stdout.events.jsonl'), 'utf8')).toBe(events);
    expect(await readFile(path.join(f.runDir, 'stderr.log'), 'utf8')).toBe('synthetic diagnostic\n');
    expect(JSON.parse(await readFile(f.final, 'utf8'))).toMatchObject({ invocationId: result.invocationId, result: claims });
  });

  it.each(['missing-final', 'truncated-final', 'double-final', 'exit-zero-error'])('retains wait exit but rejects %s final evidence', async scenario => {
    const f = await fixture({ scenario });
    const result = await f.launch();
    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBe('FINAL_OUTPUT_INVALID');
    expect(result.termination).toBe('uncertain');
    const exit = JSON.parse(await readFile(path.join(f.runDir, 'exit.json'), 'utf8'));
    expect(exit.errorCode).toBe('FINAL_OUTPUT_INVALID');
  });

  it('times out an EOF-blocked worker, records signal instead of a fake zero and clears timers', async () => {
    const f = await fixture({ scenario: 'hang' });
    const kill = vi.spyOn(process, 'kill');
    const result = await f.launch();
    expect(result).toMatchObject({ timedOut: true, exitCode: null, termination: 'uncertain' });
    expect(['SIGTERM', 'SIGKILL']).toContain(result.signal);
    const signals = kill.mock.calls.filter(call => call[1] !== 0);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every(call => call[0] < 0 && call[0] !== -process.pid)).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(kill.mock.calls.filter(call => call[1] !== 0)).toEqual(signals);
    expect(f.launcher.getPid()).toBeNull();
  });

  it('records ENOENT with unknown code and no child identity', async () => {
    const f = await fixture();
    const result = await f.launch({ launchIsolated: () => ({ mode: 'degraded', child: spawn('/nonexistent-aiwg-fixture', [], { stdio: ['ignore', 'pipe', 'pipe'] }) }) });
    expect(result).toMatchObject({ exitCode: null, signal: null, errorCode: 'ENOENT', termination: 'confirmed' });
    expect(JSON.parse(await readFile(path.join(f.runDir, 'process.json'), 'utf8')).worker).toBeNull();
  });

  it('BLOCKER regression (#2895): a worker-forged worker-exit.json cannot report a real failure as success', async () => {
    // The worker and the trusted transport share a UID with no filesystem
    // boundary between them. This worker reads invocation.json (already on
    // disk, same UID, readable) to learn the real invocationId, plants its
    // own worker-exit.json claiming exitCode:0, then really exits non-zero.
    const f = await fixture({ scenario: 'forge-exit', forgeRealExitCode: 7 });
    const result = await f.launch();
    // The forged record is readable back (same mechanism as before the fix)
    // but must only ever surface as an unauthenticated, informational hint.
    expect(result.workerReportedExit).toMatchObject({ exitCode: 0, signal: null, errorCode: null });
    // The forged claim of a clean exit must never become the reported
    // exitCode: 0 is exactly the value an attacker wants read back as
    // success, so it must never appear here.
    expect(result.exitCode).not.toBe(0);
    expect(typeof result.exitCode).toBe('number');
    // index.mjs's CLI mapping must likewise never fold this into exit 0.
    const cliExitCode = result.errorCode || result.timedOut ? 1
      : result.termination === 'confirmed' ? (result.exitCode === 0 ? 0 : 1)
      : 2;
    expect(cliExitCode).not.toBe(0);
  });

  it('MAJOR regression (#2895): a failing intermediate publish does not block the final exit.json', async () => {
    const f = await fixture();
    let processJsonAttempts = 0;
    const names: string[] = [];
    // The first process.json write happens before spawn and must still hard-
    // fail the launch if it fails (unchanged, covered elsewhere). The SECOND
    // one happens post-spawn, from observeIdentity()'s own recordProcess()
    // poll — a transient failure there is exactly the "intermediate publish"
    // case: under the pre-fix chaining, this single rejection would poison
    // the shared `publishing` chain and silently stop every later write,
    // including the final exit.json, from ever being attempted.
    const result = await f.launch({ publishRecord: async (runDir: string, name: string, value: unknown, inspect: any) => {
      names.push(name);
      if (name === 'process.json') {
        processJsonAttempts += 1;
        if (processJsonAttempts === 2) throw new Error('synthetic intermediate publish failure');
      }
      return publishWorkerRecord(runDir, name, value, inspect);
    } });
    expect(processJsonAttempts).toBeGreaterThanOrEqual(2);
    const exitRaw = await readFile(path.join(f.runDir, 'exit.json'), 'utf8');
    const exit = JSON.parse(exitRaw);
    expect(exit.invocationId).toBe(result.invocationId);
    expect(names).toContain('exit.json');
  });
});

describe('T-OG-23 pre-spawn boundaries and ownership', () => {
  it.each(['argv', 'brief', 'expired', 'digests'])('rejects changed %s before any launch', async kind => {
    const f = await fixture();
    if (kind === 'argv') f.plan.invocation!.argv!.push('--dangerously-skip-permissions');
    if (kind === 'brief') await writeFile(f.brief, 'changed');
    if (kind === 'expired') f.plan.invocation!.expiresAt = '2001-01-01T00:00:00Z';
    if (kind === 'digests') f.plan.digests.configDigest = qualificationDigest('changed');
    await writeFile(f.invocationPath, JSON.stringify(f.plan));
    await expect(f.launch({ launchIsolated: f.launchSpy })).rejects.toThrow();
    expect(f.launchSpy).not.toHaveBeenCalled();
    await expect(lstat(f.runDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reloads policy and expiry immediately before spawn', async () => {
    const f = await fixture();
    let loads = 0;
    await expect(f.launch({ loadInputs: async () => {
      if (++loads === 2) f.snapshot.config.parallelism!.worker_dispatch = false;
      return { snapshot: f.snapshot, drivers: f.drivers };
    }, launchIsolated: f.launchSpy })).rejects.toThrow(/differs|plan|disabled/);
    expect(loads).toBe(2);
    expect(f.launchSpy).not.toHaveBeenCalled();
  });

  it.each(['EROFS', 'EPERM'])('capture open %s prevents helper spawn and publishes no fake success', async code => {
    const f = await fixture();
    await expect(f.launch({ openCapture: async () => { throw Object.assign(new Error('synthetic capture open'), { code }); },
      launchIsolated: f.launchSpy })).rejects.toMatchObject({ code });
    expect(f.launchSpy).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(path.join(f.runDir, 'exit.json'), 'utf8'))).toMatchObject({ exitCode: null, descendants: 'not-started', errorCode: code });
  });

  it('pins output ancestors while opening and refuses a replaced symlink before spawn', async () => {
    const f = await fixture();
    const outputDir = path.join(f.root, 'output'); await mkdir(outputDir);
    const outside = path.join(f.root, 'outside'); await mkdir(outside);
    const request = { ...f.plan.request!, final_output: path.join(outputDir, 'final.json') };
    const plan = await resolveWorkerInvocation(f.snapshot, request, f.drivers, f.request.now);
    await writeFile(f.invocationPath, JSON.stringify(plan));
    let replaced = false;
    await expect(f.launch({ launchIsolated: f.launchSpy, openCapture: async (target: string, flags: number, mode: number) => {
      if (!replaced) {
        replaced = true;
        await rename(outputDir, `${outputDir}-original`);
        await symlink(outside, outputDir);
      }
      return open(target, flags, mode);
    } })).rejects.toThrow();
    expect(f.launchSpy).not.toHaveBeenCalled();
    expect(await readdir(outside)).toEqual([]);
    expect(await readdir(`${outputDir}-original`)).toHaveLength(1);
  });

  it.each(['run-symlink', 'prompt-symlink', 'traversal', 'writable-root', 'prior-final'])('rejects %s before spawn', async kind => {
    const f = await fixture();
    let extra: any = {};
    if (kind === 'run-symlink') await symlink(f.cwd, f.runDir);
    if (kind === 'prompt-symlink') { await rm(f.brief); await symlink(f.invocationPath, f.brief); }
    if (kind === 'traversal') extra.runDir = `${f.root}/work tree/../run`;
    if (kind === 'writable-root') extra.runDir = path.join(f.cwd, 'run');
    if (kind === 'prior-final') await writeFile(f.final, 'prior final');
    await expect(f.launch({ ...extra, launchIsolated: f.launchSpy })).rejects.toThrow();
    expect(f.launchSpy).not.toHaveBeenCalled();
  });

  it('refuses an unavailable boundary without explicit degraded selection and resource denial', async () => {
    const f = await fixture();
    await expect(f.launch({ allowDegraded: false, launchIsolated: f.launchSpy })).rejects.toThrow(/allow-degraded/);
    await expect(f.launch({ checkDispatch: () => ({ enabled: true, ok: false }), launchIsolated: f.launchSpy })).rejects.toThrow(/gate/);
    expect(f.launchSpy).not.toHaveBeenCalled();
  });

  it.each(['pid-reuse', 'pgid-reuse', 'conductor', 'unowned', 'unknown'])('never signals %s', kind => {
    const own = sampleWorkerIdentity(process.pid)!;
    const identity: any = { ...own, pid: 54321, pgid: 54321 };
    const actual = { ...identity };
    if (kind === 'pid-reuse') actual.startTicks = `${own.startTicks}9`;
    if (kind === 'pgid-reuse') actual.pgid = 123;
    if (kind === 'conductor') { identity.pgid = own.pgid; identity.pid = own.pgid; Object.assign(actual, identity); }
    if (kind === 'unowned') identity.uid += 1;
    const kill = vi.fn();
    expect(signalOwnedWorker(kind === 'unknown' ? null : identity, 'SIGKILL', {
      sample: () => actual, group: () => [actual], kill, supervisor: own,
    })).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it('adopts only explicit partial manual records and supports no-scratch context with unknowns', async () => {
    const f = await fixture();
    await mkdir(f.runDir, { mode: 0o700 });
    await writeFile(path.join(f.runDir, 'process.json'), JSON.stringify({ worker: { pid: process.pid }, exitCode: 0 }), { mode: 0o600 });
    const record = await f.launcher.adoptWorker({ runDir: f.runDir });
    expect(record).toMatchObject({ origin: 'manual', worker: { pid: process.pid, pgid: null, startTicks: null },
      exitCode: null, termination: 'uncertain', ownership: 'unknown' });
    expect(record.unavailable).toContain('confirmed-stop');
    const context = await f.launcher.adoptWorker({ worker: { pid: process.pid } });
    expect(context).toMatchObject({ runDir: null, coverage: 'conductor-context-only', ownership: 'unknown' });
    expect(context.observedWorker.pid).toBe(process.pid);
    const plan = f.plan;
    await expect(revalidateWorkerInvocationPlan(plan, f.snapshot, f.drivers, '2001-01-01T00:00:00Z')).rejects.toThrow();
  });

  it('rejects legacy bypass/loop flags in the one-shot parser', () => {
    const args = ['--launch-worker', '--invocation', '/plan.json', '--run-dir', '/run'];
    expect(parseWorkerLaunchArgs([...args, '--allow-degraded-worker'])).toMatchObject({ allowDegraded: true });
    for (const flag of ['--resume', '--provider', '--budget', '--dangerously-skip-permissions', '--launch-worker']) {
      expect(() => parseWorkerLaunchArgs([...args, flag])).toThrow();
    }
  });

  it('T-OG-14 rejects unsupported platforms before helper spawn', async () => {
    const f = await fixture();
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      await expect(f.launch({ launchIsolated: f.launchSpy })).rejects.toThrow(/qualified|plan|platform/);
      expect(f.launchSpy).not.toHaveBeenCalled();
    } finally { Object.defineProperty(process, 'platform', descriptor); }
  });
});

describe('MINOR regression (#2895): beneath() resolves symlinks, not just lexical prefixes', () => {
  it('a symlinked root and its real target are recognized as the same location', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-beneath-')); roots.push(root);
    const real = path.join(root, 'real'); await mkdir(real);
    const link = path.join(root, 'link'); await symlink(real, link);
    const nested = path.join(real, 'nested');
    // Lexically "link" and "real/nested" share no textual prefix at all, so
    // the lexical-only check this replaces would (unsafely) say "not
    // beneath" even though the symlink resolves to the exact same directory.
    expect(beneath(link, nested)).toBe(false);
    expect(await realBeneath(link, nested)).toBe(true);
    // And the reverse direction: a target reached only through the symlink
    // must also resolve as beneath the real root.
    const throughLink = path.join(link, 'nested');
    expect(beneath(real, throughLink)).toBe(false);
    expect(await realBeneath(real, throughLink)).toBe(true);
    // A genuinely unrelated directory stays not-beneath either way.
    const unrelated = path.join(root, 'elsewhere'); await mkdir(unrelated);
    expect(await realBeneath(link, unrelated)).toBe(false);
  });

  it('end-to-end: a symlinked worker-writable root cannot hide the run directory inside it', async () => {
    const f = await fixture();
    const real = path.join(f.root, 'real-writable'); await mkdir(real);
    const link = path.join(f.root, 'writable-link'); await symlink(real, link);
    (f.drivers as any).codex.qualification.installation = { workerWritableRoots: [link] };
    const runDir = path.join(real, 'nested-run');
    await expect(f.launch({ runDir, launchIsolated: f.launchSpy })).rejects.toThrow(/worker-writable/);
    expect(f.launchSpy).not.toHaveBeenCalled();
  });
});

describe('MAJOR regression (#2895): systemd-unit mode has real stop authority', () => {
  it('stops the unit via systemctl on hard timeout; confirmation comes from unit state, not the stop request', async ctx => {
    if (detectWorkerIsolation().mode !== 'systemd-unit') { ctx.skip(); return; }
    const { spawnSync } = await import('node:child_process');
    const f = await fixture({ scenario: 'hang' });
    const stopSpy = vi.fn((unit: string) => stopWorkerUnit(unit));
    try {
      const result = await f.launch({ isolation: { mode: 'systemd-unit', reason: 'live probe' }, stopUnit: stopSpy });
      expect(stopSpy).toHaveBeenCalledTimes(1);
      expect(result.isolation).toBe('systemd-unit');
      expect(result.timedOut).toBe(true);
      // Stop authority here is `systemctl --user stop`, not a best-effort
      // PID/PGID signal against an identity that may still be unresolved.
      // Confirmation still comes only from the unit's own retained state
      // (checked via getWorkerIsolationStatus inside finish()); issuing the
      // stop request is not itself proof of termination.
      expect(['confirmed', 'uncertain']).toContain(result.termination);
      if (result.termination === 'confirmed') expect(result.descendants).toBe('stopped');
    } finally {
      const unit = stopSpy.mock.calls[0]?.[0];
      if (unit) {
        spawnSync('systemctl', ['--user', 'stop', unit], { timeout: 10000 });
        spawnSync('systemctl', ['--user', 'reset-failed', unit], { timeout: 10000 });
      }
    }
  }, 20000);
});

describe('#2895 round 2, item 2: workerExitCode precedence — uncertainty dominates', () => {
  it.each([
    { label: 'timeout-uncertain', result: { termination: 'uncertain', timedOut: true, errorCode: null, exitCode: null }, expected: 2 },
    { label: 'invalid-final-uncertain', result: { termination: 'uncertain', timedOut: false, errorCode: 'FINAL_OUTPUT_INVALID', exitCode: 0 }, expected: 2 },
    { label: 'confirmed non-zero', result: { termination: 'confirmed', timedOut: false, errorCode: null, exitCode: 7 }, expected: 1 },
    { label: 'confirmed zero', result: { termination: 'confirmed', timedOut: false, errorCode: null, exitCode: 0 }, expected: 0 },
    { label: 'degraded clean-looking', result: { termination: 'uncertain', timedOut: false, errorCode: null, exitCode: 0 }, expected: 2 },
    { label: 'confirmed with stale errorCode', result: { termination: 'confirmed', timedOut: false, errorCode: 'FINAL_OUTPUT_INVALID', exitCode: 0 }, expected: 1 },
  ])('$label maps to exit code $expected', ({ result, expected }) => {
    expect(workerExitCode(result as any)).toBe(expected);
  });
});

describe('#2895 round 2, item 3: the final exit.json publish is always attempted', () => {
  it('a failing FINAL recordProcess() still results in a published exit.json', async () => {
    const f = await fixture();
    let processJsonAttempts = 0;
    const result = await f.launch({
      // Bypass the attached transport wrapper so there are exactly three
      // deterministic process.json writes: the pre-spawn write, the single
      // post-spawn observeIdentity() write (no transport to poll for), and
      // the FINAL write from finish(). Failing exactly that third call
      // reproduces "the final recordProcess() call fails" without racing
      // transport identity-resolution polling.
      launchIsolated: (opts: any) => (launchIsolatedWorker as any)({ ...opts, attached: false }),
      publishRecord: async (runDir: string, name: string, value: unknown, inspect: any) => {
        if (name === 'process.json') {
          processJsonAttempts += 1;
          if (processJsonAttempts === 3) throw new Error('synthetic final recordProcess failure');
        }
        return publishWorkerRecord(runDir, name, value, inspect);
      },
    });
    expect(processJsonAttempts).toBe(3);
    // Before the fix, recordProcess() and publish('exit.json', ...) were
    // chained in one try block, so this thrown failure skipped exit.json
    // entirely -- this read would reject ENOENT.
    const exit = JSON.parse(await readFile(path.join(f.runDir, 'exit.json'), 'utf8'));
    expect(exit.invocationId).toBe(result.invocationId);
    expect(exit.termination).toBe('uncertain');
    expect(exit.errorCode).toBe('METADATA_WRITE');
  });
});

describe('#2895 round 2, item 4: a planted worker-exit.json cannot crash the transport into reporting the wrong exit code', () => {
  it('the reported exit code is the real worker exit, and the collision is a recorded anomaly, not a crash', async () => {
    const f = await fixture({ scenario: 'forge-exit', forgeRealExitCode: 42 });
    const result = await f.launch();
    // The forged worker-exit.json (planted by the worker itself, claiming a
    // clean exit) is still readable back as an unauthenticated hint.
    expect(result.workerReportedExit).toMatchObject({ exitCode: 0, signal: null, errorCode: null });
    // Before the fix, the trusted transport's own attempt to write the real
    // worker-exit.json after the forged file already existed threw
    // uncaught inside the `exit` handler, crashing the transport itself
    // before it ever reached `process.exitCode = code`. Node's default
    // exit code for an uncaught exception is 1 -- a different wrong value
    // than 42, silently losing the real exit code rather than merely
    // "not reporting 0".
    expect(result.exitCode).toBe(42);
    const anomaly = JSON.parse(await readFile(path.join(f.runDir, 'worker-exit.json.transport-anomaly.json'), 'utf8'));
    expect(anomaly.filename).toBe('worker-exit.json');
    expect(anomaly.invocationId).toBe(result.invocationId);
  });
});

describe('#2895 round 2, item 1: a forged identity record cannot authorize a signal against an unrelated process', () => {
  it('no signal reaches the unrelated process, and identity resolution stays uncertain', async () => {
    const f = await fixture({ scenario: 'hang' });
    // Two independent, unrelated real processes, both owned by this test's
    // UID. `transportStandIn` stands in for the launcher's own trusted
    // transport child (`nativeSupervisor`); `victim` is the unrelated
    // same-UID process a forged worker-identity.json will name as the
    // "worker". Neither is an ancestor of the other -- only this test
    // process is their common parent -- so a correct kernel ancestry walk
    // from `victim` must never resolve to `transportStandIn`.
    const transportStandIn = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    const victim = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    const kill = vi.spyOn(process, 'kill');
    try {
      // Attach both 'spawn' listeners before awaiting either: the event can
      // fire as soon as the next tick, so awaiting the first process's
      // promise before even constructing the second one risks missing an
      // already-fired, one-shot 'spawn' event on the second process.
      await Promise.all([
        new Promise(resolve => transportStandIn.once('spawn', resolve)),
        new Promise(resolve => victim.once('spawn', resolve)),
      ]);
      const victimIdentity = sampleWorkerIdentity(victim.pid)!;
      const supervisorIdentity = sampleWorkerIdentity(transportStandIn.pid)!;
      const result = await f.launch({ launchIsolated: (opts: any) => {
        const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.unref = () => {};
        child.pid = transportStandIn.pid;
        // Forge worker-identity.json naming the unrelated victim as the
        // "worker", with a supervisor record that matches the real
        // transportStandIn exactly (same-UID worker can read /proc for
        // both and copy the fields verbatim).
        writeFileSync(path.join(opts.runDir, 'worker-identity.json'), JSON.stringify({
          invocationId: opts.name, supervisor: supervisorIdentity, worker: victimIdentity,
        }), { mode: 0o600 });
        return { mode: 'degraded', transportSupervisor: true, child };
      } });
      // The forged record resamples successfully (the victim is a real,
      // unchanged process) but fails kernel containment: no signal must
      // ever reach it.
      const signalsToVictim = kill.mock.calls.filter(call => call[0] === victim.pid || call[0] === -victim.pid);
      expect(signalsToVictim).toHaveLength(0);
      expect(victim.exitCode).toBeNull();
      expect(victim.signalCode).toBeNull();
      expect(result.termination).toBe('uncertain');
    } finally {
      for (const proc of [transportStandIn, victim]) { try { proc.kill('SIGKILL'); } catch { /* best effort */ } }
    }
  }, 15000);
});

describe('T-OG-15 execution-time artifacts and adapter stdin (#3002/#2998)', () => {
  it('records substituted launch argv and artifact byte digests without contents', async () => {
    const content = 'private patch 雪';
    const f = await fixture({ artifacts: [{ name: 'patch', content }] });
    const launchIsolated = vi.fn((_options: any) => { throw new Error('stop after recording launch argv'); });
    await expect(f.launch({ launchIsolated })).rejects.toThrow('stop after recording launch argv');
    const launched = launchIsolated.mock.calls[0][0] as any;
    const argv = [launched.command, ...launched.args];
    expect(argv).toContain(path.join(f.runDir, 'artifact-patch'));
    const raw = await readFile(path.join(f.runDir, 'invocation.json'), 'utf8');
    const record = JSON.parse(raw);
    const { createHash } = await import('node:crypto');
    const bytesDigest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
    expect(record.argv).toEqual(argv.map((token, i) => i === 0 ? token : `<argument:${bytesDigest(token)}>`));
    expect(record.commandDisplay).toBe(record.argv.map((token: string) => JSON.stringify(token)).join(' '));
    expect(record.executedArgvDigest).toBe(qualificationDigest(argv));
    expect(record.placeholderArgvDigest).toBe(qualificationDigest(f.plan.invocation!.argv));
    expect(record.argvDigest).toBe(record.placeholderArgvDigest);
    expect(record.artifacts).toEqual([{ name: 'patch', byteLength: Buffer.byteLength(content), sha256: bytesDigest(content) }]);
    expect(raw).not.toContain(content);
    expect(raw).not.toContain(f.prompt);
    expect(raw).not.toContain('secret-environment-value');
    expect((await readdir(f.runDir)).filter(name => name.startsWith('artifact-'))).toEqual([]);
  });
  it.each(['stdoutPath', 'stderrPath', 'finalPath'])('refuses %s in the reserved artifact namespace before writes or spawn', async field => {
    const f = await fixture({ artifacts: [{ name: 'patch', content: 'private patch' }] });
    await mkdir(f.runDir, { mode: 0o700 });
    const qualified = structuredClone(f.plan.invocation!);
    qualified[field as 'stdoutPath' | 'stderrPath' | 'finalPath'] = path.join(f.runDir, 'artifact-patch');
    const owner = await import('../../../src/serve/worker-invocation.js');
    vi.spyOn(owner, 'revalidateWorkerInvocationPlan').mockResolvedValue(qualified);
    const launchIsolated = vi.fn();
    await expect(f.launch({ launchIsolated })).rejects.toThrow(/distinct.*artifact/i);
    expect(launchIsolated).not.toHaveBeenCalled();
    expect(await readdir(f.runDir)).toEqual([]);
  });
  it.each(['', Buffer.alloc(0), new Uint8Array(0)])('rejects an empty adapter frame %j', async frame => {
    const { workerStdinBytes } = await import('../../../src/serve/worker-stdin-frame.mjs');
    expect(() => workerStdinBytes({ stdin: 'adapter-frame' }, 'brief', { buildWorkerStdinFrame: () => frame })).toThrow(/empty/i);
  });
  async function privateRun() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-artifacts-')); roots.push(root);
    const runDir = path.join(root, 'run'); await mkdir(runDir, { mode: 0o700 });
    return { root, runDir };
  }
  const declaration = (name = 'patch') => ({ argv: [process.execPath, `\${artifact:${name}}`],
    artifacts: [{ name, content: 'synthetic patch', location: 'run-directory' }] });
  it('creates distinct private paths concurrently, mode 0600, then cleans both', async () => {
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    const { materializeWorkerArtifacts } = await import('../../../tools/ralph-external/session-launcher.mjs');
    const a = await privateRun(), b = await privateRun();
    const [first, second] = await Promise.all([materializeWorkerArtifacts(declaration(), a.runDir), materializeWorkerArtifacts(declaration(), b.runDir)]);
    expect(first.argv[1]).not.toBe(second.argv[1]);
    for (const result of [first, second]) {
      expect((await lstat(result.argv[1])).mode & 0o777).toBe(0o600);
      expect(await readFile(result.argv[1], 'utf8')).toBe('synthetic patch');
      await result.cleanup();
      expect(await readdir(path.dirname(result.argv[1]))).toEqual([]);
    }
  });
  it.each(['existing', 'symlink'])('refuses a %s path and cleans files created before the refusal', async scenario => {
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    const { materializeWorkerArtifacts } = await import('../../../tools/ralph-external/session-launcher.mjs');
    const { root, runDir } = await privateRun();
    const blocked = path.join(runDir, 'artifact-blocked');
    const target = path.join(root, 'target'); await writeFile(target, 'original');
    if (scenario === 'symlink') await symlink(target, blocked); else await writeFile(blocked, 'original');
    const invocation = declaration(); invocation.artifacts.push({ name: 'blocked', content: 'overwrite', location: 'run-directory' });
    await expect(materializeWorkerArtifacts(invocation, runDir)).rejects.toThrow();
    expect(await readdir(runDir)).toEqual(['artifact-blocked']);
    expect(await readFile(target, 'utf8')).toBe('original');
    expect(await readFile(blocked, 'utf8')).toBe('original');
  });
  it.each(['../escape', '.hidden', 'a/b', 'a\\b', 'name\n', '', 'x'.repeat(65)])('refuses artifact name %j', async name => {
    const { materializeWorkerArtifacts } = await import('../../../tools/ralph-external/session-launcher.mjs');
    await expect(materializeWorkerArtifacts(declaration(name), '/nonexistent')).rejects.toThrow();
  });
  it('bounds count, per-file and total UTF-8 bytes, rejects unknown locations/placeholders before writes', async () => {
    const { materializeWorkerArtifacts } = await import('../../../tools/ralph-external/session-launcher.mjs');
    const cases = [
      { ...declaration(), artifacts: Array.from({ length: 17 }, (_, i) => ({ name: `a${i}`, content: '' })) },
      { ...declaration(), artifacts: [{ name: 'patch', content: '雪'.repeat(400000) }] },
      { ...declaration(), artifacts: Array.from({ length: 5 }, (_, i) => ({ name: `a${i}`, content: 'x'.repeat(1048576) })) },
      { ...declaration(), artifacts: [{ name: 'patch', content: '', location: 'workspace' }] },
      { ...declaration(), artifacts: [] },
    ];
    for (const invocation of cases) await expect(materializeWorkerArtifacts(invocation, '/nonexistent')).rejects.toThrow();
  });
  it('bounds exact adapter bytes and rejects missing/nonbyte framers and unknown stdin', async () => {
    const { workerStdinBytes } = await import('../../../src/serve/worker-stdin-frame.mjs');
    const invocation = { stdin: 'adapter-frame' as const };
    expect(() => workerStdinBytes(invocation, 'brief')).toThrow(/framer/);
    expect(() => workerStdinBytes(invocation, 'brief', { buildWorkerStdinFrame: () => ({}) as any })).toThrow(/bytes/);
    expect(() => workerStdinBytes(invocation, 'brief', { buildWorkerStdinFrame: () => Buffer.alloc(1048577) })).toThrow(/bound/);
    const bytes = Buffer.from([0, 1, 255, 10]);
    expect(workerStdinBytes(invocation, 'brief', { buildWorkerStdinFrame: () => bytes })).toEqual(bytes);
    expect(() => workerStdinBytes({ stdin: 'other' } as any, 'brief')).toThrow(/Unsupported/);
  });
  it.each(['spawn', 'capture', 'gate'])('cleans launcher-written artifacts when %s preparation fails', async stage => {
    const f = await fixture({ artifacts: [{ name: 'patch', content: 'synthetic patch' }] });
    let calls = 0;
    const extra = stage === 'spawn' ? { launchIsolated: () => { throw new Error('synthetic spawn refusal'); } }
      : stage === 'capture' ? { openCapture: () => { throw new Error('synthetic capture refusal'); } }
      : { checkDispatch: () => ({ ok: calls++ === 0, enabled: true, failures: [] }) };
    await expect(f.launch(extra)).rejects.toThrow();
    expect((await readdir(f.runDir)).filter(name => name.startsWith('artifact-'))).toEqual([]);
  });
  it('the attached launcher delivers the adapter NDJSON frame and closes stdin', async () => {
    const f = await fixture({ stdin: 'brief-text' });
    const { AntigravityAdapter } = await import('../../../tools/ralph-external/lib/antigravity-adapter.mjs');
    const agy = new AntigravityAdapter();
    f.drivers.codex.buildWorkerStdinFrame = (brief: any) => agy.buildWorkerStdinFrame(brief);
    f.drivers.codex.qualification.stdinFramerBinding = { storePath: path.join(f.root, 'worker-installations.json'),
      storeDigest: qualificationDigest('synthetic store binding') };
    const build = f.drivers.codex.buildInvocation;
    f.drivers.codex.buildInvocation = async (input: any) => ({ ...await build(input), stdin: 'adapter-frame' });
    const plan = await resolveWorkerInvocation(f.snapshot, f.plan.request!, f.drivers, f.request.now);
    expect(plan.invocation).toBeDefined();
    await writeFile(f.invocationPath, JSON.stringify(plan));
    await f.launch();
    expect(JSON.parse(await readFile(f.recordPath, 'utf8')).stdin).toBe(agy.buildWorkerStdinFrame(f.prompt).toString());
  });
});
