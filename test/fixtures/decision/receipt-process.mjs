import { FileDecisionReceiptStore } from '../../../src/decision/receipts.ts';
import { readFileSync } from 'node:fs';

const [directory, keyHex, invocationId, mode = 'acquire', targetState] = process.argv.slice(2);
const store = new FileDecisionReceiptStore(directory, { integrityKey: Buffer.from(keyHex, 'hex') });
process.stdout.write('ready\n');
process.stdin.once('data', async () => {
  try {
    const result = await store.acquire(invocationId, 'project', `sha256:${'a'.repeat(64)}`);
    if (mode === 'transition') {
      if (!targetState) throw new Error('Missing target state');
      if (result.receipt.state !== targetState) {
        const { nextReceipt } = await import('../../../src/decision/receipts.ts');
        const existing = result.receipt;
        const final = JSON.parse(readFileSync('examples/decision/ruleset-result.json', 'utf8'));
        final.spec.invocationId = invocationId;
        const next = nextReceipt(existing, targetState, {
          ...(targetState === 'remote-handle-known' ? { remoteHandles: ['handle-1'] } : {}),
          ...(targetState === 'completed' ? { result: final } : {}),
        });
        await store.compareAndSwap(invocationId, 'project', existing.revision, next);
      }
      process.stdout.write(`${targetState}\n`);
      setInterval(() => undefined, 1000);
      return;
    }
    if (mode === 'dispatch' && result.owner) {
      const { nextReceipt } = await import('../../../src/decision/receipts.ts');
      await store.compareAndSwap(invocationId, 'project', result.receipt.revision, nextReceipt(result.receipt, 'dispatched'));
      process.stdout.write('dispatched\n');
      setInterval(() => undefined, 1000);
      return;
    }
    process.stdout.write(`${JSON.stringify({ owner: result.owner, revision: result.receipt.revision })}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(String(error));
    process.exit(1);
  }
});
