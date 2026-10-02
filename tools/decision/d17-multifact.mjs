#!/usr/bin/env node
/** D17-MF calibrated multi-fact probe (#2850). Offline by default; collection uses tools/decision/heldout-study.mjs. */
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { resolve, join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';
register();
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const ownPath = fileURLToPath(import.meta.url);
const byteDigest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const json = async path => JSON.parse(await readFile(resolve(path), 'utf8'));
const USAGE = 'D17-MF (#2850) experimental/default-off. --dry-run SEED; --prepare SEED NEW_DIR; '
  + '--bundle PREPARED_DIR APPROVAL.json DEV_REVIEW.json DEV_REVIEW_DIGEST OUTPUT.json; --score CONFIG.json OUTPUT.json.\n'
  + 'Score config: run, trustedEvidenceDigest, trustedApprovalDigest, goldFile, integrityFile, trustedIntegrityDigest, evaluatedAt, '
  + 'd17CalibrationRun, d17CalibrationDir, d17CalibrationReviewFile, trustedD17CalibrationReviewDigest, d17DevelopmentReviewFile, trustedD17DevelopmentReviewDigest.\n'
  + 'Live collection: tools/decision/heldout-study.mjs --collect-approved, only after operator approval.\n';

async function sourceDigests() {
  const files = [join(root, 'package.json'), join(root, 'package-lock.json'), join(root, 'tsconfig.json')];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path); else if (entry.isFile()) files.push(path); else throw new Error('D17-MF source links are not accepted');
    }
  }
  await walk(join(root, 'src')); await walk(join(root, 'schemas')); await walk(join(root, 'tools/decision'));
  const digests = {};
  for (const path of files.sort()) digests[relative(root, path)] = byteDigest(await readFile(path));
  return digests;
}
export async function prepare(seed) {
  const { prepareD17MultifactStudy } = await import('../../src/decision/ensemble-study/multifact-study.ts');
  return prepareD17MultifactStudy(seed, byteDigest(await readFile(ownPath)), await sourceDigests());
}
/** Collector study module: the scoring context (re-derived D17 calibration) is supplied by the host. */
export function studyModule(context) {
  return { prepare, score: async input => {
    const { scoreD17Multifact } = await import('../../src/decision/ensemble-study/multifact-study.ts');
    return scoreD17Multifact(input, await prepare(input.corpus.provenance.seed), context);
  } };
}
async function writeDirectory(directory, files) {
  const output = resolve(directory);
  const { assertContextArtifactRoot } = await import('../../src/decision/context-live-qualification.ts');
  const { writeHeldoutFile } = await import('../../src/decision/heldout/journal.ts');
  await assertContextArtifactRoot(root, resolve(output, '..'), 'within');
  await mkdir(output, { mode: 0o700 });
  for (const [name, value] of Object.entries(files)) await writeHeldoutFile(join(output, `${name}.json`), value);
}
async function preparedFrom(directory) {
  const corpus = await json(join(directory, 'corpus.json')), prepared = await prepare(corpus.provenance.seed);
  const { heldoutDigest } = await import('../../src/decision/heldout/contract.ts');
  for (const name of ['corpus', 'preregistration', 'gold']) {
    if (heldoutDigest(await json(join(directory, `${name}.json`))) !== heldoutDigest(prepared[name])) throw new Error('D17-MF prepared study mismatch');
  }
  return prepared;
}

