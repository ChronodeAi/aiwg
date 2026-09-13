// Contract tests for the production Pi headless adapter and the launcher path
// that consumes it. Everything runs against the committed offline stub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PiAdapter } from '../../../tools/ralph-external/lib/pi-adapter.mjs';
import { createProvider, ensureProvidersRegistered, listProviders } from '../../../tools/ralph-external/lib/provider-adapter.mjs';
import { SessionLauncher } from '../../../tools/ralph-external/session-launcher.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const stub = resolve(here, '../../fixtures/providers/pi/pi-stub.mjs');
const manifest = JSON.parse(readFileSync(resolve(here, '../../fixtures/providers/pi/manifest.json'), 'utf8'));
chmodSync(stub, 0o755);

const jsonl = (...events) => events.map(event => `${JSON.stringify(event)}\n`).join('');
function withEnv(patch, run) {
  const saved = {};
  for (const [key, value] of Object.entries(patch)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const restore = () => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
  try { const result = run(); return result?.finally ? result.finally(restore) : (restore(), result); } catch (error) { restore(); throw error; }
}
function scratch(prefix) { const dir = mkdtempSync(join(tmpdir(), prefix)); return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }; }
async function launch(scenario, options = {}) {
  const { dir, cleanup } = scratch('pi-adapter-launch-');
  const receipt = join(dir, 'receipt.json');
  const launcher = new SessionLauncher();
  launcher.setProviderAdapter(new PiAdapter());
  let started = null; let child = null;
  launcher.on('started', info => { started = info; child = launcher.currentProcess; });
  const env = { AIWG_PI_BIN: stub, AIWG_PI_STUB_SCENARIO: scenario || undefined, AIWG_PI_STUB_RECEIPT: receipt,
    PI_CODING_AGENT_SESSION_DIR: options.sessionDir, CI: undefined, NO_COLOR: undefined };
  const result = await withEnv(env, () => launcher.launch({
    prompt: 'bounded fixture task', sessionId: 'aiwg-fixture-session', workingDir: dir,
    stdoutPath: join(dir, 'stdout.log'), stderrPath: join(dir, 'stderr.log'), ...options,
  }));
  const read = name => readFileSync(join(dir, name), 'utf8');
  const receiptData = existsSync(receipt) ? JSON.parse(readFileSync(receipt, 'utf8')) : null;
  return { result, started, child, launcher, stdout: read('stdout.log'), stderr: read('stderr.log'), receipt: receiptData, dir, cleanup };
}

test('Pi adapter builds a headless JSON invocation with tool restrictions and pass-through flags', () => {
  const adapter = new PiAdapter();
  const warnings = []; const warn = console.warn; console.warn = message => warnings.push(message);
  try {
    const args = adapter.buildSessionArgs({ prompt: 'do the task', model: 'openrouter/fixture', thinking: 'high', sessionId: 'sess-1',
      tools: ['read', 'grep'], systemPrompt: 'stay bounded', budget: 5, maxTurns: 3, mcpConfig: { servers: {} } });
    assert.deepEqual(args, ['--mode', 'json', '--no-approve', '--model', 'openrouter/fixture', '--thinking', 'high',
      '--session', 'sess-1', '--tools', 'read,grep', '--append-system-prompt', 'stay bounded', 'do the task']);
    assert.equal(args.filter(arg => /budget|max-turns|mcp/.test(arg)).length, 0, 'unsupported flags never reach the CLI');
    assert.deepEqual(warnings.map(message => message.match(/Warning: (.+?) not supported/)[1]), ['Budget control', 'Max turns', 'MCP configuration']);
    assert.deepEqual(adapter.buildSessionArgs({ prompt: 'p', tools: [] }), ['--mode', 'json', '--no-approve', 'p'], 'empty tool list adds no restriction flag');
    assert.deepEqual(adapter.buildAnalysisArgs({ prompt: 'analyze' }), adapter.buildSessionArgs({ prompt: 'analyze' }));
  } finally { console.warn = warn; }
  assert.deepEqual(adapter.getEnvOverrides(), { CI: 'true', NO_COLOR: '1' });
  assert.equal(adapter.mapModel('anything/goes'), 'anything/goes');
  assert.deepEqual(JSON.parse(adapter.getAbortInput()), { type: 'abort', id: 'aiwg-abort' });
  assert.ok(adapter.getAbortInput().endsWith('\n'), 'abort command is a complete JSONL frame');
  assert.deepEqual(adapter.getCapabilities(), { streamJson: true, sessionResume: true, budgetControl: false,
    systemPrompt: true, agentMode: false, mcpConfig: false, maxTurns: false, rpcAbort: true });
});

