import { streamBoundedJsonLines } from '../../../src/sessions/index.js';

const [path, root] = process.argv.slice(2);
if (!path || !root) throw new Error('reader memory probe requires source path and root');

const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
if (!forceGc) throw new Error('reader memory probe requires --expose-gc');

const stream = await streamBoundedJsonLines(
  { selectedPath: path, allowedRoots: [root], maxBytes: 16 * 1024 * 1024 },
  {
    consistency: 'complete',
    limits: {
      maxRecords: 1_000_000,
      maxTotalBytes: 16 * 1024 * 1024,
      maxRecordBytes: 1024,
    },
  },
);

forceGc();
const baseline = process.memoryUsage().heapUsed;
let retainedPeak = baseline;
let count = 0;
let first: unknown;
let last: unknown;
for await (const record of stream) {
  count += 1;
  if (count === 1) first = record.value;
  last = record.value;
  if (count % 50_000 === 0) {
    forceGc();
    retainedPeak = Math.max(retainedPeak, process.memoryUsage().heapUsed);
  }
}
forceGc();
retainedPeak = Math.max(retainedPeak, process.memoryUsage().heapUsed);

process.stdout.write(JSON.stringify({
  count,
  recordsRead: stream.recordsRead,
  first,
  last,
  retainedPeakGrowthBytes: Math.max(0, retainedPeak - baseline),
}));
