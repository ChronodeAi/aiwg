// Keycloak (OIDC) authoritative verifier for the desktop identity boundary (#2545).
//
// Produces the `verify` function `createDesktopIdentity` requires. Every call
// re-checks the user's Keycloak session through token introspection (never a
// cached claim), pins the realm issuer and the exact audience, verifies the
// login evidence signature against the realm JWKS, and mints the gateway
// delegation through RFC 8693 token exchange so the gateway can verify it on
// its own. The Bridge client secret is read from a mode-0600 file at point of
// use and never logged or returned. Section9 realm defaults come from itops
// (`config/matric-user-secrets.yaml`, `configs/keycloak/realms/section9.json`).

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

export const SECTION9_ISSUER = 'https://auth.s9.internal/realms/section9';
export const DESKTOP_ACTIONS = Object.freeze(['view', 'create', 'close', 'attach', 'control', 'observe']);
/** Default section9 group → desktop action mapping; override with `groupActions`. */
export const SECTION9_GROUP_ACTIONS = Object.freeze({
  admins: DESKTOP_ACTIONS,
  operators: DESKTOP_ACTIONS,
  viewers: Object.freeze(['view', 'observe']),
});
const JWT_ALGORITHMS = Object.freeze({ RS256: 'sha256', RS384: 'sha384', RS512: 'sha512', ES256: 'sha256', ES384: 'sha384' });
const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

const denied = (code = 'denied') => Object.assign(new Error(code), { code });
const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const b64url = (value) => Buffer.from(value, 'base64url');

function decodeJwt(token) {
  if (!text(token)) throw denied();
  const parts = token.split('.');
  if (parts.length !== 3) throw denied();
  let header; let payload;
  try {
    header = JSON.parse(b64url(parts[0]).toString('utf8'));
    payload = JSON.parse(b64url(parts[1]).toString('utf8'));
  } catch { throw denied(); }
  return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: b64url(parts[2]) };
}

function jwkToKey(jwk) {
  try { return createPublicKey({ key: jwk, format: 'jwk' }); } catch { return null; }
}

/** Verify a compact JWS against a JWKS key set; returns the payload or throws `denied`. */
export function verifyJws(token, keys) {
  const { header, payload, signingInput, signature } = decodeJwt(token);
  const digest = JWT_ALGORITHMS[header?.alg];
  if (!digest || !text(header.kid)) throw denied();
  const jwk = keys.find((key) => key.kid === header.kid && (!key.alg || key.alg === header.alg) && (!key.use || key.use === 'sig'));
  const key = jwk && jwkToKey(jwk);
  if (!key) throw denied();
  const options = header.alg.startsWith('ES') ? { key, dsaEncoding: 'ieee-p1363' } : key;
  let ok = false;
  try { ok = cryptoVerify(digest, Buffer.from(signingInput), options, signature); } catch { ok = false; }
  if (!ok) throw denied();
  return payload;
}

async function readSecret(file) {
  const info = await stat(file);
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw denied('identity_unavailable');
  const value = (await readFile(file, 'utf8')).trim();
  if (!text(value)) throw denied('identity_unavailable');
  return value;
}

function audienceMatches(aud, expected) {
  return Array.isArray(aud) ? aud.includes(expected) : aud === expected;
}

