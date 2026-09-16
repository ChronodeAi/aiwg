import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopIssuerTransport } from '../../apps/cockpit/bridge/src/desktop-issuer-transport.mjs';

describe('desktop issuer HTTPS transport', () => {
  let dir; let server; let issuer; let config; let hits; let behavior;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'desktop-issuer-tls-'));
    const openssl = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
    openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=issuer-fixture',
      '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', 'server.key', '-out', 'server.pem');
    openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=bridge-fixture',
      '-keyout', 'client.key', '-out', 'client.pem');
    chmodSync(join(dir, 'client.key'), 0o600);
    for (const file of ['client.pem', 'server.pem']) chmodSync(join(dir, file), 0o644);
    hits = 0; behavior = 'ok';
    server = createServer({ key: readFileSync(join(dir, 'server.key')), cert: readFileSync(join(dir, 'server.pem')),
      ca: readFileSync(join(dir, 'client.pem')), requestCert: true, rejectUnauthorized: true }, (req, res) => {
      hits++;
      expect(req.socket.authorized).toBe(true);
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
    const target = `${issuer}/protocol/openid-connect/token`;
    const fetch = createDesktopIssuerTransport({ ...config, timeoutMs: 100 });
    for (const action of ['redirect', 'oversized', 'hang']) {
      behavior = action;
      await expect(fetch(target)).rejects.toMatchObject({ code: 'identity_unavailable' });
    }
    expect(hits).toBe(3);
    const controller = new AbortController(); controller.abort();
    await expect(fetch(target, { signal: controller.signal })).rejects.toThrow();
    expect(hits).toBe(3);
  });
});
