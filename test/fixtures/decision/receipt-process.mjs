import { FileDecisionReceiptStore } from '../../../src/decision/receipts.ts';

const [directory, keyHex, invocationId, mode = 'acquire'] = process.argv.slice(2);
const store = new FileDecisionReceiptStore(directory, { integrityKey: Buffer.from(keyHex, 'hex') });
process.stdout.write('ready\n');
process.stdin.once('data', async () => {
  try {
    const result = await store.acquire(invocationId, 'project', `sha256:${'a'.repeat(64)}`);
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
