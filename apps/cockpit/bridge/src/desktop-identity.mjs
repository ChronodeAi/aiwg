import { randomUUID } from 'node:crypto';

const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const failure = (code = 'denied') => Object.assign(new Error(code === 'identity_unavailable' ? 'Desktop identity verification unavailable' : 'Desktop access denied'), { code, status: code === 'identity_unavailable' ? 503 : 403 });
const immutable = ['issuer', 'subject', 'userSessionId', 'workspaceId', 'browserSessionId', 'audience'];

/**
 * Backend-only identity bindings. This is NOT an OIDC/provider implementation.
 * A production authoritative provider adapter is required as `verify`.
 *
 * verify({ operation: 'bind'|'authorize'|'status', bridgeId, expected, evidence, request,
 *          signal }) -> Promise<{
 *   active: true, issuer, subject, userSessionId, workspaceId, browserSessionId,
 *   audience, checkedAt, expiresAt, actions: string[], instanceIds: string[],
 *   delegation: string, delegationExpiresAt
 * }>
 *
 * All timestamps are epoch milliseconds. The adapter MUST authenticate evidence,
 * verify issuer/signature/exact audience, and query authoritative user-session and
 * current membership/instance policy on EVERY call (including renewals). checkedAt
 * must describe that fresh check, not a token issuance time. AbortSignal cancels
 * provider I/O. Caller-supplied actor/tenant claims are never authoritative.
 * `evidence` is backend-only login proof, retained only by the adapter if required;
 * subsequent checks use the immutable expected binding. No operator-token default
 * exists. Delegation must be gateway-verifiable and scoped to returned binding and
 * rights; it is never returned from public authorization results.
 *
 * Provider revocation events should call revoke({issuer, subject, userSessionId});
 * Bridge logout must call logout(browserSessionId). The Bridge must register an
 * onInvalidate listener to close streams, and renew streams via authorize within
 * its propagation budget. This module does not itself poll an identity provider.
 */
