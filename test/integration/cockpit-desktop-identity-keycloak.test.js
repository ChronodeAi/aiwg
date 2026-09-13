import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopIdentity } from '../../apps/cockpit/bridge/src/desktop-identity.mjs';
import {
  DESKTOP_ACTIONS,
  SECTION9_ISSUER,
  createKeycloakDesktopVerifier,
  mapSection9Claims,
  verifyJws,
} from '../../apps/cockpit/bridge/src/desktop-identity-keycloak.mjs';

const ISSUER = SECTION9_ISSUER;
const AUDIENCE = 'cockpit-bridge';
const GATEWAY = 'agentic-sandbox-desktop';
const SECRET = 'bridge-client-secret-value';
const b64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

function keyPair(kid) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  return { privateKey, jwk, kid };
}
function jwt(pair, payload, header = {}) {
  const signingInput = `${b64({ alg: 'RS256', typ: 'JWT', kid: pair.kid, ...header })}.${b64(payload)}`;
  return `${signingInput}.${sign('sha256', Buffer.from(signingInput), pair.privateKey).toString('base64url')}`;
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

/** In-memory Keycloak: JWKS, introspection, refresh and token-exchange grants. */
function fakeKeycloak(pair, overrides = {}) {
  const state = {
    keys: [pair.jwk],
    active: new Map(), // access token -> claims
    refreshable: new Map(), // refresh token -> new access token
    calls: [],
    exchangeTtl: 300,
    ...overrides,
  };
  const fetch = vi.fn(async (url, init = {}) => {
    const path = new URL(url).pathname;
    state.calls.push({ path, method: init.method ?? 'GET', auth: init.headers?.authorization, body: init.body });
    if (state.failWith) return state.failWith(path);
    if (path.endsWith('/certs')) return json({ keys: state.keys });
    const basic = `Basic ${Buffer.from(`${AUDIENCE}:${SECRET}`).toString('base64')}`;
    if (init.headers?.authorization !== basic) return json({ error: 'invalid_client' }, 401);
    const params = new URLSearchParams(init.body);
    if (path.endsWith('/token/introspect')) {
      const claims = state.active.get(params.get('token'));
      return json(claims ?? { active: false });
    }
    if (path.endsWith('/token')) {
      if (params.get('grant_type') === 'refresh_token') {
        const next = state.refreshable.get(params.get('refresh_token'));
        return next ? json({ access_token: next, refresh_token: `${params.get('refresh_token')}-rotated`, expires_in: 300 }) : json({ error: 'invalid_grant' }, 400);
      }
      if (params.get('grant_type') === 'urn:ietf:params:oauth:grant-type:token-exchange') {
        if (params.get('audience') !== GATEWAY || !state.active.has(params.get('subject_token'))) return json({ error: 'invalid_grant' }, 400);
        state.exchanges = (state.exchanges ?? 0) + 1;
        return json({ access_token: `delegation-${state.exchanges}`, expires_in: state.exchangeTtl, token_type: 'Bearer' });
      }
    }
    return json({ error: 'not_found' }, 404);
  });
  return { state, fetch };
}

describe('Keycloak desktop identity verifier (#2545, section9 realm)', () => {
  let pair; let dir; let secretFile; let clock;
  const claims = (extra = {}) => ({
    active: true, iss: ISSUER, aud: [AUDIENCE, 'account'], sub: 'user-a', sid: 'sso-session-a',
    exp: Math.floor(clock / 1000) + 300, workspace_id: 'workspace-a', groups: ['/operators'],
    desktop_instances: ['11111111-1111-4111-8111-111111111111'], ...extra,
  });
  const login = (payload = {}) => jwt(pair, { iss: ISSUER, aud: AUDIENCE, sub: 'user-a', sid: 'sso-session-a',
    auth_time: Math.floor(clock / 1000) - 60, exp: Math.floor(clock / 1000) + 300, ...payload });

  beforeEach(() => {
    clock = Date.parse('2026-09-13T21:00:00Z');
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    pair = keyPair('kid-1');
    dir = mkdtempSync(join(tmpdir(), 'kc-verifier-'));
    secretFile = join(dir, 'client-secret');
    writeFileSync(secretFile, `${SECRET}\n`, { mode: 0o600 });
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

  function verifier(kc, options = {}) {
    return createKeycloakDesktopVerifier({ audience: AUDIENCE, clientId: AUDIENCE, clientSecretFile: secretFile,
      delegationAudience: GATEWAY, fetch: kc.fetch, now: () => clock, ...options });
  }

  it('rejects unusable configuration up front', () => {
    const kc = fakeKeycloak(pair);
    expect(() => verifier(kc, { issuer: 'http://auth.s9.internal/realms/section9' })).toThrow(/HTTPS realm/);
    expect(() => verifier(kc, { issuer: 'https://auth.s9.internal/' })).toThrow(/HTTPS realm/);
    expect(() => verifier(kc, { delegationAudience: '' })).toThrow(/delegationAudience/);
    expect(() => verifier(kc, { timeoutMs: 0 })).toThrow(/deadline/);
  });

  it('binds a section9 login: signature, issuer, exact audience, fresh introspection, mapped rights, exchanged delegation', async () => {
    const kc = fakeKeycloak(pair);
    const token = login();
    kc.state.active.set(token, claims());
    const identity = createDesktopIdentity({ verify: verifier(kc).verify, now: () => clock });
    const bound = await identity.bind({ browserSessionId: 'browser-1', audience: 'cockpit:browser-1', workspaceId: 'workspace-a', evidence: { accessToken: token } });
    expect(bound).toMatchObject({ issuer: ISSUER, subject: 'user-a', userSessionId: 'sso-session-a', workspaceId: 'workspace-a',
      browserSessionId: 'browser-1', audience: 'cockpit:browser-1', instanceIds: ['11111111-1111-4111-8111-111111111111'] });
    expect([...bound.actions].sort()).toEqual([...DESKTOP_ACTIONS].sort());
    expect(bound).not.toHaveProperty('delegation');
    expect(bound.expiresAt).toBe(clock - 60_000 + 10 * 60 * 60 * 1000);
    const paths = kc.state.calls.map((call) => call.path.split('/').slice(-2).join('/'));
    expect(paths).toEqual(['openid-connect/certs', 'token/introspect', 'openid-connect/token']);
    const exchange = new URLSearchParams(kc.state.calls[2].body);
    expect(exchange.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
    expect(exchange.get('audience')).toBe(GATEWAY);
    expect(exchange.get('subject_token')).toBe(token);
    await identity.withDelegation('browser-1', { action: 'create', instanceId: '11111111-1111-4111-8111-111111111111' }, async ({ delegation }) => {
      expect(delegation).toBe('delegation-1');
    });
    expect(JSON.stringify(kc.state.calls)).not.toContain('client-secret-value');
    identity.close();
  });

  it.each([
    ['wrong audience on the login token', () => ({ aud: 'grafana' }), {}],
    ['wrong issuer on the login token', () => ({ iss: 'https://auth.s9.internal/realms/apps' }), {}],
    ['login token signed by an unknown key', null, {}],
    ['inactive Keycloak session', () => ({}), { active: false }],
    ['introspected audience does not include the Bridge', () => ({}), { aud: ['account'] }],
    ['user outside the bound workspace', () => ({}), { workspace_id: 'workspace-b' }],
    ['no session id from Keycloak', () => ({}), { sid: undefined, session_state: undefined }],
  ])('denies bind: %s', async (_name, loginPatch, introspectPatch) => {
    const kc = fakeKeycloak(pair);
    const token = loginPatch === null ? jwt(keyPair('kid-1'), { iss: ISSUER, aud: AUDIENCE, sub: 'user-a' }) : login(loginPatch());
    kc.state.active.set(token, claims(introspectPatch));
    const identity = createDesktopIdentity({ verify: verifier(kc).verify, now: () => clock });
    await expect(identity.bind({ browserSessionId: 'browser-1', audience: 'cockpit:browser-1', workspaceId: 'workspace-a', evidence: { accessToken: token } }))
      .rejects.toMatchObject({ code: 'denied', status: 403 });
    identity.close();
  });

  it('re-introspects on every authorization, caches the delegation, and denies once Keycloak reports the session gone', async () => {
    const kc = fakeKeycloak(pair);
    const token = login();
    kc.state.active.set(token, claims());
    const v = verifier(kc);
    const identity = createDesktopIdentity({ verify: v.verify, now: () => clock });
    await identity.bind({ browserSessionId: 'browser-1', audience: 'cockpit:browser-1', workspaceId: 'workspace-a', evidence: { accessToken: token } });
    const introspections = () => kc.state.calls.filter((call) => call.path.endsWith('/introspect')).length;
    expect(introspections()).toBe(1);
    await identity.authorize('browser-1', { action: 'view', instanceId: '11111111-1111-4111-8111-111111111111' });
    await identity.status('browser-1');
    expect(introspections()).toBe(3);
    expect(kc.state.exchanges).toBe(1);
    clock += 400_000; // past the 300 s delegation lifetime
    kc.state.active.set(token, claims());
    await identity.authorize('browser-1', { action: 'view', instanceId: '11111111-1111-4111-8111-111111111111' });
    expect(kc.state.exchanges).toBe(2);
    const invalidated = [];
    identity.onInvalidate((event) => invalidated.push(event));
    kc.state.active.delete(token);
    await expect(identity.authorize('browser-1', { action: 'view', instanceId: '11111111-1111-4111-8111-111111111111' })).rejects.toMatchObject({ code: 'denied' });
    expect(invalidated).toEqual([{ browserSessionId: 'browser-1', reason: 'denied' }]);
    await expect(identity.status('browser-1')).rejects.toMatchObject({ code: 'denied' });
    identity.close();
  });

  it('refreshes a lapsed access token once through the refresh grant and re-introspects the new one', async () => {
    const kc = fakeKeycloak(pair);
    const token = login();
    kc.state.active.set(token, claims());
    kc.state.refreshable.set('refresh-1', 'access-2');
    kc.state.active.set('access-2', claims());
    const v = verifier(kc);
    const identity = createDesktopIdentity({ verify: v.verify, now: () => clock });
    await identity.bind({ browserSessionId: 'browser-1', audience: 'cockpit:browser-1', workspaceId: 'workspace-a', evidence: { accessToken: token, refreshToken: 'refresh-1' } });
    kc.state.active.delete(token); // access token lapsed at Keycloak
    await identity.authorize('browser-1', { action: 'view', instanceId: '11111111-1111-4111-8111-111111111111' });
    const grants = kc.state.calls.filter((call) => call.path.endsWith('/openid-connect/token')).map((call) => new URLSearchParams(call.body).get('grant_type'));
    expect(grants).toContain('refresh_token');
    const introspected = kc.state.calls.filter((call) => call.path.endsWith('/introspect')).map((call) => new URLSearchParams(call.body).get('token'));
    expect(introspected.at(-1)).toBe('access-2');
    // A new delegation is minted for the new access token, never the stale one.
    const exchanges = kc.state.calls.filter((call) => new URLSearchParams(call.body).get('grant_type')?.includes('token-exchange'));
    expect(new URLSearchParams(exchanges.at(-1).body).get('subject_token')).toBe('access-2');
    identity.close();
  });

  it('maps section9 groups and desktop: roles; viewers get view/observe only; instances can come from a membership hook', async () => {
    expect(mapSection9Claims({ groups: ['/viewers'], workspace_id: 'w' })).toEqual({ workspaceId: 'w', actions: ['view', 'observe'], instanceIds: [] });
    expect(mapSection9Claims({ groups: ['/viewers'], realm_access: { roles: ['desktop:create', 'uma_authorization'] }, resource_access: { 'cockpit-bridge': { roles: ['desktop:close'] } }, tenant_id: 't' }, { clientId: 'cockpit-bridge' }))
      .toEqual({ workspaceId: 't', actions: ['view', 'observe', 'create', 'close'], instanceIds: [] });
    expect(mapSection9Claims({ groups: ['/admins'], workspace_id: 'w', desktop_instances: ['i-1', 7, ''] }).instanceIds).toEqual(['i-1']);
    const kc = fakeKeycloak(pair);
    const token = login();
    kc.state.active.set(token, claims({ groups: ['/viewers'], desktop_instances: undefined }));
    const hook = vi.fn(async ({ subject, workspaceId }) => [`${workspaceId}:${subject}:instance`]);
    const identity = createDesktopIdentity({ verify: verifier(kc, { resolveInstances: hook }).verify, now: () => clock });
    const bound = await identity.bind({ browserSessionId: 'browser-1', audience: 'cockpit:browser-1', workspaceId: 'workspace-a', evidence: { accessToken: token } });
    expect(bound.actions).toEqual(['view', 'observe']);
    expect(bound.instanceIds).toEqual(['workspace-a:user-a:instance']);
    await expect(identity.authorize('browser-1', { action: 'create', instanceId: 'workspace-a:user-a:instance' })).rejects.toMatchObject({ code: 'denied' });
    identity.close();
  });

  it('reports the provider unavailable, never denied, when the secret is unreadable or Keycloak fails', async () => {
    const kc = fakeKeycloak(pair);
    const token = login();
    kc.state.active.set(token, claims());
    chmodSync(secretFile, 0o644);
    let identity = createDesktopIdentity({ verify: verifier(kc).verify, now: () => clock });
    await expect(identity.bind({ browserSessionId: 'b', audience: 'a', workspaceId: 'workspace-a', evidence: { accessToken: token } })).rejects.toMatchObject({ code: 'identity_unavailable', status: 503 });
    expect(kc.state.calls.some((call) => call.path.endsWith('/introspect'))).toBe(false);
    identity.close();
    chmodSync(secretFile, 0o600);
    kc.state.failWith = (path) => (path.endsWith('/introspect') ? json({ error: 'server_error' }, 500) : json({ keys: [pair.jwk] }));
    identity = createDesktopIdentity({ verify: verifier(kc).verify, now: () => clock });
    await expect(identity.bind({ browserSessionId: 'b', audience: 'a', workspaceId: 'workspace-a', evidence: { accessToken: token } })).rejects.toMatchObject({ code: 'identity_unavailable' });
    identity.close();
    const hanging = { fetch: vi.fn(() => new Promise(() => {})) };
    const v = verifier(hanging, { timeoutMs: 20 });
    await expect(v.verify({ operation: 'bind', expected: { browserSessionId: 'b', audience: 'a', workspaceId: 'workspace-a' }, evidence: { accessToken: token } })).rejects.toMatchObject({ code: 'identity_unavailable' });
  });

  it('turns a back-channel logout token into an issuer-scoped revoke selector that invalidates the binding', async () => {
    const kc = fakeKeycloak(pair);
    const token = login();
    kc.state.active.set(token, claims());
    const v = verifier(kc);
    const identity = createDesktopIdentity({ verify: v.verify, now: () => clock });
    await identity.bind({ browserSessionId: 'browser-1', audience: 'cockpit:browser-1', workspaceId: 'workspace-a', evidence: { accessToken: token } });
    const invalidated = [];
    identity.onInvalidate((event) => invalidated.push(event));
    const logoutToken = jwt(pair, { iss: ISSUER, aud: AUDIENCE, sub: 'user-a', sid: 'sso-session-a', events: { 'http://schemas.openid.net/event/backchannel-logout': {} }, jti: 'logout-1' });
    const selector = await v.logoutSelector(logoutToken);
    expect(selector).toEqual({ issuer: ISSUER, subject: 'user-a', userSessionId: 'sso-session-a' });
    identity.revoke(selector);
    expect(invalidated).toEqual([{ browserSessionId: 'browser-1', reason: 'identity_revoked' }]);
    await expect(v.logoutSelector(jwt(pair, { iss: ISSUER, aud: AUDIENCE, sub: 'user-a' }))).rejects.toMatchObject({ code: 'denied' });
    await expect(v.logoutSelector(jwt(pair, { iss: 'https://other.example/realms/x', aud: AUDIENCE, sub: 'user-a', events: { 'http://schemas.openid.net/event/backchannel-logout': {} } }))).rejects.toMatchObject({ code: 'denied' });
    identity.close();
  });

  it('verifies compact JWS strictly: unknown kid, wrong algorithm, tampered payload', () => {
    const keys = [pair.jwk];
    const good = jwt(pair, { sub: 'x' });
    expect(verifyJws(good, keys)).toEqual({ sub: 'x' });
    expect(() => verifyJws(jwt(keyPair('kid-2'), { sub: 'x' }), keys)).toThrow();
    expect(() => verifyJws(jwt(pair, { sub: 'x' }, { alg: 'none' }), keys)).toThrow();
    const [h, p, s] = good.split('.');
    expect(() => verifyJws(`${h}.${b64({ sub: 'y' })}.${s}`, keys)).toThrow();
    expect(() => verifyJws(`${h}.${p}`, keys)).toThrow();
  });
});
