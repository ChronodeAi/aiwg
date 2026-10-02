import { createHash } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateDecisionRuleset } from '../evaluate.js';
import { JevDecisionAdapter } from '../adapters/jev.js';
import { assertContextArtifactRoot, assertContextLiveSource } from '../context-live-qualification.js';
import { captureQualificationLifetime } from '../qualification/capture.js';
import { QUALIFICATION_PRIVACY_SURFACES, scanQualificationPrivacy } from '../qualification/privacy.js';
import { executeQualificationPlan, verifyQualificationArtifacts, writeQualificationEvidenceManifest } from '../qualification/runner.js';
import { qualificationIntegrityAllowlistProblems, type QualificationIntegrityMetadata } from '../qualification/release.js';
import { redactText } from '../../governance/redaction.js';
import { heldoutDigest, heldoutRequest, heldoutReservationMicros, heldoutReservationTokens, HeldoutError, HELDOUT_ENV_GATE,
  heldoutRowsInScope, planHeldoutCollection, validateHeldoutBundle } from './contract.js';
import { appendHeldoutSpend, appendHeldoutEvent, heldoutDirectory, heldoutEvidenceDigest, heldoutRunsRoot, readHeldoutFile, readHeldoutJournal,
  reconcileHeldoutBaseline, scanHeldoutSpend, writeHeldoutFile, validateHeldoutJournal, heldoutCollectionAllowance } from './journal.js';
import { readHeldoutFrozen, sealHeldoutCalibrationPhase, validateHeldoutPhaseAccess } from './calibration.js';
import type { AdapterObservation, DecisionAdapter, RulesetResult } from '../types.js';
import type { Digest, HeldoutAttempt, HeldoutBundle, HeldoutEvent, HeldoutStudyModule, HeldoutSummary } from './types.js';

interface HeldoutHost { resolveCredential(reference: string): Promise<Uint8Array>; dispose(): void }
export interface HeldoutOptions {
  enabled?: boolean; bundle: HeldoutBundle; trustedApprovalDigest: Digest; sourceRoot: string; artifactRoot: string;
  /** The only offline seam. Supplying it labels all persisted evidence injected-transport. */
  offline?: { transport: typeof fetch; host: HeldoutHost };
  signal?: AbortSignal; now?: () => number; sleep?: (ms: number) => Promise<void>;
}
const byteDigest = (bytes: Uint8Array): Digest => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const key = (a: HeldoutAttempt) => `${a.rowId}/${a.requestId}`;

/** Only the one repository resolver can be loaded; neither corpus nor provider output chooses executable code. */
async function liveHost(options: HeldoutOptions): Promise<HeldoutHost> {
  const path = resolve(options.sourceRoot, 'tools/decision/jev-credential-resolver.mjs');
  if (byteDigest(await readFile(path)) !== options.bundle.approval.credentialResolverDigest) throw new HeldoutError('resolver-pin');
  const module = await import(pathToFileURL(path).href) as { assertTlsVerification(): void; createJevCredentialResolver(): HeldoutHost };
  module.assertTlsVerification();
  return module.createJevCredentialResolver();
}