/** Default claims → binding mapping for the section9 realm. */
export function mapSection9Claims(claims, { groupActions = SECTION9_GROUP_ACTIONS, clientId } = {}) {
  const workspaceId = [claims.workspace_id, claims.tenant_id].find(text);
  const actions = new Set();
  const groups = Array.isArray(claims.groups) ? claims.groups : [];
  for (const raw of groups) {
    const group = String(raw).replace(/^\//, '');
    for (const action of groupActions[group] ?? []) actions.add(action);
  }
  const roles = [
    ...(Array.isArray(claims.realm_access?.roles) ? claims.realm_access.roles : []),
    ...(clientId && Array.isArray(claims.resource_access?.[clientId]?.roles) ? claims.resource_access[clientId].roles : []),
  ];
  for (const role of roles) {
    const match = /^desktop:([a-z]+)$/.exec(String(role));
    if (match && DESKTOP_ACTIONS.includes(match[1])) actions.add(match[1]);
  }
  const instanceIds = Array.isArray(claims.desktop_instances) ? claims.desktop_instances.filter(text) : [];
  return { workspaceId, actions: [...actions], instanceIds };
}

/**
 * Parse and verify a Keycloak back-channel logout token into the selector
 * `createDesktopIdentity().revoke()` accepts. Throws `denied` on any mismatch.
 */
export async function backchannelLogoutSelector(logoutToken, { issuer, audience, keys }) {
  const payload = verifyJws(logoutToken, keys);
  if (payload.iss !== issuer || !audienceMatches(payload.aud, audience) || !payload.events?.['http://schemas.openid.net/event/backchannel-logout']) throw denied();
  if (!text(payload.sub) && !text(payload.sid)) throw denied();
  const selector = { issuer };
  if (text(payload.sub)) selector.subject = payload.sub;
  if (text(payload.sid)) selector.userSessionId = payload.sid;
  return selector;
}

/**
 * Build the verifier. Required: `audience` (exact `aud` the Bridge login client
 * receives), `clientId`, `clientSecretFile` (mode 0600), `delegationAudience`
 * (the gateway client id the exchanged token is minted for).
 */
export function createKeycloakDesktopVerifier({
  issuer = SECTION9_ISSUER,
  audience,
  clientId,
  clientSecretFile,
  delegationAudience,
  fetch: fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = 5000,
  jwksTtlMs = 300_000,
  sessionMaxMs = 10 * 60 * 60 * 1000,
  clockSkewMs = 30_000,
  groupActions = SECTION9_GROUP_ACTIONS,
  mapClaims = (claims) => mapSection9Claims(claims, { groupActions, clientId }),
  resolveInstances,
} = {}) {
  let base;
  try { base = new URL(issuer); } catch { throw new TypeError('Keycloak issuer must be an HTTPS realm URL'); }
  if (base.protocol !== 'https:' || base.search || base.hash || !/\/realms\/[^/]+$/.test(base.pathname)) throw new TypeError('Keycloak issuer must be an HTTPS realm URL');
  for (const [name, value] of Object.entries({ audience, clientId, clientSecretFile, delegationAudience })) {
    if (!text(value)) throw new TypeError(`Keycloak desktop verifier requires ${name}`);
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation required');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) throw new TypeError('Invalid Keycloak deadline');
  const realm = issuer.replace(/\/$/, '');
  const endpoints = {
    jwks: `${realm}/protocol/openid-connect/certs`,
    introspect: `${realm}/protocol/openid-connect/token/introspect`,
    token: `${realm}/protocol/openid-connect/token`,
  };
  const sessions = new Map(); // browserSessionId -> { accessToken, refreshToken, delegation, delegationExpiresAt }
  let jwks = { keys: [], fetchedAt: -Infinity };

  async function call(url, { body, basic, signal }) {
    const controller = new AbortController();
    let timer;
    let abort;
    // The deadline is a race, not only an abort: a transport that ignores the
    // signal still cannot hold a verification open past timeoutMs.
    const deadline = new Promise((_, reject) => {
      abort = () => { controller.abort(); reject(denied(signal?.aborted ? 'denied' : 'identity_unavailable')); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      timer = setTimeout(abort, timeoutMs);
    });
    try {
      const headers = { accept: 'application/json' };
      if (body) headers['content-type'] = 'application/x-www-form-urlencoded';
      if (basic) headers.authorization = `Basic ${Buffer.from(`${basic.id}:${basic.secret}`).toString('base64')}`;
      const response = await Promise.race([
        fetchImpl(url, { method: body ? 'POST' : 'GET', headers, body, signal: controller.signal, redirect: 'error' }),
        deadline,
      ]);
      if (response.status === 401 || response.status === 403) throw denied();
      if (!response.ok) throw denied('identity_unavailable');
      try { return await Promise.race([response.json(), deadline]); } catch (error) { throw error?.code ? error : denied('identity_unavailable'); }
    } catch (error) {
      throw error?.code ? error : denied('identity_unavailable');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      deadline.catch(() => {});
    }
  }

  async function keys(signal) {
    if (now() - jwks.fetchedAt > jwksTtlMs) {
      const value = await call(endpoints.jwks, { signal });
      if (!Array.isArray(value?.keys)) throw denied('identity_unavailable');
      jwks = { keys: value.keys, fetchedAt: now() };
    }
    return jwks.keys;
  }

  // The client secret lives only inside the awaited call that needs it.
  async function withSecret(fn) {
    return fn(await readSecret(clientSecretFile));
  }

  async function introspect(accessToken, signal) {
    return withSecret((secret) => call(endpoints.introspect, {
      body: new URLSearchParams({ token: accessToken, token_type_hint: 'access_token' }).toString(),
      basic: { id: clientId, secret }, signal,
    }));
  }

  async function grant(params, signal) {
    return withSecret((secret) => call(endpoints.token, {
      body: new URLSearchParams(params).toString(), basic: { id: clientId, secret }, signal,
    }));
  }

  function assertClaims(claims) {
    if (claims?.active !== true || claims.iss !== realm || !audienceMatches(claims.aud, audience) ||
        !text(claims.sub) || !text(claims.sid ?? claims.session_state)) throw denied();
    if (Number.isFinite(claims.exp) && claims.exp * 1000 + clockSkewMs <= now()) throw denied();
  }

  /** Fresh authoritative check: introspect, refreshing once when the access token lapsed. */
  async function freshClaims(entry, signal) {
    let claims = await introspect(entry.accessToken, signal);
    if (claims?.active !== true && text(entry.refreshToken)) {
      const refreshed = await grant({ grant_type: 'refresh_token', refresh_token: entry.refreshToken }, signal);
      if (!text(refreshed?.access_token)) throw denied();
      entry.accessToken = refreshed.access_token;
      if (text(refreshed.refresh_token)) entry.refreshToken = refreshed.refresh_token;
      entry.delegation = undefined;
      claims = await introspect(entry.accessToken, signal);
    }
    assertClaims(claims);
    return claims;
  }

  async function delegation(entry, signal) {
    const skew = clockSkewMs;
    if (entry.delegation && entry.delegationExpiresAt - skew > now()) return { delegation: entry.delegation, delegationExpiresAt: entry.delegationExpiresAt };
    const exchanged = await grant({
      grant_type: TOKEN_EXCHANGE, subject_token: entry.accessToken, subject_token_type: ACCESS_TOKEN_TYPE,
      requested_token_type: ACCESS_TOKEN_TYPE, audience: delegationAudience,
    }, signal);
    if (!text(exchanged?.access_token) || !Number.isFinite(exchanged.expires_in) || exchanged.expires_in <= 0) throw denied('identity_unavailable');
    entry.delegation = exchanged.access_token;
    entry.delegationExpiresAt = now() + exchanged.expires_in * 1000;
    return { delegation: entry.delegation, delegationExpiresAt: entry.delegationExpiresAt };
  }

  async function verify({ operation, expected, evidence, signal } = {}) {
    if (!['bind', 'authorize', 'status'].includes(operation) || !text(expected?.browserSessionId)) throw denied();
    let entry = sessions.get(expected.browserSessionId);
    if (operation === 'bind') {
      if (entry || !text(evidence?.accessToken)) throw denied();
      const payload = verifyJws(evidence.accessToken, await keys(signal));
      if (payload.iss !== realm || !audienceMatches(payload.aud, audience)) throw denied();
      entry = { accessToken: evidence.accessToken, refreshToken: text(evidence.refreshToken) ? evidence.refreshToken : undefined,
        authTime: Number.isFinite(payload.auth_time) ? payload.auth_time * 1000 : now() };
    } else if (!entry) throw denied();
    let claims;
    try { claims = await freshClaims(entry, signal); }
    catch (error) { sessions.delete(expected.browserSessionId); throw error; }
    const checkedAt = now();
    const mapped = mapClaims(claims) ?? {};
    const instanceIds = typeof resolveInstances === 'function'
      ? await resolveInstances({ subject: claims.sub, workspaceId: mapped.workspaceId, claims, signal })
      : mapped.instanceIds;
    // Workspace membership is re-derived on every call; a user moved out of the
    // bound workspace is denied and the retained tokens are dropped.
    if (!text(mapped.workspaceId) || mapped.workspaceId !== expected.workspaceId ||
        !Array.isArray(mapped.actions) || !Array.isArray(instanceIds)) {
      sessions.delete(expected.browserSessionId);
      throw denied();
    }
    const { delegation: token, delegationExpiresAt } = await delegation(entry, signal);
    const expiresAt = Math.min(entry.authTime + sessionMaxMs, checkedAt + sessionMaxMs);
    if (operation === 'bind') sessions.set(expected.browserSessionId, entry);
    return {
      active: true,
      issuer: realm,
      subject: claims.sub,
      userSessionId: claims.sid ?? claims.session_state,
      workspaceId: mapped.workspaceId,
      browserSessionId: expected.browserSessionId,
      audience: expected.audience,
      checkedAt,
      expiresAt,
      actions: [...new Set(mapped.actions.filter((action) => DESKTOP_ACTIONS.includes(action)))],
      instanceIds: instanceIds.filter(text),
      delegation: token,
      delegationExpiresAt: Math.min(delegationExpiresAt, expiresAt),
    };
  }

  return Object.freeze({
    verify,
    /** Bridge logout hook: forget retained tokens for a browser session. */
    forget(browserSessionId) { sessions.delete(browserSessionId); },
    /** Verify a back-channel logout token and return the revoke() selector. */
    async logoutSelector(logoutToken, signal) {
      return backchannelLogoutSelector(logoutToken, { issuer: realm, audience, keys: await keys(signal) });
    },
    endpoints: Object.freeze({ ...endpoints }),
  });
}
