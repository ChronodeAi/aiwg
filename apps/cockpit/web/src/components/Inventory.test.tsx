import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Inventory } from './Inventory';

const VM_INSTANCE = {
  id: 'vm-1',
  runtime: 'vm',
  provider: 'cloud-hypervisor',
  capabilities: [
    { id: 'instance.snapshot', label: 'Snapshot' },
    { id: 'instance.restore', label: 'Restore' },
    { id: 'instance.fork', label: 'Fork' },
    { id: 'warm_pool.manage', label: 'Warm pools' },
  ],
  loadout: 'security-audit',
  state: 'running',
  tenant: 'default',
  card_url: '',
  runtime_posture: { kind: 'vm', isolation: 'strong', label: 'VM' },
  host_daemon: { status: 'available' },
  transport: { mode: 'mtls', trust: 'secure', label: 'mTLS', source: 'test' },
  launch_context: { name: 'vm-one', loadout: 'security-audit' },
  session_backends: [{ mode: 'managed', backend: 'zellij', available: true, drive: true }],
};

beforeEach(() => {});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Inventory provider-aware fast-start controls', () => {
  it('distinguishes secure managed UDS, compatibility fallback, and legacy recreation posture', async () => {
    const postures = [
      { ...VM_INSTANCE, id: 'docker-secure', runtime: 'docker', runtime_posture: { kind: 'docker', isolation: 'shared-kernel', label: 'Docker' }, managed_docker_posture: { transport_mode: 'uds', control_identity_present: true, control_identity_range_valid: true, workload_uid: 10001, workload_identity_separated: true, boundary: 'separated', secure_default: true, compatibility: false, requires_recreation: false, source: 'agentic-sandbox' } },
      { ...VM_INSTANCE, id: 'docker-desktop', runtime: 'docker', runtime_posture: { kind: 'docker', isolation: 'shared-kernel', label: 'Docker' }, managed_docker_posture: { transport_mode: 'mtls-bootstrap', control_identity_present: true, control_identity_range_valid: true, workload_uid: 10001, workload_identity_separated: true, boundary: 'separated', secure_default: false, compatibility: true, fallback_reason: 'Docker Desktop peer UID unavailable', requires_recreation: false, source: 'agentic-sandbox' } },
      { ...VM_INSTANCE, id: 'docker-old', runtime: 'docker', runtime_posture: { kind: 'docker', isolation: 'shared-kernel', label: 'Docker' }, managed_docker_posture: { transport_mode: 'unknown', control_identity_present: false, control_identity_range_valid: false, workload_identity_separated: false, boundary: 'unknown', secure_default: false, compatibility: true, requires_recreation: true, source: 'agentic-sandbox' } },
    ];
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ count: 3, fetched_at: '2026-08-04T00:00:00Z', instances: postures }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    render(<Inventory refreshMs={60_000} />);
    expect(await screen.findByText('Managed UDS · split identity')).toBeTruthy();
    expect(screen.getByText('Compatibility transport')).toBeTruthy();
    expect(screen.getByText('Recreate required')).toBeTruthy();
  });
  it('runs a capability-gated snapshot action and records terminal audit evidence', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.includes('/api/inventory')) return ok({ count: 1, fetched_at: '2026-07-29T00:00:00Z', instances: [VM_INSTANCE] });
      if (url.includes('/api/instances/vm-1/snapshot') && init?.method === 'POST') return ok({ id: 'op-1', state: 'running' });
      if (url.includes('/api/operations/op-1')) return ok({ id: 'op-1', state: 'succeeded', result: { provider: 'cloud-hypervisor', snapshot_id: 'vm-one-snap' } });
      if (url.includes('/api/audit/intent') && init?.method === 'POST') return ok({ id: 'audit-1' });
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;
    vi.spyOn(window, 'prompt').mockReturnValue('vm-one-snap');

    render(<Inventory refreshMs={60_000} />);

    fireEvent.click(await screen.findByRole('button', { name: /snapshot vm-1/i }));

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Snapshot succeeded: op-1'));
    const actionCall = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls
      .find((call) => String(call[0]).includes('/api/instances/vm-1/snapshot'));
    expect(JSON.parse(String(actionCall?.[1]?.body))).toMatchObject({ asset_ref: 'vm-one-snap' });
    const auditCall = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls
      .find((call) => String(call[0]).includes('/api/audit/intent'));
    expect(JSON.parse(String(auditCall?.[1]?.body))).toMatchObject({
      event: 'instance.fast_start.terminal',
      detail: {
        instance_id: 'vm-1',
        provider: 'cloud-hypervisor',
        action: 'snapshot',
        operation_id: 'op-1',
        state: 'succeeded',
      },
    });
  });

  it('disables unsafe fast-start controls when VFIO constraints exclude them', async () => {
    const vfioVm = {
      ...VM_INSTANCE,
      capability_constraints: [{
        capability: 'device.vfio',
        excludes: ['instance.snapshot', 'instance.restore', 'instance.fork', 'warm_pool.manage'],
        reason: 'VFIO-backed VMs cannot safely reuse memory state.',
      }],
    };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/inventory')) {
        return new Response(JSON.stringify({ count: 1, fetched_at: '2026-07-29T00:00:00Z', instances: [vfioVm] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    render(<Inventory refreshMs={60_000} />);

    const snapshot = await screen.findByRole('button', { name: /snapshot vm-1/i }) as HTMLButtonElement;
    expect(snapshot.disabled).toBe(true);
    expect(snapshot.getAttribute('title')).toBe('VFIO-backed VMs cannot safely reuse memory state.');
    expect((screen.getByRole('button', { name: /restore vm-1/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /fork vm-1/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /warm pool vm-1/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders libvirt checkpoint controls without unsupported fork', async () => {
    const libvirtVm = {
      ...VM_INSTANCE,
      provider: 'libvirt',
      capabilities: [
        { id: 'instance.checkpoint', label: 'Checkpoint' },
        { id: 'instance.restore', label: 'Checkpoint restore' },
        { id: 'warm_pool.manage', label: 'Warm pools' },
      ],
    };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/inventory')) {
        return new Response(JSON.stringify({ count: 1, fetched_at: '2026-07-29T00:00:00Z', instances: [libvirtVm] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    render(<Inventory refreshMs={60_000} />);

    expect(await screen.findByRole('button', { name: /checkpoint vm-1/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /restore vm-1/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /warm pool vm-1/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /fork vm-1/i })).toBeNull();
  });

  it('renders degraded sandbox trust recovery without secret material', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/inventory')) {
        return new Response(JSON.stringify({
          count: 1,
          fetched_at: '2026-07-29T00:00:00Z',
          bootstrap_trust: {
            status: 'degraded',
            mode: 'mtls',
            label: 'Sandbox trust degraded',
            source: '/api/v2/admin/bootstrap/readiness',
            ca_provider_ref: 'vault://sandbox-ca/current',
            trust_bundle_ref: 'trust-bundle://sandbox/current',
            client_identity_ref: 'spiffe://sandbox.agentic.local/cockpit/bridge',
            rotation_state: 'reload-required',
            trust_bundle_fresh: false,
            token_store_configured: true,
            missing_required_material: ['fresh_trust_bundle'],
            recovery: 'Refresh sandbox CA/bootstrap readiness, rotate stale trust material, then reload Cockpit.',
          },
          instances: [VM_INSTANCE],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    render(<Inventory refreshMs={60_000} />);

    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('Sandbox trust degraded');
    expect(banner.textContent).toContain('rotate stale trust material');
    expect(banner.textContent).toContain('vault://sandbox-ca/current');
    expect(banner.textContent).not.toMatch(/BEGIN CERTIFICATE|PRIVATE KEY|secret-token/i);
  });
});

describe('Inventory Open Desktop entry (#2547)', () => {
  const gatewayId = '11111111-1111-4111-8111-111111111111';
  const policy = { observe: false, control: true, sharing: false, clipboard_copy: false, clipboard_paste: false, file_transfer: false, audio: false, recording: false, isolation_tier: 'cooperative', generation: 1 };
  const capability = { schema_version: 'rdp-cockpit.v1', instance_id: gatewayId, incarnation: 'boot-1', policy, supported: true, readiness: 'ready', reason_codes: [] };
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  function stub(capabilityBody: unknown, instances = [{ ...VM_INSTANCE, id: gatewayId }]) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/inventory')) return ok({ count: instances.length, fetched_at: '2026-09-13T00:00:00Z', instances });
      if (url.endsWith('/capability')) return ok(capabilityBody);
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;
    return fetchMock;
  }

  it('renders no Open Desktop button without an onOpenDesktop handler and never probes capability', async () => {
    const fetchMock = stub(capability);
    render(<Inventory refreshMs={60_000} />);
    await screen.findByRole('button', { name: /stop instance/i });
    expect(screen.queryByRole('button', { name: /open desktop/i })).toBeNull();
    expect((fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls.some((call) => String(call[0]).endsWith('/capability'))).toBe(false);
  });

  it('enables Open Desktop for a supported, ready instance and opens it', async () => {
    stub(capability);
    const onOpenDesktop = vi.fn();
    render(<Inventory refreshMs={60_000} onOpenDesktop={onOpenDesktop} />);
    const button = await screen.findByRole('button', { name: `Open desktop for ${gatewayId.slice(0, 8)}…` }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    expect(onOpenDesktop).toHaveBeenCalledWith(gatewayId);
  });

  it('disables Open Desktop with the backend reason when unsupported or not ready', async () => {
    stub({ state: 'unsupported', reason: 'desktop_backend_not_configured' });
    render(<Inventory refreshMs={60_000} onOpenDesktop={() => {}} />);
    let button = await screen.findByRole('button', { name: /open desktop/i }) as HTMLButtonElement;
    await waitFor(() => expect(button.title).toBe('Desktop backend is not configured'));
    expect(button.disabled).toBe(true);
    cleanup();
    stub({ ...capability, readiness: 'not_ready', reason_codes: ['desktop_not_ready'] });
    render(<Inventory refreshMs={60_000} onOpenDesktop={() => {}} />);
    button = await screen.findByRole('button', { name: /open desktop/i }) as HTMLButtonElement;
    await waitFor(() => expect(button.title).toBe('Desktop is still getting ready: desktop_not_ready'));
    expect(button.disabled).toBe(true);
  });

  it('disables Open Desktop for a non-gateway instance id without calling the desktop API', async () => {
    const fetchMock = stub(capability, [VM_INSTANCE]);
    render(<Inventory refreshMs={60_000} onOpenDesktop={() => {}} />);
    const button = await screen.findByRole('button', { name: /open desktop for vm-1/i }) as HTMLButtonElement;
    await waitFor(() => expect(button.title).toBe('Desktop requires a gateway instance id'));
    expect(button.disabled).toBe(true);
    expect((fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls.some((call) => String(call[0]).endsWith('/capability'))).toBe(false);
  });
});

