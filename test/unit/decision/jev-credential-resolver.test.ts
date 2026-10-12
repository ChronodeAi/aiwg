import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { contextLiveBinding, contextLiveRuleset, contextLiveTarget } from '../../../src/decision/context-live-qualification.js';
import { validateBinding, validateDefinition } from '../../../src/decision/validate.js';
// @ts-ignore - untyped trusted host module (pinned by digest, not compiled)
import { acquireAppRoleToken, createJevCredentialResolver, JevResolverError, verifiedHttpsFetch } from '../../../tools/decision/jev-credential-resolver.mjs';

const SECRET = 'fixture-jev-key-0123456789';
const CLIENT = 's.fixture-approle-client-token';
const LOCATOR = 'kv_fixture/data/fixture/jev/api-key';
const REFERENCE = 'openbao-approle.fixture-jev-reader.typesafe-jev';
const env = { BAO_ADDR: 'https://bao.fixture.invalid:8200', AIWG_JEV_OPENBAO_SECRET_PATH: LOCATOR };

function fixture(options: { status?: number; body?: unknown } = {}) {
  const acquireToken = vi.fn(async () => CLIENT);
  const fetch = vi.fn(async (url: string, _init: RequestInit) => url.endsWith('/revoke-self')
    ? new Response(null, { status: 204 })
    : new Response(JSON.stringify(options.body ?? { data: { data: { token: SECRET } } }), { status: options.status ?? 200 }));
  return { acquireToken, fetch, resolver: createJevCredentialResolver({ env, acquireToken, fetch }) };
}
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
async function failure(promise: Promise<unknown>): Promise<Error & { category: string }> {
  try { await promise; } catch (error) { return error as Error & { category: string }; }
  throw new Error('expected rejection');
}

