/**
 * OMP stream accounting and the live per-session spend cap.
 *
 * Synthetic `omp --mode json` streams only: no model call, no network. The
 * live-cap cases run a fake `omp` (a small Node script) selected through
 * AIWG_OMP_BIN.
 *
 * Run with: node --test tools/ralph-external/session-launcher-omp.test.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionLauncher } from './session-launcher.mjs';
import { ProviderAdapter } from './lib/provider-adapter.mjs';
import { OmpAdapter } from './lib/omp-adapter.mjs';

/** OMP `Usage` record, cost in USD. Omit `cost` to model an unpriced backend. */
function usage({ input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost } = {}) {
  const record = { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite };
  if (cost !== undefined) record.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost };
  return record;
}

const user = { role: 'user', content: [{ type: 'text', text: 'Run echo hi, then reply done.' }] };
const callBash = {
  role: 'assistant',
  content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'echo hi' } }],
  usage: usage({ input: 4, output: 75, cacheWrite: 1000, cost: 0.5 }),
  stopReason: 'toolUse',
};
const toolResult = {
  role: 'toolResult',
  toolCallId: 'call-1',
  toolName: 'bash',
  content: [{ type: 'text', text: 'hi\n' }],
  // Not real OMP output: proves a non-assistant usage field is never read.
  usage: usage({ input: 999, cost: 9 }),
  isError: false,
};
const done = {
  role: 'assistant',
  content: [{ type: 'text', text: 'done' }],
  usage: usage({ input: 2, output: 3, cacheRead: 1000, cacheWrite: 85, cost: 0.25 }),
  stopReason: 'stop',
};

/** One bash tool call, shaped like a real `omp --mode json` run. */
const toolCallRun = [
  { type: 'session', version: 3, id: 'synthetic', cwd: '/synthetic' },
  { type: 'agent_start' },
  { type: 'turn_start' },
  { type: 'message_start', message: user },
  { type: 'message_end', message: user },
  // message_start may already carry a partial usage; only message_end counts.
  { type: 'message_start', message: { ...callBash, usage: usage({ input: 4, output: 16, cacheWrite: 1000, cost: 0.4 }) } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '' } },
  { type: 'message_end', message: callBash },
  { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: { command: 'echo hi' }, intent: 'Running echo' },
  { type: 'tool_execution_update', toolCallId: 'call-1', toolName: 'bash', args: { command: 'echo hi' }, partialResult: {} },
  { type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'bash', result: { content: [] }, isError: false },
  { type: 'message_start', message: toolResult },
  { type: 'message_end', message: toolResult },
  { type: 'turn_end', message: callBash },
  { type: 'turn_start' },
  { type: 'message_start', message: done },
  { type: 'message_end', message: done },
  { type: 'turn_end', message: done },
  { type: 'agent_end', messages: [user, callBash, toolResult, done], isTerminal: true },
];

const jsonl = events => events.map(event => JSON.stringify(event)).join('\n') + '\n';

