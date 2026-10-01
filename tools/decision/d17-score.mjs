#!/usr/bin/env node
/** Local recorded-evidence replay. This command has no live collection mode. */
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { register } from 'tsx/esm/api';
register();
const root = resolve(import.meta.dirname, '../..');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
try {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === '--help') {
    process.stdout.write('Offline D17 scoring: node tools/decision/d17-score.mjs CONFIG.json OUTPUT.json\n'
      + 'Config: run, trustedEvidenceDigest, trustedApprovalDigest, goldFile, integrityFile, trustedIntegrityDigest.\n');
  } else {
    if (args.length !== 2) throw new Error('usage');
    const config = await json(args[0]);
    if (Object.keys(config).sort().join(',') !== 'goldFile,integrityFile,run,trustedApprovalDigest,trustedEvidenceDigest,trustedIntegrityDigest') throw new Error('config');
    const { assertContextArtifactRoot } = await import('../../src/decision/context-live-qualification.ts');
    await assertContextArtifactRoot(root, dirname(resolve(args[1])), 'within');
    const module = await import('./d17-study.mjs');
    const { scoreHeldoutStudy } = await import('../../src/decision/heldout/collector.ts');
    const { writeHeldoutFile } = await import('../../src/decision/heldout/journal.ts');
    const { createHash } = await import('node:crypto');
    const moduleDigest = `sha256:${createHash('sha256').update(await readFile(new URL('./d17-study.mjs', import.meta.url))).digest('hex')}`;
    const report = await scoreHeldoutStudy({ run: resolve(config.run), trustedEvidenceDigest: config.trustedEvidenceDigest,
      trustedApprovalDigest: config.trustedApprovalDigest, module, moduleDigest, gold: await json(config.goldFile),
      integrity: await json(config.integrityFile), trustedIntegrityDigest: config.trustedIntegrityDigest });
    await writeHeldoutFile(resolve(args[1]), report);
    process.stdout.write(JSON.stringify({ providerCalls: 0, decision: report.decision, complete: report.complete }) + '\n');
  }
} catch {
  process.stderr.write('D17 scoring refused: protected inputs, source, evidence, integrity or output check failed.\n');
  process.exitCode = 1;
}
