import { afterEach, describe, expect, it } from 'vitest';
import { createBridge } from '../../apps/cockpit/bridge/src/server.mjs';
import { createDesktopIdentity } from '../../apps/cockpit/bridge/src/desktop-identity.mjs';
import http from 'node:http';

const servers = [], identities = [];
const instance = '11111111-1111-4111-8111-111111111111';
const desktop = '22222222-2222-4222-8222-222222222222';
const viewport = { width: 800, height: 600, dpi: 96 };
const policy = { observe: false, control: true, sharing: false, clipboard_copy: false, clipboard_paste: false,
  file_transfer: false, audio: false, recording: false, isolation_tier: 'cooperative', generation: 1 };
const session = { schema_version: 'rdp-cockpit.v1', id: desktop, instance_id: instance, incarnation: 'boot-1',
  workspace_id: 'workspace-a', state: 'preparing', cleanup: 'none', policy,
  absolute_expires_at: '2026-09-13T23:00:00Z', retained_until: null };
afterEach(async () => {
  identities.splice(0).forEach((identity) => identity.close());
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); })));
});
async function fixture(backend, { subject = 'user-a', authorizedInstance = instance, identityEnabled = true } = {}) {
  const identity = identityEnabled ? createDesktopIdentity({ verify: async ({ expected }) => ({ active: true, issuer: 'https://issuer.example',
    subject, userSessionId: subject, ...expected, checkedAt: Date.now(), expiresAt: Date.now() + 60000,
    actions: ['view', 'create', 'sign_out', 'revoke_access'], instanceIds: [authorizedInstance], delegation: `delegation-${subject}`, delegationExpiresAt: Date.now() + 30000 }) }) : undefined;
  if (identity) identities.push(identity);
  const server = createBridge({ desktopIdentity: identity, desktopBackend: backend });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const exchange = await fetch(`${base}/bootstrap/session`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ nonce: server.issueBootstrapNonce('browser'), audience: 'browser' }) });
  const cookie = exchange.headers.get('set-cookie').split(';')[0];
  const { csrf } = await exchange.json();
  if (identity) await server.bindDesktopIdentity({ headers: { cookie } }, { workspaceId: 'workspace-a', evidence: {} });
  const headers = { cookie, origin: base, 'x-cockpit-csrf': csrf, 'content-type': 'application/json' };
  const call = (suffix, init = {}) => fetch(`${base}/api/desktops/instances/${instance}/${suffix}`, { ...init, headers: { ...headers, ...init.headers } });
  return { server, base, cookie, headers, identity, call };
}

describe('desktop browser control HTTP', () => {
  it('keeps unsupported explicit and rejects native bearer and foreign origins', async () => {
    const b = await fixture(undefined, { identityEnabled: false });
    expect(await (await b.call('capability')).json()).toEqual({ state: 'unsupported', reason: 'desktop_backend_not_configured' });
    expect((await b.call('capability', { headers: { cookie: '', authorization: `Bearer ${b.server.cockpitToken}` } })).status).toBe(401);
    expect((await b.call('capability', { headers: { origin: 'null' } })).status).toBe(403);
  });
  it('forwards the user delegation backend-side and preserves create idempotency', async () => {
    let received;
    const b = await fixture({ request: async (request) => {
      received = request;
      return { ...session, grant: 'must-not-escape' };
    } });
    const response = await b.call('sessions', { method: 'POST', headers: { 'idempotency-key': 'request-123456789' }, body: JSON.stringify({ viewport, requested_mode: 'control' }) });
    expect(response.status).toBe(202);
    expect(received).toMatchObject({ operation: 'create', id: instance, delegation: 'delegation-user-a', idempotencyKey: 'request-123456789' });
    const value = await response.json();
    expect(value).toEqual(session);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('denies cross-instance identity before making a backend request', async () => {
    let calls = 0;
    const b = await fixture({ request: async () => { calls++; } }, { authorizedInstance: desktop });
    expect((await b.call('capability')).status).toBe(403);
    expect(calls).toBe(0);
  });
  it('rejects a cross-workspace or wrong-instance backend response', async () => {
    const b = await fixture({ request: async () => ({ id: desktop, instance_id: instance, workspace_id: 'other-workspace' }) });
    const response = await b.call(`sessions/${desktop}`);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'desktop_invalid_response' });
  });
  it('checks CSRF, routes and bounded JSON bodies before backend mutation', async () => {
    let calls = 0;
    const b = await fixture({ request: async () => { calls++; } });
    expect((await b.call('sessions', { method: 'POST', headers: { 'x-cockpit-csrf': '' }, body: '{}' })).status).toBe(403);
    expect((await b.call('capability?target=https://evil.invalid')).status).toBe(404);
    expect((await b.call('sessions/../arbitrary')).status).toBe(404);
    expect((await b.call('sessions', { method: 'POST', body: 'x'.repeat(4097) })).status).toBe(400);
    expect((await b.call('sessions', { method: 'POST', body: '{' })).status).toBe(400);
    for (const body of ['null', 'false', '0']) expect((await b.call('sessions', { method: 'POST', body })).status).toBe(400);
    expect(calls).toBe(0);
  });
  it('closes oversized unfinished uploads instead of retaining the socket outside request quotas', async () => {
    let calls = 0;
    const b = await fixture({ request: async () => { calls++; } });
    await new Promise((resolve, reject) => {
      let gotResponse = false;
      const req = http.request(`${b.base}/api/desktops/instances/${instance}/sessions`, { method: 'POST', headers: b.headers });
      const timer = setTimeout(() => { req.destroy(); reject(new Error('Rejected upload socket remained open')); }, 2000);
      req.on('response', (res) => {
        gotResponse = true;
        expect(res.statusCode).toBe(400);
        expect(res.headers.connection).toBe('close');
        res.resume();
      });
      req.on('error', (error) => { if (!gotResponse) { clearTimeout(timer); reject(error); } });
      req.on('close', () => { clearTimeout(timer); if (gotResponse) resolve(); else reject(new Error('No error response')); });
      req.write('x'.repeat(4097)); // Deliberately never end the upload.
    });
    expect(calls).toBe(0);
  });
  it('rejects a backend response naming another desktop in the same workspace', async () => {
    const b = await fixture({ request: async () => ({ ...session, id: instance }) });
    expect((await b.call(`sessions/${desktop}`)).status).toBe(502);
  });
  it('aborts in-flight backend work on browser logout and redacts backend errors', async () => {
    let started, aborted = false;
    const entered = new Promise((resolve) => { started = resolve; });
    const b = await fixture({ request: ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('secret upstream diagnostic')); }, { once: true });
      started();
    }) });
    const pending = b.call('capability');
    await entered;
    const logout = await fetch(`${b.base}/bootstrap/session`, { method: 'DELETE', headers: b.headers });
    expect(logout.status).toBe(204);
    const response = await pending;
    expect(aborted).toBe(true);
    expect(await response.json()).toEqual({ error: 'desktop_backend_unavailable' });
    expect((await b.call('capability')).status).toBe(401);
  });
  it('does not authorize one Bridge with another Bridge cookie', async () => {
    let calls = 0;
    const backend = { request: async () => { calls++; return { state: 'unsupported' }; } };
    const a = await fixture(backend), b = await fixture(backend, { subject: 'user-b' });
    expect((await b.call('capability', { headers: { cookie: a.cookie } })).status).toBe(401);
    expect(calls).toBe(0);
  });
});
