import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Desktop } from './Desktop';
import { statusForSession } from '../useDesktopSession';

const instance = '11111111-1111-4111-8111-111111111111';
const desktopId = '22222222-2222-4222-8222-222222222222';
const policy = { observe: false, control: true, sharing: false, clipboard_copy: true,
  clipboard_paste: false, file_transfer: false, audio: false, recording: false,
  isolation_tier: 'cooperative', generation: 3 };
const capability = { schema_version: 'rdp-cockpit.v1', instance_id: instance, incarnation: 'boot-1',
  policy, supported: true, readiness: 'ready', reason_codes: [] };
const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const session = { schema_version: 'rdp-cockpit.v1', instance_id: instance, incarnation: 'boot-1',
  policy, id: desktopId, workspace_id: 'workspace-1', state: 'ready', cleanup: 'none',
  absolute_expires_at: future, retained_until: null };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const capabilityPath = `/api/desktops/instances/${instance}/capability`;
const sessionsPath = `/api/desktops/instances/${instance}/sessions`;
const sessionPath = `${sessionsPath}/${desktopId}`;

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
function stubFetch(handler: Handler) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
/** Capability ready; create returns `created`; each subsequent GET returns the next entry of `polls` (last repeats). */
function scripted({ created = session, polls = [session], close }: { created?: unknown; polls?: unknown[]; close?: (body: { action: string }) => Response } = {}) {
  let pollIndex = 0;
  return stubFetch((url, init) => {
    if (url === capabilityPath) return json(capability);
    if (url === sessionsPath && init?.method === 'POST') return created instanceof Response ? created : json(created, 202);
    if (url === sessionPath && !init?.method) {
      const value = polls[Math.min(pollIndex, polls.length - 1)];
      pollIndex += 1;
      return value instanceof Response ? value : json(value);
    }
    if (url === `${sessionPath}/close` && init?.method === 'POST') return close ? close(JSON.parse(String(init.body))) : json({ ...session, state: 'closed', cleanup: 'complete' }, 202);
    return json({ error: 'unavailable' }, 500);
  });
}
const status = () => screen.getByRole('status').textContent ?? '';
async function connected(opts?: Parameters<typeof scripted>[0]) {
  const fetchMock = scripted(opts);
  render(<Desktop instanceId={instance} onBack={() => {}} pollMs={5} backoffMs={5} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === sessionsPath)).toBe(true));
  return fetchMock;
}

