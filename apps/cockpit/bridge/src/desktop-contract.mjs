// Boundary validation for the proposed rdp-cockpit.v1 contract. This module does
// not imply that the executor implements that API or that runtime UAT has passed.
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const fail = (request = false) => { throw Object.assign(new Error(request ? 'Invalid desktop request' : 'Invalid desktop response'), { code: request ? 'desktop_invalid_request' : 'desktop_invalid_response' }); };
const integer = (v, min, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= min && v <= max;
const identifier = (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
export const isDesktopUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const fields = (value, keys, request = false) => {
  if (!record(value) || keys.some((key) => !own(value, key)) || (request && Reflect.ownKeys(value).some((key) => !keys.includes(key)))) fail(request);
};
const member = (v, values, request = false) => { if (!values.includes(v)) fail(request); return v; };
const mode = (v, request) => member(v, ['control', 'observe'], request);
function viewport(value) {
  fields(value, ['width', 'height', 'dpi'], true);
  if (!integer(value.width, 640, 3840) || !integer(value.height, 480, 2160) || !integer(value.dpi, 72, 240)) fail(true);
  return { width: value.width, height: value.height, dpi: value.dpi };
}
export function validateDesktopRequest(kind, value) {
  if (kind === 'CloseRequest') {
    fields(value, ['action'], true);
    return { action: member(value.action, ['revoke_access', 'sign_out'], true) };
  }
  if (!['CreateDesktop', 'AttachmentRequest'].includes(kind)) fail(true);
  const key = kind === 'CreateDesktop' ? 'requested_mode' : 'mode';
  fields(value, ['viewport', key], true);
  return { [key]: mode(value[key], true), viewport: viewport(value.viewport) };
}
const booleans = ['observe', 'control', 'sharing', 'clipboard_copy', 'clipboard_paste', 'file_transfer', 'audio', 'recording'];
function policy(value) {
  fields(value, [...booleans, 'isolation_tier', 'generation']);
  if (booleans.some((key) => typeof value[key] !== 'boolean') || !integer(value.generation, 1)) fail();
  return { ...Object.fromEntries(booleans.map((key) => [key, value[key]])), isolation_tier: member(value.isolation_tier, ['cooperative', 'separate_desktop_vm']), generation: value.generation };
}
function timestamp(value) {
  if (typeof value !== 'string' || value.length > 40) fail();
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/);
  if (!match) fail();
  const [, y, m, d, h, minute, second, , oh, om] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || Number(h) > 23 || Number(minute) > 59 || Number(second) > 59 || Number(oh ?? 0) > 23 || Number(om ?? 0) > 59 || !Number.isFinite(Date.parse(value))) fail();
  return value;
}
const PROBLEMS = Object.freeze({
  desktop_not_supported: [501, 'Desktop access is not supported.'],
  desktop_not_ready: [409, 'The desktop is not ready.'],
  access_denied: [403, 'Desktop access denied.'],
  control_conflict: [409, 'Another controller owns the desktop.'],
  grant_expired: [410, 'Desktop admission expired. Reconnect to request new admission.'],
  stale_instance: [409, 'The instance changed. Refresh before reconnecting.'],
  route_unavailable: [503, 'The desktop route is unavailable.'],
  credentials_unavailable: [503, 'Desktop credentials are unavailable.'],
  upstream_certificate_invalid: [502, 'The desktop certificate could not be verified.'],
  quota_exceeded: [429, 'The desktop capacity limit was reached.'],
  desktop_session_ended: [410, 'The guest desktop session ended.'],
  cleanup_pending: [409, 'Desktop cleanup is pending.'],
  idempotency_conflict: [409, 'The request identifier was already used for a different request.'],
});
export function sanitizeDesktopProblem(value) {
  if (!record(value) || typeof value.code !== 'string' || !own(PROBLEMS, value.code)) fail();
  const [status, message] = PROBLEMS[value.code];
  return { code: value.code, status, message };
}
function reasons(value) {
  if (!Array.isArray(value) || value.length > 32 || value.some((code) => typeof code !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(code))) fail();
  // The draft leaves reason strings open. Never reflect unknown diagnostics;
  // callers get a stable unknown reason until that code is explicitly reviewed.
  return [...new Set(value.map((code) => own(PROBLEMS, code) || ['unknown', 'not_ready', 'unsupported'].includes(code) ? code : 'unknown'))];
}
/** Returns whitelisted protocol fields. BackendAttachmentGrant intentionally
 * retains its opaque grant for BACKEND CONSUMPTION ONLY. Never serialize that
 * result to a browser, URL, log, or persistent store. */
export function sanitizeDesktopResponse(kind, value) {
  if (kind === 'BackendAttachmentGrant') {
    fields(value, ['attachment_id', 'desktop_id', 'grant', 'expires_at', 'policy_generation']);
    if (!isDesktopUuid(value.attachment_id) || !isDesktopUuid(value.desktop_id) || !integer(value.policy_generation, 1) || typeof value.grant !== 'string' || !/^[A-Za-z0-9._~+/-]{32,4096}={0,2}$/.test(value.grant) || value.grant.length > 4096) fail();
    return { attachment_id: value.attachment_id, desktop_id: value.desktop_id, grant: value.grant, expires_at: timestamp(value.expires_at), policy_generation: value.policy_generation };
  }
  if (!['Capability', 'Desktop'].includes(kind)) fail();
  const shared = ['schema_version', 'instance_id', 'incarnation', 'policy'];
  fields(value, [...shared, ...(kind === 'Capability' ? ['supported', 'readiness', 'reason_codes'] : ['id', 'workspace_id', 'state', 'cleanup', 'absolute_expires_at', 'retained_until'])]);
  if (value.schema_version !== 'rdp-cockpit.v1' || !isDesktopUuid(value.instance_id) || !identifier(value.incarnation)) fail();
  const common = { schema_version: value.schema_version, instance_id: value.instance_id, incarnation: value.incarnation, policy: policy(value.policy) };
  if (kind === 'Capability') {
    if (typeof value.supported !== 'boolean') fail();
    return { ...common, supported: value.supported, readiness: member(value.readiness, ['ready', 'not_ready', 'unknown']), reason_codes: reasons(value.reason_codes) };
  }
  if (!isDesktopUuid(value.id) || !identifier(value.workspace_id)) fail();
  return { ...common, id: value.id, workspace_id: value.workspace_id,
    state: member(value.state, ['preparing', 'ready', 'attached', 'detached', 'closing', 'closed', 'failed']),
    cleanup: member(value.cleanup, ['none', 'pending', 'complete', 'failed']),
    absolute_expires_at: timestamp(value.absolute_expires_at), retained_until: value.retained_until === null ? null : timestamp(value.retained_until) };
}
