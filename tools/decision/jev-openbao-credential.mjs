/**
 * Trusted Jev credential resolver for the D12 live runner (#2686). The approval pins this file
 * by SHA-256, so any edit needs a new approval.
 *
 * It logs in as the scoped `aiwg-jev-reader` AppRole through the itops OpenBao helper, reads the
 * Jev key from the vaulted secret's `token` field over verified TLS, and then revokes its own
 * vault token. Errors carry a fixed category only: never the key, the secret path, the vault
 * token or any helper, secret-service or network message. Nothing runs at import time.
 *
 * This deliberately mirrors the TV-12 resolver proposed in #2770
 * (tools/decision/jev-credential-resolver.mjs); that file is not on main, and its logical
 * reference format differs from the DecisionBinding credentialRef this runner pins, so the
 * duplication stays until one shared resolver lands.
 *
 * Host configuration (read at call time):
 * - `BAO_ADDR`: HTTPS OpenBao origin (default https://rca-g2.s9.internal:8200).
 * - `BAO_CACERT`: optional PEM file for an internal CA. Verification is always on;
 *   `NODE_TLS_REJECT_UNAUTHORIZED=0` is refused.
 * - `AIWG_OPENBAO_TOKEN_HELPER`: optional absolute helper path
 *   (default ~/dev/itops/scripts/lib/openbao-token.sh), invoked as `bash HELPER approle NAME`.
 * - `AIWG_JEV_OPENBAO_SECRET_PATH`: optional KV v2 locator (default kv_internal/data/typesafe/jev/api-key).
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** Logical DecisionBinding credentialRef; only this resolver maps it to the OpenBao secret. */
export const JEV_SECRET_REFERENCE = 'openbao.typesafe.jev.api-key';
const APPROLE = 'aiwg-jev-reader';
const FIELD = 'token';
const DEFAULT_SECRET_PATH = 'kv_internal/data/typesafe/jev/api-key';
const SECRET_PATH = /^[a-z0-9_-]+\/data\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;
const CLIENT_TOKEN = /^[A-Za-z0-9._-]{8,512}$/;
const CREDENTIAL = /^[\x21-\x7e]{1,4096}$/;

/** Fixed categories only; the message never embeds secret or diagnostic text. */
export class JevResolverError extends Error {
  constructor(category) {
    super(`Jev credential resolution failed (${category})`);
    this.name = 'JevResolverError';
    this.category = category;
  }
}

/** Runs the host AppRole helper; the client token only travels through the stdout pipe. */
function acquireAppRoleToken(approle, { env, timeoutMs }) {
  const helper = env.AIWG_OPENBAO_TOKEN_HELPER ?? join(homedir(), 'dev/itops/scripts/lib/openbao-token.sh');
  if (typeof helper !== 'string' || !isAbsolute(helper)) return Promise.reject(new JevResolverError('configuration'));
  return new Promise((resolve, reject) => {
    execFile('bash', [helper, 'approle', approle], { env, timeout: timeoutMs, maxBuffer: 4096, encoding: 'utf8', windowsHide: true },
      (error, stdout) => error ? reject(new JevResolverError('login')) : resolve(String(stdout).trim()));
  });
}

/** Minimal HTTPS request with certificate verification always enabled. */
function verifiedRequest(url, options) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { ...options, rejectUnauthorized: true }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 65_536) request.destroy(new Error('too large')); else chunks.push(chunk); });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }));
      response.on('error', () => reject(new Error('response')));
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', () => reject(new Error('request')));
    request.end();
  });
}

function baoOrigin(value) {
  let url;
  try { url = new URL(String(value ?? 'https://rca-g2.s9.internal:8200')); } catch { throw new JevResolverError('configuration'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new JevResolverError('configuration');
  }
  return url.origin;
}

/** Builds a resolver. Tests inject `acquireToken` and `request`; production uses the helper and Node HTTPS. */
export function createOpenBaoJevResolver({ env = process.env, acquireToken = acquireAppRoleToken, request = verifiedRequest, timeoutMs = 15_000 } = {}) {
  return async function resolveCredential(reference) {
    if (reference !== JEV_SECRET_REFERENCE) throw new JevResolverError('reference');
    if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new JevResolverError('configuration');
    const origin = baoOrigin(env.BAO_ADDR);
    const secretPath = env.AIWG_JEV_OPENBAO_SECRET_PATH ?? DEFAULT_SECRET_PATH;
    if (!SECRET_PATH.test(secretPath)) throw new JevResolverError('configuration');
    let ca;
    try { ca = env.BAO_CACERT ? readFileSync(env.BAO_CACERT) : undefined; } catch { throw new JevResolverError('configuration'); }
    let token;
    try { token = await acquireToken(APPROLE, { env, timeoutMs }); } catch { throw new JevResolverError('login'); }
    if (typeof token !== 'string' || !CLIENT_TOKEN.test(token)) throw new JevResolverError('login');
    const options = method => ({ method, headers: { 'x-vault-token': token }, timeout: timeoutMs, rejectUnauthorized: true, ...(ca ? { ca } : {}) });
    let body;
    try {
      let response;
      try { response = await request(`${origin}/v1/${secretPath}`, options('GET')); } catch { throw new JevResolverError('read'); }
      body = response?.body;
      if (response?.status !== 200 || !Buffer.isBuffer(body)) throw new JevResolverError('read');
      let value;
      try { value = JSON.parse(body.toString('utf8'))?.data?.data?.[FIELD]; } catch { throw new JevResolverError('shape'); }
      if (typeof value !== 'string' || !CREDENTIAL.test(value)) throw new JevResolverError('shape');
      return new TextEncoder().encode(value);
    } finally {
      body?.fill(0);
      // Best effort: the AppRole token is short-lived either way.
      try { await request(`${origin}/v1/auth/token/revoke-self`, options('POST')); } catch { /* ignored */ }
    }
  };
}

let defaultResolver = null;
/** Runner interface: `async resolveCredential(logicalReference) => Uint8Array`. */
export async function resolveCredential(reference) {
  defaultResolver ??= createOpenBaoJevResolver();
  return defaultResolver(reference);
}