/** Bundle only after the 40-item development review is complete and cited by the approval, and the plan fits the allowance. */
export async function runBundle([preparedDir, approvalPath, devReview, devReviewDigest, output, ...extra]) {
  if (!preparedDir || !approvalPath || !devReview || !devReviewDigest || !output || extra.length) throw new Error('usage');
  const prepared = await preparedFrom(resolve(preparedDir));
  const study = await import('../../src/decision/ensemble-study/multifact-study.ts');
  const { heldoutDigest, validateHeldoutBundle } = await import('../../src/decision/heldout/contract.ts');
  const { assertD17ReviewBoundToApproval } = await import('../../src/decision/ensemble-study/calibration.ts');
  const { assertContextArtifactRoot } = await import('../../src/decision/context-live-qualification.ts');
  const { writeHeldoutFile } = await import('../../src/decision/heldout/journal.ts');
  const approval = await json(approvalPath);
  if (approval?.calibration?.mode !== 'artifact') throw new Error('D17-MF approval must bind the registered D17 calibration set (artifact mode)');
  study.validateD17MultifactReview(prepared, await json(devReview), devReviewDigest);
  assertD17ReviewBoundToApproval(approval, devReviewDigest);
  const bundle = { corpus: prepared.corpus, preregistration: prepared.preregistration, approval };
  validateHeldoutBundle(bundle, heldoutDigest(approval));
  const fit = study.d17MultifactFit(await study.d17MultifactPlan(prepared, approval), study.d17MultifactFreshAllowance(approval));
  if (!fit.fits) throw new Error('D17-MF plan exceeds the approval allowance');
  await assertContextArtifactRoot(root, resolve(output, '..'), 'within');
  await writeHeldoutFile(resolve(output), bundle);
  return { providerCalls: 0, approvalDigest: heldoutDigest(approval), corpusDigest: heldoutDigest(prepared.corpus),
    preregistrationDigest: heldoutDigest(prepared.preregistration), developmentReviewDigest: devReviewDigest, freshLedger: fit };
}

/** Re-derives the registered D17 calibration set from its sealed phase, then scores through the shared collector boundary. */
export async function runScore([configPath, output, ...extra]) {
  if (!configPath || !output || extra.length) throw new Error('usage');
  const config = await json(configPath);
  const keys = ['d17CalibrationDir', 'd17CalibrationReviewFile', 'd17CalibrationRun', 'd17DevelopmentReviewFile', 'evaluatedAt', 'goldFile', 'integrityFile', 'run',
    'trustedApprovalDigest', 'trustedD17CalibrationReviewDigest', 'trustedD17DevelopmentReviewDigest', 'trustedEvidenceDigest', 'trustedIntegrityDigest'];
  if (Object.keys(config).sort().join(',') !== keys.join(',')) throw new Error('config');
  const nowEpochMs = Date.parse(config.evaluatedAt);
  if (!Number.isSafeInteger(nowEpochMs) || nowEpochMs > Date.now()) throw new Error('config');
  const { readHeldoutFrozen, readHeldoutCalibrationPhase } = await import('../../src/decision/heldout/calibration.ts');
  const { verifyD17CalibrationSet } = await import('../../src/decision/ensemble-study/calibration.ts');
  const { prepare: prepareD17 } = await import('./d17-study.mjs');
  const { scoreHeldoutStudy } = await import('../../src/decision/heldout/collector.ts');
  const { writeHeldoutFile } = await import('../../src/decision/heldout/journal.ts');
  const { assertContextArtifactRoot } = await import('../../src/decision/context-live-qualification.ts');
  const { heldoutDigest } = await import('../../src/decision/heldout/contract.ts');
  await assertContextArtifactRoot(root, dirname(resolve(output)), 'within');
  const frozen = await readHeldoutFrozen(resolve(config.run), config.trustedApprovalDigest);
  const binding = frozen.bundle.approval.calibration;
  if (binding.mode !== 'artifact' || typeof frozen.testPhaseAccessAt === 'string' && nowEpochMs < Date.parse(frozen.testPhaseAccessAt)) throw new Error('config');
  const dir = resolve(config.d17CalibrationDir), set = await json(join(dir, 'calibration-set.json'));
  if (heldoutDigest(set) !== binding.calibrationArtifactDigest) throw new Error('D17-MF calibration binding');
  const sealed = await readHeldoutCalibrationPhase(resolve(config.d17CalibrationRun), set.priorApprovalDigest, set.calibrationPhaseRecordDigest);
  const d17Prepared = await prepareD17(sealed.bundle.corpus.provenance.seed, 'staged');
  const verified = verifyD17CalibrationSet(d17Prepared, { mode: 'staged', phase: 'test', calibrationArtifactDigest: binding.calibrationArtifactDigest,
    calibrationPhaseRecordDigest: set.calibrationPhaseRecordDigest, priorApprovalDigest: set.priorApprovalDigest }, {
    sealed, registered: { set, artifacts: { member: await json(join(dir, 'member-artifact.json')), aggregate: await json(join(dir, 'aggregate-artifact.json')) },
      mappings: { member: await json(join(dir, 'member-mapping.json')), aggregate: await json(join(dir, 'aggregate-mapping.json')) } },
    trustedCalibrationSetDigest: binding.calibrationArtifactDigest,
    calibrationReview: await json(config.d17CalibrationReviewFile), trustedCalibrationReviewDigest: config.trustedD17CalibrationReviewDigest,
    developmentReview: await json(config.d17DevelopmentReviewFile), trustedDevelopmentReviewDigest: config.trustedD17DevelopmentReviewDigest,
    testPhaseAccessAt: null, nowEpochMs });
  const context = { set: verified.set, trustedCalibrationSetDigest: verified.setDigest,
    member: { artifact: verified.member.artifact, mapping: verified.member.mapping }, nowEpochMs };
  const scored = await scoreHeldoutStudy({ run: resolve(config.run), trustedEvidenceDigest: config.trustedEvidenceDigest,
    trustedApprovalDigest: config.trustedApprovalDigest, module: studyModule(context), moduleDigest: byteDigest(await readFile(ownPath)),
    gold: await json(config.goldFile), integrity: await json(config.integrityFile), trustedIntegrityDigest: config.trustedIntegrityDigest });
  await writeHeldoutFile(resolve(output), scored);
  return { providerCalls: 0, decision: scored.decision, complete: scored.complete, reportDigest: heldoutDigest(scored.diagnostics) };
}

