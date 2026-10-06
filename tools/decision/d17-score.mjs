#!/usr/bin/env node
/** Local recorded-evidence replay. This command has no live collection mode. */
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { register } from 'tsx/esm/api';
register();
const root = resolve(import.meta.dirname, '../..');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
/** `--staged` writes the collector wrapper; the D17 report is its `diagnostics`. */
const d17Report = value => value?.schemaVersion === 'decision-heldout-score/v1' ? value.diagnostics : value;
const DIAGNOSTIC = ['goldFile', 'integrityFile', 'run', 'trustedApprovalDigest', 'trustedEvidenceDigest', 'trustedIntegrityDigest'];
const STAGED = [...DIAGNOSTIC, 'calibrationDir', 'calibrationReviewFile', 'calibrationRun', 'developmentReviewFile', 'evaluatedAt',
  'trustedCalibrationReviewDigest', 'trustedCalibrationSetDigest', 'trustedDevelopmentReviewDigest'].sort();
const TRADEOFF = ['tradeoffApprovalFile', 'trustedTradeoffApprovalDigest'];
const HANDOFF = [...STAGED, 'operator', 'report', 'trustedReportDigest', ...TRADEOFF].sort();
const NATIVE = ['integrityFile', 'record', 'report', 'run', 'trustedApprovalDigest', 'trustedIntegrityDigest', 'trustedRecordDigest', 'trustedReportDigest', ...TRADEOFF];
const OPERATOR = ['alias', 'aliasRevision', 'approvalReference', 'approvedAt', 'eligibilityId', 'integrityReportId'];
const HELP = 'Offline D17 scoring: node tools/decision/d17-score.mjs CONFIG.json OUTPUT.json\n'
  + `Config: run, trustedEvidenceDigest, trustedApprovalDigest, goldFile, integrityFile, trustedIntegrityDigest.\n`
  + 'Staged D09 test phase: --staged CONFIG.json OUTPUT.json (adds calibrationRun, calibrationDir, trustedCalibrationSetDigest, calibrationReviewFile, '
  + 'trustedCalibrationReviewDigest, developmentReviewFile, trustedDevelopmentReviewDigest, evaluatedAt); '
  + '--native-handoff CONFIG.json NEW_DIR (adds report, trustedReportDigest, operator, tradeoffApprovalFile, trustedTradeoffApprovalDigest); '
  + '--native CONFIG.json NEW_DIR (report, trustedReportDigest, record, trustedRecordDigest, integrityFile, trustedIntegrityDigest, run, trustedApprovalDigest, '
  + 'tradeoffApprovalFile, trustedTradeoffApprovalDigest). Tradeoff fields may be null; D09 promotion eligibility is applied by the host gateway.\n';
const closed = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error('config');
};
const moduleDigest = async () => `sha256:${createHash('sha256').update(await readFile(new URL('./d17-study.mjs', import.meta.url))).digest('hex')}`;

/**
 * Protected host calibration context for the staged test phase. The calibration set is re-derived from the sealed phase and
 * must equal the registered files; the scoring clock may not precede the calibration review or the recorded first test access.
 */
async function stagedContext(config) {
  const nowEpochMs = Date.parse(config.evaluatedAt);
  if (!Number.isSafeInteger(nowEpochMs) || nowEpochMs > Date.now()) throw new Error('config');
  const { readHeldoutFrozen } = await import('../../src/decision/heldout/calibration.ts');
  const { d17CalibrationContext } = await import('./d17-study.mjs');
  const frozen = await readHeldoutFrozen(resolve(config.run), config.trustedApprovalDigest);
  const approved = frozen.bundle.approval.calibration;
  if (approved.mode !== 'staged' || approved.phase !== 'test' || approved.calibrationArtifactDigest !== config.trustedCalibrationSetDigest
    || typeof frozen.testPhaseAccessAt !== 'string') throw new Error('config');
  const context = await d17CalibrationContext({ calibrationDir: config.calibrationDir, calibrationReviewFile: config.calibrationReviewFile,
    calibrationRun: config.calibrationRun, trustedCalibrationReviewDigest: config.trustedCalibrationReviewDigest },
  await json(resolve(config.developmentReviewFile)), config.trustedDevelopmentReviewDigest, approved);
  return { ...context, testPhaseAccessAt: frozen.testPhaseAccessAt, nowEpochMs };
}
async function scoreStaged(config) {
  const { studyModule } = await import('./d17-study.mjs');
  const { scoreHeldoutStudy } = await import('../../src/decision/heldout/collector.ts');
  return scoreHeldoutStudy({ run: resolve(config.run), trustedEvidenceDigest: config.trustedEvidenceDigest,
    trustedApprovalDigest: config.trustedApprovalDigest, module: studyModule(await stagedContext(config)), moduleDigest: await moduleDigest(),
    gold: await json(resolve(config.goldFile)), integrity: await json(resolve(config.integrityFile)), trustedIntegrityDigest: config.trustedIntegrityDigest });
}
async function writeNew(directory, files) {
  const { writeHeldoutFile } = await import('../../src/decision/heldout/journal.ts');
  await mkdir(directory, { mode: 0o700 });
  for (const [name, value] of Object.entries(files)) await writeHeldoutFile(join(directory, `${name}.json`), value);
}

