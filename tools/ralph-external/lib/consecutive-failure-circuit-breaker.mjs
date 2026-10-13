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
        // Check if cooldown has elapsed (in case timer hasn't fired yet).
        // `!== null`, not a truthy check (#2915 final review latent-bug
        // fix): `_openedAt` is a `nowMs()` timestamp, and a synthetic clock
        // can legitimately open a scope at time 0, which `0 && ...` would
        // treat as "never opened" and refuse to ever leave OPEN.
        if (this._openedAt !== null && this.nowMs() - this._openedAt >= this.cooldownMs) {
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

    if (this._state === CircuitState.OPEN && this._openedAt !== null) {
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
 *   review: settled outstanding/scope maps never dropped their keys). A
 *   hard cap refuses a brand-new scope record once at maxTrackedScopes with
 *   nothing evictable, rather than silently growing past it or evicting an
 *   OPEN/outstanding scope (#2915 final review, finding 6).
 * - maxOutstandingReservations: hard cap on live (unsettled) admission
 *   reservations, including canary reservations and uncertain blocking
 *   markers; a reservation past its own deadline is swept (treated as
 *   uncertain) rather than retained forever.
 * - maxCoveringKeys: hard cap on distinct scope keys (including the
 *   invocation key) bound to one reservation; the invocation key is never
 *   dropped when trimming.
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
  maxOutstandingReservations: 128,
  maxCoveringKeys: 6,
});

/**
 * Validate numeric policy overrides. Every bound must be an explicit finite
 * number in range — unbounded or NaN overrides are refused rather than
 * silently widening a loop (#2915 review: policy overrides lacked validation).
 */
