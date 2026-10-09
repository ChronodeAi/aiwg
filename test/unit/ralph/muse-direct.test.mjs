import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import semver from 'semver';
import { inspectPackRegistry } from '../../../tools/testing/check-orchestration-packs.mjs';
import path from 'node:path';
import { MuseAdapter, museQuotaEvidence } from '../../../tools/ralph-external/lib/muse-adapter.mjs';

const owner = new MuseAdapter();
const frame = (type, payload, id = 'record-1') => ({ schema_version: 1, id, stream: { kind: 'session', id: 'session' },
  record_type: 'event', payload_type: type, payload_schema_version: 1, payload: { run_id: 'run', ...payload } });

test('direct argv preserves explicit model and effort, trust and approval without bypasses', () => {
  const root = path.join(os.tmpdir(), 'synthetic-muse-path');
  const args = owner.buildWorkerArgs({ selected: { model: 'muse-spark-1.3', effort: { value: 'xhigh' } },
    cwd: root, briefPath: path.join(root, 'brief 雪.md'), health: { maxSteps: 3 } },
  { controls: { trust: { mapping: '[]' }, structuredOutput: { mapping: JSON.stringify(['--output-schema', path.join(root, 'schema.json')]) } } }, { sandbox: 'read-only' });
  assert.equal(args[args.indexOf('--model') + 1], 'muse-spark-1.3');
  assert.equal(args[args.indexOf('--reasoning-effort') + 1], 'xhigh');
  assert.equal(args[args.indexOf('--max-model-steps') + 1], '3');
  assert.ok(!args.includes('--trust-workspace')); assert.ok(args.includes('--disable-write'));
  assert.ok(args.includes('--disable-shell'));
  assert.equal(args[args.indexOf('--approval-judge') + 1], 'off');
  assert.equal(args[args.indexOf('--approval-mode') + 1], 'never');
  for (const flag of ['--yolo', '--disable-sandbox', '--disable-approval']) assert.ok(!args.includes(flag));
});

test('429 candidates retain scope/reset/retry and unknowns; unrelated errors have no quota', () => {
  assert.deepEqual(museQuotaEvidence({ reason: 'HTTP 429 Retry-After: 12.5 reset_at: 2026-10-09T12:00:00Z', quota_scope: 'account:fixture' }),
    { reasonCode: 'RATE_LIMIT', quotaScope: 'account:fixture', resetAt: '2026-10-09T12:00:00.000Z', retryAfterSeconds: 12.5 });
  assert.deepEqual(museQuotaEvidence({ reason: '429', reset_at: 'not a date' }),
    { reasonCode: 'RATE_LIMIT', quotaScope: null, resetAt: null, retryAfterSeconds: null });
  assert.equal(museQuotaEvidence({ reason: 'auth failed' }), null);
});

test('failed quota terminal preserves partial text and cannot be settled by exit zero', () => {
  const stream = [frame('run.output.delta', { text: 'partial' }),
    frame('run.terminal.failed', { terminal: 'failed', reason: '429', text: '' })].map(JSON.stringify).join('\n');
  const parsed = owner.parseOutput(stream);
  assert.equal(parsed.settled, false); assert.equal(parsed.text, 'partial');
  assert.equal(parsed.quota.resetAt, null);
});

test('duplicate, contradictory, malformed and oversized terminals are not candidates', () => {
  const success = JSON.stringify(frame('run.terminal.completed', { terminal: 'completed', text: '{}' }));
  assert.equal(owner.parseOutput(success + '\n' + success), null);
  assert.equal(owner.parseOutput(success + '\n{'), null);
  assert.equal(owner.parseOutput(JSON.stringify(frame('run.terminal.completed', { terminal: 'failed' }))), null);
  assert.equal(owner.parseOutput('x'.repeat(10485761)), null);
});

test('handshake needs invocation-bound run identity and delta/final cannot bind a new run', () => {
  const source = { kind: 'stdout' };
  assert.equal(owner.observeHealthEvent(frame('run.lifecycle.started', { kind: 'run_started', run_id: undefined }), source, {}), null);
  assert.equal(owner.observeHealthEvent(frame('run.output.delta', { kind: 'run_output_delta', text: 'bytes' }), source, {}), null);
  assert.equal(owner.observeHealthEvent(frame('run.terminal.completed', { kind: 'run_terminal', terminal: 'completed' }), source, {}), null);
  assert.equal(owner.observeHealthEvent(frame('run.lifecycle.started', { kind: 'run_started' }), source, { runId: 'foreign' }), null);
});

