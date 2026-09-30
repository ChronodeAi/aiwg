import { basename, join, resolve } from 'node:path';
import { checkHeldoutSchema, heldoutDigest, HeldoutError, heldoutRowsInScope, validateHeldoutBundle } from './contract.js';
import { heldoutEvidenceDigest, readHeldoutFile, readHeldoutJournal, validateHeldoutJournal, writeHeldoutFile } from './journal.js';
import type { HeldoutPriorRun } from './journal.js';
import type { Digest, HeldoutAttempt, HeldoutBundle, HeldoutCalibrationPhase, HeldoutRow } from './types.js';

interface Frozen {
  approval: { runId: string; study: string }; source: 'injected-transport' | 'provider';
  bundle: HeldoutBundle; digest: Digest; priorRuns: HeldoutPriorRun[]; testPhaseAccessAt: string | null;
}
export async function readHeldoutFrozen(run: string, trustedApprovalDigest?: Digest): Promise<Frozen> {
  const frozen = await readHeldoutFile(join(run, 'frozen.json')) as Frozen;
  checkHeldoutSchema('Frozen', frozen);
  if (frozen.digest !== heldoutDigest(frozen.bundle)) throw new HeldoutError('frozen-inputs');
  validateHeldoutBundle(frozen.bundle, trustedApprovalDigest ?? heldoutDigest(frozen.bundle.approval));
  if (basename(run) !== frozen.bundle.approval.runId || frozen.approval.runId !== frozen.bundle.approval.runId
    || frozen.approval.study !== frozen.bundle.approval.study) throw new HeldoutError('frozen-run');
  return frozen;
}
function calibrationApproval(bundle: HeldoutBundle): boolean {
  return bundle.approval.calibration.mode === 'staged' && bundle.approval.calibration.phase === 'calibration';
}
function sameStudy(bundle: HeldoutBundle, other: HeldoutBundle): boolean {
  return bundle.approval.study === other.approval.study && bundle.approval.corpusDigest === other.approval.corpusDigest
    && bundle.approval.preregistrationDigest === other.approval.preregistrationDigest;
}
function sameBudget(bundle: HeldoutBundle, other: HeldoutBundle): boolean {
  return heldoutDigest(bundle.approval.budget) === heldoutDigest(other.approval.budget)
    && bundle.approval.priorStudySpendUsd === other.approval.priorStudySpendUsd
    && bundle.approval.priorPortfolioSpendUsd === other.approval.priorPortfolioSpendUsd;
}
function terminal(rows: readonly HeldoutRow[], attempts: readonly HeldoutAttempt[]): boolean {
  return rows.every(row => row.requests.length === 0 && row.localOutcome !== null
    || attempts.some(a => a.rowId === row.id && a.result?.disposition === 'measurement-failure')
    || row.requests.every(request => attempts.some(a => a.rowId === row.id && a.requestId === request.id && a.result?.disposition === 'success')));
}
/** Reconstruct the seal from frozen approvals and full journals, including reservations and retries. */
async function phaseRecord(run: string, sealedAt: string, captured?: { attempts: HeldoutAttempt[]; source: Frozen['source'] }): Promise<HeldoutCalibrationPhase | null> {
  const frozen = await readHeldoutFrozen(run), { bundle } = frozen;
  if (!calibrationApproval(bundle)) throw new HeldoutError('calibration-phase-approval');
  const lineage: HeldoutCalibrationPhase['lineage'] = [], journals = [], attempts: HeldoutAttempt[] = [];
  const seen = new Set<string>();
  const runs = [...frozen.priorRuns.map(prior => ({ runId: prior.runId, expected: prior.evidenceDigest })),
    { runId: bundle.approval.runId, expected: null }];
  for (const item of runs) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(item.runId) || seen.has(item.runId)) throw new HeldoutError('calibration-phase-lineage');
    seen.add(item.runId);
    const path = resolve(run, '..', item.runId), prior = await readHeldoutFrozen(path);
    if (!sameStudy(bundle, prior.bundle) || !sameBudget(bundle, prior.bundle) || !calibrationApproval(prior.bundle)) {
      throw new HeldoutError('calibration-phase-lineage');
    }
    if (captured && prior.source === 'injected-transport') captured.source = 'injected-transport';
    const events = await readHeldoutJournal(path);
    await validateHeldoutJournal(prior.bundle, events);
    const evidenceDigest = await heldoutEvidenceDigest(path, events);
    if (item.expected !== null && item.expected !== evidenceDigest) throw new HeldoutError('calibration-phase-lineage');
    lineage.push({ runId: item.runId, evidenceDigest }); journals.push({ runId: item.runId, events });
    attempts.push(...events.map(event => event.attempt).filter(attempt => attempt.result));
    const settled = new Set(events.filter(event => event.attempt.result).map(event => heldoutDigest({ ...event.attempt, result: null })));
    if (events.some(event => !event.attempt.result && !settled.has(heldoutDigest(event.attempt)))) return null;
  }
  const rows = heldoutRowsInScope(bundle);
  if (attempts.some(attempt => attempt.result?.disposition === 'stop') || !terminal(rows, attempts)) return null;
  captured?.attempts.push(...attempts);
  return { schemaVersion: 'decision-heldout-calibration-phase/v1', study: bundle.approval.study, runId: bundle.approval.runId,
    corpusDigest: bundle.approval.corpusDigest, preregistrationDigest: bundle.approval.preregistrationDigest,
    approvalDigest: heldoutDigest(bundle.approval), sealedAt, rowIds: rows.map(row => row.id), lineage, lineageDigest: heldoutDigest(journals) };
}
/** Caller holds the dispatch lock. Publication is exclusive and fsynced; incomplete phases have no seal. */
export async function sealHeldoutCalibrationPhase(run: string, sealedAt: string): Promise<Digest | null> {
  const record = await phaseRecord(run, sealedAt);
  if (!record) return null;
  checkHeldoutSchema('CalibrationPhase', record);
  await writeHeldoutFile(join(run, 'calibration-phase.json'), record);
  return heldoutDigest(record);
}
/** Offline fitting reads only a reconstructed, independently pinned terminal phase. */
export async function readHeldoutCalibrationPhase(run: string, trustedApprovalDigest: Digest,
  trustedCalibrationPhaseRecordDigest: Digest) {
  const frozen = await readHeldoutFrozen(run, trustedApprovalDigest);
  const record = await readHeldoutFile(join(run, 'calibration-phase.json')) as HeldoutCalibrationPhase;
  checkHeldoutSchema('CalibrationPhase', record);
  if (heldoutDigest(record) !== trustedCalibrationPhaseRecordDigest || record.approvalDigest !== trustedApprovalDigest) {
    throw new HeldoutError('calibration-phase-seal');
  }
  const captured: { attempts: HeldoutAttempt[]; source: Frozen['source'] } = { attempts: [], source: frozen.source };
  const reconstructed = await phaseRecord(run, record.sealedAt, captured);
  if (!reconstructed || heldoutDigest(reconstructed) !== heldoutDigest(record)) throw new HeldoutError('calibration-phase-lineage');
  return { bundle: frozen.bundle, source: captured.source, record, attempts: captured.attempts };
}
/** Test access is bound to a separately approved artifact and the terminal calibration lineage. */
export async function validateHeldoutPhaseAccess(bundle: HeldoutBundle, runsRoot: string,
  priorRuns: readonly HeldoutPriorRun[], accessAt: string | null): Promise<void> {
  const calibration = bundle.approval.calibration;
  if (calibration.mode !== 'staged') return;
  try {
    const candidates: { run: string; frozen: Frozen }[] = [];
    for (const prior of priorRuns.filter(prior => prior.study === bundle.approval.study && prior.corpusDigest === bundle.approval.corpusDigest)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(prior.runId)) throw new HeldoutError('calibration-phase-lineage');
      const run = join(runsRoot, prior.runId), frozen = await readHeldoutFrozen(run);
      if (!sameStudy(bundle, frozen.bundle) || !sameBudget(bundle, frozen.bundle)
        || frozen.bundle.approval.calibration.mode !== 'staged') throw new HeldoutError('calibration-phase-lineage');
      if (await heldoutEvidenceDigest(run, await readHeldoutJournal(run)) !== prior.evidenceDigest) throw new HeldoutError('calibration-phase-lineage');
      candidates.push({ run, frozen });
    }
    if (calibration.phase === 'calibration') {
      if (candidates.some(item => !calibrationApproval(item.frozen.bundle))) throw new HeldoutError('calibration-phase-order');
      return;
    }
    const owner = candidates.find(item => heldoutDigest(item.frozen.bundle.approval) === calibration.priorApprovalDigest);
    if (!owner || !calibrationApproval(owner.frozen.bundle)) throw new HeldoutError('calibration-phase-approval');
    const record = await readHeldoutFile(join(owner.run, 'calibration-phase.json')) as HeldoutCalibrationPhase;
    checkHeldoutSchema('CalibrationPhase', record);
    if (heldoutDigest(record) !== calibration.calibrationPhaseRecordDigest || record.approvalDigest !== calibration.priorApprovalDigest
      || !accessAt || !Number.isFinite(Date.parse(accessAt)) || Date.parse(accessAt) <= Date.parse(record.sealedAt)) throw new HeldoutError('calibration-phase-seal');
    const reconstructed = await phaseRecord(owner.run, record.sealedAt);
    if (!reconstructed || heldoutDigest(reconstructed) !== heldoutDigest(record)) throw new HeldoutError('calibration-phase-lineage');
    for (const { frozen } of candidates) {
      const prior = frozen.bundle.approval.calibration;
      if (prior.mode === 'staged' && prior.phase === 'test' && heldoutDigest(prior) !== heldoutDigest(calibration)) throw new HeldoutError('calibration-phase-binding');
      if (calibrationApproval(frozen.bundle) && !record.lineage.some(item => item.runId === frozen.bundle.approval.runId)) throw new HeldoutError('calibration-phase-lineage');
    }
  } catch { throw new HeldoutError('calibration-phase-access'); }
}