export function createDesktopIdentity({ verify, timeoutMs = 5000, now = Date.now } = {}) {
  if (typeof verify !== 'function') throw new TypeError('An authoritative desktop identity verifier is required');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) throw new TypeError('Invalid verification deadline');
  const bridgeId = randomUUID();
  const sessions = new Map();
  const pending = new Map();
  const listeners = new Set();
  let closed = false;

  function invalidate(id, reason = 'denied') {
    const entry = sessions.get(id);
    sessions.delete(id);
    const attempt = pending.get(id);
    pending.delete(id);
    attempt?.abort();
    if (!entry) return;
    clearTimeout(entry.timer);
    for (const listener of listeners) {
      try { Promise.resolve(listener(Object.freeze({ browserSessionId: id, reason }))).catch(() => {}); } catch { /* One listener must not prevent other cleanup. */ }
    }
  }
  async function check(operation, expected, request, evidence, parentSignal) {
    const controller = new AbortController();
    const start = now();
    let timer;
    let abort;
    try {
      const stopped = new Promise((_, reject) => {
        abort = () => { controller.abort(); reject(failure()); };
        parentSignal?.addEventListener('abort', abort, { once: true });
        if (parentSignal?.aborted) abort();
        timer = setTimeout(() => { controller.abort(); reject(failure('identity_unavailable')); }, timeoutMs);
      });
      const result = await Promise.race([
        Promise.resolve().then(() => verify({ operation, bridgeId, expected: Object.freeze({ ...expected }), request: request ? Object.freeze({ ...request }) : undefined, evidence, signal: controller.signal })),
        stopped,
      ]);
      const end = now();
      if (!result || result.active !== true || !immutable.every((key) => text(result[key])) ||
          !Number.isFinite(result.checkedAt) || result.checkedAt < start || result.checkedAt > end ||
          !Number.isFinite(result.expiresAt) || result.expiresAt <= end ||
          !Number.isFinite(result.delegationExpiresAt) || result.delegationExpiresAt <= end || result.delegationExpiresAt > result.expiresAt ||
          !text(result.delegation) || !Array.isArray(result.actions) || !result.actions.every(text) ||
          !Array.isArray(result.instanceIds) || !result.instanceIds.every(text) ||
          Object.entries(expected).some(([key, value]) => result[key] !== value)) throw failure();
      if (request && (!result.actions.includes(request.action) || !result.instanceIds.includes(request.instanceId))) throw failure();
      return { binding: Object.freeze(Object.fromEntries(immutable.map((key) => [key, result[key]]))), expiresAt: result.expiresAt,
        actions: Object.freeze([...result.actions]), instanceIds: Object.freeze([...result.instanceIds]), delegation: result.delegation, delegationExpiresAt: result.delegationExpiresAt };
    } catch (error) {
      throw failure(error?.code === 'denied' ? 'denied' : 'identity_unavailable');
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abort);
    }
  }
  const safe = (entry) => Object.freeze({ ...entry.binding, expiresAt: entry.expiresAt, actions: entry.actions, instanceIds: entry.instanceIds });
  function schedule(id, entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (now() >= entry.expiresAt) invalidate(id, 'identity_expired');
      else schedule(id, entry);
    }, Math.min(2147483647, Math.max(1, entry.expiresAt - now())));
    entry.timer.unref?.();
  }
  async function authorization(id, request, statusOnly = false) {
    const entry = sessions.get(id);
    if (closed || !entry || entry.expiresAt <= now() || (!statusOnly && (!text(request?.action) || !text(request?.instanceId)))) {
      if (entry?.expiresAt <= now()) invalidate(id, 'identity_expired');
      throw failure();
    }
    try {
      const fresh = await check(statusOnly ? 'status' : 'authorize', entry.binding, request);
      if (sessions.get(id) !== entry || closed) throw failure();
      if (entry.expiresAt <= now()) {
        invalidate(id, 'identity_expired');
        throw failure();
      }
      // Authorization never extends the authenticated browser login's lifetime.
      entry.expiresAt = Math.min(entry.expiresAt, fresh.expiresAt);
      schedule(id, entry);
      return { ...fresh, expiresAt: entry.expiresAt, entry };
    } catch (error) {
      if (sessions.get(id) === entry) invalidate(id, error.code);
      throw error;
    }
  }
  return Object.freeze({
    async bind({ browserSessionId, audience, workspaceId, evidence } = {}) {
      if (closed || ![browserSessionId, audience, workspaceId].every(text) || sessions.has(browserSessionId) || pending.has(browserSessionId)) throw failure();
      const controller = new AbortController();
      pending.set(browserSessionId, controller);
      try {
        const result = await check('bind', { browserSessionId, audience, workspaceId }, undefined, evidence, controller.signal);
        if (closed || pending.get(browserSessionId) !== controller) throw failure();
        const entry = { binding: result.binding, expiresAt: result.expiresAt };
        sessions.set(browserSessionId, entry);
        schedule(browserSessionId, entry);
        return safe(result);
      } finally { if (pending.get(browserSessionId) === controller) pending.delete(browserSessionId); }
    },
    async authorize(id, request) { return safe(await authorization(id, request)); },
    async status(id) {
      const fresh = await authorization(id, undefined, true);
      return Object.freeze({ ...fresh.binding, expiresAt: fresh.expiresAt });
    },
    async withDelegation(id, request, backendCallback) {
      if (typeof backendCallback !== 'function') throw new TypeError('A backend delegation consumer is required');
      const fresh = await authorization(id, request);
      if (closed || sessions.get(id) !== fresh.entry || fresh.expiresAt <= now() || fresh.delegationExpiresAt <= now()) throw failure();
      return backendCallback(Object.freeze({ identity: safe(fresh), delegation: fresh.delegation, delegationExpiresAt: fresh.delegationExpiresAt }));
    },
    onInvalidate(listener) {
      if (typeof listener !== 'function') throw new TypeError('Invalid invalidation listener');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    logout(id) { invalidate(id, 'logged_out'); },
    revoke(selector) {
      if (!selector || !text(selector.issuer) || (!text(selector.subject) && !text(selector.userSessionId)) || Object.keys(selector).some((key) => !['issuer', 'subject', 'userSessionId'].includes(key))) throw new TypeError('An issuer-scoped revocation selector is required');
      // A revocation racing initial provider verification must not admit an old result.
      for (const id of [...pending.keys()]) invalidate(id, 'identity_revoked');
      for (const [id, entry] of sessions) if (Object.entries(selector).every(([key, value]) => entry.binding[key] === value)) invalidate(id, 'identity_revoked');
    },
    close() {
      closed = true;
      for (const id of new Set([...sessions.keys(), ...pending.keys()])) invalidate(id, 'bridge_closed');
      listeners.clear();
    },
  });
}
