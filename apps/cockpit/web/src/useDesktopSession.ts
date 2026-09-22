// Desktop session state machine over the Bridge control API (#2547).
//
// This hook drives the desktop panel from backend facts only: capability,
// session state, cleanup, policy, expiry and incarnation come from
// `desktop-api`; nothing here simulates a display, observer, or replay. There
// is no renderer in this build, so "live" means the guest session is running
// server-side and can be managed from the panel.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DesktopApiError, closeDesktop, createDesktop, desktopCapability, getDesktop,
  type DesktopCapability, type DesktopCloseRequest, type DesktopMode, type DesktopSession, type DesktopUnsupported,
} from './desktop-api';

export type DesktopStatus =
  | 'loading' | 'not_ready' | 'unavailable' | 'idle' | 'live' | 'reconnecting'
  | 'disconnected' | 'expired' | 'denied' | 'guest-ended' | 'failed' | 'stale' | 'handoff_waiting' | 'closing';

export interface DesktopState {
  status: DesktopStatus;
  reason: string;
  capability: DesktopCapability | null;
  session: DesktopSession | null;
  cleanup: DesktopSession['cleanup'] | null;
  failures: number;
}

export const STATUS_TEXT: Record<DesktopStatus, string> = {
  loading: 'Loading desktop capability…',
  not_ready: 'The desktop is still getting ready.',
  unavailable: 'Desktop assistance is not available for this instance.',
  idle: 'Ready to connect.',
  live: 'Desktop session live. Display transport is not available in this build; the guest session is running and can be closed from here.',
  reconnecting: 'Reconnecting to the desktop session…',
  disconnected: 'Disconnected from the desktop session. The guest session may still be running.',
  expired: 'This desktop session has expired.',
  denied: 'You do not have access to this desktop.',
  'guest-ended': 'The guest was signed out; this desktop session has ended.',
  failed: 'The desktop session failed.',
  stale: 'This instance changed. Refresh before reconnecting.',
  handoff_waiting: 'Another participant currently controls this desktop. Waiting for handoff.',
  closing: 'Closing the desktop session; cleanup is pending.',
};

export const MAX_POLL_FAILURES = 5;
/** Reconnect backoff multipliers over `backoffMs` (default 1 s): 1 s, 2 s, 4 s, then 8 s. */
const BACKOFF_STEPS = [1, 2, 4, 8];
const TERMINAL: DesktopStatus[] = ['stale', 'expired', 'guest-ended', 'failed', 'denied'];

export function unsupportedReason(reason: DesktopUnsupported['reason']): string {
  return reason === 'desktop_backend_not_configured'
    ? 'Desktop backend is not configured'
    : 'This instance does not support desktop assistance';
}

export function requestedMode(capability: DesktopCapability | null): DesktopMode | null {
  if (!capability) return null;
  if (capability.policy.control) return 'control';
  if (capability.policy.observe) return 'observe';
  return null;
}

/** Map a backend session to a panel status; pure so it can be unit-tested. */
export function statusForSession(
  session: DesktopSession,
  previous: DesktopSession | null,
  lastClose: DesktopCloseRequest['action'] | null,
  now = Date.now(),
): { status: DesktopStatus; reason: string } {
  if (previous && previous.incarnation !== session.incarnation) return { status: 'stale', reason: 'VM restarted (new incarnation)' };
  const expiresAt = Date.parse(session.absolute_expires_at);
  if (Number.isFinite(expiresAt) && expiresAt <= now && !['closed', 'failed'].includes(session.state)) return { status: 'expired', reason: '' };
  switch (session.state) {
    case 'preparing': return { status: 'loading', reason: 'Preparing the guest desktop.' };
    case 'ready':
    case 'attached': return { status: 'live', reason: '' };
    case 'detached': return { status: 'disconnected', reason: '' };
    case 'closing': return { status: 'closing', reason: '' };
    case 'closed': return lastClose === 'sign_out' ? { status: 'guest-ended', reason: '' } : { status: 'disconnected', reason: 'The desktop session was closed.' };
    case 'failed': return { status: 'failed', reason: '' };
    default: return { status: 'failed', reason: 'Unknown desktop state.' };
  }
}