/** Default-off, sequential collection. No runtime alias, calibration record, gate or workflow is changed. */
export async function collectHeldoutStudy(options: HeldoutOptions): Promise<HeldoutSummary | { status: 'disabled' }> {
  if (options.enabled !== true) return { status: 'disabled' };
  const offline = options.offline;
  if (offline !== undefined && (!offline || typeof offline.transport !== 'function'
    || typeof offline.host?.resolveCredential !== 'function' || typeof offline.host?.dispose !== 'function')) {
    throw new HeldoutError('offline-options');
  }
  // Capture the validated seam so caller mutation cannot re-enable the adapter's fetch fallback.
  const transport = offline?.transport;
  const offlineHost = offline?.host;
  if (!offline && process.env[HELDOUT_ENV_GATE] !== '1') throw new HeldoutError('live-gate');
  if (!offline && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== undefined && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '1') {
    throw new HeldoutError('tls');
  }
  validateHeldoutBundle(options.bundle, options.trustedApprovalDigest);
  // Clone after admission: caller mutation cannot change a dispatched or recorded pin.
  const bundle = structuredClone(options.bundle), { corpus, preregistration: plan, approval: a } = bundle;
  if (a.calibration.mode !== 'staged' || a.calibration.phase !== 'test') await planHeldoutCollection(bundle, options.trustedApprovalDigest);
  await assertContextLiveSource(options.sourceRoot, a.sourceCommit);
  await assertContextArtifactRoot(options.sourceRoot, options.artifactRoot);
  await heldoutDirectory(heldoutRunsRoot(options.artifactRoot));
  const lock = join(options.artifactRoot, 'research', 'qualification', 'heldout', 'dispatch.lock');
  try { await mkdir(lock, { mode: 0o700 }); } catch { throw new HeldoutError('dispatch-locked'); }
  let host: HeldoutHost | undefined;
  let uncertain = false;
  try {
    // Missing/corrupt baselines in an existing ledger require explicit reconciliation, never a reset.
    await scanHeldoutSpend(options.artifactRoot, a.study);
    const baselineDigests = await reconcileHeldoutBaseline(options.artifactRoot, a);
    const prior = await scanHeldoutSpend(options.artifactRoot, a.study);
    // An unacknowledged execution is never silently retried, even in a different study.
    if (prior.counterBlocked || prior.attempts.some(attempt => !attempt.result || attempt.result.disposition === 'stop')) throw new HeldoutError('prior-stop');
    if (!offline && prior.runs.some(run => run.corpusDigest === a.corpusDigest && run.source === 'injected-transport')) throw new HeldoutError('injected-prior');
    const old = prior.attempts.filter(attempt => attempt.study === a.study && attempt.corpusDigest === a.corpusDigest);
    if (old.some(attempt => attempt.preregistrationDigest !== a.preregistrationDigest)) throw new HeldoutError('changed-preregistration');
    const latest = new Map<string, HeldoutAttempt>();
    for (const attempt of old) if (attempt.ordinal >= (latest.get(key(attempt))?.ordinal ?? 0)) latest.set(key(attempt), attempt);
    const now = options.now ?? Date.now, sleep = options.sleep ?? delay, started = now();
    const testPhaseAccessAt = a.calibration.mode === 'staged' && a.calibration.phase === 'test' ? new Date(started).toISOString() : null;
    await validateHeldoutPhaseAccess(bundle, heldoutRunsRoot(options.artifactRoot), prior.runs, testPhaseAccessAt);
    if (testPhaseAccessAt !== null) await planHeldoutCollection(bundle, options.trustedApprovalDigest);
    const rows = heldoutRowsInScope(bundle);
    const run = join(heldoutRunsRoot(options.artifactRoot), a.runId);
    await mkdir(run, { mode: 0o700 });
    await writeHeldoutFile(join(run, 'frozen.json'), { schemaVersion: 'decision-heldout-frozen/v1', source: offline ? 'injected-transport' : 'provider', approval: { study: a.study, runId: a.runId }, bundle, baselineDigests, testPhaseAccessAt, digest: heldoutDigest(bundle), priorRuns: prior.runs.filter(r => r.study === a.study && r.corpusDigest === a.corpusDigest) });
    const events: HeldoutEvent[] = [];
    const allowance = heldoutCollectionAllowance(a, prior);
    let calls = 0, reserved = 0, accounted = 0, tokens = 0, lastDispatch = started - plan.minDispatchIntervalMs;
    let reason: string | null = null, checkpoint = false;
    const canaries = new Set<string>(['heldout-synthetic-privacy-canary']);
    const failed = new Set(old.filter(attempt => attempt.result?.disposition === 'measurement-failure').map(attempt => attempt.rowId));
    const overSlice = (slice: string, split: string) => {
      const rows = corpus.rows.filter(row => row.slice === slice && row.split === split);
      return rows.filter(row => failed.has(row.id)).length * 10000 > rows.length * plan.providerFailurePolicy.maximumSliceFailureBps;
    };
    const attemptSource = offline ? 'injected-transport' : 'provider';
    const safe = (value: unknown) => {
      const text = JSON.stringify(value);
      return typeof text === 'string' && ![...canaries].some(secret => text.includes(secret) || text.includes(JSON.stringify(secret).slice(1, -1)))
        && redactText(text).sensitivity === 'none';
    };
    // The scoped resolver starts only after every input and durable accounting check.
    const obtainHost = async () => host ??= offlineHost ?? await liveHost({ ...options, bundle });
    for (const row of rows) {
      if (reason || checkpoint) break;
      if (options.signal?.aborted) { reason = 'cancelled'; break; }
      if (failed.has(row.id) || overSlice(row.slice, row.split)) continue;
      const remaining = row.requests.filter(request => latest.get(`${row.id}/${request.id}`)?.result?.disposition !== 'success');
      if (!remaining.length) continue;
      // Checkpoint before a subject/paired arms: enough time for every bounded attempt and interval.
      const pairBound = remaining.length * (1 + plan.providerFailurePolicy.maxRetries) * (plan.requestTimeoutMs + plan.minDispatchIntervalMs);
      if (now() - started + pairBound > plan.sessionLimitMs * 0.8) { checkpoint = true; break; }
      for (const request of remaining) {
        if (reason || failed.has(row.id)) break;
        const previous = latest.get(`${row.id}/${request.id}`);
        const first = previous ? previous.ordinal + 1 : 1;
        for (let ordinal = first; ordinal <= 1 + plan.providerFailurePolicy.maxRetries; ordinal++) {
          if (options.signal?.aborted) { reason = 'cancelled'; break; }
          try { await assertContextLiveSource(options.sourceRoot, a.sourceCommit); }
          catch { reason = 'source-drift'; break; }
          const { execution, requestDigest, requestBytes, estimatedTokens: inputTokenBound } = await heldoutRequest(corpus, plan, a, row, request);
          const reserveMicros = heldoutReservationMicros(a, inputTokenBound);
          const reserveTokens = heldoutReservationTokens(plan, inputTokenBound);
          if (calls + 1 > allowance.calls || tokens + reserveTokens > allowance.tokens
            || accounted + reserveMicros > allowance.usdMicros) { reason = 'budget-exhausted'; break; }
          await sleep(Math.max(0, plan.minDispatchIntervalMs - (now() - lastDispatch)));
          if (options.signal?.aborted) { reason = 'cancelled'; break; }
          if (now() - started + plan.requestTimeoutMs > plan.sessionLimitMs * 0.8) { checkpoint = true; break; }
          const attempt: HeldoutAttempt = { schemaVersion: 'decision-heldout-attempt/v1', study: a.study, runId: a.runId,
            corpusDigest: a.corpusDigest, preregistrationDigest: a.preregistrationDigest, approvalDigest: options.trustedApprovalDigest,
            rowId: row.id, requestId: request.id, ordinal, reservedUsdMicros: reserveMicros, reservedTokens: reserveTokens,
            requestDigest, result: null };
          // fsync completes before credential lookup or any transport call. A crash retains this charge.
          uncertain = true; await appendHeldoutSpend(options.artifactRoot, attempt);
          await appendHeldoutEvent(run, events, attempt); tokens += reserveTokens; calls++; reserved += reserveMicros; accounted += reserveMicros;
          const callStarted = now(); lastDispatch = callStarted;
          let observation: AdapterObservation | null = null, receipt: RulesetResult | null = null;
          let wireProblem: string | null = null, responseDigest: Digest | null = null;
          let wireMetadata: { actualModel: string | null; usage: AdapterObservation['usage'] } | null = null;
          const traces: unknown[] = [];
          const controller = new AbortController();
          const caller = () => controller.abort(); options.signal?.addEventListener('abort', caller, { once: true });
          const timer = setTimeout(() => controller.abort(), plan.requestTimeoutMs);
          const captured = await captureQualificationLifetime(async () => {
            const resolver = await obtainHost();
            const inner = new JevDecisionAdapter({ region: a.region, now, fetch: (url, init) => {
              if (typeof init?.body !== 'string' || Buffer.byteLength(init.body, 'utf8') !== requestBytes
                || heldoutDigest(JSON.parse(init.body)) !== requestDigest) throw new HeldoutError('request-bound');
              if (transport) return transport(url, init);
              if (process.env[HELDOUT_ENV_GATE] !== '1') throw new HeldoutError('live-gate');
              if (process.env.NODE_TLS_REJECT_UNAUTHORIZED !== undefined && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '1') throw new HeldoutError('tls');
              return fetch(url, init);
            },
              observeResponseBody: (body, metadata) => {
                responseDigest = byteDigest(new TextEncoder().encode(body)); wireMetadata = metadata;
                if (!safe(body)) wireProblem = 'credential-anomaly';
                else if (metadata.actualModel !== null && metadata.actualModel !== a.servedModel) wireProblem = 'served-model';
                else if (a.priceBound.outputTokenBound !== undefined && (metadata.usage.outputTokens ?? 0) > a.priceBound.outputTokenBound) wireProblem = 'output-bound';
                else if ((metadata.usage.inputTokens ?? 0) > inputTokenBound
                  || (metadata.usage.inputTokens ?? 0) + (metadata.usage.outputTokens ?? 0) > reserveTokens) wireProblem = 'usage-bound';
                else if (metadata.usage.costUsd !== null && metadata.usage.costUsd * 1_000_000 > reserveMicros) wireProblem = 'price-bound';
              } });
            const adapter: DecisionAdapter = { id: inner.id, version: inner.version, capabilities: () => inner.capabilities(),
              evaluate: async req => { observation = await inner.evaluate(req); return observation; } };
            receipt = await evaluateDecisionRuleset({ ...execution, definitions: { [execution.definition.metadata.id]: execution.definition }, input: row.input,
              runId: a.runId, invocationId: `${row.id}-${request.id}-${ordinal}`, adapters: { jev: adapter }, signal: controller.signal, now,
              resolveCredential: async reference => {
                if (reference !== a.credentialRef) throw new HeldoutError('credential-scope');
                const bytes = await resolver.resolveCredential(reference);
                try {
                  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
                  if (!text || /[\s\x00-\x1f\x7f]/.test(text)) throw new HeldoutError('credential-shape');
                  canaries.add(text); return bytes.slice();
                } finally { bytes.fill(0); }
              }, projection: { resolve: () => execution.projection }, telemetry: { hook: { emit: span => { traces.push(span); } } } });
          }, { suppressOutput: true });
          clearTimeout(timer); options.signal?.removeEventListener('abort', caller);
          // No raw provider exceptions, model IDs or request IDs cross this boundary when a secret matches.
          const raw = observation as AdapterObservation | null;
          const metadata = wireMetadata as { actualModel: string | null; usage: AdapterObservation['usage'] } | null;
          const observed = raw && metadata ? { ...raw, actualModel: metadata.actualModel, usage: metadata.usage } : raw;
          const completed = receipt as RulesetResult | null;
          const captures = QUALIFICATION_PRIVACY_SURFACES.map(surface => ({ surface,
            content: captured.captures.find(c => c.surface === surface)?.content ?? (surface === 'receipt' ? JSON.stringify(completed)
              : surface === 'trace' ? JSON.stringify(traces) : surface === 'activity-record' ? JSON.stringify(observed) : '') }));
          const privacy = scanQualificationPrivacy(captures, [...canaries]);
          const clean = privacy.clean && safe(observed) && safe(completed) && wireProblem !== 'credential-anomaly';
          let disposition: NonNullable<HeldoutAttempt['result']>['disposition'] = 'stop';
          let outcome = 'execution-uncertain';
          if (!clean) outcome = 'credential-anomaly';
          else if (wireProblem) outcome = wireProblem;
          else if (options.signal?.aborted) outcome = 'cancelled';
          else if (captured.threw) outcome = 'dispatch-rejected';
          else if (observed?.actualModel && observed.actualModel !== a.servedModel) outcome = 'served-model';
          else if (observed && ((observed.usage.inputTokens ?? 0) > inputTokenBound
            || (observed.usage.inputTokens ?? 0) + (observed.usage.outputTokens ?? 0) > reserveTokens)) outcome = 'usage-bound';
          else if (observed?.usage.costUsd !== null && observed?.usage.costUsd !== undefined && observed.usage.costUsd * 1_000_000 > reserveMicros) outcome = 'price-bound';
          else if (observed?.status === 'success') {
            if (observed.actualModel !== a.servedModel) outcome = 'served-model';
            else if (observed.usage.inputTokens === null || observed.usage.outputTokens === null) outcome = 'usage-unknown';
            else { disposition = 'success'; outcome = 'ok'; }
          } else if (observed?.dispatchCertainty === 'terminal-response' && observed.remoteExecution !== 'unknown'
            && (observed.reason === 'invalid-output' || observed.reason === 'overloaded'
              || observed.reason === 'service-error' && (observed.httpStatus ?? 0) >= 500)) {
            disposition = ordinal <= plan.providerFailurePolicy.maxRetries ? 'retryable' : 'measurement-failure'; outcome = observed.reason;
          } else outcome = observed?.reason ?? 'execution-uncertain';
          // Unknown identity or usage on terminal errors is retained as unknown; only safe terminal failures may retry.
          const numeric = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
          attempt.result = { disposition, reason: outcome, servedModel: clean ? observed?.actualModel ?? null : null,
            inputTokens: numeric(observed?.usage.inputTokens), outputTokens: numeric(observed?.usage.outputTokens),
            providerCostUsd: numeric(observed?.usage.costUsd), responseDigest: clean ? responseDigest : null,
            receipt: clean ? completed : null, receiptDigest: clean && completed ? heldoutDigest(completed) : null,
            traceDigest: heldoutDigest(clean ? traces : []), latencyMs: Math.max(0, now() - callStarted),
            accountedUsdMicros: Math.max(reserveMicros, Math.ceil((numeric(observed?.usage.costUsd) ?? 0) * 1_000_000),
              Math.ceil((numeric(observed?.usage.inputTokens) ?? 0) * Math.max(0.1, a.priceBound.inputUsdPerMTok)
                + (numeric(observed?.usage.outputTokens) ?? 0) * a.priceBound.outputUsdPerMTok) + Math.ceil(a.priceBound.perRequestUsd * 1_000_000)) };
          accounted += attempt.result.accountedUsdMicros - reserveMicros;
          await writeHeldoutFile(join(run, `trace-${events.length}.json`), clean ? traces : []);
          await appendHeldoutSpend(options.artifactRoot, attempt);
          await appendHeldoutEvent(run, events, attempt); latest.set(key(attempt), attempt);
          uncertain = false;
          if (disposition === 'stop') { reason = outcome; uncertain = !observed || observed.remoteExecution === 'unknown'; break; }
          if (disposition === 'measurement-failure') { failed.add(row.id); break; }
          if (disposition === 'success') break;
        }
      }
    }
    try { await assertContextLiveSource(options.sourceRoot, a.sourceCommit); } catch { reason = 'source-drift'; }
    const all = [...latest.values()];
    const completedRows = rows.filter(row => row.requests.every(request => latest.get(`${row.id}/${request.id}`)?.result?.disposition === 'success')).length;
    const missingRows = rows.filter(row => row.requests.some(request => latest.get(`${row.id}/${request.id}`)?.result?.disposition !== 'success')).map(row => row.id);
    const evidenceDigest = await heldoutEvidenceDigest(run, events);
    const calibrationPhaseRecordDigest = !reason && !checkpoint && a.calibration.mode === 'staged' && a.calibration.phase === 'calibration'
      ? await sealHeldoutCalibrationPhase(run, new Date(now()).toISOString()) : null;
    const summary: HeldoutSummary = { schemaVersion: 'decision-heldout-summary/v1', status: reason ? 'stopped' : checkpoint ? 'checkpoint' : 'complete', reason,
      source: attemptSource, study: a.study, runId: a.runId, reservedUsdMicros: reserved, completedRows,
      measurementFailures: [...failed].filter(id => rows.some(row => row.id === id)), missingRows, evidenceDigest, calibrationPhaseRecordDigest, decision: 'HOLD' };
    await writeHeldoutFile(join(run, 'summary.json'), summary);
    // Recorded mode re-reads the durable ledger, rather than trusting a live-mode callback.
    const manifest = await executeQualificationPlan({ artifactRoot: run, manifest: { schemaVersion: 'decision-qualification-run/v1',
      mode: 'recorded', runId: 'replay', generatedAt: new Date(now()).toISOString(), sourceCommit: a.sourceCommit, dirty: false,
      cases: [{ id: 'HELDOUT-LEDGER', kind: 'baseline', mandatory: true, candidateTests: [], evidenceIds: ['REC-HELDOUT-01'] }] },
      executors: { 'HELDOUT-LEDGER': async () => {
        const reread = await readHeldoutJournal(run);
        return { outcome: heldoutDigest(reread) === heldoutDigest(events) ? 'pass' : 'fail',
          details: { source: attemptSource, evidenceDigest, complete: !missingRows.length, observations: all.length } };
      } }, sanitizeDetails: details => details });
    await writeHeldoutFile(join(run, 'qualification.json'), manifest);
    await writeQualificationEvidenceManifest(manifest, run, options.sourceRoot, {
      'HELDOUT-LEDGER': ['src/decision/heldout/collector.ts', 'src/decision/projection.ts', 'src/decision/adapters/jev.ts'],
    });
    return summary;
  } finally {
    try { host?.dispose(); } catch { /* resolver disposal never exposes private error text */ } finally {
      // A hung/uncertain remote operation keeps the global dispatch lock until operator reconciliation.
      if (!uncertain) await rm(lock, { recursive: true });
    }
  }
}

