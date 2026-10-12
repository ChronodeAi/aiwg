/**
 * ConsecutiveFailureCircuitBreaker - Three-state circuit breaker
 *
 * Implements the standard circuit breaker pattern:
 *   CLOSED (normal) -> N consecutive failures -> OPEN (blocking)
 *   OPEN -> cooldown expires -> HALF_OPEN (probe)
 *   HALF_OPEN -> success -> CLOSED
 *   HALF_OPEN -> failure -> OPEN (reset cooldown)
 *
 * @implements #514
 * @tests @test/unit/circuit-breaker.test.mjs
 */

import { EventEmitter } from 'node:events';

export const CircuitState = Object.freeze({
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half-open',
});

export class ConsecutiveFailureCircuitBreaker extends EventEmitter {
  /**
   * @param {object} options
   * @param {number} [options.failureThreshold=5] Consecutive failures to trip open
   * @param {number} [options.cooldownMs=120000] Time in OPEN before transitioning to HALF_OPEN
   * @param {number} [options.halfOpenMaxProbes=1] Max concurrent probes in HALF_OPEN
   * @param {function} [options.nowMs] Clock source (defaults to Date.now). The
   *   scoped breaker always injects its own clock here so both layers share
   *   one time source (#2915: a separate Date.now() desynchronizes cooldowns
   *   under synthetic clocks).
   */
  constructor(options = {}) {
    super();
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 120_000;
    this.halfOpenMaxProbes = options.halfOpenMaxProbes ?? 1;
    this.nowMs = options.nowMs ?? (() => Date.now());

    this._state = CircuitState.CLOSED;
    this._consecutiveFailures = 0;
    this._lastFailureAt = null;
    this._openedAt = null;
    this._cooldownTimer = null;
    this._activeProbes = 0;
  }

  /**
   * Check whether execution is allowed in the current state.
   * In HALF_OPEN, limits concurrent probes.
   */
  canExecute() {
    switch (this._state) {
      case CircuitState.CLOSED:
        return true;

      case CircuitState.OPEN: {
        // Check if cooldown has elapsed (in case timer hasn't fired yet)
        if (this._openedAt && this.nowMs() - this._openedAt >= this.cooldownMs) {
          this._transitionTo(CircuitState.HALF_OPEN, 'cooldown elapsed on check');
          return this._activeProbes < this.halfOpenMaxProbes;
        }
        return false;
      }

      case CircuitState.HALF_OPEN:
        return this._activeProbes < this.halfOpenMaxProbes;

      default:
        return false;
    }
  }

  /**
   * Record a successful execution. Resets failure counter.
   * In HALF_OPEN, transitions back to CLOSED.
   */
  recordSuccess() {
    this._consecutiveFailures = 0;
    this._activeProbes = Math.max(0, this._activeProbes - 1);

    if (this._state === CircuitState.HALF_OPEN) {
      this._transitionTo(CircuitState.CLOSED, 'probe succeeded');
      this.emit('recover');
    }
  }

  /**
   * Record a failed execution. Increments failure counter.
   * May trip the breaker open.
   */
  recordFailure() {
    this._consecutiveFailures++;
    this._lastFailureAt = this.nowMs();
    this._activeProbes = Math.max(0, this._activeProbes - 1);

    if (this._state === CircuitState.HALF_OPEN) {
      // Probe failed — back to OPEN with fresh cooldown
      this._transitionTo(CircuitState.OPEN, 'probe failed');
      return;
    }

    if (this._state === CircuitState.CLOSED && this._consecutiveFailures >= this.failureThreshold) {
      this._transitionTo(CircuitState.OPEN, `${this._consecutiveFailures} consecutive failures`);
      this.emit('trip', { consecutiveFailures: this._consecutiveFailures });
    }
  }

  /**
   * Get current breaker state snapshot.
   */
  getState() {
    const now = this.nowMs();
    let cooldownRemainingMs = 0;

    if (this._state === CircuitState.OPEN && this._openedAt) {
      cooldownRemainingMs = Math.max(0, this.cooldownMs - (now - this._openedAt));
    }

    return {
      state: this._state,
      consecutiveFailures: this._consecutiveFailures,
      lastFailureAt: this._lastFailureAt ? new Date(this._lastFailureAt).toISOString() : null,
      cooldownRemainingMs,
    };
  }

  /**
   * Force-reset the breaker to CLOSED state.
   */
  reset() {
    this._clearCooldownTimer();
    this._consecutiveFailures = 0;
    this._lastFailureAt = null;
    this._openedAt = null;
    this._activeProbes = 0;
    const from = this._state;
    this._state = CircuitState.CLOSED;
    if (from !== CircuitState.CLOSED) {
      this.emit('state:change', { from, to: CircuitState.CLOSED, reason: 'manual reset' });
    }
  }

  /**
   * Clean up timers. Call when done with the breaker.
   */
  destroy() {
    this._clearCooldownTimer();
    this.removeAllListeners();
  }

  // --- Private ---

