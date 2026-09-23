// Opt-in component qualification against the owned agentic-sandbox issuer fixture.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { createKeycloakDesktopVerifier, desktopBrowserAudience } from '../../apps/cockpit/bridge/src/desktop-identity-keycloak.mjs';
import { createDesktopIssuerTransport } from '../../apps/cockpit/bridge/src/desktop-issuer-transport.mjs';

const root = resolve(process.argv[2] ?? '');
assert(process.argv[2], 'Owned fixture directory required');
const info = statSync(root);
assert(info.uid === process.getuid() && !(info.mode & 0o077), 'Private owned fixture required');
const state = JSON.parse(readFileSync(join(root, 'state.json')));
const [container] = JSON.parse(execFileSync('docker', ['inspect', '--type', 'container', state.container], { encoding: 'utf8' }));
assert(container.State.Running && container.Config.Labels['agentic.desktop-issuer-fixture'] === root);
assert(state.mapper_sha256 && Number.isInteger(state.port) && state.port > 0 && state.port < 65536);
const privateDir = join(root, 'private');
const credentials = JSON.parse(readFileSync(join(privateDir, 'credentials.json')));
const issuer = `https://127.0.0.1:${state.port}/realms/desktop-fixture`;
const issuerTls = { certificateFile: join(privateDir, 'bridge-a.pem'), keyFile: join(privateDir, 'bridge-a.key'),
  caFile: join(privateDir, 'ca.pem') };
const leaf = new X509Certificate(readFileSync(issuerTls.certificateFile));
const thumbprint = Buffer.from(leaf.fingerprint256.replaceAll(':', ''), 'hex').toString('base64url');
const fetch = createDesktopIssuerTransport({ issuer, ...issuerTls, thumbprint });
async function grant(params, endpoint = 'token') {
  const response = await fetch(`${issuer}/protocol/openid-connect/${endpoint}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(),
  });
  assert(response.ok, `Synthetic issuer request failed: ${response.status}`);
  return response.status === 204 ? {} : response.json();
}
const login = await grant({ grant_type: 'password', client_id: 'login', client_secret: credentials.login,
  username: 'alice', password: credentials.password, scope: 'openid' });
// The fixture writes this mode-0600 secret file specifically for the verifier.
const verifier = createKeycloakDesktopVerifier({ issuer, audience: 'bridge', clientId: 'bridge',
  clientSecretFile: join(privateDir, 'bridge-client-secret'), delegationAudience: 'gateway', issuerTls,
  workloadCertificateThumbprint: thumbprint,
  mapClaims: claims => ({ workspaceId: claims.workspace_id, actions: ['view'], instanceIds: ['fixture-instance'] }),
});
const first = { browserSessionId: 'fixture-browser-a', audience: 'fixture:browser-a', workspaceId: 'workspace-a' };
const second = { ...first, browserSessionId: 'fixture-browser-b', audience: 'fixture:browser-b' };
const a = await verifier.verify({ operation: 'bind', expected: first, evidence: { accessToken: login.access_token } });
const b = await verifier.verify({ operation: 'bind', expected: second, evidence: { accessToken: login.access_token } });
assert.equal(a.subject, b.subject);
assert.equal(a.userSessionId, b.userSessionId);
assert.notEqual(a.delegation, b.delegation);
assert.notEqual(desktopBrowserAudience(first), desktopBrowserAudience(second));
await verifier.verify({ operation: 'status', expected: first });
await assert.rejects(verifier.verify({ operation: 'status', expected: { ...first, audience: 'foreign-browser' } }), { code: 'denied' });
await assert.rejects(verifier.verify({ operation: 'bind', expected: { ...first, browserSessionId: 'foreign', workspaceId: 'foreign-workspace' },
  evidence: { accessToken: login.access_token } }), { code: 'denied' });
await grant({ client_id: 'login', client_secret: credentials.login, refresh_token: login.refresh_token }, 'logout');
await assert.rejects(verifier.verify({ operation: 'status', expected: second }), { code: 'denied' });
console.log(JSON.stringify({ issuerImage: state.image, mapperSha256: state.mapper_sha256,
  realIssuerAndDefaultMtlsTransport: true, signedDelegationVerified: true, sameUserDistinctBrowserBindings: true,
  foreignBrowserDenied: true, foreignWorkspaceDenied: true, logoutDeniedRenewal: true,
  limitations: 'Synthetic password login; controlled action/inventory mapping; no browser login or Rust fresh membership qualification.' }));
