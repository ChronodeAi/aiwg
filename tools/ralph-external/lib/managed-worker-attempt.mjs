// Validate the parent reservation and disclose one-shot attempt bindings.
import { importImpl } from '../../_resolve-impl.mjs';
import { sampleWorkerIdentity } from '../process-monitor.mjs';
import { changedBindings } from './session-attempt.mjs';
const { qualificationDigest } = await importImpl(import.meta.url, 'models/qualification-digest.mjs');

export function managedAttemptBindings(plan) {
  const invocation = plan.invocation;
  const digests = plan.digests ?? {};
  const selected = invocation?.selected ?? plan.selected;
  return { policyDigest: invocation?.policyDigest ?? (digests.configDigest && digests.resolvedModelsDigest
    ? qualificationDigest([digests.configDigest, digests.resolvedModelsDigest]) : null),
  catalogDigest: invocation?.catalogDigest ?? digests.catalogDigest ?? null,
  profileDigest: invocation?.profileDigest ?? digests.profileDigest ?? null,
  selected: selected ? { group: selected.group, member: selected.member, cli: selected.cli,
    inferenceProvider: selected.inferenceProvider, model: selected.model,
    effort: typeof selected.effort === 'object' ? selected.effort?.value ?? null : selected.effort ?? null,
    profileRef: selected.profileRef ?? selected.profile } : null, sessionId: null };
}

export async function validateManagedAttempt(options, saved, inputs, now, validate, publish) {
  const attempt = await managedWorkerAttempt(options, saved, inputs, now);
  await publish(attempt);
  try {
    const invocation = await validate(saved, inputs.snapshot, inputs.drivers, now);
    return { invocation, attempt };
  } catch (error) {
    attempt.status = 'blocked'; attempt.errorCode = error.code ?? 'PLAN_REVALIDATION_FAILED';
    await publish(attempt);
    throw error;
  }
}

export async function managedWorkerAttempt(options, saved, inputs, now) {
  const { resolveWorkerInvocation } = await importImpl(import.meta.url, 'serve/worker-invocation.js');
  const current = await resolveWorkerInvocation(inputs.snapshot, saved.request, inputs.drivers, now);
  const original = options.attempt?.originalBindings ?? managedAttemptBindings(saved);
  const bindings = managedAttemptBindings(current);
  return { ...options.attempt, kind: 'fresh', reason: options.attempt?.reason
    ?? (options.resumeSession || options.sessionId ? 'one-shot-continuation-unsupported' : 'one-shot-profile'),
    requestedSessionId: options.attempt?.requestedSessionId ?? options.resumeSession ?? options.sessionId ?? null,
    requestId: options.managedAdmission.requestId, originalBindings: original,
    bindings, changes: changedBindings(original, bindings),
    status: current.status === 'eligible' ? 'prepared' : 'blocked',
    diagnostics: current.diagnostics };
}

/** Reuse the MC authority and its registered one-shot identity at every spawn boundary. */
export async function assertManagedWorkerLaunch(options, invocation, inputs, projectRoot = process.cwd()) {
  if (!options.managedAdmission || invocation.mode !== 'managed'
    || inputs.snapshot.config.parallelism?.worker_mode !== 'managed') throw new Error('Managed worker admission is required');
  const { createMcAdmissionScheduler } = await importImpl(import.meta.url, 'cli/handlers/mc.js');
  const { loadLauncherRegistry } = await importImpl(import.meta.url, 'cli/handlers/ralph-launcher.js');
  const { workerModelKey } = await importImpl(import.meta.url, 'models/provider-policy.js');
  const scheduler = await createMcAdmissionScheduler(projectRoot, inputs.snapshot.config);
  const { requestId, generation } = options.managedAdmission;
  const snapshot = scheduler.snapshot();
  const record = snapshot.records[requestId];
  const deadlineAtMs = Math.min(options.cycleDeadlineAtMs ?? Infinity, ...[record?.accounting?.runKey, record?.accounting?.taskKey]
    .map(key => snapshot.allowances?.[key]?.deadlineAt).filter(Boolean).map(Date.parse));
  const registered = loadLauncherRegistry(projectRoot).loops[options.loopId ?? process.env.RALPH_LOOP_ID];
  const worker = record?.managed;
  const reservation = record?.accounting?.reservation;
  if (!record || record.state !== 'admitted' || record.leaseGeneration !== generation
    || !record.launchClaimedAt || !record.metadata?.invocationId || Date.parse(record.leaseExpiresAt ?? '') <= Date.now()
    || deadlineAtMs <= Date.now()
    || worker?.kind !== 'external' || worker.group !== invocation.selected.group
    || worker.member !== invocation.selected.member || worker.cli !== invocation.selected.cli
    || worker.model !== workerModelKey(invocation.selected.inferenceProvider, invocation.selected.model)
    || reservation?.tokens != null && !(invocation.limits.tokens <= reservation.tokens)
    || reservation?.costUsd != null && !(invocation.limits.costUsd !== null && invocation.limits.costUsd <= reservation.costUsd)
    || registered?.managedAdmission?.requestId !== requestId || registered.managedAdmission.generation !== generation
    || registered.managedWorker?.invocationPath !== options.invocationPath
    || registered.managedWorker?.runDir !== options.runDir) {
    throw new Error('Managed worker launch differs from the current claimed admission');
  }
  if (record.execution) {
    const identity = sampleWorkerIdentity(process.pid);
    if (record.execution.pid !== process.pid || !identity?.bootId || !identity.startTicks
      || record.execution.startedAt !== `${identity.bootId}:${identity.startTicks}:${identity.uid}`) {
      throw new Error('Managed worker supervisor identity differs');
    }
  }
  return { ...record, deadlineAtMs };
}

