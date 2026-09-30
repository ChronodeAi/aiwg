#!/usr/bin/env node
/** Source-only D29 preparation. Collection uses the separately approved shared collector CLI. */
import { resolve, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { register } from 'tsx/esm/api';
register();
const [mode = '--dry-run', seed = 'd29-study-v2', destination] = process.argv.slice(2);
try {
  if (!['--dry-run', '--prepare'].includes(mode) || mode === '--prepare' && !destination) throw new Error('usage');
  const { prepare, dryRun } = await import('./studies/d29.mjs');
  const prepared = await prepare(seed);
  if (mode === '--prepare') {
    const { assertContextArtifactRoot } = await import('../../src/decision/context-live-qualification.ts');
    const { writeHeldoutFile } = await import('../../src/decision/heldout/journal.ts');
    const root = resolve(import.meta.dirname, '../..'), output = resolve(destination);
    await assertContextArtifactRoot(root, resolve(output, '..'), 'within');
    await mkdir(output, { mode: 0o700 });
    for (const [name, value] of Object.entries(prepared)) await writeHeldoutFile(join(output, `${name === 'approval' ? 'approval-template' : name}.json`), value);
  }
  process.stdout.write(`${JSON.stringify(await dryRun(prepared))}\n`);
} catch {
  process.stderr.write('D29 refused: use --dry-run SEED or --prepare SEED NEW_CANONICAL_ARTIFACT_DIRECTORY.\n');
  process.exitCode = 1;
}