  _transitionTo(newState, reason) {
    const from = this._state;
    if (from === newState) return;

    this._state = newState;
    this.emit('state:change', { from, to: newState, reason });

    if (newState === CircuitState.OPEN) {
      this._openedAt = this.nowMs();
      this._startCooldownTimer();
    } else {
      this._clearCooldownTimer();
      this._openedAt = null;
    }

    if (newState === CircuitState.HALF_OPEN) {
      this._activeProbes = 0;
    }
  }

  _startCooldownTimer() {
    this._clearCooldownTimer();
    this._cooldownTimer = setTimeout(() => {
      if (this._state === CircuitState.OPEN) {
        this._transitionTo(CircuitState.HALF_OPEN, 'cooldown expired');
      }
    }, this.cooldownMs);
    // Allow process to exit even if timer is pending
    if (this._cooldownTimer.unref) {
      this._cooldownTimer.unref();
    }
  }

  _clearCooldownTimer() {
    if (this._cooldownTimer) {
      clearTimeout(this._cooldownTimer);
      this._cooldownTimer = null;
    }
  }
}

/**
 * Scoped recovery policy (03 §11.5). Every bound is an explicit number or a
 * resolved config override — no unbounded retry, every loop has a max.
 *
 * - distinctThreshold/windowMs: open a scope at three distinct failures in
 *   120s, or when every member of a frozen cohort of at least two
 *   outstanding attempts fails in that window.
 * - cooldownMs/maxCooldownMs: earliest admission is max(120s cooldown,
 *   known 429 reset/Retry-After); a failed canary doubles the cooldown,
 *   capped at 900s. Malformed resets fall back to this backoff with
 *   bounded jitter.
 * - canaryTimeoutMs (half-open canary, #2915D2): once a scope is open and
 *   due, `canLaunch` admits the NEXT real launch through the existing
 *   direct-dispatch surface as the single canary for every covering scope
 *   it is due for — there is no separate probe runner. The admission is a
 *   tracked reservation bounded by this deadline; an unreported/expired
 *   canary is accounted as failed and the expiry sweep reopens with
 *   backoff. A launcher-verified success on that same invocation recovers
 *   the scope; a launcher-verified failure reopens it. Unverified/worker
 *   evidence never recovers (`isTrustedRecoveryEvidence`).
 * - maxTrackedScopes/maxChargedAttempts: explicit caps on retained scope
 *   and dedup-set state, with LRU eviction of inert entries, so a
 *   long-running process's bookkeeping never grows without bound (#2915
 *   review: settled outstanding/scope maps never dropped their keys).
 *
 * @implements #2915
 */
export const RecoveryPolicy = Object.freeze({
  distinctThreshold: 3,
  windowMs: 120_000,
  minOutstanding: 2,
  cooldownMs: 120_000,
  maxCooldownMs: 900_000,
  canaryTimeoutMs: 300_000,
  backoffMultiplier: 2,
  maxJitterMs: 1_000,
  maxRetryAfterSeconds: 86_400,
  maxTrackedScopes: 500,
  maxChargedAttempts: 5_000,
});

/**
 * Validate numeric policy overrides. Every bound must be an explicit finite
 * number in range — unbounded or NaN overrides are refused rather than
 * silently widening a loop (#2915 review: policy overrides lacked validation).
 */
export function validateRecoveryPolicy(policy) {
  const fail = (name, why) => { throw new RangeError(`Invalid recovery policy ${name}: ${why}`); };
  const positiveInt = (name, value, min = 1) => {
    if (!Number.isInteger(value) || value < min) fail(name, `expected integer >= ${min}, got ${value}`);
  };
  const positiveMs = (name, value) => {
    if (!Number.isFinite(value) || value <= 0) fail(name, `expected finite ms > 0, got ${value}`);
  };
  positiveInt('distinctThreshold', policy.distinctThreshold);
  positiveMs('windowMs', policy.windowMs);
  positiveInt('minOutstanding', policy.minOutstanding);
  positiveMs('cooldownMs', policy.cooldownMs);
  positiveMs('maxCooldownMs', policy.maxCooldownMs);
  if (policy.maxCooldownMs < policy.cooldownMs) fail('maxCooldownMs', 'must be >= cooldownMs');
  positiveMs('canaryTimeoutMs', policy.canaryTimeoutMs);
  if (!Number.isFinite(policy.backoffMultiplier) || policy.backoffMultiplier < 1) {
    fail('backoffMultiplier', `expected finite number >= 1, got ${policy.backoffMultiplier}`);
  }
  if (!Number.isFinite(policy.maxJitterMs) || policy.maxJitterMs < 0) fail('maxJitterMs', `expected finite ms >= 0, got ${policy.maxJitterMs}`);
  if (!Number.isFinite(policy.maxRetryAfterSeconds) || policy.maxRetryAfterSeconds < 0) {
    fail('maxRetryAfterSeconds', `expected finite seconds >= 0, got ${policy.maxRetryAfterSeconds}`);
  }
  positiveInt('maxTrackedScopes', policy.maxTrackedScopes, 2);
  positiveInt('maxChargedAttempts', policy.maxChargedAttempts, 2);
  return policy;
}

