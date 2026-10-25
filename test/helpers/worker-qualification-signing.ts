/** Temporary effect-ledger trust for synthetic worker approval fixtures. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateLedgerKeySecret } from '../../src/effects/keys.js';
import { effectSession, openLedger } from '../../src/effects/host.js';
import { initLedgerKeyring } from '../../src/effects/ledger.js';
import { canonicalJson } from '../../src/security/artifact-trust.js';

/** Caller owns and removes root. Never opens the operator's key or auth files. */
export async function workerSigningFixture(root: string, projectDir: string) {
  const keyPath = path.join(root, 'synthetic-ledger-key');
  const artifacts = path.join(root, 'synthetic-ledger-artifacts');
  await mkdir(path.join(projectDir, '.aiwg'), { recursive: true });
  await mkdir(artifacts, { recursive: true });
  await writeFile(keyPath, generateLedgerKeySecret(), { mode: 0o600 });
  const configPath = path.join(projectDir, '.aiwg/aiwg.config');
  const config = await readFile(configPath, 'utf8').then(JSON.parse, () => ({ version: '1' }));
  config.effects = { project: 'synthetic-workers', keyProvider: { type: 'file', path: keyPath } };
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(path.join(projectDir, '.aiwg-location'), artifacts);
  const ledger = openLedger(await effectSession(projectDir));
  const keyring = await initLedgerKeyring(ledger);
  const key = await ledger.signingKey();
  return {
    keyPath, keyring, artifacts,
    sign<T extends object>(record: T): T & { signature: { keyid: string; sig: string; signedAt: string; projectDir: string; scope: typeof keyring.scope } } {
      // Normalize the same JSON representation persisted by the store.
      const { signature: _old, ...body } = JSON.parse(JSON.stringify(record));
      const signedAt = new Date().toISOString();
      const scope = keyring.scope;
      const payload = Buffer.from(canonicalJson({ record: body, signedAt, projectDir, scope }));
      return Object.assign(record, { signature: { keyid: key.keyid, signedAt, projectDir, scope,
        sig: key.signPae('application/vnd.aiwg.worker-installation-qualification+json', payload) } });
    },
  };
}
