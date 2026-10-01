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
const USAGE = 'D17 experimental/default-off. --dry-run SEED; --prepare SEED OUTPUT_DIR; staged D09 calibration: '
  + '--dry-run-staged SEED; --prepare-staged SEED OUTPUT_DIR; --bundle PREPARED_DIR APPROVAL.json DEV_REVIEW.json DEV_REVIEW_DIGEST OUTPUT.json; '
  + '--fit-calibration RUN APPROVAL_DIGEST SEAL_DIGEST DEV_REVIEW.json DEV_REVIEW_DIGEST NEW_DIR; '
  + '--register-calibration RUN APPROVAL_DIGEST SEAL_DIGEST DEV_REVIEW.json DEV_REVIEW_DIGEST CALIBRATION_REVIEW.json CALIBRATION_REVIEW_DIGEST NEW_DIR.\n'
  + 'Live execution uses tools/decision/heldout-study.mjs --collect-approved only after operator approval.\n';

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
/** `scope` is `uncalibrated-diagnostic` (v1, default) or `staged` (two-phase D09 calibration). */
export async function prepare(seed, scope = 'uncalibrated-diagnostic') {
  if (scope === 'staged') {
    const { prepareD17StagedStudy } = await import('../../src/decision/ensemble-study/staged.ts');
    return prepareD17StagedStudy(seed, byteDigest(await readFile(ownPath)), await sourceDigests());
  }
  if (scope !== 'uncalibrated-diagnostic') throw new Error('D17 scope');
  const { prepareD17Study } = await import('../../src/decision/ensemble-study/corpus.ts');
  return prepareD17Study(seed, byteDigest(await readFile(ownPath)), await sourceDigests());
}
const scopeOf = preregistration => preregistration?.calibration?.scope === 'calibrated' ? 'staged' : 'uncalibrated-diagnostic';
/** Diagnostic scoring only; a staged study scores through `studyModule(context)` with its protected calibration context. */
export async function score(input) {
  if (scopeOf(input.preregistration) === 'staged') throw new Error('D17 staged scoring requires the protected calibration context');
  const { scoreD17Study } = await import('../../src/decision/ensemble-study/score.ts');
  return scoreD17Study(input, await prepare(input.corpus.provenance.seed));
}
/** Staged test-phase module: the context comes from protected host artifacts, never from corpus or provider output. */
export function studyModule(context) {
  return { prepare: seed => prepare(seed, 'staged'), score: async input => {
    const { scoreD17StagedStudy } = await import('../../src/decision/ensemble-study/score.ts');
    return scoreD17StagedStudy(input, await prepare(input.corpus.provenance.seed, 'staged'), context);
  } };
}
const json = async path => JSON.parse(await readFile(resolve(path), 'utf8'));
async function writeDirectory(directory, files) {
  const output = resolve(directory);
  const { assertContextArtifactRoot } = await import('../../src/decision/context-live-qualification.ts');
  const { writeHeldoutFile } = await import('../../src/decision/heldout/journal.ts');
  await assertContextArtifactRoot(root, resolve(output, '..'), 'within');
  await mkdir(output, { mode: 0o700 });
  for (const [name, value] of Object.entries(files)) await writeHeldoutFile(join(output, `${name}.json`), value);
}
/** A prepared directory is trusted only after it is regenerated from its own seed at this source. */
async function preparedFrom(directory) {
  const corpus = await json(join(directory, 'corpus.json'));
  const prepared = await prepare(corpus.provenance.seed, 'staged');
  const { heldoutDigest } = await import('../../src/decision/heldout/contract.ts');
  for (const name of ['corpus', 'preregistration', 'gold']) {
    if (heldoutDigest(await json(join(directory, `${name}.json`))) !== heldoutDigest(prepared[name])) throw new Error('D17 prepared study mismatch');
  }
  return prepared;
}