describe('TV-12 trusted Jev credential resolver (offline)', () => {
  it('reads the key through the named reader AppRole, then revokes the client token', async () => {
    const { acquireToken, fetch, resolver } = fixture();
    expect(text(await resolver.resolveCredential(REFERENCE))).toBe(SECRET);
    expect(acquireToken).toHaveBeenCalledWith('fixture-jev-reader', expect.objectContaining({ env }));
    expect(fetch.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      [`https://bao.fixture.invalid:8200/v1/${LOCATOR}`, 'GET'],
      ['https://bao.fixture.invalid:8200/v1/auth/token/revoke-self', 'POST'],
    ]);
    for (const [, init] of fetch.mock.calls) expect(init).toMatchObject({ headers: { 'x-vault-token': CLIENT }, redirect: 'error' });
  });

  it('holds the key in memory once and hands out copies the caller may zero', async () => {
    const { acquireToken, fetch, resolver } = fixture();
    const [first, concurrent] = await Promise.all([resolver.resolveCredential(REFERENCE), resolver.resolveCredential(REFERENCE)]);
    first.fill(0); concurrent.fill(0);
    expect(text(await resolver.resolveCredential(REFERENCE))).toBe(SECRET);
    expect(acquireToken).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(resolver)).not.toContain(SECRET);
    resolver.dispose();
    expect(text(await resolver.resolveCredential(REFERENCE))).toBe(SECRET);
    expect(acquireToken).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['another logical reference', 'openbao-approle.fixture-jev-reader.typesafe-other', env],
    ['the retired colon/slash form', 'openbao-approle:fixture-jev-reader/typesafe/jev', env],
    ['a non-https secret service', REFERENCE, { ...env, BAO_ADDR: 'http://bao.fixture.invalid:8200' }],
    ['credentials in the service URL', REFERENCE, { ...env, BAO_ADDR: 'https://user:pw@bao.fixture.invalid' }],
    ['a missing locator', REFERENCE, { BAO_ADDR: env.BAO_ADDR }],
    ['a traversing locator', REFERENCE, { ...env, AIWG_JEV_OPENBAO_SECRET_PATH: 'kv/data/../sys/raw' }],
  ])('refuses %s before any AppRole login', async (_label, reference, configured) => {
    const acquireToken = vi.fn(async () => CLIENT); const fetch = vi.fn();
    const resolver = createJevCredentialResolver({ env: configured, acquireToken, fetch });
    const error = await failure(resolver.resolveCredential(reference));
    expect(error).toBeInstanceOf(JevResolverError);
    expect(acquireToken).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it('uses a logical reference that a DecisionBinding credentialRef accepts', () => {
    // Regression for run r2: the colon/slash form failed binding validation before the first dispatch.
    const definition = { apiVersion: 'decision.aiwg.io/v1alpha1', kind: 'DecisionDefinition', metadata: { id: 'probe', version: '1.0.0', description: 'probe' },
      spec: { purpose: 'probe', inputSchema: { type: 'object' }, question: 'probe?', answer: { kind: 'choice', options: [{ id: 'a', description: 'a' }, { id: 'b', description: 'b' }] }, requiredCapabilities: ['choice'] } } as any;
    validateDefinition(definition);
    const ruleset = contextLiveRuleset('probe', ['q0'], [definition]);
    for (const [reference, valid] of [[REFERENCE, true], ['openbao-approle.aiwg-jev-reader.typesafe-jev', true], ['openbao-approle:aiwg-jev-reader/typesafe/jev', false]] as const) {
      const binding = contextLiveBinding(ruleset, ['q0'], contextLiveTarget({ model: 'jev-pinned', secretServiceReference: reference }, '1.0.0', 1000), 1000);
      if (valid) expect(() => validateBinding(binding, ruleset)).not.toThrow(); else expect(() => validateBinding(binding, ruleset)).toThrow('credentialRef');
    }
  });

  it('rejects a second reference after one was resolved', async () => {
    const { resolver } = fixture();
    await resolver.resolveCredential(REFERENCE);
    expect((await failure(resolver.resolveCredential('openbao-approle.other-reader.typesafe-jev'))).category).toBe('reference');
  });

  it.each([
    ['denied read', { status: 403, body: { errors: [`permission denied ${LOCATOR} ${SECRET}`] } }, 'read'],
    ['missing field', { body: { data: { data: { api_key: SECRET } } } }, 'shape'],
    ['non-string field', { body: { data: { data: { token: 42 } } } }, 'shape'],
    ['whitespace in key', { body: { data: { data: { token: `${SECRET}\n` } } } }, 'shape'],
  ])('fails closed on %s without leaking secret-service text, and still revokes', async (_label, response, category) => {
    const { fetch, resolver } = fixture(response);
    const error = await failure(resolver.resolveCredential(REFERENCE));
    expect(error.category).toBe(category);
    for (const value of [SECRET, CLIENT, LOCATOR, 'permission denied']) {
      expect(`${error.message} ${error.stack} ${JSON.stringify(error)}`).not.toContain(value);
    }
    expect(fetch.mock.calls.at(-1)![0]).toMatch(/revoke-self$/);
  });

  it('rejects a malformed client token without reading, but still revokes any token it carried', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const resolver = createJevCredentialResolver({ env, fetch, acquireToken: async () => `helper warning on stdout\n${CLIENT}` });
    expect((await failure(resolver.resolveCredential(REFERENCE))).category).toBe('login');
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['https://bao.fixture.invalid:8200/v1/auth/token/revoke-self']);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: 'POST', headers: { 'x-vault-token': CLIENT } });
  });

  it.each(['0', 'false', ''])('refuses NODE_TLS_REJECT_UNAUTHORIZED=%j before any login', async value => {
    const acquireToken = vi.fn(async () => CLIENT); const fetch = vi.fn();
    const resolver = createJevCredentialResolver({ env: { ...env, NODE_TLS_REJECT_UNAUTHORIZED: value }, acquireToken, fetch });
    expect((await failure(resolver.resolveCredential(REFERENCE))).category).toBe('tls');
    expect(acquireToken).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it('zeroes the in-memory key on dispose', async () => {
    const { resolver } = fixture();
    await resolver.resolveCredential(REFERENCE);
    const zeroed: string[] = [];
    // `fill` is inherited from %TypedArray%.prototype.
    const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
    const original = typedArray.fill;
    const fill = vi.spyOn(typedArray, 'fill').mockImplementation(function (this: Uint8Array, ...args: any[]) {
      zeroed.push(text(this)); return original.apply(this, args as [number]);
    });
    let args: unknown[][] = [];
    try { resolver.dispose(); args = fill.mock.calls.map(call => [...call]); } finally { fill.mockRestore(); }
    expect(args).toContainEqual([0]);
    expect(zeroed).toContain(SECRET);
  });

  it('verifies TLS explicitly even when the process disables verification', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tv12-tls-'));
    const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    const server = createServer();
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=DNS:localhost', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { stdio: 'ignore', timeout: 20_000 });
      server.setSecureContext({ key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem')) });
      server.on('request', (_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ok":true}'); });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const url = `https://localhost:${(server.address() as { port: number }).port}/v1/sys/health`;
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      await expect(verifiedHttpsFetch({})(url, { method: 'GET', headers: {} })).rejects.toThrow();
      const trusted = await verifiedHttpsFetch({ BAO_CACERT: join(directory, 'cert.pem') })(url, { method: 'GET', headers: {} });
      expect(await trusted.json()).toEqual({ ok: true });
    } finally {
      if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
      server.close(); await rm(directory, { recursive: true, force: true });
    }
  });

  it('runs the host helper without argv secrets and discards its stderr', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tv12-resolver-'));
    try {
      const helper = join(directory, 'helper.sh');
      await writeFile(helper, '#!/usr/bin/env bash\necho "helper-diagnostic $*" >&2\n[[ "$1" == approle && "$2" == fixture-jev-reader ]] || exit 3\nprintf "%s\\n" "$FIXTURE_CLIENT"\n');
      const hostEnv = { ...process.env, AIWG_OPENBAO_TOKEN_HELPER: helper, FIXTURE_CLIENT: CLIENT };
      await expect(acquireAppRoleToken('fixture-jev-reader', { env: hostEnv, timeoutMs: 10_000 })).resolves.toBe(CLIENT);
      const error = await failure(acquireAppRoleToken('other-reader', { env: hostEnv, timeoutMs: 10_000 }));
      expect(error.category).toBe('login'); expect(error.message).not.toContain('helper-diagnostic');
      expect((await failure(acquireAppRoleToken('fixture-jev-reader', { env: { ...hostEnv, AIWG_OPENBAO_TOKEN_HELPER: 'helper.sh' }, timeoutMs: 10_000 }))).category).toBe('configuration');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
