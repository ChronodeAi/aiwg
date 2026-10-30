// Classify native continuation and retain the original execution assumptions.
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importImpl } from '../../_resolve-impl.mjs';

const { qualificationDigest } = await importImpl(import.meta.url, 'models/qualification-digest.mjs');
const validSession = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(value);

export function changedBindings(original, current) {
  if (!original) return [];
  return [...new Set([...Object.keys(original), ...Object.keys(current)])].sort()
    .filter(key => qualificationDigest(original[key] ?? null) !== qualificationDigest(current[key] ?? null))
    .map(key => ({ binding: key, previous: original[key] ?? null, current: current[key] ?? null }));
}

export function classifySessionAttempt(adapter, { sessionId, original, current, sessionValid = true } = {}) {
  const changes = changedBindings(original, current ?? {});
  const requested = sessionId !== null && sessionId !== undefined;
  const reason = !requested ? 'no-session' : !adapter.hasCapability('sessionResume') ? 'resume-unsupported'
    : !validSession(sessionId) || !sessionValid || !original ? 'invalid-session'
      : changes.length ? 'bindings-changed' : 'session-bound';
  return { kind: reason === 'session-bound' ? 'continuation' : 'fresh', reason,
    requestedSessionId: validSession(sessionId) ? sessionId : null,
    changes, originalBindings: original ?? null, bindings: current ?? {} };
}

export function persistCycleAttempt(owner, state, outputDir, attempt) {
  state.currentAttempt = attempt;
  owner.stateManager.save(state);
  writeFileSync(join(outputDir, 'session-attempt.json'), JSON.stringify(attempt, null, 2), { mode: 0o600 });
}

export function prepareNativeAttempt(owner, state, options) {
  const adapter = owner.providerAdapter;
  // Resolve again even when a requested continuation cannot be used.
  const model = adapter.mapModel(options.model);
  const prior = state.sessionBinding;
  const sessionId = prior?.sessionId ?? (state.currentIteration > 1 ? state.sessionId : null);
  const bindings = { provider: adapter.getName(), model, sessionId,
    policyDigest: qualificationDigest({ budget: options.budget, maxTurns: options.maxTurns,
      mcpConfig: options.mcpConfig, tools: options.tools, thinking: options.thinking,
      workingDir: options.workingDir }) };
  const attempt = { attemptId: randomUUID(), previousAttemptId: state.currentAttempt?.attemptId ?? null,
    ...adapter.classifySessionAttempt({ sessionId, original: prior?.originalBindings,
      current: bindings, sessionValid: prior?.valid === true }), status: 'prepared' };
  // Only Claude/Muse accept a caller-created session id. Other CLIs must
  // report a native id before it can be used for continuation.
  const nativeId = attempt.kind === 'continuation' ? sessionId
    : ['claude', 'muse'].includes(adapter.getName()) ? randomUUID() : null;
  attempt.bindings.sessionId = nativeId;
  persistCycleAttempt(owner, state, options.outputDir, attempt);
  return { ...options, model, sessionId: nativeId, resumeSession: attempt.kind === 'continuation' ? nativeId : null,
    attempt };
}

export function finishNativeAttempt(owner, state, options, result) {
  let sessionId = options.sessionId;
  let reportedId = null;
  let conflictingSession = false;
  let providerFailed = false;
  // Session ids are accepted only from this attempt's captured provider output.
  for (const line of String(result.stdoutBuffer ?? '').split('\n')) {
    try {
      const event = JSON.parse(line);
      const observed = owner.providerAdapter.observeHealthEvent(event, { kind: 'stdout' }, {});
      providerFailed ||= observed?.kind === 'error' || observed?.kind === 'terminal' && observed.success === false;
      const candidate = observed?.sessionId ?? event.session_id ?? event.sessionId ?? event.stream?.id;
      if (validSession(candidate)) {
        conflictingSession ||= reportedId !== null && reportedId !== candidate
          || options.resumeSession != null && options.resumeSession !== candidate;
        reportedId = candidate;
        sessionId = candidate;
      }
    } catch { /* Non-JSON stdout has no native session binding. */ }
  }
  const bindings = { ...options.attempt.bindings, sessionId };
  const valid = result.exitCode === 0 && !result.timedOut && !providerFailed && !conflictingSession && validSession(sessionId);
  state.sessionBinding = { sessionId, valid,
    originalBindings: options.attempt.kind === 'continuation' ? options.attempt.originalBindings : bindings };
  options.attempt.status = 'finished';
  options.attempt.bindings = bindings;
  persistCycleAttempt(owner, state, options.outputDir, options.attempt);
  result.attempt = options.attempt;
}
