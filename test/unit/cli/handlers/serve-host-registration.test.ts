import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { ExecutorRegistry } from '../../../../src/serve/executor-registry.js';

const server = vi.hoisted(() => ({ real: false, fetch: undefined as undefined | ((request: Request) => Promise<Response>) }));
vi.mock('../../../../src/features/runtime.js', () => ({
  loadFeaturePackage: async (name: string) => {
    if (server.real) {
      if (name === '@hono/node-server') return import('@hono/node-server');
      if (name === '@hono/node-server/serve-static') return import('@hono/node-server/serve-static');
      if (name === 'ws') return import('ws');
    }
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
  server.real = false;
  root = mkdtempSync(join(tmpdir(), 'serve-host-registration-'));
  vi.stubEnv('AIWG_EXECUTOR_IDENTITY_STORE', join(root, 'identities.json'));
  vi.stubEnv('AIWG_SANDBOX_IDENTITY_STORE', join(root, 'sandbox-identities.json'));
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
  it.each([false, true])('protects ordinary executor registration (restarted: %s)', async restarted => {
    const { startServer } = await import('../../../../src/cli/handlers/serve.js');
    const executor = { executor_id: 'b1b2c3d4-e5f6-7890-abcd-ef1234567890', name: 'ordinary', version: '1', spec_version: '1.0.0',
      transport_endpoints: { rest: 'http://127.0.0.1:8122', ws: 'ws://127.0.0.1:8121' }, capabilities: [] };
    const app = await startServer({ port: 7337, host: '127.0.0.1', readOnly: false, frameworkRoot: root });
    const register = (authorization?: string, version = '1') => server.fetch!(new Request(`${app.url}/api/v1/executors/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorization ? { authorization } : {}) },
      body: JSON.stringify({ ...executor, version }),
    }));
    try {
      const first = await register();
      expect(first.status).toBe(201);
      const identity = await first.json();
      expect(identity.token).toBeTruthy();
      if (restarted) {
        registry.shutdown();
        const { ExecutorRegistry } = await import('../../../../src/serve/executor-registry.js');
        registry = new ExecutorRegistry(join(root, 'trusted', 'identities.json'));
      }
      const before = registry.get(executor.executor_id);
      const persisted = readFileSync(join(root, 'identities.json'), 'utf8');
      for (const bearer of [undefined, 'Bearer wrong-token', `Basic ${identity.token}`]) {
        const response = await register(bearer, '2');
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'Unauthorized' });
        expect(registry.get(executor.executor_id)).toEqual(before);
        expect(registry.authenticate(executor.executor_id, identity.token)).toBe(true);
        expect(readFileSync(join(root, 'identities.json'), 'utf8')).toBe(persisted);
      }
      const accepted = await register(`Bearer ${identity.token}`, '2');
      expect(accepted.status).toBe(201);
      expect(await accepted.json()).toHaveProperty('token', identity.token);
      expect(registry.get(executor.executor_id)?.version).toBe('2');
    } finally { app.close(); }
  });

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


// Exercise the real handler mount and adapter without URL-client path normalization.
describe('dashboard static assets and route coexistence', () => {
  let app: Awaited<ReturnType<typeof import('../../../../src/cli/handlers/serve.js').startServer>>;
  let assets: string;
  beforeEach(async () => {
    server.real = true;
    assets = join(root, 'apps', 'web', 'dist');
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(assets, 'asset.txt'), 'dashboard asset');
    writeFileSync(join(assets, 'hello world.txt'), 'encoded asset');
    writeFileSync(join(root, 'apps', 'web', 'outside.txt'), 'outside secret');
    // These collisions must never mask the API or the upgrade handler.
    mkdirSync(join(assets, 'api'), { recursive: true });
    writeFileSync(join(assets, 'api', 'health'), 'static API collision');
    mkdirSync(join(assets, 'ws', 'sandbox'), { recursive: true });
    writeFileSync(join(assets, 'ws', 'sandbox', 'unknown'), 'static WS collision');
    const { startServer } = await import('../../../../src/cli/handlers/serve.js');
    app = await startServer({ port: 0, host: '127.0.0.1', readOnly: true, frameworkRoot: root });
  });
  afterEach(() => app?.close());

  function rawRequest(path: string, method = 'GET'): Promise<{ status: number; body: string; headers: import('node:http').IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const req = request(app.url, { path, method, agent: false }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString(), headers: response.headers }));
        response.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
  }

  it.each(['GET', 'HEAD'])('serves an asset with %s', async method => {
    const response = await rawRequest('/asset.txt', method);
    expect(response.status).toBe(200);
    expect(response.headers['content-length']).toBe(String(Buffer.byteLength('dashboard asset')));
    expect(response.body).toBe(method === 'HEAD' ? '' : 'dashboard asset');
  });

  it.each(['POST', 'PUT', 'DELETE'])('falls through for %s on a static asset', async method => {
    const response = await rawRequest('/asset.txt', method);
    expect(response.status).toBe(404);
    expect(response.body).toBe('Not found');
  });

  it('serves an ordinary percent-encoded filename', async () => {
    expect(await rawRequest('/hello%20world.txt')).toMatchObject({ status: 200, body: 'encoded asset' });
  });

  it.each(['/%2e%2e/outside.txt', '/%252e%252e/outside.txt', '/%252e/outside.txt'])('keeps %s inside the static root', async path => {
    const response = await rawRequest(path);
    expect(response.status).toBe(404);
    expect(response.body).not.toContain('outside secret');
  });

  it('does not decode a protected percent-encoded prefix again (GHSA-rmxm-3fg6-px4f)', async () => {
    mkdirSync(join(assets, '%2e'), { recursive: true });
    writeFileSync(join(assets, '%2e', 'secret.txt'), 'protected secret');
    const protectedApp = new Hono();
    protectedApp.use('/%2e/*', context => context.text('denied', 403));
    protectedApp.use('/*', serveStatic({ root: assets }));
    // Hono routes /%252e; a second decoding would read /%2e behind the guard.
    const response = await protectedApp.request('http://localhost/%252e/secret.txt');
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('protected secret');
  });

  it('keeps API routing ahead of static assets', async () => {
    const response = await rawRequest('/api/health');
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: 'ok', readOnly: true });
    expect(await rawRequest('/api/nonexistent')).toMatchObject({ status: 404, body: '{"error":"Not found"}' });
  });

  it('keeps the sandbox WebSocket upgrade and authentication working', async () => {
    const ws = new WebSocket(`${app.url.replace('http:', 'ws:')}/ws/sandbox/unknown`);
    try {
      const closed = once(ws, 'close');
      await once(ws, 'open');
      const [code, reason] = await closed;
      expect(code).toBe(4001);
      expect(reason.toString()).toBe('Unauthorized');
    } finally { ws.terminate(); }
  });
});
