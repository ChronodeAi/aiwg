#!/usr/bin/env node
/** Source-only held-out collection. No build, network or credential read in prepare/dry-run modes. */
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const args = process.argv.slice(2), mode = args[0] ?? '--help';
const root = resolve(import.meta.dirname, '../..');
const usage = 'No provider calls by default. --prepare MODULE.mjs SEED OUTPUT_DIR; '
  + '--dry-run BUNDLE.json APPROVAL_DIGEST ARTIFACT_ROOT; '
  + '--collect-approved BUNDLE.json APPROVAL_DIGEST ARTIFACT_ROOT (requires AIWG_DECISION_HELDOUT_LIVE=1).\n';
const json = async path => JSON.parse(await readFile(path, 'utf8'));
try {
  if (mode === '--help') { process.stdout.write(usage); }
  else {
    if (!['--prepare', '--dry-run', '--collect-approved'].includes(mode) || args.length !== 4) throw new Error('usage');
    if (mode === '--collect-approved' && process.env.AIWG_DECISION_HELDOUT_LIVE !== '1') throw new Error('gate');
    const { register } = await import('tsx/esm/api'); register();
    const contract = await import('../../src/decision/heldout/contract.ts');
    const journal = await import('../../src/decision/heldout/journal.ts');
    const host = await import('../../src/decision/context-live-qualification.ts');
    if (mode === '--prepare') {
      const output = resolve(args[3]);
      // Check the existing parent before any write; the artifact router remains authoritative.
      await host.assertContextArtifactRoot(root, resolve(output, '..'), 'within');
      const path = resolve(args[1]);
      const digest = `sha256:${createHash('sha256').update(await readFile(path)).digest('hex')}`;
      const module = await import(pathToFileURL(path).href);
      const prepared = await module.prepare(args[2]);
      contract.validateHeldoutInputs(prepared.corpus, prepared.preregistration);
      if (prepared.corpus.provenance.seed !== args[2] || prepared.preregistration.scorerDigest !== digest
        || prepared.corpus.provenance.goldDigest !== contract.heldoutDigest(prepared.gold)) throw new Error('module-pins');
      await mkdir(output, { mode: 0o700 });
      for (const name of ['corpus', 'preregistration', 'gold']) await journal.writeHeldoutFile(join(output, `${name}.json`), prepared[name]);
      await journal.writeHeldoutFile(join(output, 'approval-template.json'), contract.heldoutApprovalTemplate(prepared.corpus, prepared.preregistration));
      process.stdout.write(JSON.stringify({ providerCalls: 0, corpusDigest: contract.heldoutDigest(prepared.corpus),
        preregistrationDigest: contract.heldoutDigest(prepared.preregistration) }) + '\n');
    } else {
      const bundle = await json(args[1]), artifactRoot = resolve(args[3]);
      contract.validateHeldoutBundle(bundle, args[2]);
      await host.assertContextArtifactRoot(root, artifactRoot);
      await host.assertContextLiveSource(root, bundle.approval.sourceCommit);
      if (mode === '--dry-run') {
        const prior = await journal.scanHeldoutSpend(artifactRoot, bundle.approval.study, bundle.approval);
        const estimate = await contract.planHeldoutCollection(bundle, args[2]);
        const studyPrior = prior.studyUsdMicros;
        const portfolioPrior = prior.portfolioUsdMicros;
        const remaining = Math.min(bundle.approval.budget.usd * 1e6, contract.HELDOUT_CAP_USD[bundle.approval.study] * 1e6 - studyPrior,
          contract.HELDOUT_PORTFOLIO_CAP_USD * 1e6 - portfolioPrior);
        const ready = estimate.fitsBeforeStop && estimate.reservedUsdMicros <= Math.floor(remaining * 0.8)
          && !prior.counterBlocked && !prior.attempts.some(a => !a.result || a.result.disposition === 'stop');
        process.stdout.write(JSON.stringify({ ...estimate, priorStudyUsdMicros: studyPrior, priorPortfolioUsdMicros: portfolioPrior, ready }) + '\n');
        if (!ready) process.exitCode = 1;
      } else {
        const { collectHeldoutStudy } = await import('../../src/decision/heldout/collector.ts');
        const result = await collectHeldoutStudy({ enabled: true, bundle, trustedApprovalDigest: args[2], sourceRoot: root, artifactRoot });
        process.stdout.write(JSON.stringify(result) + '\n');
        if (result.status !== 'complete') process.exitCode = 1;
      }
    }
  }
} catch (error) {
  if (error?.category === 'spend-counter-operator-repair-required') process.stderr.write('Spend counter requires operator repair; preserve the counter, head, baselines and run evidence.\n');
  process.stderr.write('Held-out collector refused: mode, approval, provenance, source, artifact root or collection check failed. No automatic retry.\n');
  process.exitCode = 1;
}
