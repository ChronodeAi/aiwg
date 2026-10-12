import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:https';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopIssuerTransport } from '../../apps/cockpit/bridge/src/desktop-issuer-transport.mjs';

describe('desktop issuer HTTPS transport', () => {
  let dir; let server; let issuer; let config; let hits; let behavior; let onRequest;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'desktop-issuer-tls-'));
    const openssl = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore', timeout: 10_000 });
    openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=issuer-fixture',
      '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', 'server.key', '-out', 'server.pem');
    openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=bridge-fixture',
      '-keyout', 'client.key', '-out', 'client.pem');
    chmodSync(join(dir, 'client.key'), 0o600);
    for (const file of ['client.pem', 'server.pem']) chmodSync(join(dir, file), 0o644);
    hits = 0; behavior = 'ok'; onRequest = undefined;
    server = createServer({ key: readFileSync(join(dir, 'server.key')), cert: readFileSync(join(dir, 'server.pem')),
      ca: readFileSync(join(dir, 'client.pem')), requestCert: true, rejectUnauthorized: true }, (req, res) => {
      hits++;
      expect(req.socket.authorized).toBe(true);
      onRequest?.(req);
      if (behavior === 'redirect') { res.writeHead(302, { location: 'https://outside.invalid/token' }); res.end(); }
      else if (behavior === 'oversized') res.end('x'.repeat(65537));
      else if (behavior === 'hang') { /* deadline must close socket */ }
      else res.end('{"active":true}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    issuer = `https://127.0.0.1:${server.address().port}/realms/desktop`;
    const leaf = new X509Certificate(readFileSync(join(dir, 'client.pem')));
    config = { issuer, certificateFile: join(dir, 'client.pem'), keyFile: join(dir, 'client.key'),
      caFile: join(dir, 'server.pem'), thumbprint: Buffer.from(leaf.fingerprint256.replaceAll(':', ''), 'hex').toString('base64url') };
  });
  afterEach(async () => {
    vi.useRealTimers();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  it('presents the configured client leaf and verifies issuer TLS', async () => {
    const fetch = createDesktopIssuerTransport(config);
    const response = await fetch(`${issuer}/protocol/openid-connect/token`, { method: 'POST', body: 'grant_type=test' });
    expect(await response.json()).toEqual({ active: true });
    expect(hits).toBe(1);
    await expect(createDesktopIssuerTransport({ ...config, caFile: undefined })(`${issuer}/protocol/openid-connect/token`))
      .rejects.toMatchObject({ code: 'identity_unavailable' });
    expect(hits).toBe(1);
  });
  it('rejects wrong pin, unsafe keys and destinations before HTTP', async () => {
    const target = `${issuer}/protocol/openid-connect/token`;
    await expect(createDesktopIssuerTransport({ ...config, thumbprint: 'x'.repeat(43) })(target)).rejects.toThrow();
    const fetch = createDesktopIssuerTransport(config);
    await expect(fetch('https://outside.invalid/realms/desktop/protocol/openid-connect/token')).rejects.toThrow();
    chmodSync(config.keyFile, 0o644);
    await expect(fetch(target)).rejects.toThrow();
    chmodSync(config.keyFile, 0o600);
    symlinkSync(config.keyFile, join(dir, 'alias.key'));
    await expect(createDesktopIssuerTransport({ ...config, keyFile: join(dir, 'alias.key') })(target)).rejects.toThrow();
    expect(hits).toBe(0);
  });
  it('bounds responses and deadlines and never follows redirects', async () => {
    // Keep real TLS and HTTP I/O, but advance the deadline only after HTTP arrives.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const target = `${issuer}/protocol/openid-connect/token`;
    const fetch = createDesktopIssuerTransport({ ...config, timeoutMs: 100 });
    for (const action of ['redirect', 'oversized']) {
      behavior = action;
      await expect(fetch(target)).rejects.toMatchObject({ code: 'identity_unavailable' });
    }
    expect(hits).toBe(2);
    behavior = 'hang';
    const arrived = new Promise(resolve => { onRequest = resolve; });
    let settled = false;
    const pending = fetch(target).finally(() => { settled = true; });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'identity_unavailable' });
    const req = await arrived;
    const closed = new Promise(resolve => req.socket.once('close', resolve));
    expect(hits).toBe(3);
    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    await closed;
    expect(hits).toBe(3);
    const controller = new AbortController(); controller.abort();
    await expect(fetch(target, { signal: controller.signal })).rejects.toThrow();
    expect(hits).toBe(3);
  });
  it('expires during TLS setup before sending an HTTP request', async () => {
    // Accept TCP and consume the ClientHello, but never complete the TLS handshake.
    // Unlike a load-dependent delay, this gate cannot let HTTP reach the handler.
    const sockets = new Set();
    let onClientHello; let onClose;
    const clientHello = new Promise(resolve => { onClientHello = resolve; });
    const closed = new Promise(resolve => { onClose = resolve; });
    const gate = createTcpServer(socket => {
      sockets.add(socket);
      socket.once('data', onClientHello);
      socket.once('close', onClose);
    });
    try {
      await new Promise((resolve, reject) => {
        gate.once('error', reject);
        gate.listen(0, '127.0.0.1', resolve);
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const stalledIssuer = `https://127.0.0.1:${gate.address().port}/realms/desktop`;
      const fetch = createDesktopIssuerTransport({ ...config, issuer: stalledIssuer, timeoutMs: 100 });
      let settled = false;
      const pending = fetch(`${stalledIssuer}/protocol/openid-connect/token`).finally(() => { settled = true; });
      const rejected = expect(pending).rejects.toMatchObject({ code: 'identity_unavailable' });
      await clientHello;
      await vi.advanceTimersByTimeAsync(99);
      expect(settled).toBe(false);
      expect(hits).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      await closed;
      expect(hits).toBe(0);
    } finally {
      vi.useRealTimers();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => gate.close(resolve));
    }
  });
});
