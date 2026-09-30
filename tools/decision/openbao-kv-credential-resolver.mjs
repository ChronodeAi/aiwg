/**
 * Never-logging OpenBao KV v2 credential resolver for the #2680 egress qualification.
 *
 * It maps logical references (for example `jev-api-scoped`) to host-only KV locators
 * from a private config file, authenticates once with a scoped AppRole token, and
 * performs only exact-path GET reads of KV data. It has no list, metadata or KV write
 * operation, so it cannot enumerate; its only other call revokes its own token on dispose. Errors carry a `category` only; values, tokens, locators and
 * response bodies never appear in errors or in the sanitized audit.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';

export class CredentialResolutionError extends Error {
  constructor(category) {
    super('credential resolution failed');
    this.name = 'CredentialResolutionError';
    this.category = category;
  }
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const REF = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_BODY_BYTES = 64 * 1024;

/** Validates the host-only config. It holds locators, never secret values. */
export function validateResolverConfig(config) {
  const fail = () => { throw new CredentialResolutionError('configuration'); };
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail();
  const allowed = ['schemaVersion', 'addr', 'caFile', 'appRole', 'tokenScript', 'mount', 'refs'];
  if (Object.keys(config).some(key => !allowed.includes(key)) || config.schemaVersion !== 'openbao-kv-resolver-config/v1') fail();
  let addr;
  try { addr = new URL(config.addr); } catch { fail(); }
  if (addr.protocol !== 'https:' || addr.username || addr.password || addr.search || addr.hash || addr.pathname !== '/') fail();
  if (config.caFile !== undefined && (typeof config.caFile !== 'string' || !config.caFile.startsWith('/'))) fail();
  if (!SEGMENT.test(config.appRole ?? '') || typeof config.tokenScript !== 'string' || !config.tokenScript.startsWith('/') || !SEGMENT.test(config.mount ?? '')) fail();
  if (!config.refs || typeof config.refs !== 'object' || Array.isArray(config.refs) || !Object.keys(config.refs).length) fail();
  for (const [ref, target] of Object.entries(config.refs)) {
    if (!REF.test(ref) || !target || typeof target !== 'object' || Object.keys(target).some(key => !['path', 'field'].includes(key))) fail();
    if (typeof target.path !== 'string' || !target.path.split('/').every(part => SEGMENT.test(part))) fail();
    if (target.field !== undefined && !SEGMENT.test(target.field)) fail();
  }
  return config;
}

/** Runs the host token helper. Only stdout is read; stderr is discarded, never logged. */
export function appRoleTokenProvider(config) {
  return () => new Promise((resolve, reject) => {
    execFile('bash', [config.tokenScript, 'approle', config.appRole], { timeout: 15_000, maxBuffer: 16 * 1024, encoding: 'utf8', windowsHide: true },
      (error, stdout) => {
        const token = typeof stdout === 'string' ? stdout.trim() : '';
        if (error || !token || /\s/.test(token)) reject(new CredentialResolutionError('failed'));
        else resolve(token);
      });
  });
}

/** Certificate verification is always explicit; a CA file may only add trust, never disable it. */
export function httpsRequestOptions(method, headers, ca) {
  return { method, headers, timeout: 10_000, rejectUnauthorized: true, ...(ca ? { ca } : {}) };
}

const assertTlsVerification = () => {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new CredentialResolutionError('configuration');
};

/** Minimal HTTPS request with bounded body and timeout. Returns status and parsed JSON (or null). */
export function httpsGetJson(config) {
  let ca;
  return async (url, headers, method = 'GET') => {
    assertTlsVerification();
    if (config.caFile && ca === undefined) ca = await readFile(config.caFile);
    return new Promise((resolve, reject) => {
      const req = httpsRequest(url, httpsRequestOptions(method, headers, ca), response => {
        const chunks = []; let size = 0;
        response.on('data', chunk => { size += chunk.length; if (size > MAX_BODY_BYTES) { req.destroy(); reject(new CredentialResolutionError('failed')); } else chunks.push(chunk); });
        response.on('end', () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = null; }
          resolve({ status: response.statusCode ?? 0, json });
        });
        response.on('error', () => reject(new CredentialResolutionError('failed')));
      });
      req.on('timeout', () => { req.destroy(); reject(new CredentialResolutionError('failed')); });
      req.on('error', () => reject(new CredentialResolutionError('failed')));
      req.end();
    });
  };
}

