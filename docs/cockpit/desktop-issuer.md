# Desktop issuer integration

The Keycloak desktop verifier requires a gateway delegation signed by the realm
and bound to the authenticated user, workspace, user session, browser context and
Bridge workload certificate. Opaque exchange responses and mismatched signed
claims are denied. This component remains opt-in; it does not enable managed
desktop discovery or supply an organizational browser login flow.

Configure `createKeycloakDesktopVerifier` with the realm `issuer`, login token
`audience`, confidential Bridge `clientId`, mode-0600 `clientSecretFile`, gateway
`delegationAudience`, and `workloadCertificateThumbprint` (unpadded base64url
SHA-256 of its leaf certificate DER). Set `issuerTls.certificateFile` and
`issuerTls.keyFile`; optionally set `issuerTls.caFile` for a private issuer CA.
The default transport verifies HTTPS and presents that exact certificate for
JWKS, introspection, exchange and refresh requests. It rejects redirects,
untrusted servers, unsafe key files, oversized responses and timeouts. An injected
`fetch` is a trusted backend integration/test seam and must implement equivalent
transport guarantees; there is no default bearer-only transport.

Install the corresponding `desktop-browser-binding-v1` Keycloak provider from
`roctinam/agentic-sandbox` and configure the same Bridge client, gateway audience
and certificate thumbprint. Retain native subject mapping and an issuer-controlled
`workspace_id` claim. Configure workspace membership/action policy independently;
the browser-binding provider grants no membership or action rights.

The backend computes `desktopBrowserAudience(expected)` as a SHA-256 digest of a
JSON tuple containing a version domain, authenticated browser-session ID, local
browser audience and workspace. The issuer receives the versioned digest in
`desktop_browser_session_audience`. Do not populate those inputs from arbitrary
browser actor headers or claimed workspaces. The existing identity boundary owns
and compares the backend browser binding; local public `audience` remains the
local browser audience. Gateway attachment consumers can use the exported helper
when they need the exact issuer browser audience.

Each returned delegation must have a verified realm signature, exact singleton
gateway audience, configured `azp`, current subject/session/workspace, matching
browser digest and workload certificate thumbprint, and valid expiry/not-before.
Its usable lifetime is capped at the signed expiry even if `expires_in` is longer.
Fresh introspection must retain the original subject/session; it cannot switch a
cached delegation to another identity. Two browsers sharing a Keycloak user
session receive different browser bindings. Refresh still runs through the same
certificate transport. Coordinate rotation with issuer/gateway pins and existing
bound refresh credentials; changing a configured file alone cannot change the
accepted workload leaf.

## Qualification

Focused tests use signed issuer responses and a real HTTPS server requiring a
client certificate. They cover claim mismatches, signature rejection, distinct
browser bindings, signed expiry, unsafe credentials, server trust, redirects,
response bounds and deadlines:

```sh
npm test -- test/integration/cockpit-desktop-identity-keycloak.test.js test/integration/cockpit-desktop-issuer-transport.test.js
```

A separate opt-in check runs the actual verifier and default transport against an
owned, running sandbox Keycloak fixture containing the browser-binding provider
and synthetic workspace mapper:

```sh
node tools/cockpit/qualify-desktop-issuer.mjs /tmp/owned-desktop-issuer-fixture
```

Create and stop that fixture using `scripts/desktop-comparison/keycloak-fixture.py`
in the sandbox repository. Its private files include `bridge-client-secret`;
never pass a credential on the command line. The script verifies container
ownership and emits only sanitized booleans and immutable image/provider refs.

The real check covers two browser bindings for one user/session, foreign browser
and workspace denial, and logout preventing renewal. It uses a synthetic password
login and controlled action/inventory mapping. Browser authorization-code/PKCE,
hosted/local UI qualification, fresh Rust membership checks, multi-user RDP and
full Cockpit acceptance remain separate gates. Refs: roctinam/aiwg#2545 and
roctinam/agentic-sandbox#853.
