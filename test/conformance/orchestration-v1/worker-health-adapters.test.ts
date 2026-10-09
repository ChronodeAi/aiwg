/** T-OG-03: synthetic per-provider health grammar, S1 partial coverage. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../../tools/ralph-external/lib/claude-adapter.mjs';
import { CodexAdapter } from '../../../tools/ralph-external/lib/codex-adapter.mjs';
import { MuseAdapter } from '../../../tools/ralph-external/lib/muse-adapter.mjs';
import { OpenCodeAdapter } from '../../../tools/ralph-external/lib/opencode-adapter.mjs';
import { FactoryAdapter } from '../../../tools/ralph-external/lib/factory-adapter.mjs';
import { PiAdapter } from '../../../tools/ralph-external/lib/pi-adapter.mjs';
import { OmpAdapter } from '../../../tools/ralph-external/lib/omp-adapter.mjs';
import { DeepSeekHarnessAdapter } from '../../../tools/ralph-external/lib/deepseek-harness-adapter.mjs';
import { createWorkerHealthObserver } from '../../../tools/ralph-external/lib/worker-health.mjs';

const adapters = {
  claude: new ClaudeAdapter(), codex: new CodexAdapter(), muse: new MuseAdapter(),
  opencode: new OpenCodeAdapter(), factory: new FactoryAdapter(),
  pi: new PiAdapter(), omp: new OmpAdapter(), 'deepseek-harness': new DeepSeekHarnessAdapter(),
};
const binding = { invocationId: 'fixture-invocation', sessionId: 'fixture-session', runId: 'fixture-run' };
const stdout = { kind: 'stdout', id: 'stdout', generation: 0, offset: 0 };
const fixtureRoot = path.resolve('test/fixtures/providers');

async function fixture(provider: string) {
  const root = path.join(fixtureRoot, provider, 'health');
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  const bytes = await readFile(path.join(root, manifest.fixture));
  const records = manifest.framing === 'plain' ? [bytes.toString()]
    : bytes.toString().trim().split('\n').map(line => JSON.parse(line));
  return { manifest, bytes, records };
}

function health(provider: string, handshake = 'semantic') {
  return {
    version: 1, handshake, outputFraming: 'jsonl', signalParser: `provider-${provider}-health-v1`,
    sessionLogLocator: null, progressEvidence: ['distinct-completed-step'], stopEvidence: 'owned-process-exit',
    fixtureRef: `test/fixtures/providers/${provider}/health/manifest.json`, qualifiedAt: null,
    statusOperation: null, cancelOperation: null,
  };
}

describe('T-OG-03 own event grammar and unavailable provider signals', () => {
  for (const [provider, adapter] of Object.entries(adapters)) {
    it(`${provider}: own sanitized fixture supplies only evidenced classes`, async () => {
      const { records, manifest } = await fixture(provider);
      expect(manifest.synthetic).toBe(true);
      expect(manifest.scenarioId).toMatch(/^T-OG-03-/);
      expect(records.map(event => adapter.observeHealthEvent(event, stdout, binding)?.kind ?? null))
        .toEqual(manifest.expectedKinds);
      expect(manifest.cleanup).toContain('pure fixture');
    });
  }

  it('provider grammars cannot borrow Codex or Muse event names', () => {
    const codexEvent = { type: 'item.completed', item: { id: 'item-1', type: 'agent_message', text: 'fixture' } };
    const museEvent = { stream: { kind: 'session', id: 'fixture-session' }, record_type: 'event',
      payload_type: 'run.terminal.completed', payload: { kind: 'run_terminal', terminal: 'completed', run_id: 'fixture-run' } };
    for (const [provider, adapter] of Object.entries(adapters)) {
      if (provider !== 'codex') expect(adapter.observeHealthEvent(codexEvent, stdout, binding)).toBeNull();
      if (provider !== 'muse') expect(adapter.observeHealthEvent(museEvent, stdout, binding)).toBeNull();
    }
  });

  it('Muse session logs require both already bound session and run', async () => {
    const { records } = await fixture('muse');
    const source = { ...stdout, kind: 'session-log', id: 'muse-owned-log' };
    expect(adapters.muse.observeHealthEvent(records[1], source, binding)?.kind).toBe('activity');
    expect(adapters.muse.observeHealthEvent(records[1], source, { invocationId: 'fixture-invocation' })).toBeNull();
    expect(adapters.muse.observeHealthEvent(records[1], source, { ...binding, runId: 'other-run' })).toBeNull();
    expect(adapters.muse.observeHealthEvent({ ...records[1], stream: { kind: 'session', id: 'unrelated-session' } }, source, binding)).toBeNull();
  });

  it('session identifiers reject cross-invocation stream traffic', async () => {
    for (const provider of ['claude', 'codex', 'muse', 'opencode', 'pi'] as const) {
      const { records } = await fixture(provider);
      expect(adapters[provider].observeHealthEvent(records[0], stdout, { ...binding, sessionId: 'unrelated-session' })).toBeNull();
    }
  });

  it('Pi agent_end and OMP willContinue are not terminal; JSON mode has no stdin abort', () => {
    expect(adapters.pi.observeHealthEvent({ type: 'agent_end', willRetry: false }, stdout, binding)?.kind).toBe('activity');
    expect(adapters.omp.observeHealthEvent({ type: 'agent_end', willContinue: true }, stdout, binding)?.kind).toBe('activity');
    expect(adapters.pi.getAbortInput()).toBeNull();
    expect(adapters.omp.getAbortInput()).toBeNull();
  });

  it('failed tools and retries are errors, never progress', () => {
    const samples = [
      [adapters.claude, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true }] } }],
      [adapters.codex, { type: 'item.completed', item: { id: 'i1', type: 'command_execution', exit_code: 1 } }],
      [adapters.pi, { type: 'agent_end', willRetry: true }],
      [adapters.omp, { type: 'tool_execution_end', toolCallId: 't1', isError: true }],
    ] as const;
    for (const [adapter, event] of samples) expect(adapter.observeHealthEvent(event, stdout, binding)?.kind).toBe('error');
  });

  it('OpenCode framing follows profile JSONL despite legacy capability boolean', async () => {
    const { records } = await fixture('opencode');
    expect(adapters.opencode.getCapabilities().streamJson).toBe(false);
    expect(adapters.opencode.observeHealthEvent(records[1], stdout, binding)?.kind).toBe('activity');
    expect(adapters.opencode.observeHealthEvent(records[0], stdout, binding)).toBeNull();
    expect(adapters.opencode.observeHealthEvent(records[2], stdout, binding)).toBeNull();
  });
});

describe('T-OG-03 bounded incremental observation remains separate from worker claims', () => {
  it('qualified terminal failures defeat exit zero and later successful-looking events', () => {
    const failure = adapters.codex.observeHealthEvent({ type: 'turn.failed', error: { message: 'synthetic failure' } }, stdout, binding);
    const observer = adapters.codex.createHealthObserver({ profile: { health: health('codex') }, ...binding });
    observer.observe({ kind: 'accepted' }); observer.observe(failure);
    observer.observe({ kind: 'terminal', success: true });
    expect(observer.finish({ exitCode: 0, termination: 'confirmed', finalValid: true }).state).not.toBe('completed');
    expect(failure?.fatal).toBe(true);
  });
  it('fragmented UTF-8 and repeated Codex completed items preserve the progress clock', async () => {
    let now = 1000;
    const observer = adapters.codex.createHealthObserver({ profile: { health: health('codex') }, ...binding,
      now: () => now, wallNow: () => Date.UTC(2026, 9, 8) + now });
    const line = (record: unknown) => Buffer.from(`${JSON.stringify(record)}\n`);
    observer.feed(line({ type: 'thread.started', thread_id: 'fixture-session' }), stdout);
    expect(observer.snapshot().handshake).not.toBe('semantic');
    now += 1000;
    observer.feed(line({ type: 'turn.started' }));
    expect(observer.snapshot().handshake).toBe('semantic');
    now += 1000;
    const useful = line({ type: 'item.completed', item: { id: 'codex-item-utf8', type: 'agent_message', text: 'synthetic café' } });
    const split = useful.indexOf(Buffer.from('é')) + 1;
    observer.feed(useful.subarray(0, split));
    observer.feed(useful.subarray(split));
    const progress = observer.snapshot().lastProgressAt;
    expect(progress).not.toBeNull();
    now += 1000;
    observer.feed(useful);
    expect(observer.snapshot().lastProgressAt).toBe(progress);
    observer.feed(line({ type: 'item.updated', item: { id: 'keepalive', type: 'reasoning' } }));
    expect(observer.snapshot().lastProgressAt).toBe(progress);
    expect(observer.snapshot().lastActivityAt).not.toBeNull();
  });

  it('malformed/truncated/oversized frames record observation gaps', () => {
    const observer = adapters.codex.createHealthObserver({ profile: { health: health('codex') }, ...binding, maxFrameBytes: 256 });
    observer.feed(Buffer.from('{broken}\n'));
    observer.feed(Buffer.from('x'.repeat(1024)));
    observer.finish({ exitCode: 0, signal: null, termination: 'confirmed' });
    expect(observer.evidence().gaps.length).toBeGreaterThan(0);
    expect(observer.snapshot().handshake).not.toBe('semantic');
    expect(observer.snapshot().state).not.toBe('completed');
  });

  it('provider terminal events are candidates until observed process exit; no claims are returned', async () => {
    const { records } = await fixture('claude');
    const observer = adapters.claude.createHealthObserver({ profile: { health: health('claude') }, ...binding });
    observer.feed(Buffer.from(records.map(record => JSON.stringify(record)).join('\n') + '\n'));
    expect(observer.snapshot().termination).toBe('running');
    expect(observer.snapshot()).not.toHaveProperty('claims');
    observer.finish({ exitCode: 1, signal: null, termination: 'confirmed' });
    expect(observer.snapshot().state).not.toBe('completed');
  });

  it('OMP native v2 chunks reassemble before completed tool evidence; incomplete chunks mark gaps', () => {
    const bytes = Buffer.from(JSON.stringify({ type: 'tool_execution_end', toolCallId: 'omp-chunk-tool',
      isError: false, result: { text: 'x'.repeat(1024 * 1024) } }));
    const parts = [];
    for (let start = 0; start < bytes.length; start += 256 * 1024) parts.push(bytes.subarray(start, start + 256 * 1024));
    const frames = parts.map((part, index) => ({ type: 'rpc_chunk', chunkId: 'omp-fixture-chunk',
      count: parts.length, index, byteLength: bytes.length, data: part.toString('base64') }));
    const observer = adapters.omp.createHealthObserver({ profile: { health: health('omp') }, ...binding });
    observer.feed(Buffer.from('{"type":"agent_start"}\n'));
    for (const frame of frames) observer.feed(Buffer.from(`${JSON.stringify(frame)}\n`));
    expect(observer.snapshot().lastProgressAt).not.toBeNull();
    expect(observer.evidence().gaps).toHaveLength(0);
    const incomplete = adapters.omp.createHealthObserver({ profile: { health: health('omp') }, ...binding });
    incomplete.feed(Buffer.from(`${JSON.stringify(frames[0])}\n`));
    incomplete.finish({ exitCode: 0, signal: null, termination: 'confirmed' });
    expect(incomplete.snapshot().lastProgressAt).toBeNull();
    expect(incomplete.evidence().gaps.length).toBeGreaterThan(0);
  });
});

describe('T-OG-03 other IN profiles remain honestly degraded', () => {
  it('Hermes only observes session-bound native log markers', async () => {
    const { bytes, manifest } = await fixture('hermes');
    const observer = createWorkerHealthObserver({ provider: 'hermes', profile: { health: health('hermes') }, ...binding });
    observer.feed(bytes, { kind: 'session-log', id: 'hermes-owned-log', generation: 0, offset: 0 });
    expect(observer.evidence().events.map(event => event.kind)).toEqual(manifest.expectedKinds.filter(Boolean));
    expect(observer.snapshot().handshake).toBe('semantic');
    expect(observer.snapshot().lastProgressAt).not.toBeNull();
    const unrelated = createWorkerHealthObserver({ provider: 'hermes', profile: { health: health('hermes') } });
    unrelated.feed(bytes, { kind: 'session-log', id: 'hermes-log', generation: 0, offset: 0 });
    expect(unrelated.evidence().events).toHaveLength(0);
    expect(unrelated.snapshot().lastProgressAt).toBeNull();
  });

  for (const provider of ['antigravity', 'grok-build', 'local-http']) {
    it(`${provider} normalizes its own wire fields without inventing handshake`, async () => {
      const { bytes, manifest } = await fixture(provider);
      const observer = createWorkerHealthObserver({ provider, profile: { health: health(provider) }, ...binding });
      observer.feed(bytes);
      const observed = observer.evidence().events.map(event => event.kind);
      expect(observed).toEqual(manifest.expectedKinds.filter(Boolean));
      expect(observer.snapshot().handshake).not.toBe('semantic');
    });
  }

  for (const provider of ['copilot', 'cursor', 'warp', 'openclaw', 'deepseek-harness', 'openhuman']) {
    it(`${provider} final-only fixture leaves semantic startup/progress unavailable`, async () => {
      const { bytes } = await fixture(provider);
      const observer = createWorkerHealthObserver({ provider,
        profile: { health: { ...health(provider, 'process-only'), outputFraming: 'plain', progressEvidence: [] } }, ...binding });
      observer.feed(bytes);
      expect(observer.snapshot().handshake).not.toBe('semantic');
      expect(observer.snapshot().lastProgressAt).toBeNull();
      expect(observer.evidence().events).toHaveLength(0);
      expect(observer.snapshot().unavailableSignals).toContain('semantic-progress');
    });
  }
});
