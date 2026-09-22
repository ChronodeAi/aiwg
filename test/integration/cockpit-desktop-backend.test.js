import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopBackend } from '../../apps/cockpit/bridge/src/desktop-backend.mjs';
import { createBridge } from '../../apps/cockpit/bridge/src/server.mjs';
import { createDesktopIdentity } from '../../apps/cockpit/bridge/src/desktop-identity.mjs';

let directory, ca, cert, key, foreignCa;
const servers = [], clients = [];
const id = '11111111-1111-4111-8111-111111111111';
const policy = { observe: false, control: true, sharing: false, clipboard_copy: false, clipboard_paste: false,
  file_transfer: false, audio: false, recording: false, isolation_tier: 'cooperative', generation: 1 };
const capability = { schema_version: 'rdp-cockpit.v1', supported: true, readiness: 'ready', reason_codes: [],
  instance_id: id, incarnation: 'boot-1', policy };
const request = { operation: 'capability', id, delegation: 'user-delegation' };
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'cockpit-desktop-tls-'));
  const openssl = (...args) => execFileSync('openssl', args, { timeout: 60_000, cwd: directory, stdio: 'pipe' });
  const root = (name) => openssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-keyout', `${name}.key`, '-out', `${name}.crt`, '-days', '1', '-subj', `/CN=${name}`);
  root('ca'); root('foreign');
  openssl('req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=localhost');
  writeFileSync(join(directory, 'extensions'), 'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth,clientAuth\n');
  openssl('x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial',
    '-out', 'leaf.crt', '-days', '1', '-extfile', 'extensions');
  [ca, cert, key, foreignCa] = ['ca.crt', 'leaf.crt', 'leaf.key', 'foreign.crt'].map((f) => readFileSync(join(directory, f)));
});
afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); })));
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));
async function fixture(handler, options = {}) {
  const server = https.createServer({ key, cert, ca, requestCert: true, rejectUnauthorized: true, ...options.server }, handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, resolve));
  const client = createDesktopBackend({ url: `https://${options.hostname ?? 'localhost'}:${server.address().port}`,
    tls: { ca, cert, key, ...options.tls }, ...options.client });
  clients.push(client);
  return client;
}
const reply = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };

describe('desktop HTTPS backend', () => {
  it('uses verified mutual TLS and user delegation on a fixed route, stripping unknown response fields', async () => {
    let received;
    const client = await fixture((req, res) => {
      received = { authorized: req.socket.authorized, path: req.url, authorization: req.headers.authorization };
      reply(res, { ...capability, password: 'must-not-escape', policy: { ...policy, secret: 'hidden' } });
    });
    expect(await client.request(request)).toEqual(capability);
    expect(received).toEqual({ authorized: true, path: `/api/v2/instances/${id}/desktop-capability`, authorization: 'Bearer user-delegation' });
  });
  it('connects a bound browser through the Bridge to the real local mutual TLS backend', async () => {
    let calls = 0;
    const backend = await fixture((req, res) => {
      expect(req.headers.authorization).toBe('Bearer browser-user-delegation');
      expect(req.socket.authorized).toBe(true);
      calls++;
      reply(res, { ...capability, grant: 'not-for-browser' });
    });
    const identity = createDesktopIdentity({ verify: async ({ expected }) => ({ active: true, issuer: 'https://issuer.example',
      subject: 'user-a', userSessionId: 'login-a', ...expected, checkedAt: Date.now(), expiresAt: Date.now() + 60000,
      actions: ['view'], instanceIds: [id], delegation: 'browser-user-delegation', delegationExpiresAt: Date.now() + 30000 }) });
    clients.push(identity);
    const bridge = createBridge({ desktopIdentity: identity, desktopBackend: backend });
    servers.push(bridge);
    await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${bridge.address().port}`;
    const login = await fetch(`${origin}/bootstrap/session`, { method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: bridge.issueBootstrapNonce('browser'), audience: 'browser' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    await login.json();
    await bridge.bindDesktopIdentity({ headers: { cookie } }, { workspaceId: 'workspace-a', evidence: {} });
    const response = await fetch(`${origin}/api/desktops/instances/${id}/capability`, { headers: { origin, cookie } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(capability);
    expect(calls).toBe(1);
  });
  it('rejects a valid response for a different instance', async () => {
    const client = await fixture((_req, res) => reply(res, { ...capability, instance_id: '22222222-2222-4222-8222-222222222222' }));
    await expect(client.request(request)).rejects.toMatchObject({ code: 'desktop_invalid_response' });
  });
  it('maps known errors without forwarding upstream text or trace data', async () => {
    const client = await fixture((_req, res) => reply(res, { code: 'control_conflict', status: 500, title: 'private-account-name', trace_id: 'secret-path' }, 409));
    await expect(client.request(request)).rejects.toMatchObject({ code: 'control_conflict', status: 409, message: 'control_conflict' });
  });
  it('sends validated lifecycle bodies and keeps attachment admission in backend results', async () => {
    const desktop = '22222222-2222-4222-8222-222222222222';
    const attachment = '33333333-3333-4333-8333-333333333333';
    const seen = [];
    const session = { schema_version: 'rdp-cockpit.v1', id: desktop, instance_id: id, incarnation: 'boot-1', workspace_id: 'workspace-a',
      state: 'ready', cleanup: 'none', policy, absolute_expires_at: '2026-09-13T23:00:00Z', retained_until: null };
    const admission = { attachment_id: attachment, desktop_id: desktop, grant: 'g'.repeat(32), expires_at: '2026-09-13T15:00:00Z', policy_generation: 1 };
    const client = await fixture(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString();
      seen.push({ path: req.url, method: req.method, idempotencyKey: req.headers['idempotency-key'], body: raw ? JSON.parse(raw) : undefined });
      if (req.method === 'DELETE') { res.writeHead(204); res.end(); }
      else if (req.url.endsWith('/attachments')) reply(res, admission, 201);
      else reply(res, session, req.method === 'POST' ? 202 : 200);
    });
    const viewport = { width: 800, height: 600, dpi: 96 };
    expect(await client.request({ ...request, operation: 'create', body: { viewport, requested_mode: 'control' }, idempotencyKey: 'request-123456789' })).toEqual(session);
    expect(await client.request({ ...request, operation: 'get', id: desktop })).toEqual(session);
    expect(await client.request({ ...request, operation: 'attach', id: desktop, body: { viewport, mode: 'control' } })).toEqual(admission);
    expect(await client.request({ ...request, operation: 'close', id: desktop, body: { action: 'revoke_access' } })).toEqual(session);
    expect(await client.request({ ...request, operation: 'detach', id: attachment })).toBeUndefined();
    expect(seen[0]).toEqual({ path: `/api/v2/instances/${id}/desktop-sessions`, method: 'POST', idempotencyKey: 'request-123456789', body: { viewport, requested_mode: 'control' } });
    expect(seen[2].body).toEqual({ viewport, mode: 'control' });
    expect(seen[3].body).toEqual({ action: 'revoke_access' });
    expect(seen[4].path).toBe(`/api/v2/desktop-attachments/${attachment}`);
  });
  it.each(['wrong-host', 'wrong-server-ca', 'wrong-client-ca'])('rejects %s before the HTTP handler', async (kind) => {
    let reached = 0;
    const client = await fixture((_req, res) => { reached++; reply(res, capability); }, {
      ...(kind === 'wrong-host' ? { hostname: '127.0.0.1' } : {}),
      ...(kind === 'wrong-server-ca' ? { tls: { ca: foreignCa } } : {}),
      ...(kind === 'wrong-client-ca' ? { server: { ca: foreignCa } } : {}),
    });
    await expect(client.request(request)).rejects.toMatchObject({ status: 503 });
    expect(reached).toBe(0);
  });
  it('refuses redirects instead of disclosing delegation to a new origin', async () => {
    const client = await fixture((_req, res) => { res.writeHead(302, { location: 'https://elsewhere.invalid/' }); res.end(); });
    await expect(client.request(request)).rejects.toMatchObject({ code: 'desktop_invalid_response' });
  });
  it('reports old executor unsupported only on capability lookup', async () => {
    const client = await fixture((_req, res) => reply(res, { arbitrary: 'old executor body' }, 404));
    expect(await client.request(request)).toEqual({ state: 'unsupported', reason: 'desktop_not_supported' });
    await expect(client.request({ ...request, operation: 'get' })).rejects.toMatchObject({ code: 'desktop_invalid_response' });
  });
  it('bounds response bytes and redacts malformed upstream content', async () => {
    const client = await fixture((_req, res) => reply(res, { secret: 'x'.repeat(2048) }), { client: { maxResponseBytes: 1024 } });
    await expect(client.request(request)).rejects.toMatchObject({ code: 'desktop_invalid_response' });
  });
  it('enforces deadlines, cancellation and concurrent request limits', async () => {
    const client = await fixture(() => {}, { client: { timeoutMs: 100, maxConcurrent: 1 } });
    const controller = new AbortController();
    const pending = client.request({ ...request, signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'desktop_backend_unavailable' });
    await expect(client.request(request)).rejects.toMatchObject({ code: 'quota_exceeded' });
    controller.abort();
    await rejected;
    await expect(client.request(request)).rejects.toMatchObject({ code: 'desktop_backend_timeout' });
    client.close();
    await expect(client.request(request)).rejects.toMatchObject({ code: 'desktop_backend_unavailable' });
  });
  it('rejects forged paths, CRLF delegation and invalid mutations before sending', async () => {
    let reached = 0;
    const client = await fixture((_req, res) => { reached++; reply(res, capability); });
    for (const override of [{ id: '../admin' }, { operation: 'arbitrary' }, { delegation: 'a\r\nx-secret:b' },
      { operation: 'create', body: { viewport: { width: 800, height: 600, dpi: 96 }, requested_mode: 'control', actor: 'forged' } }]) {
      await expect(client.request({ ...request, ...override })).rejects.toMatchObject({ code: 'desktop_invalid_request' });
    }
    expect(reached).toBe(0);
  });
  it('refuses insecure endpoint and incomplete workload TLS configuration', () => {
    for (const url of ['http://localhost', 'https://user:password@localhost', 'https://localhost/path', 'https://localhost/?token=x']) {
      expect(() => createDesktopBackend({ url, tls: { ca, cert, key } })).toThrow(TypeError);
    }
    expect(() => createDesktopBackend({ url: 'https://localhost', tls: { ca } })).toThrow(TypeError);
  });
});