/**
 * Re-scores the protected evidence under a locked artifact snapshot (scorer sources, run journals, calibration
 * set and report), requires the trusted report digest to reproduce, then emits the champion/challenger record and
 * eval-integrity metadata that bind the shadow baseline and statistics digest. Both digests must be anchored
 * externally before `--native`. The release gate is capped at HOLD: promotion needs separate approval and D09 eligibility.
 */
async function nativeHandoff(config, output) {
  closed(config.operator, OPERATOR);
  const { snapshotArtifacts, detectArtifactChanges, buildIntegrityMetadata } = await import('../eval/src/integrity.ts');
  const { heldoutDigest } = await import('../../src/decision/heldout/contract.ts');
  const { readHeldoutFrozen } = await import('../../src/decision/heldout/calibration.ts');
  const { d17NativeHandoff, d17NativeIntegrity } = await import('../../src/decision/ensemble-study/score.ts');
  const { prepare } = await import('./d17-study.mjs');
  const protectedArtifacts = [
    { path: resolve(root, 'tools/decision/d17-study.mjs'), family: 'scorer_edit' }, { path: resolve(root, 'tools/decision/d17-score.mjs'), family: 'scorer_edit' },
    { path: resolve(root, 'src/decision/ensemble-study'), family: 'scorer_edit' }, { path: resolve(root, 'src/decision/heldout'), family: 'scorer_edit' },
    { path: resolve(dirname(resolve(config.run))), family: 'fixture_edit' }, { path: resolve(config.calibrationDir), family: 'fixture_edit' },
    { path: resolve(config.report), family: 'test_edit' }, { path: resolve(config.developmentReviewFile), family: 'test_edit' },
    { path: resolve(config.calibrationReviewFile), family: 'test_edit' }, { path: resolve(config.goldFile), family: 'test_edit' },
    ...(config.tradeoffApprovalFile ? [{ path: resolve(config.tradeoffApprovalFile), family: 'test_edit' }] : [])];
  const before = await snapshotArtifacts(protectedArtifacts);
  const scored = await scoreStaged(config), report = d17Report(await json(resolve(config.report)));
  if (heldoutDigest(report) !== config.trustedReportDigest || heldoutDigest(scored.diagnostics) !== config.trustedReportDigest) throw new Error('report');
  const frozen = await readHeldoutFrozen(resolve(config.run), config.trustedApprovalDigest);
  if (!frozen.testPhaseAccessAt) throw new Error('test-access');
  const prepared = await prepare(frozen.bundle.corpus.provenance.seed, 'staged');
  const calibration = await stagedContext(config);
  const handoff = await d17NativeHandoff({ report, trustedReportDigest: config.trustedReportDigest, prepared,
    artifacts: calibration.registered.artifacts, operator: { ...config.operator, holdoutAccessedAt: frozen.testPhaseAccessAt } });
  const changed = await detectArtifactChanges(before, protectedArtifacts);
  const pairs = report.statistics.sampleN, passed = report.pairs.filter(pair => pair.challenger.correct).length;
  const base = buildIntegrityMetadata({ mode: 'locked', freshWorkspaceRequired: false, freshWorkspaceVerified: false,
    changedArtifacts: changed, sampleN: pairs, passedN: passed, overallScore: pairs ? 100 * passed / pairs : 0 });
  // The locked-snapshot evidence decides the gate; PROMOTE survives only with a passing study gate, a positive
  // quality bound and the anchored extra-cost tradeoff approval. D09 eligibility is checked again at promotion.
  const tradeoff = config.tradeoffApprovalFile ? await json(resolve(config.tradeoffApprovalFile)) : null;
  const integrity = d17NativeIntegrity({ base, pairedBaseline: handoff.pairedBaseline, report, tradeoff,
    trustedTradeoffDigest: config.trustedTradeoffApprovalDigest });
  const record = { ...handoff.record, evaluationIntegrityReport: { ...handoff.record.evaluationIntegrityReport, digest: heldoutDigest(integrity) } };
  await writeNew(output, { 'champion-challenger': record, integrity });
  return { providerCalls: 0, recordDigest: heldoutDigest(record), integrityDigest: heldoutDigest(integrity), reportDigest: config.trustedReportDigest,
    integrityState: integrity.integrity_state, compromiseLabels: integrity.compromise_labels, releaseGate: integrity.release_gate.decision };
}