/** Sealed phase -> fitted (and optionally reviewed) calibration set. No provider call or credential is involved. */
export async function runD17Calibration(mode, args) {
  const approved = mode === '--register-calibration';
  const [run, trustedApprovalDigest, trustedCalibrationPhaseRecordDigest, devReview, devReviewDigest, ...rest] = args;
  if (rest.length !== (approved ? 3 : 1) || !run || !trustedApprovalDigest || !trustedCalibrationPhaseRecordDigest || !devReview || !devReviewDigest) {
    throw new Error('usage');
  }
  const { readHeldoutCalibrationPhase } = await import('../../src/decision/heldout/calibration.ts');
  const { d17CalibrationHandoffFromSealed, registerD17CalibrationFromHandoff } = await import('../../src/decision/ensemble-study/calibration.ts');
  const sealed = await readHeldoutCalibrationPhase(resolve(run), trustedApprovalDigest, trustedCalibrationPhaseRecordDigest);
  // Regenerate the staged study from the sealed corpus seed; a changed source or corpus refuses.
  const prepared = await prepare(sealed.bundle.corpus.provenance.seed, 'staged');
  let handoff = d17CalibrationHandoffFromSealed({ sealed, prepared, trustedApprovalDigest, trustedCalibrationPhaseRecordDigest,
    developmentReview: await json(devReview), trustedDevelopmentReviewDigest: devReviewDigest });
  if (approved) handoff = registerD17CalibrationFromHandoff(handoff, await json(rest[0]), rest[1]);
  await writeDirectory(rest.at(-1), { 'member-mapping': handoff.mappings.member, 'aggregate-mapping': handoff.mappings.aggregate,
    'member-artifact': handoff.artifacts.member, 'aggregate-artifact': handoff.artifacts.aggregate, 'calibration-set': handoff.set,
    'test-approval-template': handoff.approval, ...(approved ? { compatibility: handoff.compatibility } : { 'calibration-review-template': handoff.reviewTemplate }) });
  return { providerCalls: 0, calibrationSetDigest: handoff.calibrationSetDigest,
    memberArtifactDigest: handoff.artifacts.member.digest, aggregateArtifactDigest: handoff.artifacts.aggregate.digest,
    calibrationPhaseRecordDigest: trustedCalibrationPhaseRecordDigest, priorApprovalDigest: trustedApprovalDigest,
    registration: approved ? 'reviewed-and-qualified' : 'pending-operator-review', testApproved: false };
}

/**
 * Assembles the collector's closed bundle only after the 40-item development review is complete and agrees with
 * gold and the text oracle. The shared collector is study-agnostic and its approval schema is closed, so it cannot
 * check this itself; fitting, registration and test scoring re-verify the same anchored review.
 */
export async function runD17Bundle([preparedDir, approvalPath, devReview, devReviewDigest, output, ...extra]) {
  if (!preparedDir || !approvalPath || !devReview || !devReviewDigest || !output || extra.length) throw new Error('usage');
  const prepared = await preparedFrom(resolve(preparedDir));
  const { validateD17DevelopmentReview, assertD17Staged } = await import('../../src/decision/ensemble-study/calibration.ts');
  const { heldoutDigest, validateHeldoutBundle } = await import('../../src/decision/heldout/contract.ts');
  const { assertContextArtifactRoot } = await import('../../src/decision/context-live-qualification.ts');
  const { writeHeldoutFile } = await import('../../src/decision/heldout/journal.ts');
  assertD17Staged(prepared);
  const approval = await json(approvalPath);
  const testPhase = approval?.calibration?.phase === 'test';
  validateD17DevelopmentReview(prepared, await json(devReview), devReviewDigest, { testStagesBlank: !testPhase });
  const bundle = { corpus: prepared.corpus, preregistration: prepared.preregistration, approval };
  validateHeldoutBundle(bundle, heldoutDigest(approval));
  await assertContextArtifactRoot(root, resolve(output, '..'), 'within');
  await writeHeldoutFile(resolve(output), bundle);
  return { providerCalls: 0, phase: approval.calibration.phase, approvalDigest: heldoutDigest(approval),
    corpusDigest: heldoutDigest(prepared.corpus), preregistrationDigest: heldoutDigest(prepared.preregistration),
    developmentReviewDigest: devReviewDigest };
}

