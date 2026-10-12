import https from 'node:https';
import { createSecureContext } from 'node:tls';
import { isDesktopUuid, sanitizeDesktopProblem, sanitizeDesktopResponse, validateDesktopRequest } from './desktop-contract.mjs';

const fail = (code, status = 502) => Object.assign(new Error(code), { code, status });
const operations = {
  capability: { method: 'GET', path: (id) => `/api/v2/instances/${id}/desktop-capability`, response: 'Capability', status: 200 },
  create: { method: 'POST', path: (id) => `/api/v2/instances/${id}/desktop-sessions`, request: 'CreateDesktop', response: 'Desktop', status: 202 },
  get: { method: 'GET', path: (id) => `/api/v2/desktop-sessions/${id}`, response: 'Desktop', status: 200 },
  attach: { method: 'POST', path: (id) => `/api/v2/desktop-sessions/${id}/attachments`, request: 'AttachmentRequest', response: 'BackendAttachmentGrant', status: 201 },
  detach: { method: 'DELETE', path: (id) => `/api/v2/desktop-attachments/${id}`, status: 204 },
  close: { method: 'POST', path: (id) => `/api/v2/desktop-sessions/${id}/close`, request: 'CloseRequest', response: 'Desktop', status: 202 },
};

/** Dedicated desktop control connection. The client certificate authenticates
 * the Bridge workload; Authorization carries the freshly verified user delegation.
 * The gateway must verify BOTH. No operator credential file or generic proxy is
 * consulted. The attachment grant returned by `attach` is backend-only.
 */
export function createDesktopBackend({ url, tls, timeoutMs = 5000, maxConcurrent = 32, maxResponseBytes = 65536 } = {}) {
  let endpoint;
  try { endpoint = new URL(url); } catch { throw new TypeError('Desktop HTTPS endpoint required'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
    throw new TypeError('Desktop endpoint must be an HTTPS origin');
  }
  if (!tls?.ca || !tls?.cert || !tls?.key) throw new TypeError('Desktop workload certificate, key and server CA required');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 ||
      !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 128 ||
      !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 1048576) throw new TypeError('Invalid desktop transport limits');
  // Whitelist TLS options: callers cannot disable peer or hostname verification.
  let secureContext;
  try { secureContext = createSecureContext({ ca: tls.ca, cert: tls.cert, key: tls.key, minVersion: 'TLSv1.2' }); }
  catch { throw new TypeError('Invalid desktop TLS configuration'); }
  const agent = new https.Agent({ keepAlive: true, maxSockets: maxConcurrent, secureContext, rejectUnauthorized: true });
  const active = new Set();
  let closed = false;

  async function request({ operation, id, delegation, body, idempotencyKey, signal } = {}) {
    const spec = Object.hasOwn(operations, operation) ? operations[operation] : undefined;
    if (!spec || !isDesktopUuid(id) || typeof delegation !== 'string' || !/^[\x21-\x7e]{1,16384}$/.test(delegation)) throw fail('desktop_invalid_request', 400);
    if (closed || signal?.aborted) throw fail('desktop_backend_unavailable', 503);
    if (active.size >= maxConcurrent) throw fail('quota_exceeded', 429);
    let payload;
    if (spec.request) payload = JSON.stringify(validateDesktopRequest(spec.request, body));
    else if (body !== undefined) throw fail('desktop_invalid_request', 400);
    if (operation === 'create' && (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey))) throw fail('desktop_invalid_request', 400);
    const headers = { authorization: `Bearer ${delegation}`, accept: 'application/json, application/problem+json' };
    if (payload) Object.assign(headers, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    if (operation === 'create') headers['idempotency-key'] = idempotencyKey;
    const result = await new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const abort = () => finish(fail('desktop_backend_unavailable', 503));
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        active.delete(req);
        if (error) { req.destroy(); reject(error); }
        else resolve(value);
      };
      const req = https.request(new URL(spec.path(id), endpoint), { method: spec.method, agent, headers }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxResponseBytes) finish(fail('desktop_invalid_response'));
          else chunks.push(chunk);
        });
        res.on('aborted', () => finish(fail('desktop_backend_unavailable', 503)));
        res.on('error', () => finish(fail('desktop_backend_unavailable', 503)));
        res.on('end', () => finish(null, { status: res.statusCode, contentType: res.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') }));
      });
      active.add(req);
      req.on('error', (err) => finish(fail(/CERT|TLS|SELF_SIGNED|ISSUER|VERIFY/.test(err.code ?? '') ? 'upstream_certificate_invalid' : 'desktop_backend_unavailable', 503)));
      timer = setTimeout(() => finish(fail('desktop_backend_timeout', 504)), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else req.end(payload);
    });
    if (operation === 'capability' && [404, 501].includes(result.status)) return Object.freeze({ state: 'unsupported', reason: 'desktop_not_supported' });
    if (result.status === 204 && !spec.response && !result.body) return undefined;
    if (!/^application\/(?:json|problem\+json)(?:\s*;|$)/i.test(result.contentType ?? '')) throw fail('desktop_invalid_response');
    let value;
    try { value = JSON.parse(result.body); } catch { throw fail('desktop_invalid_response'); }
    if (result.status >= 400) {
      const problem = sanitizeDesktopProblem(value);
      throw fail(problem.code, problem.status);
    }
    if (result.status !== spec.status) throw fail('desktop_invalid_response');
    const clean = sanitizeDesktopResponse(spec.response, value);
    const returnedId = ['capability', 'create'].includes(operation) ? clean.instance_id : operation === 'attach' ? clean.desktop_id : clean.id;
    if (returnedId?.toLowerCase() !== id.toLowerCase()) throw fail('desktop_invalid_response');
    return clean;
  }
  return Object.freeze({ request, close() {
    closed = true;
    for (const req of active) req.destroy(fail('desktop_backend_unavailable', 503));
    agent.destroy();
  } });
}