test('Pi adapter parses strict JSONL, reports settlement, and fails closed on malformed framing', () => {
  const adapter = new PiAdapter();
  const settled = jsonl({ type: 'session', version: 3 }, { type: 'agent_start' }, { type: 'agent_end', willRetry: false }, { type: 'agent_settled' });
  assert.deepEqual(adapter.parseOutput(settled), { events: [{ type: 'session', version: 3 }, { type: 'agent_start' }, { type: 'agent_end', willRetry: false }, { type: 'agent_settled' }], settled: true });
  assert.equal(adapter.parseOutput(jsonl({ type: 'agent_start' }, { type: 'agent_end', willRetry: true })).settled, false, 'agent_end without agent_settled is not settlement');
  assert.equal(adapter.parseOutput(settled.replace(/\n/g, '\r\n')).settled, true, 'CRLF-terminated records are tolerated');
  assert.equal(adapter.parseOutput(`${settled}\n\n`).events.length, 4, 'blank lines are skipped, not parsed');
  assert.equal(adapter.parseOutput(`${settled}not json\n`), null, 'one malformed line rejects the whole stream');
  assert.equal(adapter.parseOutput(settled.slice(0, -3)), null, 'a truncated final record rejects the stream');
  assert.equal(adapter.parseOutput(`${settled}{"type":"agent_settled"} trailing`), null, 'trailing bytes after a record are rejected');
  assert.equal(adapter.parseOutput(''), null);
  assert.equal(adapter.parseOutput('plain print-mode text\n'), null, 'print-mode text is never accepted as JSON events');
});

test('Pi adapter resolves transcripts inside the isolated session directory only when told to', () => {
  const adapter = new PiAdapter();
  assert.equal(adapter.getTranscriptPath(undefined), null);
  assert.equal(adapter.getTranscriptPath('/explicit/path/run.jsonl'), '/explicit/path/run.jsonl');
  assert.equal(adapter.getTranscriptPath('nested/id'), 'nested/id');
  withEnv({ PI_CODING_AGENT_SESSION_DIR: '/isolated/sessions' }, () => {
    assert.equal(adapter.getTranscriptPath('abc'), join('/isolated/sessions', 'abc.jsonl'));
  });
  withEnv({ PI_CODING_AGENT_SESSION_DIR: undefined }, () => {
    assert.match(adapter.getTranscriptPath('abc'), /[\\/]\.pi[\\/]agent[\\/]sessions[\\/]abc\.jsonl$/);
  });
  assert.equal(manifest.sessionEnvironment, 'PI_CODING_AGENT_SESSION_DIR', 'adapter honors the fixture-pinned isolation variable');
});

test('Pi adapter availability fails closed on incompatible Node or a failing pi --version', async () => {
  const adapter = new PiAdapter();
  const { dir, cleanup } = scratch('pi-adapter-node-');
  try {
    const fakeNode = join(dir, 'fake-node');
    writeFileSync(fakeNode, `#!/bin/sh\nprintf '20.19.0\\n'\n`); chmodSync(fakeNode, 0o755);
    const execPath = process.execPath;
    Object.defineProperty(process, 'execPath', { value: fakeNode, configurable: true, writable: true });
    try { assert.equal(await withEnv({ AIWG_PI_BIN: stub }, () => adapter.isAvailable()), false, 'Node < 22.19 is rejected before pi is probed'); }
    finally { Object.defineProperty(process, 'execPath', { value: execPath, configurable: true, writable: true }); }
    assert.equal(await withEnv({ AIWG_PI_BIN: stub, AIWG_PI_STUB_SCENARIO: 'version-failure' }, () => adapter.isAvailable()), false, 'non-zero pi --version is unavailable');
    assert.equal(await withEnv({ AIWG_PI_BIN: join(dir, 'missing-pi') }, () => adapter.isAvailable()), false, 'missing binary is unavailable');
    assert.equal(await withEnv({ AIWG_PI_BIN: stub }, () => adapter.isAvailable()), true);
    assert.equal(await withEnv({ AIWG_PI_BIN: stub }, () => adapter.getVersion()), manifest.upstreamVersion, 'observed version matches the pinned fixture contract');
    assert.equal(await withEnv({ AIWG_PI_BIN: stub, AIWG_PI_STUB_SCENARIO: 'version-failure' }, () => adapter.getVersion()), null);
  } finally { cleanup(); }
});

test('Pi adapter is registered under the external agent-loop provider registry', async () => {
  await ensureProvidersRegistered();
  assert.ok(listProviders().includes('pi'));
  assert.ok(createProvider('PI') instanceof PiAdapter);
  assert.equal(withEnv({ AIWG_PI_BIN: undefined }, () => new PiAdapter().getBinary()), 'pi');
  assert.equal(withEnv({ AIWG_PI_BIN: '/opt/pi/bin/pi' }, () => new PiAdapter().getBinary()), '/opt/pi/bin/pi');
});

