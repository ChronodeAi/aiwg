/**
 * `aiwg agentcard verify` CLI handler tests.
 *
 * @source @src/cli/handlers/agentcard.ts
 * @issue #1253
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateKeyPairSync,
  sign as cryptoSign,
} from 'node:crypto';
import { chmodSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { agentcardHandler } from '../../../src/cli/handlers/agentcard.js';
import { canonicalizeJson } from '../../../src/a2a/jcs.js';
import type { JsonValue } from '../../../src/a2a/types.js';
import { EXIT_CODES } from '../../../src/cli/errors.js';
import * as cliEnv from '../../../src/cli/env.js';
import * as promptUtils from '../../../src/cli/prompt-utils.js';

function makeKey(kid: string): { jwkJson: string; sign: (p: Uint8Array) => string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubJwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const jwk = { kty: 'OKP', crv: 'Ed25519', x: pubJwk.x, kid, alg: 'EdDSA' };
  const jwkJson = JSON.stringify({ keys: [jwk] });
  function b64url(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  return {
    jwkJson,
    sign: (payload) => {
      const hdr = JSON.stringify({ alg: 'EdDSA', kid });
      const h = b64url(Buffer.from(hdr));
      const p = b64url(Buffer.from(payload));
      const sig = cryptoSign(null, Buffer.from(h + '.' + p), privateKey);
      return h + '.' + p + '.' + b64url(sig);
    },
  };
}

function makeSignedCardJson(kid: string, sign: (p: Uint8Array) => string): string {
  const card: Record<string, JsonValue> = {
    protocolVersion: '0.3.0',
    name: 'test-agent',
    url: 'https://exec.test',
    version: '1.0.0',
    capabilities: {
      streaming: true,
      extensions: [
        { uri: 'https://x/runtime/v1', required: true },
        { uri: 'https://x/idempotency/v1', required: true },
      ],
    },
  };
  const canon = canonicalizeJson(card as JsonValue);
  const jws = sign(canon);
  card['signatures'] = [
    { header: { alg: 'EdDSA', kid }, signature: jws } as unknown as JsonValue,
  ];
  return JSON.stringify(card);
}

const ctxOf = (args: string[]) =>
  ({
    args,
    config: {},
    logger: undefined,
  } as unknown as Parameters<typeof agentcardHandler.execute>[0]);

describe('agentcardHandler', () => {
  let tmpDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'aiwg-agentcard-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    logSpy.mockRestore();
    errSpy.mockRestore();
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('verifies a signed card via JWKS file', async () => {
    const { jwkJson, sign } = makeKey('cli-kid');
    const jwksPath = path.join(tmpDir, 'jwks.json');
    writeFileSync(jwksPath, jwkJson);

    const signedJson = makeSignedCardJson('cli-kid', sign);
    globalThis.fetch = (async () =>
      new Response(signedJson, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    const result = await agentcardHandler.execute(
      ctxOf(['verify', '--host', 'https://exec.test', '--instance', 'inst-1', '--jwks', jwksPath])
    );
    expect(result.exitCode).toBe(0);
    const calls = logSpy.mock.calls.flat().join('\n');
    expect(calls).toMatch(/VERIFIED/);
    expect(calls).toMatch(/test-agent/);
    expect(calls).toMatch(/cli-kid/);
  });

  it('fails non-zero on signature mismatch', async () => {
    const { jwkJson, sign } = makeKey('cli-kid');
    const jwksPath = path.join(tmpDir, 'jwks.json');
    writeFileSync(jwksPath, jwkJson);

    // Tamper the signed card AFTER signing
    const tampered = JSON.parse(makeSignedCardJson('cli-kid', sign)) as Record<string, unknown>;
    tampered['name'] = 'MUTATED';
    const tamperedJson = JSON.stringify(tampered);

    globalThis.fetch = (async () =>
      new Response(tamperedJson, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    const result = await agentcardHandler.execute(
      ctxOf(['verify', '--host', 'https://exec.test', '--instance', 'inst-1', '--jwks', jwksPath])
    );
    expect(result.exitCode).toBe(EXIT_CODES.GENERAL);
    const errOut = errSpy.mock.calls.flat().join('\n');
    expect(errOut).toMatch(/FAILED/);
  });

  it('--skip-verify returns 0 without JWKS', async () => {
    const card = { protocolVersion: '0.3.0', name: 'unverified', url: 'https://exec.test/agents/inst-1', version: '1' };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(card), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    const result = await agentcardHandler.execute(
      ctxOf(['verify', '--host', 'https://exec.test', '--instance', 'inst-1', '--skip-verify'])
    );
    expect(result.exitCode).toBe(0);
    const calls = logSpy.mock.calls.flat().join('\n');
    expect(calls).toMatch(/SKIPPED/);
  });

  it('emits JSON when --json is set', async () => {
    const { jwkJson, sign } = makeKey('cli-kid');
    const jwksPath = path.join(tmpDir, 'jwks.json');
    writeFileSync(jwksPath, jwkJson);
    const signedJson = makeSignedCardJson('cli-kid', sign);

    globalThis.fetch = (async () =>
      new Response(signedJson, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    const result = await agentcardHandler.execute(
      ctxOf([
        'verify',
        '--host',
        'https://exec.test',
        '--instance',
        'inst-1',
        '--jwks',
        jwksPath,
        '--json',
      ])
    );
    expect(result.exitCode).toBe(0);
    const out = logSpy.mock.calls.flat().join('');
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed['ok']).toBe(true);
    expect(parsed['kid']).toBe('cli-kid');
  });

  const verifyArgs = ['verify', '--host', 'https://exec.test', '--instance', 'inst-1', '--skip-verify'];
  const secret = 'fixture-agentcard-bearer';
  const unsignedCard = { protocolVersion: '0.3.0', name: 'public', url: 'https://exec.test', version: '1' };

  it('keeps no-source access unauthenticated even at a terminal', async () => {
    vi.spyOn(cliEnv, 'isInteractive').mockReturnValue(true);
    const request = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.headers).not.toHaveProperty('authorization');
      return new Response(JSON.stringify(unsignedCard));
    });
    globalThis.fetch = request as typeof fetch;
    expect((await agentcardHandler.execute(ctxOf(verifyArgs))).exitCode).toBe(0);
    expect(request).toHaveBeenCalledOnce();
  });

  it('uses explicit hidden terminal entry before lower priority sources', async () => {
    vi.spyOn(cliEnv, 'isInteractive').mockReturnValue(true);
    const close = vi.fn();
    vi.spyOn(promptUtils, 'createSecretPromptInterface').mockReturnValue({ close } as unknown as ReturnType<typeof promptUtils.createSecretPromptInterface>);
    vi.spyOn(promptUtils, 'askString').mockResolvedValue(secret);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    globalThis.fetch = (async (_url, init) => {
      expect(init?.headers).toHaveProperty('authorization', `Bearer ${secret}`);
      return new Response(JSON.stringify(unsignedCard));
    }) as typeof fetch;
    const result = await agentcardHandler.execute(ctxOf([...verifyArgs, '--bearer-interactive', '--bearer-env', 'UNSET_FIXTURE']));
    expect(result.exitCode).toBe(0);
    expect(close).toHaveBeenCalledOnce();
    expect(stderr.mock.calls.flat().join('')).not.toContain(secret);
  });

  it.skipIf(process.platform === 'win32')('validates a private file and never falls back after a selected source fails', async () => {
    vi.stubEnv('FIXTURE_BEARER', secret);
    const file = path.join(tmpDir, 'private');
    writeFileSync(file, secret, { mode: 0o600 });
    const request = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.headers).toHaveProperty('authorization', `Bearer ${secret}`);
      return new Response(JSON.stringify(unsignedCard));
    });
    globalThis.fetch = request as typeof fetch;
    expect((await agentcardHandler.execute(ctxOf([...verifyArgs, '--bearer-file', file]))).exitCode).toBe(0);
    request.mockClear();
    if (process.platform !== 'win32') {
      chmodSync(file, 0o644);
      const result = await agentcardHandler.execute(ctxOf([...verifyArgs, '--bearer-file', file, '--bearer-env', 'FIXTURE_BEARER']));
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('group or other access');
      expect(result.message).not.toContain(secret);
      expect(request).not.toHaveBeenCalled();
      symlinkSync(file, `${file}.link`);
      expect((await agentcardHandler.execute(ctxOf([...verifyArgs, '--bearer-file', `${file}.link`]))).message).toContain('symlink');
    }
  });

  it('names standard sources when terminal entry is requested headlessly', async () => {
    vi.spyOn(cliEnv, 'isInteractive').mockReturnValue(false);
    const result = await agentcardHandler.execute(ctxOf([...verifyArgs, '--bearer-interactive']));
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/--bearer-interactive.*--bearer-stdin.*--bearer-file.*--bearer-store.*--bearer-env/);
  });

  it.each([false, true])('redacts reflected remote card fields and transport errors (json=%s)', async json => {
    vi.stubEnv('FIXTURE_BEARER', secret);
    const args = [...verifyArgs, '--bearer-env', 'FIXTURE_BEARER', ...(json ? ['--json'] : [])];
    globalThis.fetch = (async (_url, init) => {
      expect(init?.headers).toHaveProperty('authorization', `Bearer ${secret}`);
      return new Response(JSON.stringify({ ...unsignedCard, name: secret, skills: [{ id: secret, name: secret }] }));
    }) as typeof fetch;
    expect((await agentcardHandler.execute(ctxOf(args))).exitCode).toBe(0);
    expect(logSpy.mock.calls.flat().join('')).toContain('[REDACTED]');
    expect(logSpy.mock.calls.flat().join('')).not.toContain(secret);
    globalThis.fetch = (async () => { throw new Error(`request failed: Authorization: Bearer ${secret}`); }) as typeof fetch;
    const result = await agentcardHandler.execute(ctxOf(args));
    expect(result.exitCode).toBe(1);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('')).not.toContain(secret);
  });

  it('retains literal bearer compatibility with an argv deprecation warning', async () => {
    globalThis.fetch = (async (_url, init) => {
      expect(init?.headers).toHaveProperty('authorization', `Bearer ${secret}`);
      return new Response(JSON.stringify(unsignedCard));
    }) as typeof fetch;
    expect((await agentcardHandler.execute(ctxOf([...verifyArgs, '--bearer', secret]))).exitCode).toBe(0);
    const errors = errSpy.mock.calls.flat().join('');
    expect(errors).toContain('deprecated');
    expect(errors).toContain('exposes the value on argv');
    expect(errors).not.toContain(secret);
  });

  it('returns USAGE when --host is missing', async () => {
    const result = await agentcardHandler.execute(ctxOf(['verify', '--instance', 'inst-1']));
    expect(result.exitCode).toBe(EXIT_CODES.USAGE);
  });

  it('returns USAGE for unknown verb', async () => {
    const result = await agentcardHandler.execute(ctxOf(['nonsense']));
    expect(result.exitCode).toBe(EXIT_CODES.USAGE);
  });

  it('prints usage on --help', async () => {
    const result = await agentcardHandler.execute(ctxOf(['--help']));
    expect(result.exitCode).toBe(0);
    expect(logSpy.mock.calls.flat().join('\n')).toMatch(/Usage: aiwg agentcard/);
  });
});