beforeEach(() => { window.history.replaceState(null, '', '/'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Desktop panel (#2547)', () => {
  it('shows a precise reason and no Connect when the backend reports unsupported', async () => {
    stubFetch(() => json({ state: 'unsupported', reason: 'desktop_backend_not_configured' }));
    render(<Desktop instanceId={instance} onBack={() => {}} />);
    await waitFor(() => expect(status()).toContain('Desktop backend is not configured'));
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
    expect(screen.queryByRole('button', { name: /take control/i })).toBeNull();
  });

  it('surfaces not_ready reason codes with a Retry that re-checks capability', async () => {
    let calls = 0;
    stubFetch(() => { calls += 1; return json({ ...capability, readiness: calls === 1 ? 'not_ready' : 'ready', reason_codes: calls === 1 ? ['desktop_not_ready', 'cleanup_pending'] : [] }); });
    render(<Desktop instanceId={instance} onBack={() => {}} />);
    await waitFor(() => expect(status()).toContain('desktop_not_ready, cleanup_pending'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Connect' })).toBeTruthy();
    expect(status()).toContain('Ready to connect');
  });

  it('connects with the backend-granted mode and renders the live status and policy from the backend', async () => {
    const fetchMock = await connected();
    await waitFor(() => expect(status()).toContain('Desktop session live'));
    expect(status()).toContain('Display transport is not available in this build');
    const create = fetchMock.mock.calls.find(([url]) => String(url) === sessionsPath)!;
    const init = create[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ requested_mode: 'control', viewport: { dpi: 96 } });
    expect(new Headers(init.headers).get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(screen.getByText('Effective capabilities (from backend)')).toBeTruthy();
    const list = screen.getByText('Effective capabilities (from backend)').parentElement!.textContent!;
    expect(list).toContain('Control: granted');
    expect(list).toContain('Observe: not granted');
    expect(list).toContain('Clipboard copy: granted');
    expect(list).toContain('Isolation tier: cooperative');
    expect(list).toContain('Policy generation: 3');
    expect(screen.getByText('none', { selector: 'dd' })).toBeTruthy();
    // Observe is not granted, so no Observe button; Take Control is granted but has no transport.
    expect(screen.queryByRole('button', { name: /observe/i })).toBeNull();
    const control = screen.getByRole('button', { name: /take control/i }) as HTMLButtonElement;
    expect(control.disabled).toBe(true);
    expect(control.title).toBe('Display transport is not available in this build');
  });

  it('disables Connect when the backend grants neither observe nor control and renders no mode buttons', async () => {
    stubFetch(() => json({ ...capability, policy: { ...policy, control: false, observe: false } }));
    render(<Desktop instanceId={instance} onBack={() => {}} />);
    const connect = await screen.findByRole('button', { name: 'Connect' }) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    expect(connect.title).toContain('neither observe nor control');
    expect(screen.queryByRole('button', { name: /observe/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /take control/i })).toBeNull();
  });

  it('reports expired when the absolute expiry has passed', async () => {
    await connected({ created: { ...session, absolute_expires_at: new Date(Date.now() - 1000).toISOString() } });
    await waitFor(() => expect(status()).toContain('has expired'));
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
  });

  it('reports denied on access_denied and never reflects server diagnostics', async () => {
    await connected({ created: json({ error: 'access_denied', diagnostic: 'private-detail' }, 403) });
    await waitFor(() => expect(status()).toContain('You do not have access to this desktop'));
    expect(document.body.textContent).not.toContain('private-detail');
  });

  it('shows handoff waiting on a control conflict and keeps following the session', async () => {
    await connected({ polls: [json({ error: 'control_conflict' }, 409), { ...session, state: 'attached' }] });
    await waitFor(() => expect(status()).toContain('Another participant currently controls this desktop'));
    await waitFor(() => expect(status()).toContain('Desktop session live'));
  });

  it('backs off through reconnecting and settles on disconnected after repeated transport failures', async () => {
    let created = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === capabilityPath) return json(capability);
      if (url === sessionsPath && init?.method === 'POST') { created = true; return json(session, 202); }
      if (url === sessionPath) throw new TypeError('network down');
      return json({ error: 'unavailable' }, 500);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<Desktop instanceId={instance} onBack={() => {}} pollMs={5} backoffMs={2} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(created).toBe(true));
    await waitFor(() => expect(status()).toContain('Reconnecting'));
    await waitFor(() => expect(status()).toContain('Lost contact with the desktop service'), { timeout: 3000 });
    const polls = fetchMock.mock.calls.filter(([url]) => String(url) === sessionPath).length;
    expect(polls).toBe(5);
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
  });

  it('Disconnect only stops following; the guest session stays and Reconnect resumes', async () => {
    const fetchMock = await connected();
    await waitFor(() => expect(status()).toContain('Desktop session live'));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(status()).toContain('You disconnected from this desktop; the guest session is still running');
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/close'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(status()).toContain('Desktop session live'));
  });

  it('Revoke access posts revoke_access and ends as disconnected, not guest-ended', async () => {
    const closes: string[] = [];
    await connected({ close: (body) => { closes.push(body.action); return json({ ...session, state: 'closed', cleanup: 'complete' }, 202); } });
    await waitFor(() => expect(status()).toContain('Desktop session live'));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke access' }));
    await waitFor(() => expect(status()).toContain('The desktop session was closed'));
    expect(closes).toEqual(['revoke_access']);
    expect(status()).not.toContain('guest was signed out');
    expect(screen.getByText('complete', { selector: 'dd' })).toBeTruthy();
  });

  it('Sign out guest confirms, posts sign_out, and ends as guest-ended', async () => {
    const closes: string[] = [];
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await connected({ close: (body) => { closes.push(body.action); return json({ ...session, state: 'closed', cleanup: 'pending' }, 202); } });
    await waitFor(() => expect(status()).toContain('Desktop session live'));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out guest' }));
    await waitFor(() => expect(status()).toContain('The guest was signed out'));
    expect(closes).toEqual(['sign_out']);
    expect(screen.getByText('pending', { selector: 'dd' })).toBeTruthy();
  });

  it('does not sign out when the confirmation is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const fetchMock = await connected();
    await waitFor(() => expect(status()).toContain('Desktop session live'));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out guest' }));
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/close'))).toBe(false);
  });

  it('marks the session stale when the VM incarnation changes and stops polling', async () => {
    const fetchMock = await connected({ polls: [{ ...session, incarnation: 'boot-2' }] });
    await waitFor(() => expect(status()).toContain('VM restarted (new incarnation)'));
    const before = fetchMock.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetchMock.mock.calls.length).toBe(before);
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
  });

  it('renders Observe and Take Control disabled with the transport reason only when the backend grants them', async () => {
    stubFetch(() => json({ ...capability, policy: { ...policy, observe: true, control: true } }));
    render(<Desktop instanceId={instance} onBack={() => {}} />);
    const observe = await screen.findByRole('button', { name: /observe/i }) as HTMLButtonElement;
    const control = screen.getByRole('button', { name: /take control/i }) as HTMLButtonElement;
    for (const button of [observe, control]) {
      expect(button.disabled).toBe(true);
      expect(button.title).toBe('Display transport is not available in this build');
    }
  });

  it('aborts the in-flight capability request on unmount and calls onBack', async () => {
    let seen: AbortSignal | undefined;
    stubFetch((_url, init) => { seen = init?.signal ?? undefined; return new Promise<Response>(() => undefined); });
    const onBack = vi.fn();
    const view = render(<Desktop instanceId={instance} onBack={onBack} />);
    await waitFor(() => expect(seen).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Back to inventory' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(seen?.aborted).toBe(true);
  });
});

describe('statusForSession mapping', () => {
  const base = session as Parameters<typeof statusForSession>[0];
  it('maps every backend state and honours close intent, expiry and incarnation', () => {
    expect(statusForSession({ ...base, state: 'preparing' }, null, null).status).toBe('loading');
    expect(statusForSession({ ...base, state: 'attached' }, null, null).status).toBe('live');
    expect(statusForSession({ ...base, state: 'detached' }, null, null).status).toBe('disconnected');
    expect(statusForSession({ ...base, state: 'closing' }, null, null).status).toBe('closing');
    expect(statusForSession({ ...base, state: 'closed' }, null, 'sign_out').status).toBe('guest-ended');
    expect(statusForSession({ ...base, state: 'closed' }, null, 'revoke_access').status).toBe('disconnected');
    expect(statusForSession({ ...base, state: 'failed' }, null, null).status).toBe('failed');
    expect(statusForSession({ ...base, absolute_expires_at: '2020-01-01T00:00:00Z' }, null, null).status).toBe('expired');
    expect(statusForSession({ ...base, incarnation: 'boot-9' }, base, null)).toEqual({ status: 'stale', reason: 'VM restarted (new incarnation)' });
  });
});
