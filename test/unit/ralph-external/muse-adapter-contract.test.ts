// Cover offline Muse argv and output contracts in the orchestration Vitest lane.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MuseAdapter, isMuseRalphEnabled, museQuotaEvidence, register } from '../../../tools/ralph-external/lib/muse-adapter.mjs';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); vi.unstubAllEnvs(); });
const adapter = new MuseAdapter();
const record = (payload_type: string, payload: object) => JSON.stringify({ payload_type, payload });
function direct() {
  const dir = mkdtempSync(path.join(tmpdir(), 'muse-direct-contract-')); roots.push(dir);
  return { invocation: { selected: { model: 'muse-spark-1.3', effort: { value: 'high' } },
    cwd: dir, briefPath: path.join(dir, 'brief.md'), health: { maxSteps: 3 } },
  profile: { controls: { structuredOutput: { mapping: JSON.stringify(['--output-schema', path.join(dir, 'schema.json')]),
    support: 'supported' }, trust: { mapping: '["--trust-workspace"]' } } } };
}

describe('T-OG-03 Muse offline argv and settlement contracts', () => {
  it('accepts only invocation-bound event identities and requires a handshake before activity or final', () => {
    const frame = (payload_type: string, payload: object) => ({ id: 'event', record_type: 'event',
      stream: { kind: 'session', id: 'session' }, payload_type, payload: { run_id: 'run', ...payload } });
    const started = frame('run.lifecycle.started', { kind: 'run_started' });
    const delta = frame('run.output.delta', { kind: 'run_output_delta', text: 'partial' });
    const completed = frame('run.terminal.completed', { kind: 'run_terminal', terminal: 'completed' });
    const source = { kind: 'stdout' }, bound = { sessionId: 'session', runId: 'run' };
    expect(adapter.observeHealthEvent(started, source, {}))
      .toEqual({ kind: 'accepted', sessionId: 'session', runId: 'run', key: 'event' });
    expect(adapter.observeHealthEvent(delta, source, {})).toBeNull();
    expect(adapter.observeHealthEvent(delta, source, { sessionId: 'session' })).toBeNull();
    expect(adapter.observeHealthEvent(delta, source, bound)).toEqual({ kind: 'activity', key: 'event' });
    expect(adapter.observeHealthEvent(completed, source, bound)).toEqual({ kind: 'terminal', success: true, key: 'event' });
    expect(adapter.observeHealthEvent(frame('run.terminal.failed', { kind: 'run_terminal', terminal: 'failed', reason: '429' }),
      source, bound)).toMatchObject({ fatal: true, reasonCode: 'RATE_LIMIT', quotaScope: null, resetAt: null });
    expect(adapter.observeHealthEvent(started, source, { sessionId: 'foreign' })).toBeNull();
    expect(adapter.observeHealthEvent(delta, { kind: 'session-log' }, {})).toBeNull();
    expect(adapter.observeHealthEvent(delta, { kind: 'session-log' }, { sessionId: 'session' })).toBeNull();
    expect(adapter.observeHealthEvent(delta, { kind: 'session-log' }, bound)).toEqual({ kind: 'activity', key: 'event' });
    expect(adapter.observeHealthEvent(frame('run.model.configured', {}), source, bound)).toBeNull();
    for (const event of [null, 'text', {}, { ...started, stream: undefined }, { ...started, stream: { kind: 'session' } },
      { ...started, payload: null }, { ...started, payload: 'text' }, { ...started, payload: {} },
      { ...started, payload: { run_id: '' } }]) {
      expect(adapter.observeHealthEvent(event, source, bound)).toBeNull();
    }
  });

  it('keeps unknown quota scope and reset unknown while retaining a valid reset embedded in the reason', () => {
    expect(museQuotaEvidence({ reason: '429 reset_at: 2026-10-09T12:00:00Z', quota_scope: 'invalid scope' }))
      .toEqual({ reasonCode: 'RATE_LIMIT', quotaScope: null, resetAt: '2026-10-09T12:00:00.000Z', retryAfterSeconds: null });
    expect(museQuotaEvidence({ reason: '429', reset_at: 'invalid' })).toMatchObject({ resetAt: null, quotaScope: null });
  });

  it.each(['read-only', 'workspace-write', 'external'])('binds host trust and explicit model/effort under %s', sandbox => {
    const { invocation, profile } = direct();
    const args = adapter.buildWorkerArgs(invocation, profile, { sandbox, approval: 'never' });
    expect(args).toContain('--trust-workspace');
    expect(args).toContain(invocation.selected.model);
    expect(args).toContain(invocation.briefPath);
    expect(args.includes('--disable-write')).toBe(sandbox === 'read-only');
    expect(args.includes('--disable-sandbox')).toBe(sandbox === 'external');
  });

  it('allows explicitly unqualified text output and an explicitly empty trust mapping', () => {
    const { invocation, profile } = direct();
    profile.controls.structuredOutput = { mapping: '[]', support: 'unqualified' };
    profile.controls.trust.mapping = '[]';
    const args = adapter.buildWorkerArgs(invocation, profile, { sandbox: 'workspace-write' });
    expect(args).not.toContain('--output-schema');
    expect(args).not.toContain('--trust-workspace');
  });

  it.each(['{', '{}', '[]', '["wrong","/schema"]', '["--output-schema",5]',
    '["--output-schema","relative"]', '["--output-schema","/bad\\u0000path"]', '["--output-schema","/a/../schema"]',
  ])('refuses an unbound output schema mapping %j', mapping => {
    const { invocation, profile } = direct(); profile.controls.structuredOutput.mapping = mapping;
    expect(() => adapter.buildWorkerArgs(invocation, profile, { sandbox: 'read-only' })).toThrow(/output-schema/);
  });

  it.each(['{', '{}', '["--yolo"]', '["--trust-workspace","--yolo"]'])('refuses invalid host trust %j', mapping => {
    const { invocation, profile } = direct(); profile.controls.trust.mapping = mapping;
    expect(() => adapter.buildWorkerArgs(invocation, profile, { sandbox: 'read-only' })).toThrow(/workspace trust/);
  });

  it('refuses missing model, effort, bounded steps, approval, and sandbox authority', () => {
    const { invocation, profile } = direct();
    for (const model of ['', 'bad\0model', undefined]) {
      expect(() => adapter.buildWorkerArgs({ ...invocation, selected: { ...invocation.selected, model } }, profile,
        { sandbox: 'read-only' })).toThrow(/explicit resolved model/);
    }
    for (const effort of [undefined, { value: 'invented' }]) {
      expect(() => adapter.buildWorkerArgs({ ...invocation, selected: { ...invocation.selected, effort } }, profile,
        { sandbox: 'read-only' })).toThrow(/explicit resolved effort/);
    }
    for (const cwd of [undefined, 'relative', '/a/../b', '/bad\0path']) {
      expect(() => adapter.buildWorkerArgs({ ...invocation, cwd }, profile, { sandbox: 'read-only' })).toThrow(/absolute/);
    }
    for (const permissions of [undefined, { sandbox: 'invented' }, { sandbox: 'read-only', approval: 'ask' }]) {
      expect(() => adapter.buildWorkerArgs(invocation, profile, permissions)).toThrow(/sandbox authority|approval requires never/);
    }
    for (const maxSteps of [undefined, 0, 1.5]) {
      expect(() => adapter.buildWorkerArgs({ ...invocation, health: { maxSteps } }, profile,
        { sandbox: 'read-only' })).toThrow(/bounded steps/);
    }
  });

  it('keeps session prompts positional, resumes by id, and uses documented caps', () => {
    expect(adapter.buildSessionArgs({ prompt: '-a prompt' })).toEqual(['exec', '--json', '--', '-a prompt']);
    expect(adapter.buildSessionArgs({ prompt: 'continue', sessionId: 'session', model: 'muse-spark-1.3',
      reasoningEffort: 'high', maxTurns: 3, approvalMode: 'never' })).toEqual([
      'exec', '--json', '--session-id', 'session', '--model', 'muse-spark-1.3',
      '--reasoning-effort', 'high', '--max-model-steps', '3', '--approval-mode', 'never', '--', 'continue',
    ]);
  });

  it('uses prompt-file transport and text analysis without inventing unsupported flags', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'muse-contract-')); roots.push(dir);
    const brief = path.join(dir, 'brief.md');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(adapter.buildSessionArgs({ promptFile: brief, model: 'claude-sonnet-5', budget: 1,
      systemPrompt: 'system', agent: 'agent', mcpConfig: {} }))
      .toEqual(['exec', '--json', '--prompt-file', brief]);
    expect(warn).toHaveBeenCalledTimes(4);
    expect(adapter.buildAnalysisArgs({ prompt: 'analyze' })).toEqual(['exec', '--', 'analyze']);
  });

  it('exports explicit or last sessions, with optional redaction and no assumed transcript path', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'muse-export-')); roots.push(dir);
    const out = path.join(dir, 'export.json');
    expect(adapter.buildExportArgs()).toEqual(['export']);
    expect(adapter.buildExportArgs({ sessionId: 's', out })).toEqual(['export', '--session', 's', '--out', out]);
    expect(adapter.buildExportArgs({ last: true, sessionId: 'ignored', redacted: true }))
      .toEqual(['export', '--last', '--redacted']);
    expect(adapter.getTranscriptPath()).toBeNull();
    expect(adapter.getAbortInput()).toBeNull();
    expect(adapter.getEnvOverrides()).toEqual({ CI: 'true', NO_COLOR: '1' });
    expect(adapter.getCapabilities()).toMatchObject({ streamJson: true, sessionResume: true, maxTurns: true, budgetControl: false });
    expect(adapter.getName()).toBe('muse');
    vi.stubEnv('AIWG_MUSE_BIN', undefined);
    expect(adapter.getBinary()).toBe('muse');
    vi.stubEnv('AIWG_MUSE_BIN', path.join(dir, 'fake-muse'));
    expect(adapter.getBinary()).toBe(path.join(dir, 'fake-muse'));
    const factory = vi.fn(); register(factory);
    expect(factory.mock.calls[0][0]).toBe('muse');
    expect(factory.mock.calls[0][1]()).toBeInstanceOf(MuseAdapter);
  });

  it.each(['0', 'false', ' NO ', 'off'])('disables legacy registration for %j', value => {
    vi.stubEnv('AIWG_MUSE_RALPH_ENABLED', value); expect(isMuseRalphEnabled()).toBe(false);
  });
  it.each([undefined, '', '1'])('defaults legacy registration on for %j', value => {
    vi.stubEnv('AIWG_MUSE_RALPH_ENABLED', value); expect(isMuseRalphEnabled()).toBe(true);
  });

  it('settles from a matching terminal and prefers final text over streamed deltas', () => {
    const output = [record('run.output.delta', { text: 'partial' }),
      record('run.terminal.completed', { terminal: 'completed', text: 'final' })].join('\r\n') + '\r\n';
    expect(adapter.parseOutput(output)).toMatchObject({ text: 'final', settled: true, terminal: 'completed', reason: null });
    expect(adapter.parseOutput(record('run.output.delta', { text: 'partial' })))
      .toMatchObject({ text: 'partial', settled: null, terminal: null });
    expect(adapter.parseOutput('null\n{}\n')).toMatchObject({ text: null, settled: null });
  });

  it('retains failed partial text and quota evidence without treating exit zero as completion', () => {
    const output = [record('run.output.delta', { text: 'partial' }), record('run.terminal.failed', {
      terminal: 'failed', text: '', reason: '429 Retry-After: 5', reset_at: '2026-10-09T12:00:00Z', quota_scope: 'test:account',
    })].join('\n');
    expect(adapter.parseOutput(output)).toMatchObject({ text: 'partial', settled: false, reason: '429 Retry-After: 5',
      quota: { reasonCode: 'RATE_LIMIT', retryAfterSeconds: 5, resetAt: '2026-10-09T12:00:00.000Z', quotaScope: 'test:account' } });
    expect(adapter.parseOutput(record('run.terminal.failed', { terminal: 'failed', reason: 'auth failed' })))
      .toMatchObject({ text: null, settled: false, reason: 'auth failed' });
  });

  it.each([undefined, '', '{', 'x'.repeat(10485761),
    record('run.terminal.completed', { terminal: 'failed' }), record('run.terminal.cancelled', { terminal: 'cancelled' }),
    record('run.terminal.completed', { terminal: 'completed' }) + '\n{}',
  ])('refuses malformed, oversized, contradictory or post-terminal output (case %#)', output => {
    expect(adapter.parseOutput(output)).toBeNull();
  });
});
