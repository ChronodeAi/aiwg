import { describe, expect, it } from 'vitest';
import { isDesktopUuid, sanitizeDesktopProblem, sanitizeDesktopResponse, validateDesktopRequest } from '../../apps/cockpit/bridge/src/desktop-contract.mjs';
const id = '12345678-1234-1234-1234-123456789abc';
const viewport = { width: 1280, height: 720, dpi: 96 };
const policy = { observe: false, control: true, sharing: false, clipboard_copy: false, clipboard_paste: false, file_transfer: false, audio: false, recording: false, isolation_tier: 'separate_desktop_vm', generation: 1 };
const capability = { schema_version: 'rdp-cockpit.v1', supported: true, readiness: 'ready', reason_codes: [], instance_id: id, incarnation: 'boot-123', policy };
const desktop = { schema_version: 'rdp-cockpit.v1', id, instance_id: id, incarnation: 'boot-123', workspace_id: 'org.workspace-1', state: 'ready', cleanup: 'none', policy, absolute_expires_at: '2026-09-15T12:00:00Z', retained_until: null };
const grant = { attachment_id: id, desktop_id: id, grant: 'a'.repeat(32), expires_at: '2026-09-15T12:00:00Z', policy_generation: 1 };
const invalidRequest = (fn) => expect(fn).toThrow(expect.objectContaining({ code: 'desktop_invalid_request', message: 'Invalid desktop request' }));
const invalidResponse = (fn) => expect(fn).toThrow(expect.objectContaining({ code: 'desktop_invalid_response', message: 'Invalid desktop response' }));
describe('desktop request boundary', () => {
  it.each([['CreateDesktop', { viewport, requested_mode: 'control' }], ['AttachmentRequest', { viewport, mode: 'observe' }], ['CloseRequest', { action: 'sign_out' }]])('validates %s and rejects actor/grant/extra keys', (kind, body) => {
    expect(validateDesktopRequest(kind, body)).toEqual(body);
    for (const key of ['actor', 'workspace_id', 'grant', 'constructor']) invalidRequest(() => validateDesktopRequest(kind, { ...body, [key]: 'untrusted' }));
    for (const key of Object.keys(body)) { const partial = { ...body }; delete partial[key]; invalidRequest(() => validateDesktopRequest(kind, partial)); }
  });
  it.each([{ width: 639 }, { width: 3841 }, { width: 640.5 }, { height: 479 }, { height: 2161 }, { dpi: 71 }, { dpi: 241 }, { dpi: '96' }, { width: Infinity }, { password: 'sensitive' }])('rejects viewport %j', (change) => {
    invalidRequest(() => validateDesktopRequest('CreateDesktop', { requested_mode: 'control', viewport: { ...viewport, ...change } }));
  });
  it('accepts viewport endpoints and rejects wrong object types/kinds/modes', () => {
    for (const bounds of [{ width: 640, height: 480, dpi: 72 }, { width: 3840, height: 2160, dpi: 240 }]) expect(validateDesktopRequest('AttachmentRequest', { mode: 'control', viewport: bounds }).viewport).toEqual(bounds);
    for (const body of [null, [], 42, Object.create({ action: 'sign_out' })]) invalidRequest(() => validateDesktopRequest('CloseRequest', body));
    invalidRequest(() => validateDesktopRequest('unknown', {}));
    invalidRequest(() => validateDesktopRequest('CreateDesktop', { viewport, requested_mode: 'admin' }));
    invalidRequest(() => validateDesktopRequest('CloseRequest', { action: 'shutdown_vm' }));
  });
});
describe('desktop response boundary', () => {
  it.each([['Capability', capability], ['Desktop', desktop], ['BackendAttachmentGrant', grant]])('whitelists %s and requires every field', (kind, body) => {
    expect(sanitizeDesktopResponse(kind, { ...body, password: 'private', target: 'private', trace_id: 'private', ...(body.policy ? { policy: { ...policy, credential: 'private' } } : {}) })).toEqual(body);
    for (const key of Object.keys(body)) { const partial = { ...body }; delete partial[key]; invalidResponse(() => sanitizeDesktopResponse(kind, partial)); }
    invalidResponse(() => sanitizeDesktopResponse(kind, null));
  });
  it('constructs fresh nested policy and reason objects', () => {
    const result = sanitizeDesktopResponse('Capability', capability);
    result.policy.control = false; result.reason_codes.push('unknown');
    expect(policy.control).toBe(true); expect(capability.reason_codes).toEqual([]);
  });
  it.each([{ schema_version: 'other' }, { instance_id: 'not-uuid' }, { incarnation: '' }, { incarnation: 'x'.repeat(129) }, { incarnation: 'Bearer secret' }, { incarnation: 'https://internal' }, { supported: 1 }, { readiness: 'live' }, { reason_codes: ['token=secret'] }, { reason_codes: Array(33).fill('unknown') }, { reason_codes: 'not-array' }])('rejects capability %j', (change) => invalidResponse(() => sanitizeDesktopResponse('Capability', { ...capability, ...change })));
  it('never reflects unknown reason strings', () => {
    expect(sanitizeDesktopResponse('Capability', { ...capability, reason_codes: ['desktop_not_ready', 'unreviewed_secret', 'another_unknown'] }).reason_codes).toEqual(['desktop_not_ready', 'unknown']);
  });
  it.each([{ id: 'bad' }, { workspace_id: '' }, { workspace_id: 'x\nsecret' }, { state: 'invented' }, { cleanup: 'invented' }, { retained_until: false }])('rejects desktop %j', (change) => invalidResponse(() => sanitizeDesktopResponse('Desktop', { ...desktop, ...change })));
  it.each(['2026-02-30T00:00:00Z', '2025-02-29T00:00:00Z', '2026-09-15', '2026-09-15T24:00:00Z', '2026-09-15T00:61:00Z', '2026-09-15T00:00:61Z', '2026-09-15T00:00:00+24:00', '2026-09-15T00:00:00+01:60', 'x'.repeat(41), null])('rejects malformed timestamp %j', (stamp) => invalidResponse(() => sanitizeDesktopResponse('Desktop', { ...desktop, absolute_expires_at: stamp })));
  it('accepts valid leap dates, offsets and fractional seconds', () => {
    const retained_until = '2028-02-29T23:59:59.123456789+01:30';
    expect(sanitizeDesktopResponse('Desktop', { ...desktop, retained_until }).retained_until).toBe(retained_until);
  });
  it('validates every policy field', () => {
    for (const key of Object.keys(policy)) { const partial = { ...policy }; delete partial[key]; invalidResponse(() => sanitizeDesktopResponse('Capability', { ...capability, policy: partial })); }
    for (const change of [{ observe: 'false' }, { generation: 0 }, { generation: Number.MAX_SAFE_INTEGER + 1 }, { isolation_tier: 'shared' }]) invalidResponse(() => sanitizeDesktopResponse('Capability', { ...capability, policy: { ...policy, ...change } }));
  });
  it.each([{ attachment_id: 'bad' }, { desktop_id: null }, { grant: 'a'.repeat(31) }, { grant: 'a'.repeat(4097) }, { grant: 'a'.repeat(31) + '\n' }, { grant: {} }, { policy_generation: 0 }])('rejects invalid backend grant %j', (change) => invalidResponse(() => sanitizeDesktopResponse('BackendAttachmentGrant', { ...grant, ...change })));
  it('validates UUID and refuses unknown response kinds', () => {
    expect(isDesktopUuid(id.toUpperCase())).toBe(true);
    for (const value of [null, `${id}/`, `${id}\n`, 1]) expect(isDesktopUuid(value)).toBe(false);
    invalidResponse(() => sanitizeDesktopResponse('unknown', {}));
  });
});
describe('safe desktop problems', () => {
  it.each(['desktop_not_supported', 'desktop_not_ready', 'access_denied', 'control_conflict', 'grant_expired', 'stale_instance', 'route_unavailable', 'credentials_unavailable', 'upstream_certificate_invalid', 'quota_exceeded', 'desktop_session_ended', 'cleanup_pending', 'idempotency_conflict'])('maps %s without echoing upstream material', (code) => {
    const result = sanitizeDesktopProblem({ code, status: 200, title: 'private', message: 'private', trace_id: 'private', type: 'https://private' });
    expect(result.code).toBe(code); expect(result.status).toBeGreaterThanOrEqual(400);
    expect(Object.keys(result)).toEqual(['code', 'status', 'message']); expect(JSON.stringify(result)).not.toContain('private');
  });
  it.each([null, [], {}, { code: 'secret' }, { code: '__proto__' }, { code: 403 }])('rejects unknown problem %j', (value) => invalidResponse(() => sanitizeDesktopProblem(value)));
});