/** Typed API errors that map to a panel status; `null` means transient (caller retries). */
export function statusForError(error: unknown): { status: DesktopStatus; reason: string } | null {
  if (!(error instanceof DesktopApiError)) return null;
  switch (error.code) {
    case 'access_denied':
    case 'unauthorized': return { status: 'denied', reason: error.message };
    case 'desktop_session_ended': return { status: 'expired', reason: error.message };
    case 'control_conflict': return { status: 'handoff_waiting', reason: error.message };
    case 'stale_instance': return { status: 'stale', reason: error.message };
    case 'desktop_not_supported': return { status: 'unavailable', reason: error.message };
    case 'quota_exceeded':
    case 'idempotency_conflict':
    case 'desktop_invalid_request':
    case 'desktop_invalid_response': return { status: 'failed', reason: error.message };
    default: return null;
  }
}

function idempotencyKey(): string {
  const raw = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return raw.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 128).padEnd(16, '0');
}

function errorFallback(error: unknown, status: DesktopStatus): { status: DesktopStatus; reason: string } {
  return statusForError(error) ?? { status, reason: error instanceof Error ? error.message : 'Desktop assistance is temporarily unavailable.' };
}

export function useDesktopSession(instanceId: string, pollMs = 2000, backoffMs = 1000) {
  const [state, setState] = useState<DesktopState>({ status: 'loading', reason: '', capability: null, session: null, cleanup: null, failures: 0 });
  const controller = useRef<AbortController | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const sessionRef = useRef<DesktopSession | null>(null);
  const lastClose = useRef<DesktopCloseRequest['action'] | null>(null);
  const polling = useRef(false);

  const stopPolling = useCallback(() => {
    polling.current = false;
    if (timer.current !== undefined) { window.clearTimeout(timer.current); timer.current = undefined; }
  }, []);

  const signal = useCallback(() => {
    controller.current ??= new AbortController();
    return controller.current.signal;
  }, []);

  const apply = useCallback((session: DesktopSession) => {
    const mapped = statusForSession(session, sessionRef.current, lastClose.current);
    sessionRef.current = session;
    setState((s) => ({ ...s, status: mapped.status, reason: mapped.reason, session, cleanup: session.cleanup, failures: 0 }));
    return mapped.status;
  }, []);

  const loadCapability = useCallback(async () => {
    setState((s) => ({ ...s, status: 'loading', reason: '' }));
    try {
      const capability = await desktopCapability(instanceId, signal());
      if (signal().aborted) return;
      if ('state' in capability && capability.state === 'unsupported') {
        setState((s) => ({ ...s, status: 'unavailable', reason: unsupportedReason(capability.reason), capability: null }));
        return;
      }
      const cap = capability as DesktopCapability;
      if (!cap.supported) {
        setState((s) => ({ ...s, status: 'unavailable', reason: cap.reason_codes.join(', ') || 'This instance does not support desktop assistance', capability: cap }));
      } else if (cap.readiness === 'ready') {
        setState((s) => ({ ...s, status: 'idle', reason: '', capability: cap }));
      } else {
        setState((s) => ({ ...s, status: 'not_ready', reason: cap.readiness === 'unknown' ? 'Desktop readiness unknown' : cap.reason_codes.join(', '), capability: cap }));
      }
    } catch (error) {
      if (signal().aborted) return;
      setState((s) => ({ ...s, ...errorFallback(error, 'unavailable'), capability: null }));
    }
  }, [instanceId, signal]);

  const poll = useCallback(async () => {
    const current = sessionRef.current;
    if (!polling.current || !current) return;
    try {
      const fresh = await getDesktop(instanceId, current.id, signal());
      if (!polling.current || signal().aborted) return;
      const status = apply(fresh);
      if (TERMINAL.includes(status) || fresh.state === 'closed') { stopPolling(); return; }
      timer.current = window.setTimeout(poll, pollMs);
    } catch (error) {
      if (!polling.current || signal().aborted) return;
      const mapped = statusForError(error);
      if (mapped) {
        setState((s) => ({ ...s, ...mapped }));
        if (mapped.status === 'handoff_waiting') timer.current = window.setTimeout(poll, pollMs);
        else stopPolling();
        return;
      }
      setState((s) => {
        const failures = s.failures + 1;
        if (failures >= MAX_POLL_FAILURES) {
          stopPolling();
          return { ...s, status: 'disconnected', reason: 'Lost contact with the desktop service.', failures };
        }
        timer.current = window.setTimeout(poll, backoffMs * BACKOFF_STEPS[Math.min(failures - 1, BACKOFF_STEPS.length - 1)]);
        return { ...s, status: 'reconnecting', reason: '', failures };
      });
    }
  }, [apply, backoffMs, instanceId, pollMs, signal, stopPolling]);

  const startPolling = useCallback(() => {
    polling.current = true;
    timer.current = window.setTimeout(poll, pollMs);
  }, [poll, pollMs]);

  const connect = useCallback(async () => {
    const mode = requestedMode(state.capability);
    if (!mode) return;
    lastClose.current = null;
    setState((s) => ({ ...s, status: 'loading', reason: 'Requesting a desktop session…', failures: 0 }));
    try {
      const session = await createDesktop(instanceId, {
        requested_mode: mode,
        viewport: { width: window.innerWidth, height: window.innerHeight, dpi: Math.round(96 * (window.devicePixelRatio || 1)) },
      }, { idempotencyKey: idempotencyKey(), signal: signal() });
      if (signal().aborted) return;
      sessionRef.current = null;
      const status = apply(session);
      if (!TERMINAL.includes(status)) startPolling();
    } catch (error) {
      if (signal().aborted) return;
      setState((s) => ({ ...s, ...errorFallback(error, 'failed') }));
    }
  }, [apply, instanceId, signal, startPolling, state.capability]);

  /** Stop polling only; the guest session stays. */
  const disconnect = useCallback(() => {
    stopPolling();
    setState((s) => ({ ...s, status: 'disconnected', reason: 'You disconnected from this desktop; the guest session is still running.' }));
  }, [stopPolling]);

  const reconnect = useCallback(() => {
    if (!sessionRef.current) return;
    setState((s) => ({ ...s, status: 'reconnecting', reason: '', failures: 0 }));
    polling.current = true;
    void poll();
  }, [poll]);

  const close = useCallback(async (action: DesktopCloseRequest['action']) => {
    const current = sessionRef.current;
    if (!current) return;
    stopPolling();
    lastClose.current = action;
    setState((s) => ({ ...s, status: 'closing', reason: action === 'sign_out' ? 'Signing the guest out…' : 'Revoking desktop access…' }));
    try {
      const session = await closeDesktop(instanceId, current.id, { action }, signal());
      if (signal().aborted) return;
      const status = apply(session);
      if (status === 'closing') startPolling();
    } catch (error) {
      if (signal().aborted) return;
      setState((s) => ({ ...s, ...errorFallback(error, 'failed') }));
    }
  }, [apply, instanceId, signal, startPolling, stopPolling]);

  useEffect(() => {
    controller.current = new AbortController();
    sessionRef.current = null;
    lastClose.current = null;
    void loadCapability();
    return () => {
      stopPolling();
      controller.current?.abort();
      controller.current = null;
    };
  }, [loadCapability, stopPolling]);

  return { state, connect, disconnect, reconnect, close, retry: loadCapability };
}
