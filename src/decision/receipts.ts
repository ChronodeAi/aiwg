import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../security/artifact-trust.js';
import type { ArtifactPin, DecisionReceipt, DecisionReceiptState, DecisionReceiptStore } from './types.js';

export function decisionInvocationFingerprint(input: {
  invocationId: string;
  value: unknown;
  definitions: ArtifactPin[];
  ruleset: ArtifactPin;
  binding: ArtifactPin;
  policy?: ArtifactPin | null;
  calibration?: ArtifactPin | null;
}): string {
  return `sha256:${createHash('sha256').update(canonicalJson({
    invocationId: input.invocationId, input: input.value, definitions: input.definitions,
    ruleset: input.ruleset, binding: input.binding,
    policy: input.policy ?? null, calibration: input.calibration ?? null,
  })).digest('hex')}`;
}

const terminal = new Set<DecisionReceiptState>(['completed', 'failed', 'execution-uncertain']);
const allowed: Record<DecisionReceiptState, DecisionReceiptState[]> = {
  acquired: ['dispatched', 'observation-received', 'composed', 'failed', 'execution-uncertain'],
  dispatched: ['remote-handle-known', 'observation-received', 'execution-uncertain'],
  'remote-handle-known': ['observation-received', 'execution-uncertain'],
  'observation-received': ['observation-received', 'dispatched', 'composed', 'failed', 'execution-uncertain'],
  composed: ['completed', 'failed'],
  completed: [], failed: [], 'execution-uncertain': [],
};

export class DecisionReceiptIntegrityError extends Error {}
export class DecisionReceiptAccessError extends Error {}

export function validateReceipt(receipt: DecisionReceipt, invocationId: string, projectId: string): void {
  if (!receipt || receipt.schema !== 'decision-receipt/v2' || receipt.invocationId !== invocationId || receipt.projectId !== projectId
    || !Number.isSafeInteger(receipt.revision) || receipt.revision < 1
    || !/^sha256:[a-f0-9]{64}$/.test(receipt.fingerprint)
    || !Object.hasOwn(allowed, receipt.state) || !Array.isArray(receipt.remoteHandles)
    || receipt.remoteHandles.some(handle => typeof handle !== 'string' || !handle.length)
    || !receipt.evaluations || typeof receipt.evaluations !== 'object' || Array.isArray(receipt.evaluations)
    || Object.entries(receipt.evaluations).some(([alias, result]) => result.spec.alias !== alias || result.spec.invocationId !== invocationId)
    || (receipt.pending !== null && (!receipt.pending || typeof receipt.pending.alias !== 'string'
      || !Number.isSafeInteger(receipt.pending.targetIndex) || receipt.pending.targetIndex < 0
      || !Number.isSafeInteger(receipt.pending.ordinal) || receipt.pending.ordinal < 1
      || !Array.isArray(receipt.pending.attempts)))
    || (receipt.state === 'completed' && (!receipt.result || receipt.result.spec.invocationId !== invocationId
      || receipt.result.spec.status === 'error' && receipt.result.spec.reason === 'execution-uncertain'))
    || (receipt.state !== 'completed' && receipt.result !== undefined)) {
    throw new DecisionReceiptIntegrityError('Invalid decision receipt');
  }
}

export function nextReceipt(previous: DecisionReceipt, state: DecisionReceiptState, extra: Partial<Pick<DecisionReceipt, 'result' | 'remoteHandles' | 'evaluations' | 'pending'>> = {}): DecisionReceipt {
  if (!allowed[previous.state].includes(state)) throw new DecisionReceiptIntegrityError('Illegal receipt transition');
  const next = { ...structuredClone(previous), ...structuredClone(extra), state, revision: previous.revision + 1 };
  if (next.remoteHandles.length < previous.remoteHandles.length || previous.remoteHandles.some((handle, index) => next.remoteHandles[index] !== handle)) {
    throw new DecisionReceiptIntegrityError('Remote handle lineage changed');
  }
  if (Object.entries(previous.evaluations).some(([alias, result]) => canonicalJson(next.evaluations[alias]) !== canonicalJson(result))) {
    throw new DecisionReceiptIntegrityError('Completed evaluation lineage changed');
  }
  validateReceipt(next, previous.invocationId, previous.projectId);
  return next;
}

function initial(invocationId: string, projectId: string, fingerprint: string): DecisionReceipt {
  const receipt: DecisionReceipt = { schema: 'decision-receipt/v2', revision: 1, projectId, invocationId, fingerprint, state: 'acquired', remoteHandles: [], evaluations: {}, pending: null };
  validateReceipt(receipt, invocationId, projectId);
  return receipt;
}

function assertTransition(previous: DecisionReceipt, next: DecisionReceipt): void {
  const expected = nextReceipt(previous, next.state, {
    ...(next.result !== undefined ? { result: next.result } : {}), remoteHandles: next.remoteHandles,
    evaluations: next.evaluations, pending: next.pending,
  });
  if (canonicalJson(expected) !== canonicalJson(next)) throw new DecisionReceiptIntegrityError('Receipt mutation outside legal transition');
}

