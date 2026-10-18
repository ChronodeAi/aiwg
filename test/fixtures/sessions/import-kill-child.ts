import { importDiscoveryManifest } from '../../../src/sessions/batch-import.js';
import { acquireImportLease } from '../../../src/sessions/import-lease.js';
import { SessionRepository } from '../../../src/sessions/repository.js';
import { readDiscoveryManifest } from '../../../src/sessions/workspace-discovery.js';

const [database, manifestPath] = process.argv.slice(2);
const manifest = await readDiscoveryManifest(manifestPath!);
const lease = await acquireImportLease(database!, 'kill-test-import');
const repository = new SessionRepository(database!);
try {
  await importDiscoveryManifest({
    manifest,
    repository,
    fault(boundary) {
      if (boundary !== 'source-staged') return;
      process.send?.('source-staged');
      // Pause at a durable boundary so the parent can kill an actual import.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
      throw new Error('parent did not terminate the import within 10 seconds');
    },
  });
} finally {
  repository.close();
  await lease.release();
}