function tempDir(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Run the real post-session parser over a synthetic OMP stream. */
async function captureOmp(t, events, adapter = new OmpAdapter()) {
  const directory = tempDir(t, 'aiwg-omp-usage-');
  const launcher = new SessionLauncher();
  launcher.setProviderAdapter(adapter);
  const errors = [];
  launcher.on('artifact-error', error => errors.push(error.message));
  const stdoutPath = join(directory, 'stdout.jsonl');
  writeFileSync(stdoutPath, jsonl(events));
  const result = {};
  await launcher._captureSessionArtifacts({ sessionId: 'synthetic', workingDir: directory, outputDir: join(directory, 'output'), stdoutPath }, result);
  assert.deepEqual(errors, []);
  const { stats } = JSON.parse(readFileSync(result.parsedEventsPath, 'utf8'));
  return { result, stats };
}

test('omp: an assistant message counts once despite turn_end and agent_end repeats', async t => {
  const { result, stats } = await captureOmp(t, toolCallRun);
  assert.equal(stats.usageEvents, 2);
  assert.equal(result.inputTokens, 4 + 2);
  assert.equal(result.outputTokens, 75 + 3);
  assert.equal(stats.cacheReadInputTokens, 1000);
  assert.equal(stats.cacheCreationInputTokens, 1000 + 85);
  assert.equal(result.totalTokens, (4 + 75 + 1000) + (2 + 3 + 1000 + 85));
  assert.ok(Math.abs(result.costUsd - 0.75) < 1e-9, `costUsd ${result.costUsd}`);
  assert.equal(result.tokenUsageObserved, true);
  assert.equal(result.costObserved, true);
});

test('omp: user and toolResult messages and every non-message_end event contribute nothing', () => {
  const adapter = new OmpAdapter();
  for (const event of [
    { type: 'message_end', message: user },
    { type: 'message_end', message: toolResult },
    { type: 'message_start', message: done },
    { type: 'turn_end', message: done },
    { type: 'agent_end', messages: [done] },
    { type: 'tool_execution_end', toolCallId: 'x', isError: false, usage: usage({ input: 1, cost: 1 }) },
    { type: 'message_update', message: done },
    { type: 'cache_warming_start', phase: 'refresh', provider: 'p', model: 'm' },
  ]) {
    const counted = adapter.extractUsage(event);
    assert.equal(counted.hasUsage, false, event.type);
    assert.equal(counted.costUsd, 0, event.type);
    assert.equal(counted.totalTokens, 0, event.type);
  }
  const counted = adapter.extractUsage({ type: 'message_end', message: done });
  assert.deepEqual(counted, {
    inputTokens: 2,
    outputTokens: 3,
    cacheCreationInputTokens: 85,
    cacheReadInputTokens: 1000,
    totalTokens: 1090,
    costUsd: 0.25,
    hasTokenField: true,
    hasCostField: true,
    hasUsage: true,
  });
});

test('omp: a billed cache_warming_end is counted; an unbilled one is not', async t => {
  const events = [
    ...toolCallRun.slice(0, -1),
    { type: 'cache_warming_start', phase: 'refresh', provider: 'anthropic', model: 'synthetic' },
    { type: 'cache_warming_end', phase: 'refresh', provider: 'anthropic', model: 'synthetic', outcome: 'hit',
      usage: usage({ input: 1, output: 1, cacheRead: 2000, cost: 0.125 }) },
    { type: 'cache_warming_start', phase: 'refresh', provider: 'anthropic', model: 'synthetic' },
    { type: 'cache_warming_end', phase: 'refresh', provider: 'anthropic', model: 'synthetic', outcome: 'error' },
    toolCallRun.at(-1),
  ];
  const { result, stats } = await captureOmp(t, events);
  assert.equal(stats.usageEvents, 3);
  assert.equal(stats.cacheReadInputTokens, 1000 + 2000);
  assert.ok(Math.abs(result.costUsd - 0.875) < 1e-9, `costUsd ${result.costUsd}`);
});

test('omp: cost is unobservable when usage has no finite cost.total', async t => {
  for (const cost of [undefined, {}, { total: null }, { total: '0.5' }, { total: Number.NaN }]) {
    const priced = { ...done, usage: { ...usage({ input: 2, output: 3 }), ...(cost === undefined ? {} : { cost }) } };
    const { result, stats } = await captureOmp(t, [{ type: 'message_end', message: priced }]);
    assert.equal(result.costObserved, false, JSON.stringify(cost));
    assert.equal(result.costUsd, 0);
    assert.equal(result.tokenUsageObserved, true);
    assert.equal(result.totalTokens, 5);
    assert.equal(stats.costFieldSeen, false);
  }
  const { result } = await captureOmp(t, [{ type: 'message_end', message: { ...done, usage: { cost: { total: 0 } } } }]);
  assert.equal(result.costObserved, true, 'an explicit zero cost is observed');
  assert.equal(result.tokenUsageObserved, false);
});

test('omp: tool calls are tool_execution_start events and failures are errors', async t => {
  const adapter = new OmpAdapter();
  assert.equal(adapter.categorizeEvent({ type: 'tool_execution_start', toolCallId: 'a' }), 'tool_call');
  assert.equal(adapter.categorizeEvent({ type: 'tool_execution_end', toolCallId: 'a', isError: true }), 'error');
  assert.equal(adapter.categorizeEvent({ type: 'tool_execution_end', toolCallId: 'a', isError: false }), 'tool_execution_end');
  assert.equal(adapter.categorizeEvent({ type: 'error', message: 'boom' }), 'error');
  assert.equal(adapter.categorizeEvent({ type: 'rpc_frame_error' }), 'error');
  assert.equal(adapter.categorizeEvent({ type: 'message_end', message: done }), 'completion');
  assert.equal(adapter.categorizeEvent({ type: 'message_end', message: user }), 'message_end');
  assert.equal(adapter.categorizeEvent({ type: 'tool_execution_update', toolCallId: 'a' }), 'tool_execution_update');
  assert.equal(adapter.categorizeEvent({}), 'unknown');

  const events = [
    ...toolCallRun.slice(0, -1),
    { type: 'tool_execution_start', toolCallId: 'call-2', toolName: 'read', args: { path: 'x' } },
    { type: 'tool_execution_end', toolCallId: 'call-2', toolName: 'read', result: { content: [] }, isError: true },
    { type: 'rpc_frame_error', message: 'synthetic' },
    toolCallRun.at(-1),
  ];
  const { result, stats } = await captureOmp(t, events);
  assert.equal(result.toolCallCount, 2);
  assert.equal(result.errorCount, 2);
  assert.equal(stats.completionCount, 2);
});

test('an adapter without usage hooks keeps the generic logic', async t => {
  class PlainAdapter extends ProviderAdapter {
    getName() { return 'plain'; }
    getCapabilities() { return { budgetControl: false }; }
  }
  const adapter = new PlainAdapter();
  assert.equal(adapter.extractUsage({}), null);
  assert.equal(adapter.categorizeEvent({}), null);
  assert.equal(adapter.reportsStreamUsage(), false);
  assert.equal(new OmpAdapter().reportsStreamUsage(), true);
  const event = { type: 'result', total_cost_usd: 0.5, usage: { input_tokens: 10, output_tokens: 5 }, tool: 'bash' };
  const { result } = await captureOmp(t, [event], adapter);
  const generic = new SessionLauncher()._extractUsageStats(event);
  assert.equal(result.costUsd, generic.costUsd);
  assert.equal(result.totalTokens, generic.totalTokens);
  assert.equal(result.toolCallCount, 1);
});

test('omp: buildSessionArgs no longer warns that budget is unsupported', t => {
  const warn = t.mock.method(console, 'warn', () => {});
  const args = new OmpAdapter().buildSessionArgs({ prompt: 'synthetic', budget: 5 });
  assert.equal(warn.mock.callCount(), 0);
  assert.equal(args.includes('5'), false);
});

test('omp: mapModel turns loop tier names into OMP roles and passes everything else through', () => {
  const adapter = new OmpAdapter();
  for (const [tier, role] of [['haiku', '@smol'], ['sonnet', '@default'], ['opus', '@slow']]) {
    assert.equal(adapter.mapModel(tier), role, tier);
    assert.equal(adapter.mapModel(tier.toUpperCase()), role, tier.toUpperCase());
    assert.equal(adapter.mapModel(tier[0].toUpperCase() + tier.slice(1)), role);
  }
  for (const model of [
    'claude-sonnet-5', 'anthropic/claude-opus-5-5', '@slow', '@task', 'sonnet:high', 'opus:xhigh',
    ' sonnet', 'sonnet-4', 'claude-haiku', 'constructor', 'toString', '',
  ]) {
    assert.equal(adapter.mapModel(model), model, JSON.stringify(model));
  }
});

test('omp: session and analysis args carry the mapped model', () => {
  const adapter = new OmpAdapter();
  const analysis = adapter.buildAnalysisArgs({ prompt: 'synthetic', model: 'sonnet' });
  assert.equal(analysis[analysis.indexOf('--model') + 1], '@default');
  const session = adapter.buildSessionArgs({ prompt: 'synthetic', model: 'Opus' });
  assert.equal(session[session.indexOf('--model') + 1], '@slow');
  const exact = adapter.buildSessionArgs({ prompt: 'synthetic', model: 'anthropic/claude-sonnet-5' });
  assert.equal(exact[exact.indexOf('--model') + 1], 'anthropic/claude-sonnet-5');
});

// ── Live per-session cap ────────────────────────────────────────────────

const FAKE_OMP = `#!${process.execPath}
import { readFileSync } from 'node:fs';
const { costs, split, holdMs } = JSON.parse(readFileSync(new URL('./fake-omp.json', import.meta.url), 'utf8'));
const write = text => new Promise(resolve => process.stdout.write(text, resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const messages = [];
await write(JSON.stringify({ type: 'agent_start' }) + '\\n');
for (const [index, cost] of costs.entries()) {
  const message = { role: 'assistant', content: [{ type: 'text', text: 'step ' + index }], stopReason: 'stop',
    usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0, totalTokens: 115,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } } };
  messages.push(message);
  const line = JSON.stringify({ type: 'message_end', message }) + '\\n';
  if (split) {
    // Deliver one event in two writes so the reader must buffer a partial line.
    await write(line.slice(0, line.length >> 1));
    await sleep(50);
    await write(line.slice(line.length >> 1));
  } else {
    await write(line);
  }
  await write(JSON.stringify({ type: 'turn_end', message }) + '\\n');
}
await sleep(holdMs);
await write(JSON.stringify({ type: 'agent_end', messages }) + '\\n');
`;

/** Launch one session against a fake omp that reports `costs` then holds. */
async function launchFakeOmp(t, { costs, split = false, holdMs, budget, adapter = new OmpAdapter() }) {
  const directory = tempDir(t, 'aiwg-omp-cap-');
  const binary = join(directory, 'fake-omp.mjs');
  writeFileSync(binary, FAKE_OMP);
  chmodSync(binary, 0o755);
  writeFileSync(join(directory, 'fake-omp.json'), JSON.stringify({ costs, split, holdMs }));
  const previous = process.env.AIWG_OMP_BIN;
  process.env.AIWG_OMP_BIN = binary;
  t.after(() => {
    if (previous === undefined) delete process.env.AIWG_OMP_BIN;
    else process.env.AIWG_OMP_BIN = previous;
  });
  const launcher = new SessionLauncher();
  launcher.setProviderAdapter(adapter);
  const exceeded = [];
  launcher.on('budget-exceeded', detail => exceeded.push(detail));
  const started = Date.now();
  const result = await launcher.launch({
    prompt: 'synthetic',
    sessionId: 'synthetic',
    budget,
    workingDir: directory,
    stdoutPath: join(directory, 'stdout.jsonl'),
    stderrPath: join(directory, 'stderr.log'),
    outputDir: join(directory, 'output'),
    timeoutMs: 60_000,
  });
  return { result, exceeded, elapsedMs: Date.now() - started };
}

test('live cap: a fake omp over its per-session budget is terminated promptly', { timeout: 30_000 }, async t => {
  // 0.4 + 0.4 + 0.4 reaches the $1 budget on the third message_end. The fake
  // would otherwise hold its process open for 30 s.
  const { result, exceeded, elapsedMs } = await launchFakeOmp(t, { costs: [0.4, 0.4, 0.4], split: true, holdMs: 30_000, budget: 1 });
  assert.equal(result.budgetExceeded, true);
  assert.equal(result.timedOut, false);
  assert.notEqual(result.exitCode, 0);
  assert.ok(elapsedMs < 15_000, `terminated after ${elapsedMs} ms`);
  assert.equal(exceeded.length, 1);
  assert.ok(Math.abs(exceeded[0].costUsd - 1.2) < 1e-9, `cap fired at $${exceeded[0].costUsd}`);
  assert.equal(exceeded[0].budgetUsd, 1);
  assert.equal(result.costObserved, true);
  assert.ok(result.costUsd >= 1);
});

test('live cap: a fake omp under its per-session budget is not terminated', { timeout: 30_000 }, async t => {
  // turn_end repeats each message's usage; counting it would reach $1.60 here.
  const { result, exceeded, elapsedMs } = await launchFakeOmp(t, { costs: [0.4, 0.4], holdMs: 300, budget: 1 });
  assert.equal(result.budgetExceeded, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 0);
  assert.ok(elapsedMs >= 300, `exited after ${elapsedMs} ms`);
  assert.deepEqual(exceeded, []);
  assert.ok(Math.abs(result.costUsd - 0.8) < 1e-9, `costUsd ${result.costUsd}`);
});

test('live cap: not armed for a provider with native budget control', { timeout: 30_000 }, async t => {
  class NativeBudgetOmp extends OmpAdapter {
    getCapabilities() { return { ...super.getCapabilities(), budgetControl: true }; }
  }
  const { result, exceeded } = await launchFakeOmp(t, { costs: [0.6, 0.6], holdMs: 100, budget: 1, adapter: new NativeBudgetOmp() });
  assert.equal(result.budgetExceeded, false);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(exceeded, []);
});