test('configured-model event never establishes backend/start/progress and observer loss remains degraded', () => {
  let now = 0;
  const observer = owner.createHealthObserver({ health: { handshake: 'semantic', outputFraming: 'jsonl', progressEvidence: [], coverage: 'degraded' },
    now: () => now, wallNow: () => Date.UTC(2026, 9, 9) });
  observer.feed(Buffer.from(JSON.stringify(frame('run.model.configured', { model_id: 'muse-spark-1.3' })) + '\n'));
  assert.equal(observer.snapshot().handshake, 'unobserved');
  observer.feed(Buffer.from(JSON.stringify(frame('run.lifecycle.started', { kind: 'run_started' })) + '\n'));
  now = 1000;
  observer.feed(Buffer.from(JSON.stringify(frame('run.output.delta', { kind: 'run_output_delta', text: 'bytes' })) + '\n'));
  assert.equal(observer.snapshot().handshake, 'semantic');
  assert.equal(observer.snapshot().lastProgressAt, null);
  const activity = observer.snapshot().lastActivityAt;
  now = 40000; observer.check();
  assert.equal(observer.snapshot().lastActivityAt, activity);
  assert.ok(observer.snapshot().unavailableSignals.includes('observer-continuity'));
  assert.ok(observer.snapshot().unavailableSignals.includes('semantic-progress'));
});

test('unrelated Muse session logs cannot refresh bound activity', () => {
  const delta = frame('run.output.delta', { kind: 'run_output_delta', text: 'foreign bytes' });
  assert.equal(owner.observeHealthEvent(delta, { kind: 'session-log' }, { sessionId: 'foreign', runId: 'run' }), null);
  assert.equal(owner.observeHealthEvent(delta, { kind: 'session-log' }, {}), null);
});

const declarations = JSON.parse(readFileSync(new URL('../../../agentic/code/providers/model-capabilities.v1.json', import.meta.url))).providers.muse;
function directInput() {
  const root = path.join(os.tmpdir(), 'synthetic-muse-policy');
  const profile = structuredClone(declarations.workerHealthAdapter.invocationProfiles['direct-shell']);
  profile.controls.structuredOutput.mapping = JSON.stringify(['--output-schema', path.join(root, 'schema.json')]);
  return { profile, input: { selected: { model: 'muse-spark-1.3', effort: { value: 'medium' } },
    cwd: root, briefPath: path.join(root, 'brief'), health: { maxSteps: 1 } } };
}

test('T-OG-06 exactly registers both partial Muse test files', () => {
  const root = path.resolve('.');
  const registry = JSON.parse(readFileSync(path.join(root, 'test/conformance/orchestration-v1/packs.json')));
  const report = inspectPackRegistry(registry, root);
  assert.equal(report.packs['T-OG-06'].status, 'partial');
  assert.deepEqual(report.packs['T-OG-06'].testFiles, [
    'test/conformance/orchestration-v1/muse-direct.test.ts', 'test/unit/ralph/muse-direct.test.mjs']);
});

test('workspace trust defaults off and only the host profile can explicitly enable it', () => {
  const { profile, input } = directInput();
  assert.equal(profile.controls.trust.mapping, '[]');
  assert.ok(!owner.buildWorkerArgs(input, profile, { sandbox: 'external' }).includes('--trust-workspace'));
  profile.controls.trust.mapping = '["--trust-workspace"]';
  const args = owner.buildWorkerArgs(input, profile, { sandbox: 'read-only' });
  for (const flag of ['--trust-workspace', '--disable-write', '--disable-shell']) assert.ok(args.includes(flag));
  for (const flag of ['--yolo', '--disable-sandbox']) assert.ok(!args.includes(flag));
  profile.controls.trust.mapping = '["--yolo"]';
  assert.throws(() => owner.buildWorkerArgs(input, profile, { sandbox: 'external' }), /trust/);
});

test('approval judge is explicitly disabled in the frozen approval mapping and argv', () => {
  const { profile, input } = directInput();
  assert.deepEqual(JSON.parse(profile.controls.approval.mapping), ['--approval-mode', 'never', '--approval-judge', 'off']);
  const args = owner.buildWorkerArgs(input, profile, { sandbox: 'external' });
  assert.equal(args[args.indexOf('--approval-judge') + 1], 'off');
});

test('declared effort set matches help; unknown effort cannot reach argv', () => {
  assert.deepEqual(declarations.effortValues, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  const { profile, input } = directInput();
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    input.selected.effort.value = effort;
    const args = owner.buildWorkerArgs(input, profile, { sandbox: 'external' });
    assert.equal(args[args.indexOf('--reasoning-effort') + 1], effort);
  }
  input.selected.effort.value = 'made-up';
  assert.throws(() => owner.buildWorkerArgs(input, profile, { sandbox: 'external' }), /effort/);
});

test('version banner mismatch is a documented gate, not synthetic installation qualification', () => {
  const adapter = declarations.workerHealthAdapter;
  const banner = 'Muse Code 1.4.4 (1.4.4-R5419.1)';
  assert.equal(semver.satisfies(banner, adapter.supportedVersions), false);
  assert.notEqual(banner, adapter.supportedVersions);
  assert.equal(adapter.qualification.status, 'unqualified');
  assert.ok(adapter.invocationProfiles['direct-shell'].pitfalls.some(value => value.includes('raw trimmed banner')));
});