test('launcher settles a Pi session with restricted tools, strict stdout, and a silent stderr', async () => {
  const run = await launch('', { tools: ['read', 'grep'], model: 'openrouter/fixture', systemPrompt: 'bounded' });
  try {
    assert.equal(run.result.exitCode, 0);
    assert.equal(run.result.timedOut, false);
    assert.deepEqual(run.started.args.slice(0, 3), ['--mode', 'json', '--no-approve']);
    assert.deepEqual(run.receipt.argv, run.started.args, 'the child received exactly the adapter-built argv');
    assert.equal(run.receipt.argv[run.receipt.argv.indexOf('--tools') + 1], 'read,grep');
    assert.deepEqual(run.receipt.env, { CI: 'true', NO_COLOR: '1' }, 'headless env overrides reach the child');
    const parsed = new PiAdapter().parseOutput(run.stdout);
    assert.equal(parsed.settled, true);
    assert.deepEqual(parsed.events.map(event => event.type), ['session', 'agent_start', 'agent_end', 'agent_settled']);
    assert.equal(run.stderr, '', 'no diagnostics leak into stderr on the healthy path');
    assert.equal(run.result.stdoutBuffer, run.stdout);
    assert.equal(run.launcher.currentProcess, null);
  } finally { run.cleanup(); }
});

test('launcher keeps Pi diagnostics on stderr and rejects malformed stdout framing', async () => {
  const run = await launch('malformed');
  try {
    assert.equal(run.result.exitCode, 0, 'a zero exit does not imply usable output');
    assert.match(run.stderr, /stderr channel only/);
    assert.match(run.stdout, /not-json diagnostic/);
    assert.equal(new PiAdapter().parseOutput(run.stdout), null, 'adapter fails closed instead of guessing at settlement');
    assert.doesNotMatch(run.stderr, /agent_settled/, 'events never cross into stderr');
  } finally { run.cleanup(); }
});

test('launcher propagates the abort command on timeout and the child exits without a signal', async () => {
  const run = await launch('hang-until-abort', { timeoutMs: 150 });
  try {
    assert.equal(run.result.timedOut, true);
    assert.deepEqual(run.receipt.abort, { type: 'abort', id: 'aiwg-abort' }, 'the adapter abort frame reached the child stdin');
    assert.equal(run.child.signalCode, null, 'child honored the abort and exited on its own');
    assert.equal(run.result.exitCode, 0);
    assert.ok(run.result.duration < 2000, `graceful abort completed before SIGTERM escalation (${run.result.duration}ms)`);
    const parsed = new PiAdapter().parseOutput(run.stdout);
    assert.equal(parsed.settled, true);
    assert.deepEqual(parsed.events.at(-2), { type: 'agent_end', willRetry: false, stopReason: 'aborted' });
    assert.match(run.stderr, /stderr channel only/);
    assert.doesNotMatch(run.stdout, /stderr channel/, 'stderr diagnostics never enter the JSONL stream');
    assert.equal(run.launcher.currentProcess, null);
  } finally { run.cleanup(); }
});

test('launcher tears down a Pi child that ignores the abort command', { timeout: 15000 }, async () => {
  const run = await launch('ignore-stdin', { timeoutMs: 100 });
  try {
    assert.equal(run.result.timedOut, true);
    assert.equal(run.receipt.abort, undefined);
    assert.equal(run.child.signalCode, 'SIGTERM', 'bounded escalation terminated the unresponsive child');
    assert.equal(run.child.exitCode, null);
    assert.equal(run.result.exitCode, 1, 'signal exits surface as failure');
    assert.ok(run.result.duration >= 2000 && run.result.duration < 7000, `SIGTERM after the 2s abort grace window (${run.result.duration}ms)`);
    assert.equal(new PiAdapter().parseOutput(run.stdout).settled, false);
    assert.equal(run.launcher.currentProcess, null);
  } finally { run.cleanup(); }
});

test('launcher captures the Pi transcript from the isolated session directory', async () => {
  const { dir: sessionDir, cleanup } = scratch('pi-adapter-sessions-');
  const outputDir = join(sessionDir, 'output');
  mkdirSync(outputDir, { recursive: true });
  const transcript = readFileSync(resolve(here, '../../fixtures/sessions/pi/valid.jsonl'), 'utf8');
  writeFileSync(join(sessionDir, 'aiwg-fixture-session.jsonl'), transcript);
  const run = await launch('', { sessionDir, outputDir });
  try {
    assert.equal(run.result.transcriptPath, join(outputDir, 'session-transcript.jsonl'));
    assert.equal(readFileSync(run.result.transcriptPath, 'utf8'), transcript);
    assert.equal(run.result.exitCode, 0);
  } finally { run.cleanup(); cleanup(); }
});
