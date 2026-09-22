import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopIdentity } from '../../apps/cockpit/bridge/src/desktop-identity.mjs';

const stores = [];
const input = { browserSessionId: 'browser-a', workspaceId: 'workspace-a', audience: 'gateway/browser-a', evidence: 'backend-login-proof' };
const request = { action: 'desktop.attach', instanceId: 'vm-a' };
const assertion = (expected, overrides = {}) => ({ active: true, issuer: 'https://issuer.example', subject: 'alice', userSessionId: 'login-a', ...expected,
  checkedAt: Date.now(), expiresAt: Date.now() + 60000, delegationExpiresAt: Date.now() + 30000,
  actions: ['desktop.attach'], instanceIds: ['vm-a'], delegation: 'secret-delegation', ...overrides });
function setup(verify = vi.fn(async ({ expected }) => assertion(expected)), options = {}) {
  if (!vi.isMockFunction(verify)) verify = vi.fn(verify);
  const store = createDesktopIdentity({ verify, ...options }); stores.push(store); return { store, verify };
}
afterEach(() => { stores.splice(0).forEach((store) => store.close()); vi.useRealTimers(); });

describe('authoritative desktop identity bindings', () => {
  it('requires a verifier and bounded verification deadline', () => {
    expect(() => createDesktopIdentity()).toThrow(/verifier/);
    expect(() => createDesktopIdentity({ verify() {}, timeoutMs: Infinity })).toThrow(/deadline/);
  });
  it('freshly checks every authorization/status and keeps delegation backend-only', async () => {
    const { store, verify } = setup();
    const bound = await store.bind(input);
    const authorized = await store.authorize(input.browserSessionId, request);
    const status = await store.status(input.browserSessionId);
    expect(JSON.stringify([bound, authorized, status])).not.toContain('secret-delegation');
    expect(status).not.toHaveProperty('instanceIds');
    expect(status).not.toHaveProperty('actions');
    expect(verify.mock.calls.map(([call]) => call.operation)).toEqual(['bind', 'authorize', 'status']);
    expect(verify.mock.calls[1][0].evidence).toBeUndefined();
    const backend = vi.fn(() => 'worker-connected');
    expect(await store.withDelegation(input.browserSessionId, request, backend)).toBe('worker-connected');
    expect(backend.mock.calls[0][0].delegation).toBe('secret-delegation');
    expect(verify).toHaveBeenCalledTimes(4);
  });
  it('isolates Bridges, users, workspaces and requested instance/action', async () => {
    const a = setup(); const b = setup();
    await a.store.bind(input);
    await expect(b.store.authorize(input.browserSessionId, request)).rejects.toMatchObject({ code: 'denied' });
    await b.store.bind({ ...input, browserSessionId: 'browser-b' });
    expect(a.verify.mock.calls[0][0].bridgeId).not.toBe(b.verify.mock.calls[0][0].bridgeId);
    await expect(a.store.authorize(input.browserSessionId, { ...request, instanceId: 'vm-other' })).rejects.toMatchObject({ code: 'denied' });
    await expect(b.store.authorize('browser-b', { ...request, action: 'desktop.revoke' })).rejects.toMatchObject({ code: 'denied' });
  });
  it.each(['issuer', 'subject', 'userSessionId', 'workspaceId', 'browserSessionId', 'audience'])('rejects changed immutable %s and cancels attachments', async (key) => {
    const { store, verify } = setup(); const cancelled = vi.fn(); store.onInvalidate(cancelled);
    await store.bind(input);
    verify.mockImplementation(async ({ expected }) => assertion(expected, { [key]: 'forged' }));
    await expect(store.authorize(input.browserSessionId, request)).rejects.toMatchObject({ code: 'denied' });
    expect(cancelled).toHaveBeenCalledWith({ browserSessionId: input.browserSessionId, reason: 'denied' });
    await expect(store.status(input.browserSessionId)).rejects.toMatchObject({ code: 'denied' });
  });
  it.each([
    { active: false }, { checkedAt: 1 }, { checkedAt: Number.MAX_SAFE_INTEGER },
    { expiresAt: 1 }, { delegationExpiresAt: 1 }, { delegationExpiresAt: Number.MAX_SAFE_INTEGER },
    { actions: [] }, { instanceIds: [] }, { delegation: '' },
  ])('fails closed on invalid/removed policy %j', async (override) => {
    const { store, verify } = setup(); await store.bind(input);
    verify.mockImplementation(async ({ expected }) => assertion(expected, override));
    await expect(store.authorize(input.browserSessionId, request)).rejects.toMatchObject({ code: 'denied' });
  });
  it('sanitizes provider errors and refuses stale claims on outage', async () => {
    const { store, verify } = setup(); await store.bind(input);
    verify.mockRejectedValue(new Error('Bearer secret-delegation provider-debug'));
    await expect(store.authorize(input.browserSessionId, request)).rejects.toMatchObject({ code: 'identity_unavailable', message: 'Desktop identity verification unavailable' });
    await expect(store.status(input.browserSessionId)).rejects.toMatchObject({ code: 'denied' });
  });
  it('aborts timed out verification and never admits late results', async () => {
    vi.useFakeTimers(); let resolve; let signal;
    const { store } = setup(({ expected, signal: candidate }) => { signal = candidate; return new Promise((done) => { resolve = () => done(assertion(expected)); }); }, { timeoutMs: 50 });
    const binding = store.bind(input); const rejection = expect(binding).rejects.toMatchObject({ code: 'identity_unavailable' });
    await vi.advanceTimersByTimeAsync(51); await rejection;
    expect(signal.aborted).toBe(true); resolve();
    await expect(store.status(input.browserSessionId)).rejects.toMatchObject({ code: 'denied' });
  });
  it('logout cannot race a pending bind or authorization into resurrection', async () => {
    let resolve;
    const { store, verify } = setup(({ expected }) => new Promise((done) => { resolve = () => done(assertion(expected)); }));
    const binding = store.bind(input); const rejected = expect(binding).rejects.toMatchObject({ code: 'denied' });
    await Promise.resolve(); store.logout(input.browserSessionId); resolve(); await rejected;
    verify.mockImplementation(async ({ expected }) => assertion(expected)); await store.bind(input);
    verify.mockImplementation(({ expected }) => new Promise((done) => { resolve = () => done(assertion(expected)); }));
    const authorization = store.authorize(input.browserSessionId, request);
    await Promise.resolve(); store.logout(input.browserSessionId); resolve();
    await expect(authorization).rejects.toMatchObject({ code: 'denied' });
  });
  it('a late old authorization cannot invalidate a newly bound login', async () => {
    const { store, verify } = setup(); await store.bind(input);
    let reject;
    verify.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const old = store.authorize(input.browserSessionId, request);
    const rejected = expect(old).rejects.toMatchObject({ code: 'identity_unavailable' });
    await Promise.resolve(); store.logout(input.browserSessionId);
    await store.bind(input);
    reject(new Error('provider connection failed')); await rejected;
    expect((await store.status(input.browserSessionId)).subject).toBe('alice');
  });
  it('revocation cancels in-flight identity admission', async () => {
    let resolve;
    const { store } = setup(({ expected }) => new Promise((done) => { resolve = () => done(assertion(expected)); }));
    const binding = store.bind(input); const rejected = expect(binding).rejects.toMatchObject({ code: 'denied' });
    await Promise.resolve(); store.revoke({ issuer: 'https://issuer.example', subject: 'alice' });
    resolve(); await rejected;
    await expect(store.status(input.browserSessionId)).rejects.toMatchObject({ code: 'denied' });
  });
  it('revokes exact issuer/session and handles failing listeners independently', async () => {
    const { store } = setup(); await store.bind(input);
    const called = vi.fn(); store.onInvalidate(() => { throw new Error('cleanup'); }); store.onInvalidate(called);
    store.revoke({ issuer: 'other', subject: 'alice' });
    await store.status(input.browserSessionId);
    store.revoke({ issuer: 'https://issuer.example', userSessionId: 'login-a' });
    expect(called).toHaveBeenCalledWith({ browserSessionId: input.browserSessionId, reason: 'identity_revoked' });
    expect(() => store.revoke({ subject: 'alice' })).toThrow();
  });
  it.each(['authorize', 'status'])('rejects %s completing after original expiry even before the timer runs', async (operation) => {
    let clock = 1000;
    let complete;
    const { store } = setup(({ expected, operation: check }) => {
      const result = () => assertion(expected, { checkedAt: clock, expiresAt: clock + 1000, delegationExpiresAt: clock + 500 });
      if (check === 'bind') return result();
      return new Promise((resolve) => { complete = () => resolve(result()); });
    }, { now: () => clock });
    const invalidated = vi.fn(); store.onInvalidate(invalidated);
    await store.bind(input);
    const pending = operation === 'status' ? store.status(input.browserSessionId) : store.authorize(input.browserSessionId, request);
    await Promise.resolve();
    // Move only the injected clock: the scheduled expiry timer has not fired.
    clock = 2000;
    complete();
    await expect(pending).rejects.toMatchObject({ code: 'denied' });
    expect(invalidated).toHaveBeenCalledExactlyOnceWith({ browserSessionId: input.browserSessionId, reason: 'identity_expired' });
    await expect(store.status(input.browserSessionId)).rejects.toMatchObject({ code: 'denied' });
  });
  it('expires sessions and notifies cleanup without another browser request', async () => {
    vi.useFakeTimers(); const { store } = setup(); const called = vi.fn(); store.onInvalidate(called);
    await store.bind(input); await vi.advanceTimersByTimeAsync(60001);
    expect(called).toHaveBeenCalledWith({ browserSessionId: input.browserSessionId, reason: 'identity_expired' });
    await expect(store.status(input.browserSessionId)).rejects.toMatchObject({ code: 'denied' });
  });
});