/** Failure scopes, narrowest first. A failure opens only its own scope. */
export const FailureScope = Object.freeze({
  INVOCATION: 'invocation',
  MODEL: 'model',
  INSTALLATION: 'installation',
  QUOTA: 'quota',
  PROVIDER: 'provider',
  HOST: 'host',
});

// Reason codes produced by classifyWorkerHealthFailure (lib/worker-health.mjs).
// Anything unlisted — task-local errors, unknown signatures — stays in the
// invocation scope so independent task failures never open a wider scope.
const QUOTA_CODES = new Set(['RATE_LIMIT']);
const HOST_CODES = new Set(['RESOURCE', 'NOT_FOUND', 'SANDBOX']);
const PROVIDER_CODES = new Set(['NETWORK']);
const INSTALLATION_CODES = new Set(['AUTH']);
const MODEL_CODES = new Set(['MODEL']);

export const scopeKeyFor = Object.freeze({
  invocation: (id) => `invocation:${id ?? 'unknown'}`,
  model: (key) => `model:${key ?? 'unknown'}`,
  // `qualifier`, when supplied, distinguishes separately-qualified
  // installations that share a CLI name (#2915 review: two projects
  // resolving different installations under `codex` shared one
  // `installation:codex` scope). Omitted/null preserves the plain
  // `installation:<cli>` key so existing single-installation callers and
  // tests are unaffected.
  installation: (cli, qualifier = null) => qualifier
    ? `installation:${cli ?? 'unknown'}:${qualifier}`
    : `installation:${cli ?? 'unknown'}`,
  quota: (account) => `quota:${account ?? 'unknown'}`,
  provider: (name) => `provider:${name ?? 'unknown'}`,
  host: (id) => `host:${id ?? 'local'}`,
});

/** Scope breadth rank, narrowest first. Used to fold over-broad claims back. */
const SCOPE_RANK = Object.freeze({
  [FailureScope.INVOCATION]: 0,
  [FailureScope.MODEL]: 1,
  [FailureScope.INSTALLATION]: 2,
  [FailureScope.QUOTA]: 3,
  [FailureScope.PROVIDER]: 4,
  [FailureScope.HOST]: 5,
});

export function scopeRank(scope) {
  return SCOPE_RANK[scope] ?? 0;
}

/**
 * Evidence sources. Only `launcher` (launcher-observed spawn/wait/exit facts
 * from its own child and unit status) and `resolver` (the #2887 resolved
 * invocation and installation qualification) are trusted to widen a scope.
 * `worker` covers everything derived from worker stderr/stdout, structured
 * worker output, or worker-writable files — including the qualified health
 * classifier's reason codes, which describe worker-observed text, not
 * launcher-verified facts. Worker-sourced failures NEVER widen: they stay in
 * the invocation scope, so one misbehaving task retried under fresh ids can
 * poison at most its own attempts, never a provider, host, quota or
 * installation scope (#2915 review: scope poisoning).
 *
 * Identity separation: the inference backend (`inferenceProvider`, e.g.
 * `openai`) and the CLI installation (`cli`, e.g. `codex`) are distinct
 * trusted identities. Provider scope keys use the raw backend string — never
 * normalized through the CLI/provider-definition registry, which maps
 * backends onto CLI ids (`openai` -> `codex`) and merges the two identities.
 */
export const RecoveryEvidenceSource = Object.freeze({
  LAUNCHER: 'launcher',
  RESOLVER: 'resolver',
  WORKER: 'worker',
});

const TRUSTED_SOURCES = new Set([RecoveryEvidenceSource.LAUNCHER, RecoveryEvidenceSource.RESOLVER]);

export function isTrustedRecoveryEvidence(source) {
  return TRUSTED_SOURCES.has(source);
}

/**
 * Attribute a failure to the narrowest scope its evidence supports. Trusted
 * launcher/resolver evidence with a matching trusted identity may implicate a
 * wider scope (still `suspected` until the distinct-invocation correlation
 * rule confirms it). Anything else — worker-derived codes, missing source,
 * or a wider claim without its required trusted identity — folds back to the
 * invocation scope. In particular a single task's repeated local failures
 * (unknown codes, task errors, worker-observed signatures) can never open a
 * provider, host, quota, installation or model scope; a genuine outage
 * promotes beyond invocation only when N distinct invocations within the
 * window carry the same trusted evidence (the correlation rule in
 * recordFailure).
 */
