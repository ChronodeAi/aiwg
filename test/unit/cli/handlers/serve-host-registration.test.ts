import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutorRegistry } from '../../../../src/serve/executor-registry.js';

const server = vi.hoisted(() => ({ fetch: undefined as undefined | ((request: Request) => Promise<Response>) }));
vi.mock('../../../../src/features/runtime.js', () => ({
  loadFeaturePackage: async (name: string) => {
    if (name === 'hono') return import('hono');
    if (name === '@hono/node-server') return { serve: (options: { fetch: typeof server.fetch }) => {
      server.fetch = options.fetch;
      return { close() {}, address: () => ({ port: 7337 }) };
    } };
    if (name === 'ws') return {};
    throw new Error('optional feature unavailable');
  },
}));

let root: string, registry: ExecutorRegistry;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'serve-host-registration-'));
  vi.stubEnv('AIWG_EXECUTOR_IDENTITY_STORE', join(root, 'identities.json'));
  const module = await import('../../../../src/serve/executor-registry.js');
  registry = new module.ExecutorRegistry(join(root, 'trusted', 'identities.json'));
  vi.spyOn(module.executorRegistry, 'register').mockImplementation((payload, token) => registry.register(payload, token));
});
afterEach(() => {
  registry.shutdown();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('host executor registration HTTP authentication', () => {
  it('returns 401 for missing or incorrect bearer tokens and forwards the current token', async () => {
    const { InMemoryAdmissionStore, bindTrustedHostAdmissionPolicy } = await import('../../../../src/serve/shared-host-scheduler.js');
    const { hostname } = await import('node:os');
    const { startServer } = await import('../../../../src/cli/handlers/serve.js');
    const executor = { executor_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', name: 'synthetic', version: '1', spec_version: '1.0.0',
      transport_endpoints: { rest: 'http://127.0.0.1:8122', ws: 'ws://127.0.0.1:8121' }, capabilities: ['x-admission-policy-revision:1'] };
    const registration = registry.register(executor);
    if ('status' in registration) throw new Error(registration.error);
    const store = new InMemoryAdmissionStore();
    bindTrustedHostAdmissionPolicy(store, { authorityRef: 'host:synthetic', hostId: hostname(), revision: 1,
      policy: { maxConcurrent: 1, defaultHostQuota: 1, leaseTtlMs: 60000, agingIntervalMs: 30000, allowPreemption: false },
      maxQueued: 16, dimensionCaps: {}, projects: {} });
    registry.installHostAdmissionAuthority(executor.executor_id, executor.version, store, []);
    const app = await startServer({ port: 7337, host: '127.0.0.1', readOnly: false, frameworkRoot: root });
    try {
      for (const authorization of ['', 'Bearer synthetic-wrong-token']) {
        const response = await server.fetch!(new Request(`${app.url}/api/v1/executors/register`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', authorization }, body: JSON.stringify({ ...executor, version: '2' }),
        }));
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'Unauthorized' });
        expect(store.read().hostRegistrationRevoked).not.toBe(true);
        expect(registry.get(executor.executor_id)?.version).toBe('1');
      }
      const response = await server.fetch!(new Request(`${app.url}/api/v1/executors/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', authorization: `Bearer ${registration.token}` },
        body: JSON.stringify({ ...executor, version: '2' }),
      }));
      expect(response.status).toBe(201);
      expect(store.read().hostRegistrationRevoked).toBe(true);
    } finally { app.close(); }
  });
});
