import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// @ts-ignore - untyped trusted host module (pinned by digest, not compiled)
import { acquireAppRoleToken, createJevCredentialResolver, JevResolverError } from '../../../tools/decision/jev-credential-resolver.mjs';

const SECRET = 'fixture-jev-key-0123456789';
const CLIENT = 's.fixture-approle-client-token';
const LOCATOR = 'kv_fixture/data/fixture/jev/api-key';
const REFERENCE = 'openbao-approle:fixture-jev-reader/typesafe/jev';
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
    ['another logical reference', 'openbao-approle:fixture-jev-reader/typesafe/other', env],
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

  it('rejects a second reference after one was resolved', async () => {
    const { resolver } = fixture();
    await resolver.resolveCredential(REFERENCE);
    expect((await failure(resolver.resolveCredential('openbao-approle:other-reader/typesafe/jev'))).category).toBe('reference');
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

  it('rejects a malformed client token without calling the secret service', async () => {
    const fetch = vi.fn();
    const resolver = createJevCredentialResolver({ env, fetch, acquireToken: async () => 'bad token\nwith text' });
    expect((await failure(resolver.resolveCredential(REFERENCE))).category).toBe('login');
    expect(fetch).not.toHaveBeenCalled();
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