async function main() {
  const args = process.argv.slice(2), mode = args[0] ?? '--help';
  if (mode === '--help') { process.stdout.write(USAGE); return; }
  if (mode === '--bundle') { process.stdout.write(`${JSON.stringify(await runBundle(args.slice(1)))}\n`); return; }
  if (mode === '--score') { process.stdout.write(`${JSON.stringify(await runScore(args.slice(1)))}\n`); return; }
  if (!['--dry-run', '--prepare'].includes(mode) || args.length !== (mode === '--prepare' ? 3 : 2)) throw new Error('usage');
  const prepared = await prepare(args[1]);
  const study = await import('../../src/decision/ensemble-study/multifact-study.ts');
  const { heldoutDigest } = await import('../../src/decision/heldout/contract.ts');
  const planning = { ...prepared.approvalTemplate, region: 'offline-planning', credentialRef: 'offline-planning' };
  const plan = await study.d17MultifactPlan(prepared, planning);
  const fit = study.d17MultifactFit(plan, study.d17MultifactFreshAllowance({ ...planning, priorStudySpendUsd: 0, priorPortfolioSpendUsd: 0 }));
  if (mode === '--prepare') {
    await writeDirectory(args[2], { corpus: prepared.corpus, preregistration: prepared.preregistration, gold: prepared.gold, analysis: prepared.analysis,
      audit: prepared.audit, 'approval-template': prepared.approvalTemplate, reviewTemplate: prepared.reviewTemplate });
  }
  process.stdout.write(JSON.stringify({ providerCalls: 0, rows: prepared.corpus.rows.length, plan, freshLedgerFit: fit, budget: prepared.approvalTemplate.budget,
    audit: { equalizedPasses: prepared.audit.equalizedPasses, equalizedMax: prepared.audit.equalizedMax, controlMax: prepared.audit.controlMax },
    corpusDigest: heldoutDigest(prepared.corpus), preregistrationDigest: heldoutDigest(prepared.preregistration), analysisDigest: heldoutDigest(prepared.analysis),
    goldDigest: heldoutDigest(prepared.gold), auditDigest: prepared.analysis.auditDigest, approvalTemplateDigest: heldoutDigest(prepared.approvalTemplate),
    reviewTemplateDigest: heldoutDigest(prepared.reviewTemplate) }) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === ownPath) main().catch(() => {
  process.stderr.write('D17-MF refused: source pins, seed, audit, review, calibration, budget or artifact root failed.\n'); process.exitCode = 1;
});