export function attributeFailureScope({
  reasonCode = null,
  evidenceSource = null,
  invocationId = null,
  modelKey = null,
  cli = null,
  inferenceProvider = null,
  provider = null,
  quotaAccount = null,
  hostId = null,
  corroboratedBackends = null,
  installationQualifier = null,
} = {}) {
  const invocation = { scope: FailureScope.INVOCATION, scopeKey: scopeKeyFor.invocation(invocationId), confidence: 'suspected' };
  if (!isTrustedRecoveryEvidence(evidenceSource)) return invocation;
  // Legacy alias: `provider` carried either identity through the old call
  // sites. The backend wins for provider scope; the CLI never implies it.
  const backend = inferenceProvider ?? null;
  if (reasonCode === 'NOT_FOUND' || reasonCode === 'SPAWN_REFUSED') {
    // Launcher-observed failure to execute the resolved CLI binary itself
    // (spawn ENOENT/EACCES on argv[0], never a worker-observed message —
    // worker-sourced NOT_FOUND returns in the invocation scope above). A
    // missing task subprocess must never implicate the host.
    if (cli == null || cli === '') return invocation;
    return { scope: FailureScope.INSTALLATION, scopeKey: scopeKeyFor.installation(cli, installationQualifier), confidence: 'suspected' };
  }
  if (QUOTA_CODES.has(reasonCode)) {
    if (quotaAccount == null || quotaAccount === '') return invocation;
    return { scope: FailureScope.QUOTA, scopeKey: scopeKeyFor.quota(quotaAccount), confidence: 'suspected' };
  }
  if (HOST_CODES.has(reasonCode)) {
    // Host scope pauses cross-provider retries: it requires corroboration
    // across at least two distinct trusted backends in this evidence set.
    // Single-provider host signatures stay invocation-scoped.
    const backends = [...new Set((corroboratedBackends ?? []).filter((b) => b != null && b !== ''))];
    if (backends.length < 2) return invocation;
    return { scope: FailureScope.HOST, scopeKey: scopeKeyFor.host(hostId), confidence: 'suspected' };
  }
  if (PROVIDER_CODES.has(reasonCode)) {
    if (backend == null || backend === '') return invocation;
    return { scope: FailureScope.PROVIDER, scopeKey: scopeKeyFor.provider(backend), confidence: 'suspected' };
  }
  if (INSTALLATION_CODES.has(reasonCode)) {
    if (cli == null || cli === '') return invocation;
    return { scope: FailureScope.INSTALLATION, scopeKey: scopeKeyFor.installation(cli, installationQualifier), confidence: 'suspected' };
  }
  if (MODEL_CODES.has(reasonCode)) {
    if (modelKey == null || modelKey === '') return invocation;
    return { scope: FailureScope.MODEL, scopeKey: scopeKeyFor.model(modelKey), confidence: 'suspected' };
  }
  return invocation;
}

const RECOVERY_REMEDIES = Object.freeze({
  invocation: 'Inspect this attempt only; do not widen the scope. Retry after confirmed stop within task attempts/budget.',
  model: 'Refresh or re-resolve the model binding without silent pin replacement; retry after confirmed stop.',
  installation: 'Check the CLI installation, PATH and executable version; other providers are unaffected.',
  quota: 'Wait for the quota reset; do not retry-storm. Aliases sharing the account share this outage.',
  provider: 'Wait for provider recovery or fail over to an unaffected provider; host-local work is unaffected.',
  host: 'Check memory, disk, PATH and sandbox policy on this host. Cross-provider retries stay paused.',
});

/**
 * ScopedFailureBreaker - correlated-failure scopes over the existing
 * ConsecutiveFailureCircuitBreaker transitions (closed → open → half-open).
 *
 * Each scope owns one inner breaker (failureThreshold 1: the correlation
 * rule below is the only trip authority), sharing this instance's injected
 * `nowMs` clock. Probes drive the inner half-open transitions; an echo
 * probe can never close an upstream outage — only a launcher-verified
 * relevant probe success admits one canary, and only a launcher-verified
 * canary success recovers the scope.
 *
 * All window/cooldown math uses the injectable `nowMs` clock, so tests run
 * on synthetic time (vitest fake timers cover the default Date.now clock).
 *
 * Restart/state (#2915D): all breaker state lives in-memory in this
 * instance — there is deliberately no persisted store (a durable shared
 * store would be a new subsystem; managed-tier shared ownership stays
 * deferred to Tier 1). A restarted conductor therefore comes up with every
 * scope CLOSED (fail-open on restart). This is the smaller safe option
 * because two couplings survive the restart: (1) the stop-before-retry gate
 * still requires the launcher's own confirmed-termination evidence
 * (exit.json `termination`) before any retry, so uncertain work is never
 * replayed blindly; (2) fresh trusted evidence re-opens a scope through the
 * same distinct-invocation rule, so a real outage re-pauses within N
 * failures. No uncertain probe/canary reservation survives a restart —
 * reservations are single-use and bound to this instance.
 */
export class ScopedFailureBreaker extends EventEmitter {
  /**
   * @param {object} options
   * @param {object} [options.policy] Numeric overrides for RecoveryPolicy.
   * @param {function} [options.nowMs] Synthetic-clock source (defaults to Date.now).
   * @param {function} [options.jitterMs] Bounded-jitter source (defaults to Math.random-based).
   */
  constructor(options = {}) {
    super();
    this.policy = validateRecoveryPolicy({ ...RecoveryPolicy, ...(options.policy ?? {}) });
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.jitterMs = options.jitterMs
      ?? (() => Math.floor(Math.random() * (this.policy.maxJitterMs + 1)));
    this._scopes = new Map();
    this._outstanding = new Map();
    this._canarySeq = 0;
    this._chargedAttempts = new Set();
    this.canariesCharged = 0;
  }

