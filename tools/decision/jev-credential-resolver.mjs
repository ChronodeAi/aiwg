/**
 * Trusted TV-12 host credential resolver (#2681). The live runner pins this file by SHA-256.
 *
 * It resolves the Jev API key through a scoped OpenBao reader AppRole and returns the key only
 * as bytes in memory. It never logs, serializes or persists the key or the AppRole token, and
 * its errors carry a fixed category, never provider, secret-service or helper text.
 *
 * No import-time side effects: nothing runs until `resolveCredential` is called.
 *
 * Host configuration (read at call time, not import time):
 * - `BAO_ADDR`: HTTPS OpenBao origin. Requests set `rejectUnauthorized: true` explicitly, so
 *   `BAO_SKIP_VERIFY` has no effect, and any `NODE_TLS_REJECT_UNAUTHORIZED` other than `1` is
 *   refused. Trust an internal CA with `BAO_CACERT`, `NODE_OPTIONS=--use-system-ca` or
 *   `NODE_EXTRA_CA_CERTS`.
 * - `AIWG_OPENBAO_TOKEN_HELPER`: absolute path of the host token helper. It is invoked as
 *   `bash HELPER approle NAME` and must print one short-lived client token on stdout.
 * - `AIWG_JEV_OPENBAO_SECRET_PATH`: private KV v2 locator (`MOUNT/data/PATH`). It is host
 *   configuration so the locator stays out of source control and approval artifacts.
 *
 * The logical reference `openbao-approle:NAME/typesafe/jev` names the reader AppRole.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { isAbsolute } from 'node:path';

const REFERENCE = /^openbao-approle:([a-z0-9][a-z0-9-]{0,62})\/typesafe\/jev$/;
const SECRET_PATH = /^[a-z0-9_-]+\/data\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;
const CLIENT_TOKEN = /^[A-Za-z0-9._-]{8,512}$/;
const CREDENTIAL = /^[\x21-\x7e]{1,4096}$/;
const FIELD = 'token';
const MAX_RESPONSE_BYTES = 65_536;

/** Fixed categories only; never embeds a helper, secret-service or provider message. */
export class JevResolverError extends Error {
  constructor(category) {
    super(`Jev credential resolution failed (${category})`);
    this.name = 'JevResolverError';
    this.category = category;
  }
}

/** Refuses a process or host environment that disables TLS certificate verification. */
export function assertTlsVerification(env = process.env) {
  for (const value of [env.NODE_TLS_REJECT_UNAUTHORIZED, process.env.NODE_TLS_REJECT_UNAUTHORIZED]) {
    if (value !== undefined && value !== '1') throw new JevResolverError('tls');
  }
}

/**
 * Fetch-shaped HTTPS client for the secret service with explicit certificate verification. It never
 * follows redirects and bounds the response. `BAO_CACERT`, when set, is the only trusted CA.
 */
export function verifiedHttpsFetch(env = process.env) {
  return async (url, init = {}) => {
    const ca = env.BAO_CACERT ? await readFile(env.BAO_CACERT) : undefined;
    return new Promise((resolve, reject) => {
      const outgoing = httpsRequest(url, { method: init.method ?? 'GET', headers: init.headers ?? {}, rejectUnauthorized: true,
        ...(ca ? { ca } : {}), signal: init.signal }, response => {
        const chunks = []; let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) { response.destroy(); reject(new Error('response too large')); } else chunks.push(chunk);
        });
        response.on('end', () => resolve(new Response([204, 304].includes(response.statusCode) ? null : Buffer.concat(chunks), { status: response.statusCode ?? 502 })));
        response.on('error', reject);
      });
      outgoing.on('error', reject);
      outgoing.end();
    });
  };
}