async function main() {
  const args = process.argv.slice(2), mode = args[0] ?? '--help';
  if (mode === '--help') { process.stdout.write(USAGE); return; }
  if (mode === '--fit-calibration' || mode === '--register-calibration') {
    process.stdout.write(`${JSON.stringify(await runD17Calibration(mode, args.slice(1)))}\n`); return;
  }
  if (mode === '--bundle') { process.stdout.write(`${JSON.stringify(await runD17Bundle(args.slice(1)))}\n`); return; }
  const modes = { '--dry-run': ['uncalibrated-diagnostic', 2], '--prepare': ['uncalibrated-diagnostic', 3],
    '--dry-run-staged': ['staged', 2], '--prepare-staged': ['staged', 3] };
  if (!modes[mode] || args.length !== modes[mode][1]) throw new Error('usage');
  const scope = modes[mode][0];
  const prepared = await prepare(args[1], scope);
  const { heldoutDigest, heldoutRequest } = await import('../../src/decision/heldout/contract.ts');
  // Projection/token checks are offline; placeholder approval identity is never persisted as an approval.
  let maximumRequestEstimateTokens = 0;
  // Projection is calibration-independent: an unstaged planning binding bounds every row of both phases.
  const planning = { model: 'jev-1.13.0', region: 'offline-planning', credentialRef: 'offline-planning', calibration: { mode: 'uncalibrated-diagnostic' } };
  for (const row of prepared.corpus.rows) {
    const projected = await heldoutRequest(prepared.corpus, prepared.preregistration, planning, row, row.requests[0]);
    maximumRequestEstimateTokens = Math.max(maximumRequestEstimateTokens, projected.estimatedTokens);
  }
  if (mode === '--prepare' || mode === '--prepare-staged') {
    await writeDirectory(args[2], Object.fromEntries(Object.entries(prepared).map(([name, value]) =>
      [name === 'approvalTemplate' ? 'approval-template' : name, value])));
  }
  const preregistrationDigest = heldoutDigest(prepared.preregistration);
  process.stdout.write(JSON.stringify({ ...prepared.dryRun, maximumRequestEstimateTokens,
    corpusDigest: heldoutDigest(prepared.corpus), preregistrationDigest,
    approvalTemplateDigest: heldoutDigest(prepared.approvalTemplate), analysisDigest: heldoutDigest(prepared.analysis),
    splitManifestDigest: heldoutDigest(prepared.splitManifest), goldDigest: heldoutDigest(prepared.gold),
    approvalText: scope === 'staged'
      ? `I, roctinam, approve D17 synthetic-only STAGED D09 calibration preregistration ${preregistrationDigest}, the completed 40-item development review DEVELOPMENT_REVIEW_DIGEST and the separately completed calibration-phase approval digest APPROVAL_DIGEST, with USD 8 study/USD 48 portfolio caps and the frozen 88-assessment review protocol; test access requires a separately reviewed calibration set and test-phase approval; no promotion is authorized.`
      : `I, roctinam, approve D17 synthetic-only UNCALIBRATED diagnostic preregistration ${preregistrationDigest} and the separately completed priced approval digest APPROVAL_DIGEST, with USD 8 study/USD 48 portfolio caps and the frozen 88-assessment review protocol; no D09 qualification, calibrated gates or promotion are authorized.` }) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === ownPath) main().catch(() => {
  process.stderr.write('D17 preparation refused: source pins, protocol, seed, review, calibration, payload bound or artifact root failed.\n'); process.exitCode = 1;
});