  /**
   * Track a launch so the cohort frozen at the first failure sees attempts
   * outstanding in-window. Cohort membership is immutable once frozen: later
   * launches never join it (#2915 review: noteLaunched grew the frozen
   * cohort, so the original members' unanimous failure could not open it).
   * Outstanding entries older than the window are pruned here, so a leaked
   * note (a pre-spawn failure that never settled) can pollute a cohort for
   * at most one window, never permanently.
   */
  noteLaunched(scopeKeys, invocationId) {
    const now = this.nowMs();
    for (const scopeKey of scopeKeys ?? []) {
      let set = this._outstanding.get(scopeKey);
      if (!set) { set = new Map(); this._outstanding.set(scopeKey, set); }
      set.set(invocationId, now);
      for (const [id, atMs] of set) {
        if (now - atMs >= this.policy.windowMs) set.delete(id);
      }
    }
  }

  /**
   * Clear outstanding membership across all covering scopes once an attempt
   * settles (used for pre-spawn failures that must leave no trace, and
   * after recording an outcome against a single scope so sibling scopes do
   * not retain a stale member that would veto future cohort unanimity).
   */
  noteSettled({ scopeKeys = [], invocationId } = {}) {
    for (const scopeKey of scopeKeys ?? []) this._removeOutstanding(scopeKey, invocationId);
  }

  /**
   * Record a failed invocation against its attributed scope. Each distinct
   * invocation counts once per window; later samples of the same attempt
   * never inflate the count. Opens the narrowest evidenced scope when three
   * distinct invocations fail in 120s, or when every member of a frozen
   * cohort of at least two outstanding attempts has failed.
   *
   * Trust enforcement: the recorded scope is the NARROWER of the caller's
   * claim and what the attached evidence supports (re-attributed here, so a
   * wide claim on worker-derived or identity-less evidence folds back to the
   * invocation scope instead of opening a shared scope). Callers may always
   * record narrower than the evidence allows.
   */
  recordFailure({ scope, scopeKey, invocationId, reasonCode = null, evidenceSource = null,
    modelKey = null, cli = null, inferenceProvider = null, quotaAccount = null, hostId = null,
    corroboratedBackends = null, resetAtMs = null, retryAfterSeconds = null, installationQualifier = null } = {}) {
    if (!scope || !scopeKey) throw new Error('recordFailure requires an attributed scope and scopeKey');
    const supported = attributeFailureScope({ reasonCode, evidenceSource, invocationId, modelKey,
      cli, inferenceProvider, quotaAccount, hostId, corroboratedBackends, installationQualifier });
    if (scopeRank(supported.scope) < scopeRank(scope)) {
      scope = supported.scope;
      scopeKey = supported.scopeKey;
    }
    const now = this.nowMs();
    const rec = this._scopeRecord(scope, scopeKey);
    this._touch(rec);
    this._removeOutstanding(scopeKey, invocationId);

    // Genuine rolling-window retention: prune only failures older than the
    // window. Refreezing the cohort epoch must NOT discard still-recent
    // failures (#2915 review: the epoch reset cleared them, so three
    // in-window failures counted as two and never opened the scope).
    rec.failures = rec.failures.filter((f) => now - f.atMs < this.policy.windowMs);
    if (rec.cohortFrozenAt === null || now - rec.cohortFrozenAt >= this.policy.windowMs) {
      rec.cohort = new Set([...(this._outstanding.get(scopeKey)?.keys() ?? []), invocationId]);
      rec.cohortFrozenAt = now;
    }
    if (!rec.failures.some((f) => f.invocationId === invocationId)) {
      rec.failures.push({ invocationId, atMs: now, reasonCode });
    }
    const distinct = new Set(rec.failures.map((f) => f.invocationId));
    rec.evidence.set(reasonCode ?? 'UNKNOWN', (rec.evidence.get(reasonCode ?? 'UNKNOWN') ?? 0) + 1);

    const reset = this._resolveResetAtMs({ resetAtMs, retryAfterSeconds }, now);
    if (reset !== null && (rec.resetAtMs === null || reset > rec.resetAtMs)) {
      rec.resetAtMs = reset;
      // A later 429 reset/Retry-After pushes the next probe out: honoring an
      // updated reset must move nextProbeAtMs, not just resetAtMs (#2915
      // review: probes were admitted before the updated reset elapsed).
      if (rec.status !== 'closed') {
        rec.nextProbeAtMs = Math.max(rec.nextProbeAtMs, reset + this._boundedJitter());
      }
    }

    // Cumulative attempt accounting: charged once per distinct invocation,
    // with unknown cost kept unknown (never zero).
    this._chargeAttempt(scopeKey, invocationId);

    if (rec.status !== 'closed') {
      // A failure against an open scope with an outstanding canary
      // (#2915D2) IS the canary's failure (canLaunch admits at most one
      // launch per open scope at a time), and reopens immediately with
      // doubled backoff rather than waiting on the distinct-failure
      // threshold, which never fires again for an already-open scope.
      if (rec.activeCanary) {
        rec.activeCanary = null;
        this._reopen(rec, now);
        this._emitSummary(rec, 'canary-failed', { invocationId });
        return { opened: false, state: 'open', distinctFailures: distinct.size, canaryFailed: true };
      }
      return { opened: false, state: 'open', distinctFailures: distinct.size };
    }

    const cohort = rec.cohort ?? new Set();
    const allOutstandingFailed = cohort.size >= this.policy.minOutstanding
      && [...cohort].every((id) => distinct.has(id));
    if (distinct.size >= this.policy.distinctThreshold || allOutstandingFailed) {
      rec.openedAtMs = now;
      rec.nextProbeAtMs = Math.max(now + rec.episodeCooldownMs, rec.resetAtMs ?? 0) + this._boundedJitter();
      rec.breaker.cooldownMs = rec.episodeCooldownMs;
      rec.breaker.recordFailure();
      rec.status = 'open';
      this._emitSummary(rec, 'opened', { affectedAttempts: [...distinct] });
      return { opened: true, state: 'open', distinctFailures: distinct.size };
    }
    return { opened: false, state: 'closed', distinctFailures: distinct.size };
  }