/** Runs the host AppRole helper. The client token only travels through the stdout pipe. */
export function acquireAppRoleToken(approle, { env, timeoutMs }) {
  const helper = env.AIWG_OPENBAO_TOKEN_HELPER;
  if (typeof helper !== 'string' || !isAbsolute(helper)) return Promise.reject(new JevResolverError('configuration'));
  return new Promise((resolve, reject) => {
    execFile('bash', [helper, 'approle', approle], { env, timeout: timeoutMs, maxBuffer: 4096, encoding: 'utf8', windowsHide: true },
      (error, stdout) => error ? reject(new JevResolverError('login')) : resolve(String(stdout).trim()));
  });
}

function baoOrigin(value) {
  let url;
  try { url = new URL(String(value ?? '')); } catch { throw new JevResolverError('configuration'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new JevResolverError('configuration');
  }
  return url.origin;
}

/**
 * Builds an isolated resolver. Tests inject `acquireToken` and `fetch`; production uses the
 * host helper and the global fetch. The key is cached in memory for one runner process so each
 * request does not repeat an AppRole login; every call returns a fresh copy the caller may zero.
 */
export function createJevCredentialResolver({ env = process.env, acquireToken = acquireAppRoleToken,
  fetch: fetchImpl = verifiedHttpsFetch(env), timeoutMs = 15_000 } = {}) {
  let cached = null;
  let pending = null;

  const revoke = async (origin, token) => {
    // Best effort: the AppRole token is short-lived either way, and revocation failure is not fatal.
    try {
      const revoked = await fetchImpl(`${origin}/v1/auth/token/revoke-self`, { method: 'POST', headers: { 'x-vault-token': token }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      await revoked.body?.cancel();
    } catch { /* ignored */ }
  };

  async function load(reference, approle) {
    assertTlsVerification(env);
    const origin = baoOrigin(env.BAO_ADDR);
    const secretPath = env.AIWG_JEV_OPENBAO_SECRET_PATH;
    if (typeof secretPath !== 'string' || !SECRET_PATH.test(secretPath)) throw new JevResolverError('configuration');
    let token;
    try { token = await acquireToken(approle, { env, timeoutMs }); } catch { throw new JevResolverError('login'); }
    if (typeof token !== 'string' || !CLIENT_TOKEN.test(token)) {
      // Unexpected helper output may still carry a live token; revoke every token-shaped word, then fail.
      const candidates = typeof token === 'string' ? token.split(/\s+/).filter(word => CLIENT_TOKEN.test(word)).slice(0, 4) : [];
      for (const candidate of candidates) await revoke(origin, candidate);
      throw new JevResolverError('login');
    }
    const headers = { 'x-vault-token': token };
    try {
      let body;
      try {
        const response = await fetchImpl(`${origin}/v1/${secretPath}`, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) { await response.body?.cancel(); throw new Error('status'); }
        body = await response.json();
      } catch { throw new JevResolverError('read'); }
      const value = body?.data?.data?.[FIELD];
      if (typeof value !== 'string' || !CREDENTIAL.test(value)) throw new JevResolverError('shape');
      cached = { reference, bytes: new TextEncoder().encode(value) };
    } finally { await revoke(origin, token); }
  }

  return {
    async resolveCredential(reference) {
      const match = typeof reference === 'string' ? REFERENCE.exec(reference) : null;
      if (!match || cached && cached.reference !== reference) throw new JevResolverError('reference');
      if (!cached) {
        pending ??= load(reference, match[1]).finally(() => { pending = null; });
        await pending;
        if (!cached || cached.reference !== reference) throw new JevResolverError('reference');
      }
      return cached.bytes.slice();
    },
    /** Zeroes and drops the in-memory key. */
    dispose() { cached?.bytes.fill(0); cached = null; },
    toJSON() { return { resolver: 'openbao-approle-jev', cached: cached !== null }; },
  };
}

let defaultResolver = null;
/** Runner interface: `async resolveCredential(logicalReference) => Uint8Array`. */
export async function resolveCredential(reference) {
  defaultResolver ??= createJevCredentialResolver();
  return defaultResolver.resolveCredential(reference);
}
/** Runner interface: zeroes and drops the in-memory key at the end of a run. */
export function dispose() {
  defaultResolver?.dispose();
  defaultResolver = null;
}
