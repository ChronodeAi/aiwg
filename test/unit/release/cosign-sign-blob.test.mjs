import { describe, it, expect, vi } from 'vitest';
import { acquireSigningIdentity, signBlob } from '../../../tools/release/cosign-sign-blob.mjs';

const env = {
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.example.invalid/token?existing=1&audience=wrong',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-request-secret',
};
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => body });

describe('release signing identity recovery', () => {
  it('retries the reported malformed ambient response, then signs once using the fetched identity', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response('unexpected upstream response', 503))
      .mockResolvedValueOnce(response('unexpected upstream response'))
      .mockResolvedValueOnce(response(JSON.stringify({ value: 'synthetic-signing-identity' })));
    const sleep = vi.fn(), spawn = vi.fn(() => ({ status: 0 }));
    await signBlob({ file: 'aiwg-2026.10.9.tgz', bundle: 'aiwg-2026.10.9.tgz.sigstore', env, fetchImpl, sleep, spawn });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[1000], [2000]]);
    for (const [url, options] of fetchImpl.mock.calls) {
      expect(new URL(url).searchParams.get('audience')).toBe('sigstore');
      expect(new URL(url).searchParams.get('existing')).toBe('1');
      expect(options).toMatchObject({ headers: { Authorization: 'Bearer synthetic-request-secret' }, redirect: 'error' });
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, tier, options] = spawn.mock.calls[0];
    expect(command).toBe('cosign');
    expect(args).toEqual(['sign-blob', '--yes', '--oidc-provider', 'envvar', '--bundle', 'aiwg-2026.10.9.tgz.sigstore', 'aiwg-2026.10.9.tgz']);
    expect(JSON.stringify(args)).not.toContain('synthetic-signing-identity');
    expect(tier).toBe('long');
    expect(options).toMatchObject({ timeout: 180000, env: { SIGSTORE_ID_TOKEN: 'synthetic-signing-identity' } });
    expect(options.env).not.toHaveProperty('ACTIONS_ID_TOKEN_REQUEST_TOKEN');
    expect(options.env).not.toHaveProperty('ACTIONS_ID_TOKEN_REQUEST_URL');
    expect(env).not.toHaveProperty('SIGSTORE_ID_TOKEN');
  });

  it.each([
    ['HTTP failure', () => response('synthetic-signing-identity', 503), 'HTTP 503; body length 26 bytes'],
    ['malformed JSON', () => response('unexpected'), 'HTTP 200; body length 10 bytes'],
    ['missing identity', () => response('{"value":""}'), 'HTTP 200; body length 12 bytes'],
    ['network failure', () => { throw new Error('synthetic-request-secret synthetic-signing-identity'); }, 'HTTP unavailable; body length 0 bytes'],
  ])('fails closed after three attempts on %s and exposes only safe diagnostics', async (_name, result, diagnostic) => {
    const fetchImpl = vi.fn(result), sleep = vi.fn(), spawn = vi.fn();
    const error = await signBlob({ file: 'artifact', bundle: 'bundle', env, fetchImpl, sleep, spawn }).catch(error => error);
    expect(error.message).toBe(`Actions OIDC token acquisition failed after 3 attempts (${diagnostic})`);
    expect(error.message).not.toMatch(/synthetic-(?:request-secret|signing-identity)/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[1000], [2000]]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not retry a successful identity acquisition or a cosign signing failure', async () => {
    const fetchImpl = vi.fn(async () => response('{"value":"synthetic-signing-identity"}'));
    const sleep = vi.fn(), spawn = vi.fn(() => ({ status: 1, stderr: 'synthetic-signing-identity', error: new Error('synthetic-request-secret') }));
    await expect(signBlob({ file: 'artifact', bundle: 'bundle', env, fetchImpl, sleep, spawn })).rejects.toThrow('cosign sign-blob failed (exit 1)');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('suppresses thrown signer errors that could include the token', async () => {
    await expect(signBlob({ file: 'artifact', bundle: 'bundle', env,
      fetchImpl: async () => response('{"value":"synthetic-signing-identity"}'),
      spawn: () => { throw new Error('synthetic-signing-identity'); },
    })).rejects.toThrow(/^cosign sign-blob failed$/);
  });

  it.each([{}, { ...env, ACTIONS_ID_TOKEN_REQUEST_URL: 'http://actions.example.invalid/token' }, { ...env, ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' }])('refuses missing or insecure request configuration before any request', async invalid => {
    const fetchImpl = vi.fn();
    await expect(acquireSigningIdentity({ env: invalid, fetchImpl })).rejects.toThrow(/Actions OIDC request/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