  /**
   * A success clears outstanding membership but never closes an open scope
   * by itself — UNLESS the scope is OPEN and currently holds an outstanding
   * canary reservation (#2915D2), in which case this success resolves it
   * and recovers the scope (see `canLaunch`). Resolution does not match an
   * `invocationId` against the reservation: `canLaunch` admits at most one
   * launch per open scope at a time (every other covering launch is
   * refused while a canary is outstanding), so by construction the only
   * attempt that can ever report an outcome against an open scope while its
   * `activeCanary` is set IS that admitted canary — matching an id here
   * would only reproduce the exact wiring gap the review found (production
   * call sites mint the real invocationId AFTER `canLaunch`, so an id
   * recorded at admission time would never match the id reported back).
   * Every launched attempt is charged exactly once — including successes
   * (#2915 review: successful attempts charged 0, so the task allowance
   * under-counted real spend).
   */
  recordSuccess({ scopeKey, invocationId } = {}) {
    this._removeOutstanding(scopeKey, invocationId);
    this._chargeAttempt(scopeKey, invocationId);
    const rec = scopeKey ? this._scopes.get(scopeKey) : null;
    if (!rec) return;
    this._touch(rec);
    if (rec.status === 'closed') { rec.breaker.recordSuccess(); return; }
    if (rec.activeCanary) {
      rec.activeCanary = null;
      rec.reopens = 0;
      rec.episodeCooldownMs = this.policy.cooldownMs;
      rec.resetAtMs = null;
      rec.nextProbeAtMs = 0;
      rec.status = 'closed';
      rec.breaker.reset();
      this._emitSummary(rec, 'recovered', { invocationId });
    }
    // A success for an open scope with NO outstanding canary (expired and
    // already swept by `expireStaleReservations`) never recovers it by
    // surprise — only a success against a live canary reservation may.
  }

  /**
   * An attempt whose termination the launcher could not confirm is charged
   * to the task allowance but contributes NO failure evidence: uncertain
   * work must never open a scope, and its stop is still unproven (the
   * stop-before-retry gate, not the breaker, governs any retry of it). If
   * this invocation held the admitted canary reservation, release it and
   * reopen with backoff — an uncertain canary outcome is not proof of
   * recovery and must not leave the scope silently admitting the next
   * launch as a canary indefinitely.
   */
  noteUncertainTermination({ scopeKeys = [], invocationId } = {}) {
    for (const scopeKey of scopeKeys ?? []) {
      this._removeOutstanding(scopeKey, invocationId);
      const rec = this._scopes.get(scopeKey);
      if (rec?.activeCanary) {
        rec.activeCanary = null;
        this._reopen(rec, this.nowMs());
        this._emitSummary(rec, 'canary-uncertain', { invocationId });
      }
    }
    this._chargeAttempt(scopeKeys?.[0], invocationId);
  }

  _chargeAttempt(scopeKey, invocationId) {
    if (invocationId == null || this._chargedAttempts.has(invocationId)) return false;
    this._chargedAttempts.add(invocationId);
    if (this._chargedAttempts.size > this.policy.maxChargedAttempts) {
      const oldest = this._chargedAttempts.values().next().value;
      this._chargedAttempts.delete(oldest);
    }
    const rec = scopeKey ? this._scopes.get(scopeKey) : null;
    if (rec) rec.attemptsCharged += 1;
    return true;
  }

