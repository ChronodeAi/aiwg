# Desktop identity integration

The Bridge provides an optional identity boundary for desktop access (#2545).
It requires a trusted provider adapter; the default Cockpit launch does not
configure one. This component alone does not enable RDP or complete #2545.

## Provider contract

Create `createDesktopIdentity({ verify })` from `src/desktop-identity.mjs` and
pass the result as `desktopIdentity` to `createBridge`. The module documents
the complete verifier input and result schema. Every bind, status, and
authorization request requires a fresh authoritative check of the user session,
workspace membership, action, and instance policy. Token claims cached at login
do not satisfy that contract.

The adapter must authenticate login evidence, validate issuer, signature and
audience, and return a gateway-verifiable scoped delegation. Provider failures
deny access. There is no operator-token fallback. The issuer, claims mapping,
membership authority, and login flow still need production integration.

After the trusted login callback authenticates the user, call
`server.bindDesktopIdentity(req, { workspaceId, evidence })` using the original
browser request. The Bridge derives the browser binding and audience from its
HttpOnly session cookie. There is no public endpoint accepting identity claims.
Browser expiration or logout racing verification prevents binding or disclosure.

## Browser boundary

`GET /api/desktop-identity` requires the browser session and an exact local
origin. A same-origin GET without Origin is accepted only with
`Sec-Fetch-Site: same-origin`. Validation uses the actual listener port and
does not trust forwarded headers. Hosted reverse-proxy access needs a separate
explicit origin configuration before it can be supported.

Without a provider the endpoint returns `state: unsupported`. With a provider
it returns freshly checked, redacted identity status. Delegations are never
returned by this endpoint. Native bearer credentials alone cannot access it.

`DELETE /bootstrap/session` requires the browser cookie, exact Origin, and CSRF
token. It removes browser authority, invalidates its desktop binding, and expires
the cookie. Browser session expiration and Bridge shutdown also invalidate
bindings.

## Transport integration still required

The desktop transport must use `withDelegation` for backend calls, register
`onInvalidate` to close active streams, and renew authorization within its
revocation budget. The identity module does not poll the provider itself.
Provider revocation events must call `revoke` with an issuer-scoped selector.
The existing terminal transport has not been converted into a desktop transport.

API forwarding, worker attachment, the desktop panel, production identity
provider integration, and real browser/Tauri/VS Code qualification remain under
issues #2545, #2546, and #2547. Unit and local HTTP tests do not prove those workflows.

## Desktop control API

The optional `desktopBackend` Bridge setting accepts the dedicated adapter from
`src/desktop-backend.mjs`. Configure `createDesktopBackend` with an HTTPS origin
and `tls: { ca, cert, key }` supplied through backend custody. The client
certificate authenticates the Bridge workload; each request also carries the
fresh user delegation. The gateway must verify both identities. This adapter
does not read the existing operator bearer file. TLS peer and hostname checks
cannot be disabled through its options, and redirects are never followed.

The local browser control routes use the prefix
`/api/desktops/instances/{instance}`:

| Method | Route | Required identity action |
| --- | --- | --- |
| GET | `/capability` | `view` |
| POST | `/sessions` | `create` |
| GET | `/sessions/{desktop}` | `view` |
| POST | `/sessions/{desktop}/close` | See below |

The close action is `revoke_access` or `sign_out`, from the validated body.
Create requires a 16–128
character `Idempotency-Key` containing letters, digits, `_` or `-`. Request
bodies follow the proposed `rdp-cockpit.v1` contract; unknown request fields
are rejected. Responses are whitelisted and checked against the requested
instance and authenticated workspace. Arbitrary upstream error text is not
returned to the browser.

These routes require the browser cookie, exact local origin and mutation CSRF.
Authorization is rechecked for each request. Browser logout and identity
invalidation cancel pending backend calls. Limits are 4 KiB browser bodies,
eight pending requests per browser, 64 across the Bridge, and ten seconds for
the browser control operation. The backend defaults to 32 concurrent requests,
64 KiB responses and a five-second deadline. Backend limits are configurable
within fixed bounds. This is control-plane traffic, not display frames.

An unconfigured backend reports unsupported. A capability lookup returning
404 or 501 from an older executor also reports unsupported; terminal routes
retain their existing behavior. Attach grants are available only through the
backend adapter, with no browser route that serializes them. The authenticated
WebSocket worker transport and desktop rendering remain unimplemented.

The local TLS tests use generated test certificates and a real HTTPS server.
They verify client authentication, server trust, hostname validation, response
limits, redirects, and the browser-to-Bridge-to-HTTPS request path. Their
identity provider and desktop responses are test fixtures; they do not qualify
production identity, the Sandbox broker, or RDP.

## Verification

Run the focused suites from the repository root after `npm run build:cli`:

```sh
npx vitest run --config config/vitest.config.js \
  test/integration/cockpit-desktop-identity.test.js \
  test/integration/cockpit-desktop-session.test.js \
  test/integration/cockpit-bridge.test.js
```

For an isolated worktree, set `AIWG_CONFIG` to a dedicated temporary directory
so installation identity checks do not use another checkout's configuration.
