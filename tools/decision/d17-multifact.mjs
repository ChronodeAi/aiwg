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
const D17_CONTEXT_KEYS = ['d17CalibrationDir', 'd17CalibrationReviewFile', 'd17CalibrationRun', 'd17DevelopmentReviewFile',
  'trustedD17CalibrationReviewDigest', 'trustedD17DevelopmentReviewDigest'];
const USAGE = 'D17-MF (#2850) experimental/default-off. --dry-run SEED; --prepare SEED NEW_DIR; '
  + '--bundle PREPARED_DIR APPROVAL.json DEV_REVIEW.json DEV_REVIEW_DIGEST OUTPUT.json D17_CALIBRATION_CONTEXT.json; '
  + '--dry-run-ledger BUNDLE.json APPROVAL_DIGEST ARTIFACT_ROOT D17_CALIBRATION_CONTEXT.json; --score CONFIG.json OUTPUT.json.\n'
  + `D17 calibration context: ${D17_CONTEXT_KEYS.join(', ')}.\n`
  + 'Score config: run, trustedEvidenceDigest, trustedApprovalDigest, goldFile, integrityFile, trustedIntegrityDigest, evaluatedAt and the D17 calibration context keys.\n'
  + 'Collection and scoring run at the exact approved source commit.\n'
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

/**
 * Re-derives the registered D17 calibration set bound by the approval from its sealed calibration phase (re-fit,
 * out-of-fold metrics, both reviews) and qualifies the member artifact at `nowEpochMs`; returns the scorer context.
 */
export async function deriveD17Calibration(contextConfig, bindingDigest, nowEpochMs) {
  if (!contextConfig || D17_CONTEXT_KEYS.some(k => typeof contextConfig[k] !== 'string')) throw new Error('D17 calibration context');
  const { readHeldoutCalibrationPhase } = await import('../../src/decision/heldout/calibration.ts');
  const { verifyD17CalibrationSet } = await import('../../src/decision/ensemble-study/calibration.ts');
  const { heldoutDigest } = await import('../../src/decision/heldout/contract.ts');
  const { prepare: prepareD17 } = await import('./d17-study.mjs');
  const dir = resolve(contextConfig.d17CalibrationDir), set = await json(join(dir, 'calibration-set.json'));
  if (heldoutDigest(set) !== bindingDigest) throw new Error('D17-MF calibration binding');
  const sealed = await readHeldoutCalibrationPhase(resolve(contextConfig.d17CalibrationRun), set.priorApprovalDigest, set.calibrationPhaseRecordDigest);
  const d17Prepared = await prepareD17(sealed.bundle.corpus.provenance.seed, 'staged');
  const verified = verifyD17CalibrationSet(d17Prepared, { mode: 'staged', phase: 'test', calibrationArtifactDigest: bindingDigest,
    calibrationPhaseRecordDigest: set.calibrationPhaseRecordDigest, priorApprovalDigest: set.priorApprovalDigest }, {
    sealed, registered: { set, artifacts: { member: await json(join(dir, 'member-artifact.json')), aggregate: await json(join(dir, 'aggregate-artifact.json')) },
      mappings: { member: await json(join(dir, 'member-mapping.json')), aggregate: await json(join(dir, 'aggregate-mapping.json')) } },
    trustedCalibrationSetDigest: bindingDigest,
    calibrationReview: await json(contextConfig.d17CalibrationReviewFile), trustedCalibrationReviewDigest: contextConfig.trustedD17CalibrationReviewDigest,
    developmentReview: await json(contextConfig.d17DevelopmentReviewFile), trustedDevelopmentReviewDigest: contextConfig.trustedD17DevelopmentReviewDigest,
    testPhaseAccessAt: null, nowEpochMs });
  return { set: verified.set, trustedCalibrationSetDigest: verified.setDigest, member: { artifact: verified.member.artifact, mapping: verified.member.mapping } };
}

/**
 * Bundle only for a private seed, after the 40-item development review is complete and cited by the approval, with the
 * registered D17 calibrator re-derived and qualified now, and with a plan that fits the allowance.
 */
