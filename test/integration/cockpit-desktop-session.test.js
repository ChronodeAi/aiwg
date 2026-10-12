import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBridge, validDesktopBrowserOrigin } from '../../apps/cockpit/bridge/src/server.mjs';
import { createDesktopIdentity } from '../../apps/cockpit/bridge/src/desktop-identity.mjs';

const servers = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  })));
});

async function bridge(options = {}) {
  const server = createBridge(options);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const exchange = await fetch(`${base}/bootstrap/session`, {
    method: 'POST', headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ nonce: server.issueBootstrapNonce('browser'), audience: 'browser' }),
  });
  expect(exchange.status).toBe(201);
  const cookie = exchange.headers.get('set-cookie').split(';')[0];
  const { csrf } = await exchange.json();
  return { server, base, cookie, csrf, headers: { cookie, origin: base } };
}

describe('desktop browser session boundary', () => {
  it('rechecks browser expiry after an awaited provider response', async () => {
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    let statusEntered;
    const entered = new Promise((resolve) => { statusEntered = resolve; });
    let releaseStatus;
    const released = new Promise((resolve) => { releaseStatus = resolve; });
    const identity = createDesktopIdentity({ verify: async ({ operation, expected }) => {
      if (operation === 'status') {
        statusEntered();
        await released;
      }
      return { active: true, issuer: 'https://issuer.example', subject: 'user-a', userSessionId: 'session-a', ...expected,
        checkedAt: Date.now(), expiresAt: Date.now() + 60_000, actions: ['attach'], instanceIds: ['instance-a'],
        delegation: 'secret-delegation', delegationExpiresAt: Date.now() + 30_000 };
    } });
    const b = await bridge({ desktopIdentity: identity, sessionTtlMs: 250 });
    await b.server.bindDesktopIdentity({ headers: { cookie: b.cookie } }, { workspaceId: 'workspace-a', evidence: {} });
    const response = fetch(`${b.base}/api/desktop-identity`, { headers: b.headers });
    await entered;
    clock += 251;
    releaseStatus();
    const denied = await response;
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: 'unauthorized' });
    identity.close();
  });
  it('does not turn an operator bearer or a bootstrap cookie into desktop identity', async () => {
    const b = await bridge();
    const bearer = await fetch(`${b.base}/api/desktop-identity`, {
      headers: { authorization: `Bearer ${b.server.cockpitToken}`, origin: b.base },
    });
    expect(bearer.status).toBe(401);
    const status = await fetch(`${b.base}/api/desktop-identity`, { headers: b.headers });
    expect(await status.json()).toEqual({ state: 'unsupported', reason: 'desktop_identity_not_configured' });
    const forged = await fetch(`${b.base}/api/desktop-identity`, {
      method: 'POST', headers: { ...b.headers, 'x-cockpit-csrf': b.csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'other-user', tenant: 'other-workspace' }),
    });
    expect(forged.status).toBe(405);
  });

  it('requires exact desktop Origin, allowing absent Origin only for safe same-origin browser fetches', async () => {
    const b = await bridge();
    for (const origin of [undefined, 'null', `${b.base}/`, 'https://foreign.example', `${b.base}@evil.test`, `${b.base}, ${b.base}`]) {
      const headers = { cookie: b.cookie, ...(origin === undefined ? {} : { origin }) };
      expect((await fetch(`${b.base}/api/desktop-identity`, { headers })).status).toBe(403);
    }
    expect((await fetch(`${b.base}/api/desktop-identity`, {
      headers: { cookie: b.cookie, 'sec-fetch-site': 'same-origin' },
    })).status).toBe(200);
  });

  it('anchors local Origin to the listening port and ignores proxy claims', () => {
    const req = { method: 'GET', headers: { host: '127.0.0.1:8140', origin: 'http://127.0.0.1:8140' }, socket: { localPort: 8140 } };
    expect(validDesktopBrowserOrigin(req)).toBe(true);
    expect(validDesktopBrowserOrigin({ ...req, socket: { localPort: 8141 } })).toBe(false);
    expect(validDesktopBrowserOrigin({ ...req, headers: { host: 'cockpit.example', origin: 'https://cockpit.example', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'cockpit.example' } })).toBe(false);
    expect(validDesktopBrowserOrigin({ ...req, headers: { ...req.headers, origin: 'http://127.0.0.1:8140/' } })).toBe(false);
  });

  it('binds through the trusted login adapter, checks fresh status, and invalidates on CSRF-protected logout', async () => {
    let subject;
    let checks = 0;
    let unavailable = false;
    const invalidations = [];
    // Contract fixture only. A real organizational verifier remains required.
    const identity = createDesktopIdentity({ verify: async ({ expected, evidence }) => {
      checks++;
      if (unavailable) throw new Error('private provider detail must not reach HTTP');
      subject ??= evidence.subject;
      return {
        active: true, issuer: 'https://issuer.example', subject, userSessionId: 'org-session', ...expected,
        checkedAt: Date.now(), expiresAt: Date.now() + 60_000,
        actions: ['discover', 'attach'], instanceIds: ['instance-a'],
        delegation: 'backend-only-fixture-delegation', delegationExpiresAt: Date.now() + 30_000,
      };
    } });
    identity.onInvalidate((event) => invalidations.push(event));
    const b = await bridge({ desktopIdentity: identity });
    const req = { headers: { cookie: b.cookie } };
    await b.server.bindDesktopIdentity(req, { workspaceId: 'workspace-a', evidence: { subject: 'user-a' } });
    const status = await fetch(`${b.base}/api/desktop-identity`, { headers: b.headers });
    expect(status.status).toBe(200);
    const body = await status.json();
    expect(body).toMatchObject({ subject: 'user-a', workspaceId: 'workspace-a' });
    expect(JSON.stringify(body)).not.toContain('delegation');
    expect(body).not.toHaveProperty('instanceIds');
    expect(checks).toBe(2);
    const foreign = await bridge();
    expect((await fetch(`${foreign.base}/api/desktop-identity`, { headers: { cookie: b.cookie, origin: foreign.base } })).status).toBe(401);
    expect((await fetch(`${b.base}/bootstrap/session`, { method: 'DELETE', headers: b.headers })).status).toBe(403);
    expect(invalidations).toHaveLength(0);
    const logout = await fetch(`${b.base}/bootstrap/session`, {
      method: 'DELETE', headers: { ...b.headers, 'x-cockpit-csrf': b.csrf },
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(invalidations).toHaveLength(1);
    expect(invalidations[0].reason).toBe('logged_out');
    expect((await fetch(`${b.base}/api/desktop-identity`, { headers: b.headers })).status).toBe(401);
    await expect(b.server.bindDesktopIdentity(req, { workspaceId: 'workspace-a', evidence: {} })).rejects.toMatchObject({ code: 'desktop_identity_denied' });
    identity.close();
  });

  it('does not expose issuer failures or fall back to a previously verified identity', async () => {
    let offline = false;
    const identity = createDesktopIdentity({ verify: async ({ expected }) => {
      if (offline) throw new Error('sensitive issuer failure');
      return { active: true, issuer: 'https://issuer.example', subject: 'user-a', userSessionId: 'session-a', ...expected,
        checkedAt: Date.now(), expiresAt: Date.now() + 60_000, actions: ['attach'], instanceIds: ['instance-a'],
        delegation: 'secret-delegation', delegationExpiresAt: Date.now() + 30_000 };
    } });
    const b = await bridge({ desktopIdentity: identity });
    await b.server.bindDesktopIdentity({ headers: { cookie: b.cookie } }, { workspaceId: 'workspace-a', evidence: {} });
    offline = true;
    const failure = await fetch(`${b.base}/api/desktop-identity`, { headers: b.headers });
    expect(failure.status).toBe(503);
    expect(await failure.json()).toEqual({ error: 'desktop_identity_unavailable' });
    expect((await fetch(`${b.base}/api/desktop-identity`, { headers: b.headers })).status).toBe(403);
    identity.close();
  });
});