export class MemoryDecisionReceiptStore implements DecisionReceiptStore {
  private readonly receipts = new Map<string, DecisionReceipt>();
  constructor(private readonly authorize: (projectId: string) => boolean | Promise<boolean> = () => true) {}
  private async check(projectId: string): Promise<void> {
    if (!await this.authorize(projectId)) throw new DecisionReceiptAccessError('Decision receipt access denied');
  }
  async read(invocationId: string, projectId = 'default'): Promise<DecisionReceipt | null> {
    await this.check(projectId);
    const receipt = this.receipts.get(invocationId);
    if (!receipt) return null;
    validateReceipt(receipt, invocationId, projectId);
    return structuredClone(receipt);
  }
  async acquire(invocationId: string, projectId: string, fingerprint: string): Promise<{ owner: boolean; receipt: DecisionReceipt }> {
    await this.check(projectId);
    const existing = this.receipts.get(invocationId);
    if (existing) {
      validateReceipt(existing, invocationId, projectId);
      return { owner: false, receipt: structuredClone(existing) };
    }
    const receipt = initial(invocationId, projectId, fingerprint);
    this.receipts.set(invocationId, receipt);
    return { owner: true, receipt: structuredClone(receipt) };
  }
  async compareAndSwap(invocationId: string, projectId: string, expectedRevision: number, next: DecisionReceipt): Promise<boolean> {
    await this.check(projectId);
    const current = this.receipts.get(invocationId);
    if (!current) throw new DecisionReceiptIntegrityError('Missing decision receipt');
    validateReceipt(current, invocationId, projectId);
    if (current.revision !== expectedRevision) return false;
    assertTransition(current, next);
    this.receipts.set(invocationId, structuredClone(next));
    return true;
  }
  async waitForTerminal(invocationId: string, projectId: string, fingerprint: string, signal?: AbortSignal): Promise<DecisionReceipt> {
    for (;;) {
      const receipt = await this.read(invocationId, projectId);
      if (!receipt || receipt.fingerprint !== fingerprint) throw new DecisionReceiptIntegrityError('Receipt fingerprint mismatch');
      if (terminal.has(receipt.state)) return receipt;
      if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
      await sleep(20, signal);
    }
  }
}

interface FileStoreOptions {
  integrityKey: Uint8Array;
  authorize?: (projectId: string) => boolean | Promise<boolean>;
}

export class FileDecisionReceiptStore implements DecisionReceiptStore {
  constructor(private readonly directory: string, private readonly options: FileStoreOptions) {
    if (options.integrityKey.length < 32) throw new Error('Decision receipt integrity key must be at least 32 bytes');
  }
  private async check(projectId: string): Promise<void> {
    if (this.options.authorize && !await this.options.authorize(projectId)) throw new DecisionReceiptAccessError('Decision receipt access denied');
  }
  private pathFor(invocationId: string): string {
    return join(this.directory, `${createHash('sha256').update(invocationId).digest('hex')}.json`);
  }
  private mac(receipt: DecisionReceipt): string {
    return createHmac('sha256', this.options.integrityKey).update(canonicalJson(receipt)).digest('hex');
  }
  async read(invocationId: string, projectId = 'default'): Promise<DecisionReceipt | null> {
    await this.check(projectId);
    let document: { receipt: DecisionReceipt; mac: string };
    try { document = JSON.parse(await readFile(this.pathFor(invocationId), 'utf8')) as typeof document; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new DecisionReceiptIntegrityError('Corrupt decision receipt');
    }
    if (!document || typeof document.mac !== 'string' || !/^[a-f0-9]{64}$/.test(document.mac)) throw new DecisionReceiptIntegrityError('Corrupt decision receipt envelope');
    const actual = Buffer.from(document.mac, 'hex');
    if (!timingSafeEqual(actual, Buffer.from(this.mac(document.receipt), 'hex'))) throw new DecisionReceiptIntegrityError('Decision receipt integrity check failed');
    validateReceipt(document.receipt, invocationId, projectId);
    return structuredClone(document.receipt);
  }
  async acquire(invocationId: string, projectId: string, fingerprint: string): Promise<{ owner: boolean; receipt: DecisionReceipt }> {
    await this.check(projectId);
    return this.withLock(invocationId, async () => {
      const existing = await this.read(invocationId, projectId);
      if (existing) return { owner: false, receipt: existing };
      const receipt = initial(invocationId, projectId, fingerprint);
      await this.persist(invocationId, receipt);
      return { owner: true, receipt };
    });
  }
  async compareAndSwap(invocationId: string, projectId: string, expectedRevision: number, next: DecisionReceipt): Promise<boolean> {
    await this.check(projectId);
    return this.withLock(invocationId, async () => {
      const current = await this.read(invocationId, projectId);
      if (!current) throw new DecisionReceiptIntegrityError('Missing decision receipt');
      if (current.revision !== expectedRevision) return false;
      assertTransition(current, next);
      await this.persist(invocationId, next);
      return true;
    });
  }
  async waitForTerminal(invocationId: string, projectId: string, fingerprint: string, signal?: AbortSignal): Promise<DecisionReceipt> {
    for (;;) {
      const receipt = await this.read(invocationId, projectId);
      if (!receipt || receipt.fingerprint !== fingerprint) throw new DecisionReceiptIntegrityError('Receipt fingerprint mismatch');
      if (terminal.has(receipt.state)) return receipt;
      if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
      await sleep(30, signal);
    }
  }
  private async persist(invocationId: string, receipt: DecisionReceipt): Promise<void> {
    const destination = this.pathFor(invocationId);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(`${JSON.stringify({ receipt, mac: this.mac(receipt) })}\n`); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, destination);
      const dir = await open(this.directory, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } finally { await rm(temporary, { force: true }); }
  }
  private async withLock<T>(invocationId: string, operation: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = `${this.pathFor(invocationId)}.lock`;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        const lock = await open(path, 'wx', 0o600);
        try {
          await lock.writeFile(String(process.pid));
          await lock.sync();
          return await operation();
        } finally { await lock.close(); await rm(path, { force: true }); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const age = await stat(path).then(s => Date.now() - s.mtimeMs, () => 0);
        if (age > 30_000) await rm(path, { force: true });
        await sleep(Math.min(10 + attempt, 100));
      }
    }
    throw new Error('Decision receipt lock timeout');
  }
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new Error('Aborted')); }, { once: true });
  });
}
