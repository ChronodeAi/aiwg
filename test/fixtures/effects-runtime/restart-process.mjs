// Pause at a durable effect boundary so the parent can kill before acknowledgment.
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { openEffectLedger, staticKeyProvider, recordIntent, reconcileEffect,
  writeCheckpoint, createVerifierRegistry, fileDigestVerifier, payloadDigest } from '../../../src/effects/index.ts';

const [projectDir, seedHex, boundary] = process.argv.slice(2);
const bytes = 'one synthetic effect\n';
const file = join(projectDir, 'applied.txt');
const input = { kind: 'file.digest', target: `file:${file}@${payloadDigest(bytes)}`,
  context: {}, payloadDigest: payloadDigest(bytes) };
const ledger = openEffectLedger({ projectDir,
  scope: { tenant: 'local', project: 'example/repo', subsystem: 'delivery' },
  writer: 'before-crash', keyProvider: staticKeyProvider(seedHex),
  clock: () => Date.parse('2026-09-24T10:00:00Z') });
try {
  const intent = await recordIntent(ledger, input);
  await writeCheckpoint(ledger);
  if (!intent.idempotent) {
    const handle = await open(file, 'a', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
  }
  if (boundary === 'completed') await reconcileEffect(ledger, intent.effectId, {
    verifiers: createVerifierRegistry([fileDigestVerifier({ root: projectDir })]),
  });
  // Register the hold before reporting state; no timer determines the crash point.
  const held = once(process, 'message');
  process.send({ boundary, intent, input });
  await held;
} catch (error) {
  process.stderr.write(String(error?.stack ?? error));
  process.exit(1);
}