/**
 * Creates the resolver. `tokenProvider` and `request` are injectable for offline tests.
 * Granted values are cached per logical ref for the run and zeroed by `dispose()`.
 */
export function createOpenBaoKvResolver(rawConfig, seams = {}) {
  // Refuse a process that has disabled TLS verification globally, even with an injected request seam.
  assertTlsVerification();
  const config = validateResolverConfig(rawConfig);
  const tokenProvider = seams.tokenProvider ?? appRoleTokenProvider(config);
  const request = seams.request ?? httpsGetJson(config);
  const entries = [];
  const cache = new Map();
  let token;
  let disposed = false;
  let seq = 0;
  const record = (op, ref, outcome, httpStatus) => { entries.push({ seq: ++seq, op, ref, outcome, httpStatus }); };
  const login = () => {
    token ??= tokenProvider().then(value => { record('login', null, 'granted', null); return value; },
      () => { record('login', null, 'failed', null); throw new CredentialResolutionError('failed'); });
    return token;
  };
  return {
    async resolveCredential(ref) {
      if (disposed) throw new CredentialResolutionError('failed');
      const target = typeof ref === 'string' && REF.test(ref) ? config.refs[ref] : undefined;
      if (!target || !Object.hasOwn(config.refs, ref)) { record('read', REF.test(String(ref)) ? ref : 'invalid-ref', 'configuration', null); throw new CredentialResolutionError('configuration'); }
      if (cache.has(ref)) return new Uint8Array(cache.get(ref));
      const value = await login();
      const url = new URL(`/v1/${config.mount}/data/${target.path}`, config.addr);
      let response;
      try { response = await request(url, { 'X-Vault-Token': value, accept: 'application/json' }); }
      catch { record('read', ref, 'failed', null); throw new CredentialResolutionError('failed'); }
      const status = response?.status ?? 0;
      if (status === 403) { record('read', ref, 'denied', status); throw new CredentialResolutionError('denied'); }
      if (status === 404) { record('read', ref, 'missing', status); throw new CredentialResolutionError('missing'); }
      const data = status === 200 ? response.json?.data?.data : undefined;
      const keys = data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data) : [];
      const field = target.field ?? (keys.length === 1 ? keys[0] : undefined);
      const secret = field !== undefined && data ? data[field] : undefined;
      if (typeof secret !== 'string' || !secret) { record('read', ref, status === 200 ? 'configuration' : 'failed', status); throw new CredentialResolutionError(status === 200 ? 'configuration' : 'failed'); }
      record('read', ref, 'granted', status);
      const bytes = new TextEncoder().encode(secret);
      cache.set(ref, bytes);
      return new Uint8Array(bytes);
    },
    /** Sanitized: logical refs, operation, outcome and HTTP status only. */
    audit: () => entries.map(entry => ({ ...entry })),
    /** Zeroes cached values and revokes the AppRole token itself. Revocation failure is recorded, never thrown. */
    async dispose() {
      disposed = true;
      for (const bytes of cache.values()) bytes.fill(0);
      cache.clear();
      const pending = token; token = undefined;
      if (!pending) return;
      let value;
      try { value = await pending; } catch { return; }
      try {
        const response = await request(new URL('/v1/auth/token/revoke-self', config.addr), { 'X-Vault-Token': value }, 'POST');
        const status = response?.status ?? 0;
        record('revoke', null, status === 204 || status === 200 ? 'revoked' : 'failed', status);
      } catch { record('revoke', null, 'failed', null); }
    },
  };
}
