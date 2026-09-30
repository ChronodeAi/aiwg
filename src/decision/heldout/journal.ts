import { lstat, mkdir, open, readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { heldoutDigest, HeldoutError, heldoutReservationMicros, validateHeldoutAttempt, validateHeldoutBundle, checkHeldoutSchema } from './contract.js';
import type { Digest, HeldoutAttempt, HeldoutBundle, HeldoutEvent, HeldoutSummary } from './types.js';

export const heldoutRunsRoot = (root: string): string => join(root, 'research', 'qualification', 'heldout', 'runs');
/** Reject symlinked journal ancestors as well as leaves: spend cannot be redirected to another root. */
export async function heldoutDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (await realpath(path) !== resolve(path)) throw new HeldoutError('artifact-symlink');
}
export async function writeHeldoutFile(path: string, value: unknown): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); } finally { await file.close(); }
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
export async function readHeldoutFile(path: string): Promise<unknown> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32_000_000) throw new HeldoutError('artifact-file');
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}
export async function readHeldoutJournal(run: string): Promise<HeldoutEvent[]> {
  if (await realpath(run) !== resolve(run)) throw new HeldoutError('artifact-symlink');
  const entries = (await readdir(run)).filter(name => /^\d{8}\.json$/.test(name)).sort();
  const events: HeldoutEvent[] = [];
  const pending = new Map<string, HeldoutAttempt>();
  const seen = new Set<string>();
  for (const name of entries) {
    const event = await readHeldoutFile(join(run, name)) as HeldoutEvent;
    checkHeldoutSchema('Event', event);
    const { digest, ...payload } = event;
    if (Object.keys(event).sort().join(',') !== 'attempt,digest,previous,schemaVersion,sequence'
      || event.sequence !== events.length + 1 || name !== `${String(event.sequence).padStart(8, '0')}.json`
      || event.previous !== (events.at(-1)?.digest ?? null) || digest !== heldoutDigest(payload)) throw new HeldoutError('journal-chain');
    validateHeldoutAttempt(event.attempt);
    const attempt = event.attempt, key = `${attempt.rowId}/${attempt.requestId}/${attempt.ordinal}`;
    if (!attempt.result) {
      if (seen.has(key)) throw new HeldoutError('duplicate-reservation');
      seen.add(key);
      pending.set(key, attempt);
    } else {
      const reservation = pending.get(key);
      if (!reservation || heldoutDigest({ ...attempt, result: null }) !== heldoutDigest(reservation)) throw new HeldoutError('unreserved-result');
      pending.delete(key);
      const trace = await readHeldoutFile(join(run, `trace-${event.sequence - 1}.json`));
      if (heldoutDigest(trace) !== attempt.result.traceDigest) throw new HeldoutError('trace-digest');
    }
    events.push(event);
  }
  return events;
}
export async function appendHeldoutEvent(run: string, events: HeldoutEvent[], attempt: HeldoutAttempt): Promise<void> {
  validateHeldoutAttempt(attempt);
  const payload = { schemaVersion: 'decision-heldout-event/v1' as const, sequence: events.length + 1, previous: events.at(-1)?.digest ?? null, attempt: structuredClone(attempt) };
  const event: HeldoutEvent = { ...payload, digest: heldoutDigest(payload) };
  await writeHeldoutFile(join(run, `${String(event.sequence).padStart(8, '0')}.json`), event);
  events.push(event);
}
export interface HeldoutPriorRun { runId: string; evidenceDigest: Digest; corpusDigest: Digest; study: string; source: 'injected-transport' | 'provider' }
export async function heldoutEvidenceDigest(run: string, events: HeldoutEvent[]): Promise<Digest> {
  return heldoutDigest({ frozenDigest: heldoutDigest(await readHeldoutFile(join(run, 'frozen.json'))),
    journalDigest: events.at(-1)?.digest ?? heldoutDigest([]) });
}
export interface HeldoutScan {
  studyUsdMicros: number; portfolioUsdMicros: number; attempts: HeldoutAttempt[]; journalDigests: Digest[]; runs: HeldoutPriorRun[];
}
/** Count reservations, including crashes and failed requests; successful small usage never refunds spend. */
export async function scanHeldoutSpend(root: string, study: string): Promise<HeldoutScan> {
  const runs = heldoutRunsRoot(root);
  await heldoutDirectory(runs);
  const result: HeldoutScan = { studyUsdMicros: 0, portfolioUsdMicros: 0, attempts: [], journalDigests: [], runs: [] };
  for (const name of (await readdir(runs)).sort()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw new HeldoutError('run-path');
    const run = join(runs, name);
    const frozen = await readHeldoutFile(join(run, 'frozen.json')) as { approval: { runId: string; study: string }; digest: Digest;
      bundle: HeldoutBundle; priorRuns: HeldoutPriorRun[]; source: 'injected-transport' | 'provider' };
    checkHeldoutSchema('Frozen', frozen);
    if (frozen.approval?.runId !== name || !['D17', 'D29'].includes(frozen.approval.study)
      || frozen.digest !== heldoutDigest(frozen.bundle)) throw new HeldoutError('frozen-inputs');
    validateHeldoutBundle(frozen.bundle, heldoutDigest(frozen.bundle.approval));
    if (frozen.bundle.approval.runId !== name || frozen.bundle.approval.study !== frozen.approval.study) throw new HeldoutError('frozen-run');
    for (const prior of frozen.priorRuns) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(prior.runId) || prior.runId === name) throw new HeldoutError('prior-run');
      const path = join(runs, prior.runId);
      if (await heldoutEvidenceDigest(path, await readHeldoutJournal(path)) !== prior.evidenceDigest) throw new HeldoutError('prior-evidence');
    }
    const events = await readHeldoutJournal(run);
    if ((await readdir(run)).includes('summary.json')) {
      const summary = await readHeldoutFile(join(run, 'summary.json')) as HeldoutSummary;
      checkHeldoutSchema('Summary', summary);
      if (summary.evidenceDigest !== await heldoutEvidenceDigest(run, events)) throw new HeldoutError('truncated-journal');
    }
    result.runs.push({ runId: name, evidenceDigest: await heldoutEvidenceDigest(run, events), corpusDigest: frozen.bundle.approval.corpusDigest, study: frozen.approval.study, source: frozen.source });
    const latest = new Map<string, HeldoutAttempt>();
    for (const { attempt } of events) {
      if (attempt.runId !== name || attempt.study !== frozen.approval.study) throw new HeldoutError('journal-run');
      const approved = frozen.bundle.approval;
      if (attempt.corpusDigest !== approved.corpusDigest || attempt.preregistrationDigest !== approved.preregistrationDigest
        || attempt.approvalDigest !== heldoutDigest(approved)
        || attempt.reservedUsdMicros !== heldoutReservationMicros(approved, frozen.bundle.preregistration)
        || attempt.reservedTokens !== frozen.bundle.preregistration.perRequestTokenBound) throw new HeldoutError('journal-pins');
      const key = `${attempt.rowId}/${attempt.requestId}/${attempt.ordinal}`;
      if (!attempt.result) {
        result.portfolioUsdMicros += attempt.reservedUsdMicros;
        if (attempt.study === study) result.studyUsdMicros += attempt.reservedUsdMicros;
      } else {
        if (attempt.result.accountedUsdMicros < attempt.reservedUsdMicros) throw new HeldoutError('reservation-refund');
        const extra = attempt.result.accountedUsdMicros - attempt.reservedUsdMicros;
        result.portfolioUsdMicros += extra;
        if (attempt.study === study) result.studyUsdMicros += extra;
      }
      latest.set(key, attempt);
    }
    result.attempts.push(...latest.values());
    if (events.length) result.journalDigests.push(events.at(-1)!.digest);
  }
  return result;
}
