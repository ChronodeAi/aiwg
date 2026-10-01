#!/usr/bin/env node
/** Source-only D29 preparation and sealed calibration handoff. Collection requires the shared collector CLI. */
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { register } from 'tsx/esm/api';
register();

export async function runD29Command(args) {
  const [mode = '--dry-run', seed = 'd29-study-v6', destination] = args;
  const { prepare, dryRun } = await import('./studies/d29.mjs');
  const { assertContextArtifactRoot } = await import('../../src/decision/context-live-qualification.ts');
  const { writeHeldoutFile, readHeldoutFile } = await import('../../src/decision/heldout/journal.ts');
  const root = resolve(import.meta.dirname, '../..');
  const write = async (directory, files) => {
    const output = resolve(directory);
    await assertContextArtifactRoot(root, resolve(output, '..'), 'within');
    await mkdir(output, { mode: 0o700 });
    for (const [name, value] of Object.entries(files)) await writeHeldoutFile(join(output, `${name}.json`), value);
  };
  if (mode === '--fit-calibration' || mode === '--register-calibration') {
    const [run, trustedApprovalDigest, trustedCalibrationPhaseRecordDigest, ...rest] = args.slice(1);
    const approved = mode === '--register-calibration';
    if (rest.length !== (approved ? 3 : 1) || !run || !trustedApprovalDigest || !trustedCalibrationPhaseRecordDigest) throw new Error('usage');
    const { prepareCalibrationHandoff, registerCalibrationHandoff } = await import('./studies/d29-calibration.mjs');
    const input = { run: resolve(run), trustedApprovalDigest, trustedCalibrationPhaseRecordDigest };
    const handoff = approved ? await registerCalibrationHandoff({ ...input, review: await readHeldoutFile(resolve(rest[0])), trustedReviewDigest: rest[1] })
      : await prepareCalibrationHandoff(input);
    await write(rest.at(-1), { 'readiness-mapping': handoff.mapping, 'calibration-artifact': handoff.artifact,
      'test-approval-template': handoff.approval, ...(approved ? { compatibility: handoff.compatibility }
        : { 'calibration-review-template': { schemaVersion: 'decision-d29-calibration-review/v1', approved: null, reviewer: 'roctinam',
          calibrationArtifactDigest: handoff.calibrationArtifactDigest, approvalReference: null, reviewedAt: null } }) });
    return { providerCalls: 0, calibrationArtifactDigest: handoff.calibrationArtifactDigest,
      calibrationPhaseRecordDigest: trustedCalibrationPhaseRecordDigest, priorApprovalDigest: trustedApprovalDigest,
      registration: approved ? 'reviewed' : 'pending-operator-review', testApproved: false };
  }
  if (!['--dry-run', '--prepare'].includes(mode) || args.length > 3 || mode === '--prepare' && !destination) throw new Error('usage');
  const prepared = await prepare(seed);
  if (mode === '--prepare') await write(destination, Object.fromEntries(Object.entries(prepared).map(([name, value]) => [name === 'approval' ? 'approval-template' : name, value])));
  return dryRun(prepared);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(await runD29Command(process.argv.slice(2)))}\n`); }
  catch {
    process.stderr.write('D29 refused: use --dry-run SEED, --prepare SEED NEW_CANONICAL_ARTIFACT_DIRECTORY, --fit-calibration RUN APPROVAL_DIGEST SEAL_DIGEST NEW_DIRECTORY, or --register-calibration RUN APPROVAL_DIGEST SEAL_DIGEST REVIEW.json REVIEW_DIGEST NEW_DIRECTORY.\n');
    process.exitCode = 1;
  }
}