export async function runBundle([preparedDir, approvalPath, devReview, devReviewDigest, output, calibrationContext, ...extra]) {
  if (!preparedDir || !approvalPath || !devReview || !devReviewDigest || !output || !calibrationContext || extra.length) throw new Error('usage');
  const prepared = await preparedFrom(resolve(preparedDir));
  const study = await import('../../src/decision/ensemble-study/multifact-study.ts');
  const { heldoutDigest, validateHeldoutBundle } = await import('../../src/decision/heldout/contract.ts');
  const { assertD17ReviewBoundToApproval } = await import('../../src/decision/ensemble-study/calibration.ts');
  const { assertContextArtifactRoot } = await import('../../src/decision/context-live-qualification.ts');
  const { writeHeldoutFile } = await import('../../src/decision/heldout/journal.ts');
  study.assertD17MultifactPrivateSeed(prepared.corpus.provenance.seed);
  const approval = await json(approvalPath);
  if (approval?.calibration?.mode !== 'artifact') throw new Error('D17-MF approval must bind the registered D17 calibration set (artifact mode)');
  study.validateD17MultifactReview(prepared, await json(devReview), devReviewDigest);
  assertD17ReviewBoundToApproval(approval, devReviewDigest);
  const bundle = { corpus: prepared.corpus, preregistration: prepared.preregistration, approval };
  validateHeldoutBundle(bundle, heldoutDigest(approval));
  await deriveD17Calibration(await json(calibrationContext), approval.calibration.calibrationArtifactDigest, Date.now());
  const fit = study.d17MultifactFit(await study.d17MultifactPlan(prepared, approval), study.d17MultifactFreshAllowance(approval));
  if (!fit.fits) throw new Error('D17-MF plan exceeds the approval allowance');
  await assertContextArtifactRoot(root, resolve(output, '..'), 'within');
  await writeHeldoutFile(resolve(output), bundle);
  return { providerCalls: 0, approvalDigest: heldoutDigest(approval), corpusDigest: heldoutDigest(prepared.corpus),
    preregistrationDigest: heldoutDigest(prepared.preregistration), developmentReviewDigest: devReviewDigest, calibratorQualifiedAt: new Date().toISOString(), freshLedger: fit };
}

/** Pre-spend check against the real ledger: shared plan, remaining allowance, seed reuse, private seed and a qualified calibrator now. */
export async function runLedgerDryRun([bundlePath, approvalDigest, artifactRoot, calibrationContext, ...extra]) {
  if (!bundlePath || !approvalDigest || !artifactRoot || !calibrationContext || extra.length) throw new Error('usage');
  const bundle = await json(bundlePath);
  const study = await import('../../src/decision/ensemble-study/multifact-study.ts');
  const { planHeldoutCollection } = await import('../../src/decision/heldout/contract.ts');
  const { scanHeldoutSpend, heldoutCollectionAllowance } = await import('../../src/decision/heldout/journal.ts');
  const { assertD17SeedUnused } = await import('../../src/decision/ensemble-study/staged.ts');
  const { assertContextArtifactRoot } = await import('../../src/decision/context-live-qualification.ts');
  study.assertD17MultifactPrivateSeed(bundle?.corpus?.provenance?.seed);
  await assertContextArtifactRoot(root, resolve(artifactRoot));
  const estimate = await planHeldoutCollection(bundle, approvalDigest);
  const prior = await scanHeldoutSpend(resolve(artifactRoot), 'D17', bundle.approval);
  assertD17SeedUnused(prior.attempts, bundle.approval);
  await deriveD17Calibration(await json(calibrationContext), bundle.approval.calibration.calibrationArtifactDigest, Date.now());
  const fit = study.d17MultifactFit(await study.d17MultifactPlan(bundle, bundle.approval), heldoutCollectionAllowance(bundle.approval, prior));
  const ready = fit.fits && estimate.fitsBeforeStop && !prior.counterBlocked && !prior.attempts.some(a => !a.result || a.result.disposition === 'stop');
  return { providerCalls: 0, plan: { maximumAttempts: estimate.maximumAttempts, reservedTokens: estimate.reservedTokens, reservedUsdMicros: estimate.reservedUsdMicros },
    ledger: fit, prior: { studyUsdMicros: prior.studyUsdMicros, portfolioUsdMicros: prior.portfolioUsdMicros, studyCalls: prior.studyCalls }, ready };
}

