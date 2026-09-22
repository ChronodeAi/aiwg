import { apiRaw } from './api';
import { isDesktopUuid, sanitizeDesktopResponse, validateDesktopRequest,
  type CreateDesktopRequest, type DesktopCloseRequest, type DesktopSession,
  type DesktopCapability } from '../../bridge/src/desktop-contract.mjs';

export type { CreateDesktopRequest, DesktopCloseRequest, DesktopSession,
  DesktopCapability, DesktopMode, DesktopViewport } from '../../bridge/src/desktop-contract.mjs';

export interface DesktopUnsupported {
  state: 'unsupported';
  reason: 'desktop_backend_not_configured' | 'desktop_not_supported';
}

const messages = {
  unauthorized: 'Sign in to Cockpit to connect to this desktop.',
  access_denied: 'You do not have access to this desktop.',
  desktop_not_supported: 'Desktop assistance is not available for this instance.',
  desktop_not_ready: 'The desktop is still getting ready.',
  control_conflict: 'Another participant currently controls this desktop.',
  stale_instance: 'This instance changed. Refresh before reconnecting.',
  desktop_session_ended: 'This desktop session has ended.',
  cleanup_pending: 'The desktop is still being cleaned up.',
  quota_exceeded: 'Desktop capacity is currently full. Try again later.',
  idempotency_conflict: 'This request identifier was already used. Refresh before trying again.',
  desktop_invalid_request: 'The desktop request is invalid.',
  desktop_invalid_response: 'The desktop service returned an invalid response.',
  unavailable: 'Desktop assistance is temporarily unavailable.',
} as const;
type DesktopErrorCode = keyof typeof messages;

export class DesktopApiError extends Error {
  constructor(readonly code: DesktopErrorCode, readonly status = 0) {
    super(messages[code]);
    this.name = 'DesktopApiError';
  }
}

function resource(instanceId: string, desktopId?: string): string {
  if (!isDesktopUuid(instanceId) || (desktopId !== undefined && !isDesktopUuid(desktopId))) {
    throw new DesktopApiError('desktop_invalid_request');
  }
  return `/api/desktops/instances/${instanceId}${desktopId === undefined ? '' : `/sessions/${desktopId}`}`;
}

async function request(path: string, init: RequestInit): Promise<unknown> {
  const response = await apiRaw(path, init);
  const value: unknown = await response.json().catch((error: unknown) => {
    if (init.signal?.aborted) throw init.signal.reason;
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return null;
  });
  if (!response.ok) {
    const rawCode = value && typeof value === 'object' && 'error' in value ? value.error : undefined;
    const code = typeof rawCode === 'string' && Object.hasOwn(messages, rawCode) ? rawCode as DesktopErrorCode : 'unavailable';
    // Server diagnostics and arbitrary error strings never reach the UI.
    throw new DesktopApiError(code, response.status);
  }
  return value;
}

function desktop(value: unknown, instanceId: string, desktopId?: string): DesktopSession {
  try {
    const result = sanitizeDesktopResponse('Desktop', value);
    if (result.instance_id.toLowerCase() !== instanceId.toLowerCase() ||
        (desktopId !== undefined && result.id.toLowerCase() !== desktopId.toLowerCase())) throw new Error();
    return result;
  } catch {
    throw new DesktopApiError('desktop_invalid_response');
  }
}

export async function desktopCapability(instanceId: string, signal?: AbortSignal): Promise<DesktopCapability | DesktopUnsupported> {
  const value = await request(`${resource(instanceId)}/capability`, { signal });
  if (value && typeof value === 'object' && 'state' in value && value.state === 'unsupported' &&
      'reason' in value && typeof value.reason === 'string' &&
      ['desktop_backend_not_configured', 'desktop_not_supported'].includes(value.reason)) {
    return { state: 'unsupported', reason: value.reason as DesktopUnsupported['reason'] };
  }
  try {
    const result = sanitizeDesktopResponse('Capability', value);
    if (result.instance_id.toLowerCase() !== instanceId.toLowerCase()) throw new Error();
    return result;
  } catch {
    throw new DesktopApiError('desktop_invalid_response');
  }
}

export async function getDesktop(instanceId: string, desktopId: string, signal?: AbortSignal): Promise<DesktopSession> {
  return desktop(await request(resource(instanceId, desktopId), { signal }), instanceId, desktopId);
}

export async function createDesktop(instanceId: string, body: CreateDesktopRequest,
  options: { idempotencyKey: string; signal?: AbortSignal }): Promise<DesktopSession> {
  const path = `${resource(instanceId)}/sessions`;
  if (typeof options.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(options.idempotencyKey)) throw new DesktopApiError('desktop_invalid_request');
  let validated: CreateDesktopRequest;
  try { validated = validateDesktopRequest('CreateDesktop', body); }
  catch { throw new DesktopApiError('desktop_invalid_request'); }
  return desktop(await request(path, { method: 'POST', signal: options.signal,
    headers: { 'content-type': 'application/json', 'idempotency-key': options.idempotencyKey },
    body: JSON.stringify(validated) }), instanceId);
}

// Neither close action means "return control to the agent". Handoff must use
// the attachment/control lifecycle and retain the authenticated guest session.
export async function closeDesktop(instanceId: string, desktopId: string,
  body: DesktopCloseRequest, signal?: AbortSignal): Promise<DesktopSession> {
  const path = `${resource(instanceId, desktopId)}/close`;
  let validated: DesktopCloseRequest;
  try { validated = validateDesktopRequest('CloseRequest', body); }
  catch { throw new DesktopApiError('desktop_invalid_request'); }
  return desktop(await request(path, { method: 'POST', signal,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(validated) }), instanceId, desktopId);
}