/** Scoring is local and advisory. Digest-bound upstream integrity can only retain HOLD or tighten to ROLLBACK. */
export async function scoreHeldoutStudy(input: { run: string; trustedEvidenceDigest: Digest; trustedApprovalDigest: Digest;
  module: HeldoutStudyModule; moduleDigest: Digest; gold: unknown; integrity: QualificationIntegrityMetadata; trustedIntegrityDigest: Digest }) {
  const frozen = await readHeldoutFrozen(input.run, input.trustedApprovalDigest);
  const { corpus, preregistration, approval } = frozen.bundle;
  await validateHeldoutPhaseAccess(frozen.bundle, resolve(input.run, '..'), frozen.priorRuns, frozen.testPhaseAccessAt);
  if (heldoutDigest(input.gold) !== corpus.provenance.goldDigest || input.moduleDigest !== preregistration.scorerDigest
    || heldoutDigest(input.integrity) !== input.trustedIntegrityDigest) throw new HeldoutError('scoring-pins');
  const problems = qualificationIntegrityAllowlistProblems(input.integrity);
  if (problems.includes('integrity-invalid')) throw new HeldoutError('integrity-invalid');
  const events = await readHeldoutJournal(input.run);
  await validateHeldoutJournal(frozen.bundle, events);
  if (await heldoutEvidenceDigest(input.run, events) !== input.trustedEvidenceDigest) throw new HeldoutError('evidence-pin');
  const manifest = await readHeldoutFile(join(input.run, 'qualification.json')) as Parameters<typeof verifyQualificationArtifacts>[0];
  if (manifest.mode !== 'recorded' || !(await verifyQualificationArtifacts(manifest, input.run)).every(v => v.verified)
    || !manifest.evidence.length || manifest.evidence.some(e => e.outcome !== 'pass')) throw new HeldoutError('recorded-evidence');
  for (const prior of frozen.priorRuns) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(prior.runId) || prior.corpusDigest !== preregistration.corpusDigest || prior.study !== corpus.study) throw new HeldoutError('prior-evidence');
    const path = resolve(input.run, '..', prior.runId), journal = await readHeldoutJournal(path);
    const previous = await readHeldoutFrozen(path);
    if (previous.bundle.approval.preregistrationDigest !== approval.preregistrationDigest) throw new HeldoutError('prior-evidence');
    await validateHeldoutJournal(previous.bundle, journal);
    await validateHeldoutPhaseAccess(previous.bundle, resolve(input.run, '..'), previous.priorRuns, previous.testPhaseAccessAt);
    if (await heldoutEvidenceDigest(path, journal) !== prior.evidenceDigest) throw new HeldoutError('prior-evidence');
    events.unshift(...journal);
  }
  const latest = new Map<string, HeldoutAttempt>();
  for (const { attempt } of events) latest.set(`${key(attempt)}/${attempt.ordinal}`, attempt);
  const rows = heldoutRowsInScope(frozen.bundle);
  const attempts = [...latest.values()].filter(attempt => rows.some(row => row.id === attempt.rowId));
  const complete = rows.every(row => row.requests.every(request => attempts.some(a => a.rowId === row.id
    && a.requestId === request.id && a.result?.disposition === 'success')));
  const approvedCalibration = structuredClone(approval.calibration);
  const calibrated = approvedCalibration.mode === 'uncalibrated-diagnostic'
    || approvedCalibration.mode === 'staged' && approvedCalibration.phase === 'calibration' ? false : null;
  const diagnostics = await input.module.score({ corpus: { ...corpus, rows }, preregistration, attempts, gold: input.gold,
    integrity: structuredClone(input.integrity), approvedCalibration: structuredClone(approvedCalibration), calibrated });
  if (calibrated === false && (!diagnostics || typeof diagnostics !== 'object'
    || (diagnostics as Record<string, unknown>).calibrated !== false
    || 'decision' in diagnostics && diagnostics.decision === 'PROMOTE'
    || 'd09Qualified' in diagnostics && diagnostics.d09Qualified !== false
    || 'calibratedGate' in diagnostics && diagnostics.calibratedGate !== false)) throw new HeldoutError('uncalibrated-report');
  // The collector validates no artifact itself. When a staged test-phase scorer reports that it validated the exact
  // approved calibration binding (its `calibration.calibrationSetDigest`), the top level reflects that study claim;
  // every other scorer (including D29, which reports no such binding) keeps the collector's not-performed default.
  const study = diagnostics as { calibrated?: unknown; d09Qualified?: unknown; calibratedGate?: unknown;
    calibration?: { mode?: unknown; calibrationSetDigest?: unknown } } | null;
  const studyValidated = approvedCalibration.mode === 'staged' && approvedCalibration.phase === 'test' && calibrated === null
    && study?.calibrated === true && study.d09Qualified === true && study.calibration?.mode === 'staged-test'
    && study.calibration.calibrationSetDigest === approvedCalibration.calibrationArtifactDigest;
  return { schemaVersion: 'decision-heldout-score/v1', source: frozen.priorRuns.some(run => run.source === 'injected-transport') ? 'injected-transport' : frozen.source, evidenceDigest: input.trustedEvidenceDigest, integrityDigest: input.trustedIntegrityDigest,
    complete, diagnostics, approvedCalibration, calibrated: studyValidated ? true : calibrated, d09Qualified: studyValidated,
    calibratedGate: studyValidated && study?.calibratedGate === true,
    calibrationArtifactValidation: studyValidated ? 'performed-by-study-scorer' : 'not-performed', integrityProblems: problems, decision: input.integrity.release_gate.decision === 'ROLLBACK'
      || input.integrity.compromise_labels.length > 0 ? 'ROLLBACK' as const : 'HOLD' as const };
}
