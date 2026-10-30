// Context pruning digests and shared validation errors.
import { sha256 } from './compile-cache/identity.js';
import type { ContextPruningPairRecord, ContextPruningCandidate, ContextPruningReceipt } from './context-pruning-types.js';

export class ContextPruningError extends Error {
  constructor(message: string, readonly reason: 'invalid-input' | 'schema' | 'semantic') {
    super(message);
    this.name = 'ContextPruningError';
  }
}

export const SHA = /^sha256:[0-9a-f]{64}$/;
export function contextPruningDigest(value: unknown): `sha256:${string}` {
  return sha256(value);
}

/** Order-independent digest of the frozen evaluation pairs: sorted (pairId, slice) tuples. */
export function contextPruningPairSetDigest(pairs: readonly ContextPruningPairRecord[]): `sha256:${string}` {
  const tuples = pairs.map(pair => [pair.pairId, pair.slice] as const)
    .sort(([a, sa], [b, sb]) => a < b ? -1 : a > b ? 1 : sa < sb ? -1 : sa > sb ? 1 : 0);
  return contextPruningDigest({ schemaVersion: 'decision-context-pruning-pair-set/v1', pairs: tuples });
}

/** Identity of one pilot run over an ordered candidate set, optionally tied to an evaluation pair. */
export function contextPruningRunId(pairId: string | null, candidates: readonly ContextPruningCandidate[]): `sha256:${string}` {
  return contextPruningDigest({
    schemaVersion: 'decision-context-pruning-run-id/v1',
    pairId,
    candidates: candidates.map(candidate => contextPruningDigest(candidate)),
  });
}

/** Order-independent digest of a receipt set, for anchoring the evaluated receipts separately from the report. */
export function contextPruningReceiptSetDigest(receipts: readonly ContextPruningReceipt[]): `sha256:${string}` {
  return contextPruningDigest({
    schemaVersion: 'decision-context-pruning-receipt-set/v1',
    receipts: receipts.map(receipt => receipt.receiptDigest).sort(),
  });
}

export function requirePlain(value: unknown, label: string): void {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new ContextPruningError(`${label} must be a plain object`, 'schema');
  }
}
