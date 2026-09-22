import { beforeEach, describe, expect, it, vi } from 'vitest';

const instance = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const policy = { observe: true, control: true, sharing: false, clipboard_copy: false,
  clipboard_paste: false, file_transfer: false, audio: false, recording: false,
  isolation_tier: 'cooperative', generation: 1 };
const session = { schema_version: 'rdp-cockpit.v1', instance_id: instance, incarnation: 'boot-1',
  policy, id, workspace_id: 'workspace-1', state: 'ready', cleanup: 'none',
  absolute_expires_at: '2026-09-13T22:00:00Z', retained_until: null };
const body = { requested_mode: 'control' as const, viewport: { width: 1280, height: 800, dpi: 96 } };
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe('desktop browser API', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/');
  });

  it('creates with the session cookie, CSRF, caller-owned retry key and cancellation', async () => {
    const fetch = vi.fn().mockResolvedValue(reply(session, 202));
    vi.stubGlobal('fetch', fetch);
    const { createDesktop } = await import('./desktop-api');
    const controller = new AbortController();
    await createDesktop(instance, body, { idempotencyKey: 'stable-request-key-1', signal: controller.signal });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [path, init] = fetch.mock.calls[0];
    expect(path).toBe(`/api/desktops/instances/${instance}/sessions`);
    expect(init.credentials).toBe('same-origin');
    expect(init.signal).toBe(controller.signal);
    expect(init.headers.get('x-cockpit-csrf')).toBe('test-session-csrf');
    expect(init.headers.get('idempotency-key')).toBe('stable-request-key-1');
    expect(JSON.parse(init.body)).toEqual(body);
  });

  it('looks up the existing desktop without provisioning another session', async () => {
    const fetch = vi.fn().mockResolvedValue(reply({ ...session, grant: 'must-not-enter-ui', password: 'private' }));
    vi.stubGlobal('fetch', fetch);
    const { getDesktop } = await import('./desktop-api');
    expect(await getDesktop(instance, id)).toEqual(session);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(`/api/desktops/instances/${instance}/sessions/${id}`);
    expect(fetch.mock.calls[0][1].method).toBeUndefined();
  });

  it('returns a typed unsupported state without reflecting extra diagnostics', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ state: 'unsupported',
      reason: 'desktop_backend_not_configured', diagnostic: 'private' })));
    const { desktopCapability } = await import('./desktop-api');
    expect(await desktopCapability(instance)).toEqual({ state: 'unsupported', reason: 'desktop_backend_not_configured' });
  });

  it('validates capability and removes unrecognized fields', async () => {
    const capability = { schema_version: 'rdp-cockpit.v1', instance_id: instance, incarnation: 'boot-1',
      policy, supported: true, readiness: 'ready', reason_codes: [] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ ...capability, token: 'private' })));
    const { desktopCapability } = await import('./desktop-api');
    expect(await desktopCapability(instance)).toEqual(capability);
  });

  it('rejects a coerced unsupported reason instead of returning a non-string', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ state: 'unsupported', reason: ['desktop_not_supported'] })));
    const { desktopCapability } = await import('./desktop-api');
    await expect(desktopCapability(instance)).rejects.toMatchObject({ code: 'desktop_invalid_response' });
  });

  it.each([{ ...session, instance_id: id }, { ...session, id: instance }, { ...session, policy: {} }])(
    'rejects wrong-target or malformed session data', async response => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(response)));
      const { getDesktop } = await import('./desktop-api');
      await expect(getDesktop(instance, id)).rejects.toMatchObject({ code: 'desktop_invalid_response' });
    });

  it('does not send malformed IDs, viewport sizes or retry keys', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const { getDesktop, createDesktop } = await import('./desktop-api');
    await expect(getDesktop('../other', id)).rejects.toMatchObject({ code: 'desktop_invalid_request' });
    await expect(createDesktop(instance, body, { idempotencyKey: 'short' })).rejects.toMatchObject({ code: 'desktop_invalid_request' });
    await expect(createDesktop(instance, { ...body, viewport: { ...body.viewport, width: 9000 } },
      { idempotencyKey: 'stable-request-key-1' })).rejects.toMatchObject({ code: 'desktop_invalid_request' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses fixed user-facing errors and does not retry a failed mutation', async () => {
    const fetch = vi.fn().mockResolvedValue(reply({ error: 'internal_secret_failure', message: 'private credential' }, 502));
    vi.stubGlobal('fetch', fetch);
    const { createDesktop } = await import('./desktop-api');
    await expect(createDesktop(instance, body, { idempotencyKey: 'stable-request-key-1' }))
      .rejects.toMatchObject({ code: 'unavailable', message: 'Desktop assistance is temporarily unavailable.' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves cancellation instead of treating it as an access decision', async () => {
    const error = new DOMException('Cancelled', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));
    const { getDesktop } = await import('./desktop-api');
    await expect(getDesktop(instance, id)).rejects.toBe(error);
  });

  it('preserves cancellation while reading a response body after headers arrive', async () => {
    const error = new DOMException('Cancelled while reading', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.reject(error) }));
    const { getDesktop } = await import('./desktop-api');
    await expect(getDesktop(instance, id)).rejects.toBe(error);
  });

  it('preserves the supplied abort reason during body reading', async () => {
    const controller = new AbortController();
    const reason = new Error('Caller cancelled');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => {
      controller.abort(reason); return Promise.reject(new Error('Stream interrupted'));
    } }));
    const { getDesktop } = await import('./desktop-api');
    await expect(getDesktop(instance, id, controller.signal)).rejects.toBe(reason);
  });

  it('requires an explicit close action and never treats return-control as sign-out', async () => {
    const fetch = vi.fn().mockResolvedValue(reply({ ...session, state: 'closing', cleanup: 'pending' }, 202));
    vi.stubGlobal('fetch', fetch);
    const { closeDesktop } = await import('./desktop-api');
    // Runtime validation remains required even if a caller bypasses TypeScript.
    await expect(closeDesktop(instance, id, { action: 'return_control' } as never))
      .rejects.toMatchObject({ code: 'desktop_invalid_request' });
    expect(fetch).not.toHaveBeenCalled();
    expect(await closeDesktop(instance, id, { action: 'sign_out' })).toMatchObject({ state: 'closing', cleanup: 'pending' });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ action: 'sign_out' });
  });
});