/**
 * Scores at a clock no earlier than the latest collection end the collector recorded (qualification.json across the run
 * lineage) and no later than now; the registered D17 calibrator is re-derived and qualified at collection end and now.
 */
export async function runScore([configPath, output, ...extra]) {
  if (!configPath || !output || extra.length) throw new Error('usage');
  const config = await json(configPath);
  const keys = [...D17_CONTEXT_KEYS, 'evaluatedAt', 'goldFile', 'integrityFile', 'run', 'trustedApprovalDigest', 'trustedEvidenceDigest', 'trustedIntegrityDigest'].sort();
  if (Object.keys(config).sort().join(',') !== keys.join(',')) throw new Error('config');
  const nowEpochMs = Date.parse(config.evaluatedAt);
  if (!Number.isSafeInteger(nowEpochMs) || nowEpochMs > Date.now()) throw new Error('config');
  const { readHeldoutFrozen } = await import('../../src/decision/heldout/calibration.ts');
  const { scoreHeldoutStudy } = await import('../../src/decision/heldout/collector.ts');
  const { writeHeldoutFile } = await import('../../src/decision/heldout/journal.ts');
  const { assertContextArtifactRoot } = await import('../../src/decision/context-live-qualification.ts');
  const { heldoutDigest } = await import('../../src/decision/heldout/contract.ts');
  await assertContextArtifactRoot(root, dirname(resolve(output)), 'within');
  const run = resolve(config.run), frozen = await readHeldoutFrozen(run, config.trustedApprovalDigest);
  if (frozen.bundle.approval.calibration.mode !== 'artifact') throw new Error('config');
  const ends = [];
  for (const dir of [run, ...frozen.priorRuns.map(prior => join(dirname(run), prior.runId))]) ends.push(Date.parse((await json(join(dir, 'qualification.json'))).generatedAt));
  if (ends.some(t => !Number.isFinite(t))) throw new Error('collection clock');
  const collectionEndedAt = new Date(Math.max(...ends)).toISOString();
  if (nowEpochMs < Date.parse(collectionEndedAt)) throw new Error('scoring clock');
  const derived = await deriveD17Calibration(config, frozen.bundle.approval.calibration.calibrationArtifactDigest, nowEpochMs);
  const scored = await scoreHeldoutStudy({ run, trustedEvidenceDigest: config.trustedEvidenceDigest,
    trustedApprovalDigest: config.trustedApprovalDigest, module: studyModule({ ...derived, collectionEndedAt, nowEpochMs }), moduleDigest: byteDigest(await readFile(ownPath)),
    gold: await json(config.goldFile), integrity: await json(config.integrityFile), trustedIntegrityDigest: config.trustedIntegrityDigest });
  await writeHeldoutFile(resolve(output), scored);
  return { providerCalls: 0, decision: scored.decision, complete: scored.complete, collectionEndedAt, reportDigest: heldoutDigest(scored.diagnostics) };
}

async function main() {
  const args = process.argv.slice(2), mode = args[0] ?? '--help';
  if (mode === '--help') { process.stdout.write(USAGE); return; }
  if (mode === '--bundle') { process.stdout.write(`${JSON.stringify(await runBundle(args.slice(1)))}\n`); return; }
  if (mode === '--score') { process.stdout.write(`${JSON.stringify(await runScore(args.slice(1)))}\n`); return; }
  if (mode === '--dry-run-ledger') {
    const result = await runLedgerDryRun(args.slice(1));
    process.stdout.write(`${JSON.stringify(result)}\n`); if (!result.ready) process.exitCode = 1; return;
  }
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