export function validateRecoveryPolicy(policy) {
  const fail = (name, why) => { throw new RangeError(`Invalid recovery policy ${name}: ${why}`); };
  const positiveInt = (name, value, min = 1, max = Infinity) => {
    if (!Number.isInteger(value) || value < min || value > max) {
      fail(name, `expected integer in [${min}, ${max === Infinity ? '∞' : max}], got ${value}`);
    }
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
  // #2915 review 4 (finding 6): these four are PROTECTIVE maxima, not mere
  // floors — an override above the shipped default would widen the exact
  // unbounded-growth loops this policy exists to close. Upper bound equals
  // the shipped `RecoveryPolicy` default for each (500/128/5000/6); a
  // caller that genuinely needs a smaller budget may still lower it.
  positiveInt('maxTrackedScopes', policy.maxTrackedScopes, 2, RecoveryPolicy.maxTrackedScopes);
  positiveInt('maxChargedAttempts', policy.maxChargedAttempts, 2, RecoveryPolicy.maxChargedAttempts);
  positiveInt('maxOutstandingReservations', policy.maxOutstandingReservations, 1, RecoveryPolicy.maxOutstandingReservations);
  positiveInt('maxCoveringKeys', policy.maxCoveringKeys, 1, RecoveryPolicy.maxCoveringKeys);
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
    this._observedInvocations = new Set();
    this.canariesObserved = 0;
    // Reservation registry (#2915 final review): every admission mints an
    // opaque, breaker-owned token here. A reservation is removed the moment
    // it settles (`settle`) or expires past its own deadline (swept by
    // `_sweepReservations`, called at the top of every `admit`/`settle`), so
    // this map's steady-state size tracks live in-flight attempts, not
    // cumulative history.
    this._reservations = new Map();
    this._reservationSeq = 0;
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
   * One atomic admission (#2915 final review, replaces the former
   * independent `canLaunch` + `noteLaunched` pair). Returns:
   *   - `{ ok: true, token }` — admitted; `token` is an opaque,
   *     breaker-owned reservation that MUST be passed to exactly one later
   *     `settle()` call. `token.canaryKeys` names which covering scopes (if
   *     any) this admission is the half-open canary for.
   *   - `{ ok: false, blockedBy, nextEligibleAt }` — refused; no state was
   *     mutated (no reservation minted, no cohort membership recorded).
   *
   * `scopeKeys` plus the derived `invocation:<id>` key form the covering set
   * for this attempt, capped at `policy.maxCoveringKeys` (the invocation key
   * is never dropped when trimming — #2915 final review, bounded covering
   * keys). Every covering OPEN scope must be simultaneously eligible (due,
   * no outstanding canary, inner breaker executable) for admission to
   * succeed; this keeps the same "all covering scopes settle together"
   * invariant the review required (`all-covering-scopes-settle`).
   *
   * Reservation lifetime is bounded by `policy.maxOutstandingReservations`:
   * once at capacity, a new admission is refused with
   * `blockedBy: ['reservation-capacity']` rather than ever evicting a live
   * reservation (OPEN-scope protection always wins over admitting more
   * concurrent work).
   */
  admit({ invocationId = null, scopeKeys = [] } = {}) {
    const now = this.nowMs();
    this._sweepReservations(now);
    this._sweepOutstanding(now);
    const invocationKey = invocationId != null ? scopeKeyFor.invocation(invocationId) : null;
    const covering = [...new Set([...(scopeKeys ?? []), ...(invocationKey ? [invocationKey] : [])])];
    // #2915 review 5 (finding 5, "lost covering protection"): an oversized
    // covering set is REFUSED outright, never silently trimmed. Every
    // legitimate production caller derives covering keys from
    // `recoveryScopeKeysForInvocation`, which never produces more than
    // `maxCoveringKeys` (6) keys in the first place -- a set larger than
    // that is already outside what this breaker can safely attribute, and
    // trimming it previously dropped some of the caller's own named scopes
    // from tracking entirely, discarding whatever protection they were
    // meant to provide rather than refusing the admission that needed them.
    if (covering.length > this.policy.maxCoveringKeys) {
      return { ok: false, blockedBy: ['covering-set-too-large'], nextEligibleAt: now };
    }
    // #2915 review 5 (finding 5): refuse an admission that would need to
    // track one or more BRAND-NEW shared scopes the tracking table has no
    // room for, rather than admitting it and silently discarding that
    // scope's failure evidence later (`_scopeRecordBounded` returning
    // `null` at settlement time, with no way to signal the caller it never
    // happened). Invocation-scoped keys are exempt: `maxChargedAttempts` is
    // their own separate, much larger budget, never `maxTrackedScopes`.
    // Counted in aggregate (never per-key) so two new keys in the SAME
    // admission can never both claim the same single evictable slot.
    const newSharedKeyCount = covering.filter((key) => key !== invocationKey && !this._scopes.has(key)).length;
    if (newSharedKeyCount > 0 && !this._canTrackNewSharedScopes(newSharedKeyCount)) {
      return { ok: false, blockedBy: ['scope-tracking-capacity'], nextEligibleAt: now };
    }
    const openKeys = covering.filter((key) => {
      const rec = this._scopes.get(key);
      return rec && rec.status !== 'closed';
    });
    const canaryKeys = [];
    if (openKeys.length > 0) {
      const blockedBy = [];
      for (const scopeKey of openKeys) {
        const rec = this._scopes.get(scopeKey);
        if (rec.activeCanary) { blockedBy.push(scopeKey); continue; }
        const dueFloor = Math.max(rec.nextProbeAtMs ?? 0, rec.resetAtMs ?? 0);
        if (now < dueFloor || !rec.breaker.canExecute()) { blockedBy.push(scopeKey); continue; }
        canaryKeys.push(scopeKey);
      }
      if (blockedBy.length > 0) {
        const nextEligibleAt = openKeys.reduce((max, key) => Math.max(max, this._scopes.get(key)?.nextProbeAtMs ?? 0), 0);
        return { ok: false, blockedBy, nextEligibleAt };
      }
    }
    if (this._reservations.size >= this.policy.maxOutstandingReservations) {
      return { ok: false, blockedBy: ['reservation-capacity'], nextEligibleAt: now };
    }
    this._reservationSeq += 1;
    this._canarySeq += canaryKeys.length > 0 ? 1 : 0;
    const id = `res-${this._reservationSeq}`;
    // Only a canary reservation carries the bounded 300s deadline (03 §11.5:
    // the half-open probe window) — an ordinary (non-canary) admission is
    // not bounded by it at all, and never auto-settles via the sweep below;
    // it occupies one slot of `maxOutstandingReservations` until its own
    // caller settles it, however long the real attempt legitimately runs
    // (#2915 final review risk: a canary-only deadline must never leak onto
    // ordinary long-running attempts).
    const deadlineMs = canaryKeys.length > 0 ? now + this.policy.canaryTimeoutMs : Infinity;
    const token = Object.freeze({ id, breaker: this, invocationId, coveringKeys: Object.freeze(covering),
      canaryKeys: Object.freeze(canaryKeys), mintedAtMs: now, deadlineMs });
    this._reservations.set(id, { token, settled: false });
    this.noteLaunched(covering, invocationId);
    for (const scopeKey of canaryKeys) {
      const rec = this._scopes.get(scopeKey);
      rec.activeCanary = { id, scopeKey, invocationId, reservedAtMs: now, deadlineMs };
      rec.canariesObserved += 1;
      this.canariesObserved += 1;
      this._touch(rec);
    }
    return { ok: true, token };
  }

  /**
   * Idempotent, ownership-checked settlement of one `admit()` token (#2915
   * final review). `outcome.kind` is `'succeeded' | 'failed' | 'uncertain'`
   * (the launcher-owned `attemptOutcome`, never a worker claim); `failed`
   * additionally accepts the same attribution fields `recordFailure` used
   * to (`reasonCode`, `evidenceSource`, `cli`, `inferenceProvider`,
   * `quotaAccount`, `hostId`, `corroboratedBackends`, `resetAtMs`,
   * `retryAfterSeconds`, `installationQualifier`, `scope`/`scopeKey` as the
   * caller's own claim, narrowed to what the evidence supports).
   *
   * A token from a different breaker instance, or one already settled
   * (including one already swept as expired), is refused with
   * `{ ok: false, reason }` and mutates nothing — exactly one caller ever
   * wins the settlement of a given reservation
   * (`old-attempt-cannot-settle-canary`).
   *
   * Every covering scope this reservation held settles together: canary
   * scopes resolve per `outcome.kind` (recover / reopen+backoff / reopen
   * uncertain), and every covering scope's outstanding cohort membership is
   * cleared regardless of canary status (`all-covering-scopes-settle`).
   */
  settle(token, outcome = { kind: 'uncertain' }) {
    const now = this.nowMs();
    this._sweepReservations(now);
    this._sweepOutstanding(now);
    // #2915 review 4 (finding 5, exact token ownership): a passed-in token
    // is NEVER trusted for its own field values — only as a lookup key.
    // `entry.token !== token` (reference inequality) refuses ANY copy with
    // altered fields, including one that also copies `breaker`/`id`
    // correctly but changes `invocationId`/`coveringKeys`/`canaryKeys`: the
    // legitimate caller always holds the exact frozen object `admit()`
    // returned, so only that exact object reference can ever match.
    if (!token || typeof token.id !== 'string' || token.breaker !== this) {
      return { ok: false, reason: 'reservation is not owned by this breaker' };
    }
    const entry = this._reservations.get(token.id);
    if (!entry || entry.settled || entry.token !== token) {
      return { ok: false, reason: 'reservation is unknown, already settled, expired, or does not match the stored token' };
    }
    entry.settled = true;
    this._reservations.delete(token.id);
    const { invocationId, coveringKeys, canaryKeys } = entry.token;
    const kind = outcome?.kind ?? 'uncertain';
    // Enforce the canary's own deadline even at settlement time: a reported
    // outcome that arrives after the deadline elapsed never recovers or
    // otherwise resolves the scope through this path — it was (or will be)
    // swept as expired instead (#2915 final review: "enforce deadlines on
    // completion").
    for (const scopeKey of canaryKeys) {
      const rec = this._scopes.get(scopeKey);
      if (!rec || !rec.activeCanary || rec.activeCanary.id !== token.id) continue; // already reopened/expired elsewhere
      if (now > rec.activeCanary.deadlineMs) {
        rec.activeCanary = null;
        this._reopen(rec, now);
        continue;
      }
      rec.activeCanary = null;
      if (kind === 'succeeded') {
        this._recoverScope(rec, invocationId);
      } else if (kind === 'failed') {
        // A reset/Retry-After carried by THIS canary's own failure evidence
        // still merges before reopening — the same "a later failure carries
        // a further reset" rule that applies to any other failure, so a
        // canary that fails with a longer-than-backoff reset does not get
        // probed again before that reset elapses.
        const reset = this._resolveResetAtMs({ resetAtMs: outcome?.resetAtMs ?? null, retryAfterSeconds: outcome?.retryAfterSeconds ?? null }, now);
        if (reset !== null && (rec.resetAtMs === null || reset > rec.resetAtMs)) rec.resetAtMs = reset;
        this._reopen(rec, now);
      } else {
        this._reopen(rec, now);
      }
    }
    if (kind === 'succeeded') {
      for (const scopeKey of coveringKeys) {
        this._recordObservedAttempt(scopeKey, invocationId);
        if (canaryKeys.includes(scopeKey)) continue; // already resolved above
        const rec = this._scopes.get(scopeKey);
        if (rec && rec.status === 'closed') rec.breaker.recordSuccess();
      }
      if (coveringKeys.length === 0) this._recordObservedAttempt(null, invocationId);
    } else if (kind === 'failed') {
      this._settleFailure(token, outcome ?? {}, now);
    }
    // #2915 review 4 (finding 8): an 'uncertain' settlement is NEVER
    // recorded as an observed attempt — it is the kind every pre-spawn
    // refusal settles as (see `settleDirectWorker`), and this diagnostic
    // counter must not read as if something dispatched when it did not.
    // The allowance LEDGER (`debited`), not this counter, is what actually
    // enforces attempt consumption.
    this.noteSettled({ scopeKeys: coveringKeys, invocationId });
    return { ok: true };
  }

  /**
   * Failure attribution + the distinct-threshold/cohort-unanimous open rule,
   * folded into `settle()`. Scopes this token already held as a canary were
   * resolved directly above (reopen on failure, never re-evaluated against
   * the distinct-failure threshold, matching the former `recordFailure`
   * canary short-circuit); every other covering scope goes through the
   * narrowing + correlation rule unchanged from the pre-#2915-final design.
   */
  _settleFailure(token, outcome, now) {
    const { invocationId, canaryKeys } = token;
    const supported = attributeFailureScope({
      reasonCode: outcome.reasonCode ?? null, evidenceSource: outcome.evidenceSource ?? null, invocationId,
      modelKey: outcome.modelKey ?? null, cli: outcome.cli ?? null, inferenceProvider: outcome.inferenceProvider ?? null,
      quotaAccount: outcome.quotaAccount ?? null, hostId: outcome.hostId ?? null,
      corroboratedBackends: outcome.corroboratedBackends ?? null, installationQualifier: outcome.installationQualifier ?? null,
    });
    // When the caller supplies an explicit `scope`/`scopeKey` claim, the
    // recorded scope is the NARROWER of that claim and what the attached
    // evidence supports — a wide claim on worker-derived or identity-less
    // evidence folds back to whatever the evidence actually proves, but a
    // claim that is already as narrow or narrower than the evidence (the
    // normal case: the caller pre-derived this exact attribution, e.g.
    // `classifyAttemptForSettlement`) is kept EXACTLY as given, including
    // its specific scopeKey — a same-rank evidence key (e.g. the generic
    // `host:local` an omitted `hostId` resolves to) must never silently
    // replace a caller's more specific identity (e.g. `host:noodle`) at the
    // same scope breadth. A caller that omits `scope`/`scopeKey` entirely
    // gets the evidence-derived attribution directly.
    let scope;
    let scopeKey;
    if (outcome.scope && outcome.scopeKey) {
      scope = outcome.scope;
      scopeKey = outcome.scopeKey;
      if (scopeRank(supported.scope) < scopeRank(scope)) { scope = supported.scope; scopeKey = supported.scopeKey; }
    } else {
      scope = supported.scope;
      scopeKey = supported.scopeKey;
    }
    if (canaryKeys.includes(scopeKey)) { this._recordObservedAttempt(scopeKey, invocationId); return; } // already reopened as this token's canary failure, above
    const rec = this._scopeRecordBounded(scope, scopeKey);
    // Charge AFTER the scope record exists (or is confirmed unattainable at
    // the hard cap) so `rec.attemptsObserved` reflects this attempt whenever
    // a record is created for it, rather than undercounting the very failure
    // that first creates the scope.
    this._recordObservedAttempt(scopeKey, invocationId);
    if (!rec) return; // at hard capacity with nothing evictable: bookkeeping-only, never exceeds the bound
    this._touch(rec);
    this._removeOutstanding(scopeKey, invocationId);
    // Genuine rolling-window retention: prune only failures older than the
    // window. Refreezing the cohort epoch must NOT discard still-recent
    // failures.
    rec.failures = rec.failures.filter((f) => now - f.atMs < this.policy.windowMs);
    if (rec.cohortFrozenAt === null || now - rec.cohortFrozenAt >= this.policy.windowMs) {
      rec.cohort = new Set([...(this._outstanding.get(scopeKey)?.keys() ?? []), invocationId]);
      rec.cohortFrozenAt = now;
    }
    if (!rec.failures.some((f) => f.invocationId === invocationId)) {
      rec.failures.push({ invocationId, atMs: now, reasonCode: outcome.reasonCode ?? null });
    }
    const distinct = new Set(rec.failures.map((f) => f.invocationId));
    const reasonLabel = outcome.reasonCode ?? 'UNKNOWN';
    rec.evidence.set(reasonLabel, (rec.evidence.get(reasonLabel) ?? 0) + 1);
    const reset = this._resolveResetAtMs({ resetAtMs: outcome.resetAtMs ?? null, retryAfterSeconds: outcome.retryAfterSeconds ?? null }, now);
    if (reset !== null && (rec.resetAtMs === null || reset > rec.resetAtMs)) {
      rec.resetAtMs = reset;
      if (rec.status !== 'closed') rec.nextProbeAtMs = Math.max(rec.nextProbeAtMs, reset + this._boundedJitter());
    }
    if (rec.status !== 'closed') {
      // Already open and this token held no canary on it (defensive: admit()
      // never admits a non-canary reservation covering an open scope).
      return;
    }
    const cohort = rec.cohort ?? new Set();
    const allOutstandingFailed = cohort.size >= this.policy.minOutstanding && [...cohort].every((id) => distinct.has(id));
    if (distinct.size >= this.policy.distinctThreshold || allOutstandingFailed) {
      rec.openedAtMs = now;
      rec.nextProbeAtMs = Math.max(now + rec.episodeCooldownMs, rec.resetAtMs ?? 0) + this._boundedJitter();
      rec.breaker.cooldownMs = rec.episodeCooldownMs;
      rec.breaker.recordFailure();
      rec.status = 'open';
    }
  }

  _recoverScope(rec, invocationId) {
    rec.reopens = 0;
    rec.episodeCooldownMs = this.policy.cooldownMs;
    rec.resetAtMs = null;
    rec.nextProbeAtMs = 0;
    rec.status = 'closed';
    rec.breaker.reset();
  }

  /**
   * #2915 review 4 (finding 8): DIAGNOSTIC only — `attemptsObserved`/
   * `canariesObserved` (renamed from `attemptsCharged`/`canariesCharged`)
   * report what this breaker has seen, never what it enforces. Nothing in
   * `admit()` reads either counter; the allowance LEDGER
   * (`reserveDirectWorkerAllowance`/`debitDirectWorkerAllowance` in
   * session-launcher.mjs) is the actual enforcement. `settle()` only calls
   * this for `'succeeded'`/`'failed'` kinds — an `'uncertain'` settlement
   * (every pre-spawn refusal settles this way) is never recorded here.
   */
  _recordObservedAttempt(scopeKey, invocationId) {
    if (invocationId == null || this._observedInvocations.has(invocationId)) return false;
    this._observedInvocations.add(invocationId);
    if (this._observedInvocations.size > this.policy.maxChargedAttempts) {
      const oldest = this._observedInvocations.values().next().value;
      this._observedInvocations.delete(oldest);
    }
    const rec = scopeKey ? this._scopes.get(scopeKey) : null;
    if (rec) rec.attemptsObserved += 1;
    return true;
  }

  /**
   * Account and settle (as uncertain) every reservation past its own
   * deadline — including non-canary reservations, which share the same
   * bounded TTL so `_reservations` cannot grow without bound from attempts
   * whose caller crashed before calling `settle()`. A hung or unreported
   * canary is treated as a failed canary: it reopens with backoff and frees
   * the scope for a fresh admission once due (the deadline enforcement
   * `expireStaleReservations` used to apply only at the scope level now
   * applies uniformly through the reservation registry). Called at the top
   * of every `admit`/`settle`, so expiry is always observed on the very next
   * call even when the admitted attempt never reports back at all (process
   * crash, dropped callback) — the backstop that makes the design
   * deadlock-free (`deadline-reopens-before-readmission`).
   */
  _sweepReservations(now) {
    for (const [id, entry] of this._reservations) {
      if (entry.settled) { this._reservations.delete(id); continue; }
      if (now <= entry.token.deadlineMs) continue;
      entry.settled = true;
      this._reservations.delete(id);
      const { invocationId, coveringKeys, canaryKeys } = entry.token;
      for (const scopeKey of canaryKeys) {
        const rec = this._scopes.get(scopeKey);
        if (rec?.activeCanary?.id === id) {
          rec.activeCanary = null;
          this._reopen(rec, now);
        }
      }
      this.noteSettled({ scopeKeys: coveringKeys, invocationId });
    }
  }

  /** Public alias retained for direct test/diagnostic use; `admit`/`settle`
   * already call this internally on every invocation. */
  expireStaleReservations() {
    this._sweepReservations(this.nowMs());
  }

  /**
   * Prune every outstanding cohort-membership entry older than the window,
   * across ALL tracked scope keys — not just the ones this call's own
   * covering set touches (#2915 final review, finding 6: pruning used to
   * touch only keys revisited by `noteLaunched`, so an invocation scope for
   * an attempt that never launched again, or never settled, retained its
   * membership forever even once the window had long since elapsed). Bounded
   * by the number of tracked outstanding scope keys, which is itself bounded
   * in steady state by `maxTrackedScopes`/`maxOutstandingReservations`.
   */
  _sweepOutstanding(now) {
    for (const [key, set] of this._outstanding) {
      for (const [id, atMs] of set) {
        if (now - atMs >= this.policy.windowMs) set.delete(id);
      }
      if (set.size === 0) this._outstanding.delete(key);
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
      attemptsObserved: rec.attemptsObserved,
      canariesObserved: rec.canariesObserved,
      cooldownRemainingMs: inner.cooldownRemainingMs,
    };
  }

  snapshot() {
    return {
      scopes: [...this._scopes.keys()].map((key) => this.getState(key)),
      attemptsObserved: this._observedInvocations.size,
      canariesObserved: this.canariesObserved,
      reservationsOutstanding: this._reservations.size,
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
    this._reservations.clear();
  }

  destroy() {
    for (const rec of this._scopes.values()) rec.breaker.destroy();
    this._scopes.clear();
    this._outstanding.clear();
    this._reservations.clear();
    this.removeAllListeners();
  }

  // --- Private ---

  /**
   * Create-or-fetch a tracked scope record, enforcing a true hard cap
   * (#2915 final review, finding 6): once at `maxTrackedScopes` with no
   * CLOSED/memberless scope to evict, a brand-new scope key is refused
   * tracking entirely — `null` — rather than growing past the bound or ever
   * evicting an OPEN/outstanding scope. The caller still charges the
   * attempt; it simply cannot attribute it to a persistently-tracked scope
   * record under this adversarial condition.
   *
   * Invocation-scoped records are counted and bounded SEPARATELY from every
   * shared scope (installation/quota/provider/host/model), against
   * `maxChargedAttempts` rather than `maxTrackedScopes` (#2915 review 4,
   * finding 6: "invocation-local records outside the shared-scope quota").
   * An invocation record can never legitimately open (cohort/distinct
   * counting is always 1 for a single invocation id), so a flood of
   * single-task failures can never exhaust the small shared-scope budget
   * that genuinely correlated installation/host/provider/quota outages
   * depend on, and vice versa — two OPEN shared scopes can never be forced
   * out to make room for one-off invocation bookkeeping.
   */
  _scopeRecordBounded(scope, scopeKey) {
    let rec = this._scopes.get(scopeKey);
    if (rec) return rec;
    const isInvocation = scope === FailureScope.INVOCATION;
    const cap = isInvocation ? this.policy.maxChargedAttempts : this.policy.maxTrackedScopes;
    const count = this._scopeCount(isInvocation);
    if (count >= cap && !this._evictInertScopeIfPossible(isInvocation)) {
      return null;
    }
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
      attemptsObserved: 0,
      canariesObserved: 0,
      lastTouchedMs: this.nowMs(),
    };
    this._scopes.set(scopeKey, rec);
    return rec;
  }

  /** Last-touched bookkeeping for LRU eviction of inert (closed, memberless) scopes. */
  _touch(rec) {
    rec.lastTouchedMs = this.nowMs();
  }

  /** Count tracked scopes in one category (invocation-scoped vs every
   * shared scope) — the two independent quotas `_scopeRecordBounded`
   * enforces. Bounded by `_scopes.size`, itself bounded by the two maxima. */
  _scopeCount(isInvocation) {
    let count = 0;
    for (const rec of this._scopes.values()) {
      if ((rec.scope === FailureScope.INVOCATION) === isInvocation) count += 1;
    }
    return count;
  }

  /**
   * Explicit, bounded eviction (#2915 review: settled outstanding/scope maps
   * never dropped their own keys, so 1,000 successful attempts retained
   * 1,000+ map entries forever). Only CLOSED scopes with no outstanding
   * members AND no failure evidence still inside the rolling window are
   * eligible — an open scope, one with outstanding attempts, or one with
   * recent (in-window) failure evidence is never evicted (#2915 review 4,
   * finding 6: "never evict recent failure evidence or OPEN scopes" — a
   * two-failure CLOSED scope that has not yet reached the distinct
   * threshold must survive long enough for a third, still-in-window
   * failure to correlate against it). Only scopes matching `isInvocation`
   * are considered, so eviction never crosses between the two independent
   * quotas `_scopeRecordBounded` enforces. The scan is bounded by
   * `maxTrackedScopes`/`maxChargedAttempts`, never unbounded. Returns
   * whether an eviction actually freed a slot, so `_scopeRecordBounded` can
   * refuse to track a new scope at true capacity instead of growing past
   * the cap (#2915 final review, finding 6: the former best-effort bound
   * could be exceeded whenever nothing was evictable).
   */
  _evictInertScopeIfPossible(isInvocation) {
    const now = this.nowMs();
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [key, rec] of this._scopes) {
      if ((rec.scope === FailureScope.INVOCATION) !== isInvocation) continue;
      if (rec.status !== 'closed' || rec.activeCanary) continue;
      const outstanding = this._outstanding.get(key);
      if (outstanding && outstanding.size > 0) continue;
      if (rec.failures.some((f) => now - f.atMs < this.policy.windowMs)) continue;
      if (rec.lastTouchedMs < oldestAt) { oldestAt = rec.lastTouchedMs; oldestKey = key; }
    }
    if (oldestKey === null) return false;
    this._scopes.get(oldestKey)?.breaker.destroy();
    this._scopes.delete(oldestKey);
    this._outstanding.delete(oldestKey);
    return true;
  }

  /**
   * Non-mutating admission-time dry run (#2915 review 5, finding 5): would
   * `neededCount` BRAND-NEW shared-scope records fit without exceeding
   * `maxTrackedScopes`, counting both genuinely free slots and scopes that
   * `_evictInertScopeIfPossible` would actually be willing to evict (same
   * eligibility: CLOSED, no active canary, no outstanding members, no
   * in-window failure evidence)? Performs no eviction itself -- `admit()`
   * only needs to know capacity EXISTS before minting a reservation;
   * `_scopeRecordBounded` still performs the real eviction lazily, later,
   * exactly as before, when a scope record is actually created.
   */
  _canTrackNewSharedScopes(neededCount) {
    const cap = this.policy.maxTrackedScopes;
    const freeSlots = Math.max(0, cap - this._scopeCount(false));
    if (neededCount <= freeSlots) return true;
    let stillNeeded = neededCount - freeSlots;
    const now = this.nowMs();
    for (const rec of this._scopes.values()) {
      if (rec.scope === FailureScope.INVOCATION) continue;
      if (rec.status !== 'closed' || rec.activeCanary) continue;
      const outstanding = this._outstanding.get(rec.scopeKey);
      if (outstanding && outstanding.size > 0) continue;
      if (rec.failures.some((f) => now - f.atMs < this.policy.windowMs)) continue;
      stillNeeded -= 1;
      if (stillNeeded <= 0) return true;
    }
    return false;
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
}
