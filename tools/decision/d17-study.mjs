#!/usr/bin/env node
/** Experimental D17 preparation; default execution is offline and never resolves credentials. */
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';
register();
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const ownPath = fileURLToPath(import.meta.url);
const byteDigest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** All runtime source and schemas are pinned, including transitive projection, redaction and scoring helpers. */
async function sourceDigests() {
  const files = [join(root, 'package.json'), join(root, 'package-lock.json'), join(root, 'tsconfig.json')];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error('D17 source links are not accepted');
    }
  }
  await walk(join(root, 'src')); await walk(join(root, 'schemas')); await walk(join(root, 'tools/decision'));
  const digests = {};
  for (const path of files.sort()) digests[relative(root, path)] = byteDigest(await readFile(path));
  return digests;
}
export async function prepare(seed) {
  const { prepareD17Study } = await import('../../src/decision/ensemble-study/corpus.ts');
  return prepareD17Study(seed, byteDigest(await readFile(ownPath)), await sourceDigests());
}
export async function score(input) {
  const { scoreD17Study } = await import('../../src/decision/ensemble-study/score.ts');
  return scoreD17Study(input, await prepare(input.corpus.provenance.seed));
}
async function main() {
  const args = process.argv.slice(2), mode = args[0] ?? '--help';
  if (mode === '--help') {
    process.stdout.write('D17 experimental/default-off. --dry-run SEED; --prepare SEED OUTPUT_DIR.\n'
      + 'Live execution uses tools/decision/heldout-study.mjs --collect-approved only after operator approval.\n');
    return;
  }
  if (!['--dry-run', '--prepare'].includes(mode) || args.length !== (mode === '--prepare' ? 3 : 2)) throw new Error('usage');
  const prepared = await prepare(args[1]);
  const { heldoutDigest, heldoutRequest } = await import('../../src/decision/heldout/contract.ts');
  // Projection/token checks are offline; placeholder approval identity is never persisted as an approval.
  let maximumRequestEstimateTokens = 0;
  for (const row of prepared.corpus.rows) {
    const projected = await heldoutRequest(prepared.corpus, prepared.preregistration,
      { model: 'jev-1.13.0', region: 'offline-planning', credentialRef: 'offline-planning' }, row, row.requests[0]);
    maximumRequestEstimateTokens = Math.max(maximumRequestEstimateTokens, projected.estimatedTokens);
  }
  if (mode === '--prepare') {
    const output = resolve(args[2]);
    const { assertContextArtifactRoot } = await import('../../src/decision/context-live-qualification.ts');
    const { writeHeldoutFile } = await import('../../src/decision/heldout/journal.ts');
    await assertContextArtifactRoot(root, resolve(output, '..'), 'within');
    await mkdir(output, { mode: 0o700 });
    for (const [name, value] of Object.entries(prepared)) await writeHeldoutFile(join(output,
      `${name === 'approvalTemplate' ? 'approval-template' : name}.json`), value);
  }
  process.stdout.write(JSON.stringify({ ...prepared.dryRun, maximumRequestEstimateTokens,
    corpusDigest: heldoutDigest(prepared.corpus), preregistrationDigest: heldoutDigest(prepared.preregistration),
    approvalTemplateDigest: heldoutDigest(prepared.approvalTemplate), analysisDigest: heldoutDigest(prepared.analysis),
    splitManifestDigest: heldoutDigest(prepared.splitManifest), goldDigest: heldoutDigest(prepared.gold),
    approvalText: `I, roctinam, approve D17 synthetic-only preregistration ${heldoutDigest(prepared.preregistration)} and the separately completed priced approval digest APPROVAL_DIGEST, with USD 8 study/USD 48 portfolio caps and the frozen 88-assessment review protocol; no promotion is authorized.` }) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === ownPath) main().catch(() => {
  process.stderr.write('D17 preparation refused: source pins, protocol, seed, payload bound or artifact root failed.\n'); process.exitCode = 1;
});
