import { isDesktopUuid, sanitizeDesktopResponse, validateDesktopRequest } from './desktop-contract.mjs';

const failure = (code, status = 400) => Object.assign(new Error(code), { code, status });
const errors = new Set(['desktop_invalid_request', 'desktop_invalid_response', 'desktop_backend_unavailable', 'desktop_backend_timeout',
  'desktop_not_supported', 'desktop_not_ready', 'access_denied', 'control_conflict', 'grant_expired', 'stale_instance',
  'route_unavailable', 'credentials_unavailable', 'upstream_certificate_invalid', 'quota_exceeded', 'desktop_session_ended', 'cleanup_pending', 'idempotency_conflict']);

async function readBody(req, signal) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw failure('desktop_invalid_request');
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const clean = () => { req.removeListener('data', data); req.removeListener('end', end); req.removeListener('error', abort); signal.removeEventListener('abort', abort); };
    const abort = () => { clean(); reject(failure('desktop_invalid_request')); };
    const data = (chunk) => {
      size += chunk.length;
      if (size > 4096) abort();
      else chunks.push(chunk);
    };
    const end = () => {
      clean();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(failure('desktop_invalid_request')); }
    };
    req.on('data', data); req.on('end', end); req.on('error', abort);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Browser control API only. Attachment grants and display upgrades have a
 * separate backend-only lifecycle; this handler never exposes the attach call. */
export function createDesktopHttpHandler({ identity, backend, getAuth, validOrigin, validCsrf, json: writeJson }) {
  const pending = new Map();
  const unsubscribe = identity?.onInvalidate(({ browserSessionId }) => {
    for (const controller of pending.get(browserSessionId) ?? []) controller.abort();
  });
  async function handle(req, res, url) {
    if (url.pathname !== '/api/desktops' && !url.pathname.startsWith('/api/desktops/')) return false;
    const json = (response, status, value) => {
      if (status >= 400 && !req.complete) {
        response.setHeader('connection', 'close');
        response.once('finish', () => req.socket.destroySoon());
      }
      return writeJson(response, status, value);
    };
    res.setHeader('cache-control', 'no-store');
    const auth = getAuth(req);
    if (!auth) { json(res, 401, { error: 'unauthorized' }); return true; }
    if (!validOrigin(req, { allowSameOriginFetch: true })) { json(res, 403, { error: 'forbidden_origin' }); return true; }
    if (!validCsrf(req, auth)) { json(res, 403, { error: 'csrf_required' }); return true; }
    if (['GET', 'HEAD'].includes(req.method) && (req.headers['transfer-encoding'] || Number(req.headers['content-length']) > 0)) {
      json(res, 400, { error: 'desktop_invalid_request' }); return true;
    }
    const match = url.pathname.match(/^\/api\/desktops\/instances\/([^/]+)\/(capability|sessions)(?:\/([^/]+)(?:\/(close))?)?$/);
    if (!match || url.search || !isDesktopUuid(match[1]) || (match[3] && !isDesktopUuid(match[3]))) { json(res, 404, { error: 'not_found' }); return true; }
    const [, instanceId, resource, desktopId, suffix] = match;
    const operation = resource === 'capability' && !desktopId && req.method === 'GET' ? 'capability'
      : resource === 'sessions' && !desktopId && req.method === 'POST' ? 'create'
        : resource === 'sessions' && desktopId && !suffix && req.method === 'GET' ? 'get'
          : resource === 'sessions' && desktopId && suffix === 'close' && req.method === 'POST' ? 'close' : null;
    if (!operation) { json(res, 405, { error: 'method_not_allowed' }); return true; }
    if (!identity || !backend) { json(res, operation === 'capability' ? 200 : 503, { state: 'unsupported', reason: 'desktop_backend_not_configured' }); return true; }
    const controller = new AbortController();
    const requests = pending.get(auth.sessionId) ?? new Set();
    if (requests.size >= 8 || [...pending.values()].reduce((count, items) => count + items.size, 0) >= 64) {
      json(res, 429, { error: 'quota_exceeded' }); return true;
    }
    requests.add(controller); pending.set(auth.sessionId, requests);
    const abort = () => controller.abort();
    req.once('aborted', abort);
    res.once('close', abort);
    const timer = setTimeout(abort, 10000);
    try {
      const body = ['create', 'close'].includes(operation) ? await readBody(req, controller.signal) : undefined;
      if (['create', 'close'].includes(operation)) validateDesktopRequest(operation === 'create' ? 'CreateDesktop' : 'CloseRequest', body);
      const action = operation === 'close' ? (body?.action === 'sign_out' ? 'sign_out' : 'revoke_access') : operation === 'create' ? 'create' : 'view';
      const result = await identity.withDelegation(auth.sessionId, { action, instanceId }, async ({ delegation, identity: verified }) => {
        const value = await backend.request({ operation, id: desktopId ?? instanceId, body,
          idempotencyKey: req.headers['idempotency-key'], delegation, signal: controller.signal });
        if (controller.signal.aborted || getAuth(req)?.sessionId !== auth.sessionId) throw failure('access_denied', 403);
        if (value?.state === 'unsupported' && operation === 'capability') return { state: 'unsupported', reason: 'desktop_not_supported' };
        if (value?.instance_id?.toLowerCase() !== instanceId.toLowerCase() ||
            (desktopId && value?.id?.toLowerCase() !== desktopId.toLowerCase()) ||
            (operation !== 'capability' && value?.workspace_id !== verified.workspaceId)) throw failure('desktop_invalid_response', 502);
        return sanitizeDesktopResponse(operation === 'capability' ? 'Capability' : 'Desktop', value);
      });
      json(res, operation === 'create' || operation === 'close' ? 202 : 200, result);
    } catch (error) {
      const code = error?.code === 'denied' ? 'access_denied' : error?.code === 'identity_unavailable' ? 'desktop_backend_unavailable' : errors.has(error?.code) ? error.code : 'desktop_backend_unavailable';
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : code === 'desktop_invalid_request' ? 400 : 502;
      if (!res.destroyed) json(res, status, { error: code });
    } finally {
      clearTimeout(timer); req.removeListener('aborted', abort); res.removeListener('close', abort);
      requests.delete(controller);
      if (!requests.size) pending.delete(auth.sessionId);
    }
    return true;
  }
  return { handle, close() {
    unsubscribe?.();
    for (const requests of pending.values()) for (const controller of requests) controller.abort();
    pending.clear();
  } };
}