  /**
   * Synchronous launch gate (#2915D2, half-open canary). A closed covering
   * scope never blocks. An OPEN covering scope blocks UNLESS it is due
   * (past its backoff/reset floor) and holds no outstanding canary — in
   * which case THIS launch is admitted and reserved, for every due covering
   * scope at once, as their single half-open canary. The admission and the
   * reservation happen in the same synchronous call, so no tick or
   * concurrent caller can slip a second launch past the same due window
   * (there is no separate probe step to race). The caller's own
   * `recordSuccess`/`recordFailure`/`noteUncertainTermination` after the
   * real attempt settles the reservation: success recovers every scope it
   * covered, failure reopens with doubled backoff, and an unreported/expired
   * reservation is swept as failed by `expireStaleReservations` so a hung
   * canary can never gate a scope forever (no deadlock: every open scope
   * always has a bounded, reachable path back to a real launch).
   */
  canLaunch({ invocationId = null, scopeKeys = [] } = {}) {
    this.expireStaleReservations();
    const covering = [...(scopeKeys ?? [])];
    if (invocationId != null) covering.push(scopeKeyFor.invocation(invocationId));
    const openKeys = covering.filter((key) => {
      const rec = this._scopes.get(key);
      return rec && rec.status !== 'closed';
    });
    if (openKeys.length === 0) return { ok: true, blockedBy: [] };
    const now = this.nowMs();
    const blockedBy = [];
    const admissible = [];
    for (const scopeKey of openKeys) {
      const rec = this._scopes.get(scopeKey);
      if (rec.activeCanary) { blockedBy.push(scopeKey); continue; }
      const dueFloor = Math.max(rec.nextProbeAtMs ?? 0, rec.resetAtMs ?? 0);
      if (now < dueFloor || !rec.breaker.canExecute()) { blockedBy.push(scopeKey); continue; }
      admissible.push(scopeKey);
    }
    if (blockedBy.length > 0) return { ok: false, blockedBy };
    this._canarySeq += 1;
    const canaryId = `canary-${this._canarySeq}`;
    for (const scopeKey of admissible) {
      const rec = this._scopes.get(scopeKey);
      rec.activeCanary = { id: canaryId, scopeKey, invocationId, reservedAtMs: now, deadlineMs: now + this.policy.canaryTimeoutMs };
      rec.canariesCharged += 1;
      this.canariesCharged += 1;
      this._touch(rec);
      this._emitSummary(rec, 'canary-admitted', { invocationId });
    }
    return { ok: true, blockedBy: [], canaryId, canaryScopeKeys: admissible };
  }

  /**
   * Account and close every canary reservation past its deadline. A hung or
   * unreported canary is a failed canary: it reopens with backoff and frees
   * the scope for a fresh admission once due. Called at the top of every
   * gate/record path, so expiry is always observed by the next check even
   * when the admitted attempt never reports back at all (process crash,
   * dropped callback) — this is the backstop that makes the half-open
   * design deadlock-free.
   */
  expireStaleReservations() {
    const now = this.nowMs();
    for (const rec of this._scopes.values()) {
      if (rec.activeCanary && now > rec.activeCanary.deadlineMs) {
        const canaryId = rec.activeCanary.id;
        rec.activeCanary = null;
        this._reopen(rec, now);
        this._emitSummary(rec, 'canary-expired', { canaryId });
      }
    }
  }

  getState(scopeKey) {
    const rec = this._scopes.get(scopeKey);
    if (!rec) return { scopeKey, state: 'closed', tracked: false };
    const inner = rec.breaker.getState();
    return {
      scopeKey,
      scope: rec.scope,
      tracked: true,
      state: rec.status,
      consecutiveFailures: inner.consecutiveFailures,
      distinctFailures: new Set(rec.failures.map((f) => f.invocationId)).size,
      outstanding: this._outstanding.get(scopeKey)?.size ?? 0,
      cohortSize: rec.cohort?.size ?? 0,
      activeCanary: rec.activeCanary ? { ...rec.activeCanary } : null,
      episodeCooldownMs: rec.episodeCooldownMs,
      nextProbeAtMs: rec.nextProbeAtMs,
      resetAtMs: rec.resetAtMs,
      attemptsCharged: rec.attemptsCharged,
      canariesCharged: rec.canariesCharged,
      cooldownRemainingMs: inner.cooldownRemainingMs,
    };
  }

  snapshot() {
    return {
      scopes: [...this._scopes.keys()].map((key) => this.getState(key)),
      attemptsCharged: this._chargedAttempts.size,
      canariesCharged: this.canariesCharged,
    };
  }

  reset(scopeKey) {
    if (scopeKey) {
      const rec = this._scopes.get(scopeKey);
      if (rec) {
        rec.breaker.destroy();
        this._scopes.delete(scopeKey);
        this._outstanding.delete(scopeKey);
      }
      return;
    }
    for (const rec of this._scopes.values()) rec.breaker.destroy();
    this._scopes.clear();
    this._outstanding.clear();
  }

  destroy() {
    for (const rec of this._scopes.values()) rec.breaker.destroy();
    this._scopes.clear();
    this._outstanding.clear();
    this.removeAllListeners();
  }

