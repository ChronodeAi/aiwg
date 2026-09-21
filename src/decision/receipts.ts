import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../security/artifact-trust.js';
import type { ArtifactPin, DecisionReceipt, DecisionReceiptStore } from './types.js';

export function decisionInvocationFingerprint(input: {
  invocationId: string;
  value: unknown;
  definitions: ArtifactPin[];
  ruleset: ArtifactPin;
  binding: ArtifactPin;
}): string {
  return `sha256:${createHash('sha256').update(canonicalJson({
    invocationId: input.invocationId,
    input: input.value,
    definitions: input.definitions,
    ruleset: input.ruleset,
    binding: input.binding,
  })).digest('hex')}`;
}

export class MemoryDecisionReceiptStore implements DecisionReceiptStore {
  private readonly receipts = new Map<string, DecisionReceipt>();

  async read(invocationId: string): Promise<DecisionReceipt | null> {
    const receipt = this.receipts.get(invocationId);
    return receipt ? structuredClone(receipt) : null;
  }

  async write(invocationId: string, receipt: DecisionReceipt): Promise<void> {
    this.receipts.set(invocationId, structuredClone(receipt));
  }
}

export class FileDecisionReceiptStore implements DecisionReceiptStore {
  constructor(private readonly directory: string) {}

  async read(invocationId: string): Promise<DecisionReceipt | null> {
    try {
      return JSON.parse(await readFile(this.pathFor(invocationId), 'utf8')) as DecisionReceipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async write(invocationId: string, receipt: DecisionReceipt): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.pathFor(invocationId);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, destination);
  }

  private pathFor(invocationId: string): string {
    const filename = `${createHash('sha256').update(invocationId).digest('hex')}.json`;
    return join(this.directory, filename);
  }
}