async function native(config, output) {
  const { heldoutDigest } = await import('../../src/decision/heldout/contract.ts');
  const { readHeldoutFrozen } = await import('../../src/decision/heldout/calibration.ts');
  const { buildD17NativeReport } = await import('../../src/decision/ensemble-study/score.ts');
  const { prepare } = await import('./d17-study.mjs');
  const report = d17Report(await json(resolve(config.report))), record = await json(resolve(config.record)), integrity = await json(resolve(config.integrityFile));
  if (heldoutDigest(record) !== config.trustedRecordDigest) throw new Error('record');
  const frozen = await readHeldoutFrozen(resolve(config.run), config.trustedApprovalDigest);
  const prepared = await prepare(frozen.bundle.corpus.provenance.seed, 'staged');
  const nativeReport = await buildD17NativeReport({ report, prepared, record, integrity,
    trustedIntegrityDigest: config.trustedIntegrityDigest, trustedReportDigest: config.trustedReportDigest,
    ...(config.tradeoffApprovalFile ? { tradeoff: await json(resolve(config.tradeoffApprovalFile)), trustedTradeoffDigest: config.trustedTradeoffApprovalDigest } : {}) });
  await writeNew(output, { 'native-integrity-report': nativeReport });
  return { providerCalls: 0, decision: nativeReport.decision, upstreamDecision: nativeReport.upstreamDecision,
    findings: nativeReport.findings, digest: nativeReport.digest };
}

try {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === '--help') process.stdout.write(HELP);
  else {
    const mode = args[0].startsWith('--') ? args[0] : '--diagnostic', rest = mode === '--diagnostic' ? args : args.slice(1);
    if (!['--diagnostic', '--staged', '--native-handoff', '--native'].includes(mode) || rest.length !== 2) throw new Error('usage');
    const config = await json(rest[0]);
    closed(config, { '--diagnostic': DIAGNOSTIC, '--staged': STAGED, '--native-handoff': HANDOFF, '--native': NATIVE }[mode]);
    const { assertContextArtifactRoot } = await import('../../src/decision/context-live-qualification.ts');
    await assertContextArtifactRoot(root, dirname(resolve(rest[1])), 'within');
    if (mode === '--native-handoff') process.stdout.write(`${JSON.stringify(await nativeHandoff(config, resolve(rest[1])))}\n`);
    else if (mode === '--native') process.stdout.write(`${JSON.stringify(await native(config, resolve(rest[1])))}\n`);
    else {
      const { writeHeldoutFile } = await import('../../src/decision/heldout/journal.ts');
      let report;
      if (mode === '--staged') report = await scoreStaged(config);
      else {
        const module = await import('./d17-study.mjs');
        const { scoreHeldoutStudy } = await import('../../src/decision/heldout/collector.ts');
        report = await scoreHeldoutStudy({ run: resolve(config.run), trustedEvidenceDigest: config.trustedEvidenceDigest,
          trustedApprovalDigest: config.trustedApprovalDigest, module, moduleDigest: await moduleDigest(), gold: await json(config.goldFile),
          integrity: await json(config.integrityFile), trustedIntegrityDigest: config.trustedIntegrityDigest });
      }
      await writeHeldoutFile(resolve(rest[1]), report);
      const { heldoutDigest } = await import('../../src/decision/heldout/contract.ts');
      process.stdout.write(JSON.stringify({ providerCalls: 0, decision: report.decision, complete: report.complete,
        ...(mode === '--staged' ? { reportDigest: heldoutDigest(report.diagnostics), statisticalGate: report.diagnostics.statistics.statisticalGate } : {}) }) + '\n');
    }
  }
} catch {
  process.stderr.write('D17 scoring refused: protected inputs, source, evidence, calibration, review, integrity or output check failed.\n');
  process.exitCode = 1;
}