  // --- Private ---

  _scopeRecord(scope, scopeKey) {
    let rec = this._scopes.get(scopeKey);
    if (rec) return rec;
    this._evictInertScopeIfNeeded();
    rec = {
      scope,
      scopeKey,
      // Scope-level status is authoritative for gates and reports; the
      // inner breaker owns only the half-open transitions, whose
      // timer-driven states must never read as scope recovery. The inner
      // breaker shares this instance's injected clock (one clock, #2915E).
      status: 'closed',
      breaker: new ConsecutiveFailureCircuitBreaker({
        failureThreshold: 1,
        cooldownMs: this.policy.cooldownMs,
        halfOpenMaxProbes: 1,
        nowMs: this.nowMs,
      }),
      failures: [],
      cohort: null,
      cohortFrozenAt: null,
      evidence: new Map(),
      resetAtMs: null,
      openedAtMs: null,
      nextProbeAtMs: 0,
      episodeCooldownMs: this.policy.cooldownMs,
      activeCanary: null,
      reopens: 0,
      attemptsCharged: 0,
      canariesCharged: 0,
      lastTouchedMs: this.nowMs(),
    };
    this._scopes.set(scopeKey, rec);
    return rec;
  }

  /** Last-touched bookkeeping for LRU eviction of inert (closed, memberless) scopes. */
  _touch(rec) {
    rec.lastTouchedMs = this.nowMs();
  }

  /**
   * Explicit, bounded eviction (#2915 review: settled outstanding/scope maps
   * never dropped their own keys, so 1,000 successful attempts retained
   * 1,000+ map entries forever). Only CLOSED scopes with no outstanding
   * members are eligible — an open scope (or one with outstanding attempts)
   * is never evicted, so real recovery state is never silently dropped. The
   * scan is bounded by `maxTrackedScopes`, never unbounded.
   */
  _evictInertScopeIfNeeded() {
    if (this._scopes.size < this.policy.maxTrackedScopes) return;
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [key, rec] of this._scopes) {
      if (rec.status !== 'closed' || rec.activeCanary) continue;
      const outstanding = this._outstanding.get(key);
      if (outstanding && outstanding.size > 0) continue;
      if (rec.lastTouchedMs < oldestAt) { oldestAt = rec.lastTouchedMs; oldestKey = key; }
    }
    if (oldestKey !== null) {
      this._scopes.get(oldestKey)?.breaker.destroy();
      this._scopes.delete(oldestKey);
      this._outstanding.delete(oldestKey);
    }
    // If every tracked scope is open or has outstanding members, there is
    // nothing safe to evict this call; the bound is best-effort under that
    // adversarial condition rather than ever discarding live recovery state.
  }

  _removeOutstanding(scopeKey, invocationId) {
    const set = this._outstanding.get(scopeKey);
    if (!set || invocationId == null) return;
    set.delete(invocationId);
    if (set.size === 0) this._outstanding.delete(scopeKey);
  }

  _resolveResetAtMs({ resetAtMs, retryAfterSeconds }, now) {
    if (Number.isFinite(resetAtMs) && resetAtMs > now) return resetAtMs;
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
      return now + Math.min(retryAfterSeconds, this.policy.maxRetryAfterSeconds) * 1000;
    }
    return null;
  }

  _boundedJitter() {
    const cap = this.policy.maxJitterMs;
    const value = Math.floor(Number(this.jitterMs()) || 0);
    return Math.max(0, Math.min(cap, value));
  }

  /** Reopen (or stay open) with doubled backoff, capped at maxCooldownMs. */
  _reopen(rec, now) {
    rec.reopens += 1;
    rec.episodeCooldownMs = Math.min(
      this.policy.maxCooldownMs,
      this.policy.cooldownMs * (this.policy.backoffMultiplier ** rec.reopens),
    );
    rec.openedAtMs = now;
    rec.nextProbeAtMs = Math.max(now + rec.episodeCooldownMs, rec.resetAtMs ?? 0) + this._boundedJitter();
    rec.breaker.cooldownMs = rec.episodeCooldownMs;
    rec.breaker.recordFailure();
    this._touch(rec);
  }

  _emitSummary(rec, transition, extra) {
    // One actionable summary per transition — never per-tick noise. Unknown
    // cost stays unknown: costUsd is null, never zero.
    this.emit('summary', {
      transition,
      scope: rec.scope,
      scopeKey: rec.scopeKey,
      affectedAttempts: rec.failures.map((f) => f.invocationId),
      evidence: Object.fromEntries(rec.evidence),
      nextProbeAtMs: rec.nextProbeAtMs,
      resetAtMs: rec.resetAtMs,
      cooldownMs: rec.episodeCooldownMs,
      remedy: RECOVERY_REMEDIES[rec.scope] ?? RECOVERY_REMEDIES.invocation,
      costUsd: null,
      attemptsCharged: rec.attemptsCharged,
      ...(extra ?? {}),
    });
  }
}
