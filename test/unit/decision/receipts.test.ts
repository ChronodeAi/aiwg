import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileDecisionReceiptStore, MemoryDecisionReceiptStore, decisionInvocationFingerprint, nextReceipt } from '../../../src/decision/receipts.js';
import { evaluateDecisionRuleset } from '../../../src/decision/evaluate.js';
import type { AdapterObservation, DecisionAdapter, DecisionBinding, DecisionDefinition, DecisionRuleset, DecisionReceiptStore } from '../../../src/decision/types.js';
import { readFileSync } from 'node:fs';

const fixture = <T>(name: string): T => JSON.parse(readFileSync(`examples/decision/${name}`, 'utf8')) as T;
const temp: string[] = [];
afterEach(async () => { await Promise.all(temp.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function stores(): Promise<DecisionReceiptStore[]> {
  const directory = await mkdtemp(join(tmpdir(), 'decision-receipt-'));
  temp.push(directory);
  return [new MemoryDecisionReceiptStore(), new FileDecisionReceiptStore(directory, { integrityKey: randomBytes(32) })];
}
function request(store: DecisionReceiptStore, adapter: DecisionAdapter, invocationId = 'atomic') {
  return {
    ruleset: fixture<DecisionRuleset>('ruleset.json'), binding: fixture<DecisionBinding>('binding-jev.json'),
    definitions: { category: fixture<DecisionDefinition>('decision-category.json'), severity: fixture<DecisionDefinition>('decision-severity.json'), core: fixture<DecisionDefinition>('decision-core_unavailable.json') },
    input: fixture('input.json'), runId: 'run', invocationId, adapters: { jev: adapter }, receiptStore: store,
  };
}
function adapter(gate?: Promise<void>): DecisionAdapter {
  return {
    id: 'jev', version: '1.0.0',
    capabilities: async () => ({ answerKinds: ['choice', 'ordinal-score', 'truth-probability'], features: ['choice', 'ordinal-score', 'truth-probability'], maxOptions: 255, maxLevels: 10, confidenceProfiles: ['typesafe-distribution-v1', 'typesafe-truth-v1'], executable: true }),
    evaluate: vi.fn(async ({ alias }) => {
      await gate;
      const observation: AdapterObservation = { status: 'success', reason: 'none', value: alias === 'category' ? 'documentation' : alias === 'severity' ? 0.25 : 0.05,
        uncertainty: { source: 'provider', profile: alias === 'core_unavailable' ? 'typesafe-truth-v1' : 'typesafe-distribution-v1', calibration: 'vendor-claimed', confidence: 0.9, distribution: null, calibrationRef: null },
        actualModel: 'model', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 }, requestId: 'request' };
      return observation;
    }),
  };
}

describe('REC-ATOMIC store conformance', () => {
  it('acquires one owner and rejects stale CAS in both stores', async () => {
    for (const store of await stores()) {
      const fingerprint = `sha256:${'a'.repeat(64)}`;
      const [a, b] = await Promise.all([store.acquire('id', 'project', fingerprint), store.acquire('id', 'project', fingerprint)]);
      expect([a.owner, b.owner].sort()).toEqual([false, true]);
      const next = nextReceipt(a.receipt, 'dispatched');
      expect(await store.compareAndSwap('id', 'project', 1, next)).toBe(true);
      expect(await store.compareAndSwap('id', 'project', 1, next)).toBe(false);
      await expect(store.read('id', 'other-project')).rejects.toThrow();
    }
  });

  it('races equivalent callers behind an adapter barrier and returns the identical result', async () => {
    for (const store of await stores()) {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const worker = adapter(gate);
      const base = request(store, worker);
      const first = evaluateDecisionRuleset(base);
      const second = evaluateDecisionRuleset(base);
      release();
      const [one, two] = await Promise.all([first, second]);
      expect(one).toEqual(two);
      expect(one.spec.status).toBe('completed');
      expect(vi.mocked(worker.evaluate).mock.calls).toHaveLength(3);
      const mismatch = await evaluateDecisionRuleset({ ...base, input: { message: 'changed' } });
      expect(mismatch.spec.reason).toBe('replay-mismatch');
      const policy = { id: 'policy', version: '1', digest: `sha256:${'b'.repeat(64)}` as const };
      expect((await evaluateDecisionRuleset({ ...base, policyPin: policy })).spec.reason).toBe('replay-mismatch');
      expect((await evaluateDecisionRuleset({ ...base, calibrationPin: policy })).spec.reason).toBe('replay-mismatch');
      expect(vi.mocked(worker.evaluate).mock.calls).toHaveLength(3);
    }
  });

  it('rejects modified durable records before reuse', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'decision-receipt-tamper-'));
    temp.push(directory);
    const store = new FileDecisionReceiptStore(directory, { integrityKey: randomBytes(32) });
    const receipt = await store.acquire('id', 'project', `sha256:${'a'.repeat(64)}`);
    expect(receipt.owner).toBe(true);
    const name = (await readdir(directory)).find(file => file.endsWith('.json'))!;
    const path = join(directory, name);
    const body = (await readFile(path, 'utf8')).replace('acquired', 'completed');
    await writeFile(path, body);
    await expect(store.read('id', 'project')).rejects.toThrow(/integrity/);
  });

  it('elects exactly one owner across two processes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'decision-receipt-process-'));
    temp.push(directory);
    const key = randomBytes(32).toString('hex');
    const start = () => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/decision/receipt-process.mjs', directory, key, 'process-race'],
        { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      let errors = '';
      let ready!: () => void;
      const initialized = new Promise<void>(resolve => { ready = resolve; });
      child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('ready\n')) ready(); });
      child.stderr.on('data', chunk => { errors += String(chunk); });
      const result = new Promise<{ owner: boolean; revision: number }>((resolve, reject) => child.on('exit', code => {
        if (code !== 0) reject(new Error(errors));
        else resolve(JSON.parse(output.trim().split('\n').at(-1)!) as { owner: boolean; revision: number });
      }));
      return { child, initialized, result };
    };
    const a = start();
    const b = start();
    await Promise.all([a.initialized, b.initialized]);
    a.child.stdin.write('go\n');
    b.child.stdin.write('go\n');
    const results = await Promise.all([a.result, b.result]);
    expect(results.map(result => result.owner).sort()).toEqual([false, true]);
    expect(results.map(result => result.revision)).toEqual([1, 1]);
  });

  it('canonicalizes input keys and binds ordered pins', () => {
    const pin = { id: 'x', version: '1', digest: `sha256:${'a'.repeat(64)}` as const };
    const base = { invocationId: 'x', ruleset: pin, binding: pin, definitions: [pin], value: { é: 1.5, a: -0 } };
    expect(decisionInvocationFingerprint(base)).toBe(decisionInvocationFingerprint({ ...base, value: { a: 0, é: 1.5 } }));
    expect(decisionInvocationFingerprint(base)).not.toBe(decisionInvocationFingerprint({ ...base, policy: pin }));
  });

  it('checks access on reads and waits', async () => {
    let permitted = true;
    const store = new MemoryDecisionReceiptStore(() => permitted);
    await store.acquire('id', 'project', `sha256:${'a'.repeat(64)}`);
    permitted = false;
    await expect(store.read('id', 'project')).rejects.toThrow(/access denied/);
    await expect(store.waitForTerminal('id', 'project', `sha256:${'a'.repeat(64)}`)).rejects.toThrow(/access denied/);
  });

  it('blocks outcomes when receipt persistence fails after inference', async () => {
    const delegate = new MemoryDecisionReceiptStore();
    const broken: DecisionReceiptStore = {
      read: delegate.read.bind(delegate), acquire: delegate.acquire.bind(delegate),
      waitForTerminal: delegate.waitForTerminal.bind(delegate),
      compareAndSwap: async (id, project, revision, next) => next.state === 'completed'
        ? Promise.reject(new Error('disk full')) : delegate.compareAndSwap(id, project, revision, next),
    };
    const worker = adapter();
    const result = await evaluateDecisionRuleset(request(broken, worker, 'disk-full'));
    expect(result.spec.reason).toBe('persistence-error');
    expect(result.spec.outcome).toBeUndefined();
    expect(vi.mocked(worker.evaluate).mock.calls).toHaveLength(3);
  });

  it('never retries an incomplete dispatched receipt', async () => {
    for (const store of await stores()) {
      const worker = adapter();
      const base = request(store, worker, 'crashed');
      // Use the evaluator to create a legitimate fingerprint, then inject a crash at dispatch.
      const failStore: DecisionReceiptStore = {
        read: store.read.bind(store), acquire: store.acquire.bind(store), waitForTerminal: store.waitForTerminal.bind(store),
        compareAndSwap: async (id, project, revision, next) => {
          const saved = await store.compareAndSwap(id, project, revision, next);
          if (next.state === 'dispatched') throw new Error('process stopped');
          return saved;
        },
      };
      const first = await evaluateDecisionRuleset({ ...base, receiptStore: failStore });
      expect(first.spec.reason).toBe('persistence-error');
      const restarted: DecisionReceiptStore = { read: store.read.bind(store), acquire: store.acquire.bind(store),
        compareAndSwap: store.compareAndSwap.bind(store), waitForTerminal: async () => { throw new Error('owner disappeared'); } };
      const second = await evaluateDecisionRuleset({ ...base, receiptStore: restarted });
      expect(second.spec.reason).toBe('execution-uncertain');
      expect(vi.mocked(worker.evaluate)).not.toHaveBeenCalled();
    }
  });
});
