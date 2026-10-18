import { mkdtemp } from '../../helpers/temp-dir.js';
import { symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { syntheticSecrets } from '../../fixtures/sessions/redaction-secrets.js';
import { SessionRejectionDetailSchema } from '../../../src/sessions/contracts.js';
import {
  SESSION_PROVIDER_IDS,
  SessionContractError,
  schemaRejectionDetail,
  SessionEventSchema,
  assertSessionProviderId,
  assertSupportedSchemaMajor,
  authorizeSourceFile,
  DeletionReceiptSchema,
  defineSessionAdapterFixture,
  redactSessionText,
  redactSessionValue,
  sanitizeNativeExtensions,
  requireNetworkConsent,
  prefilterAuthorizedSearchScope,
  sha256,
} from '../../../src/sessions/index.js';

describe('session contracts', () => {
  it.each(['flag', 'env', 'config', 'default'])('preserves %s byte-limit origin in rejection details', origin => {
    const detail = { limit: 'maxTotalBytes', configured: 1, observed: 2,
      setting: 'sessions.import.max_source_bytes', origin };
    expect(SessionRejectionDetailSchema.parse(detail)).toEqual(detail);
  });

  it('extracts bounded paths and codes from nested validator failures without input values', () => {
    const schema = z.object({ events: z.array(z.union([
      z.object({ role: z.literal('user') }), z.object({ role: z.literal('assistant') }),
    ])) });
    const result = schema.safeParse({ events: [{ role: 'synthetic-transcript-marker' }] });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(schemaRejectionDetail(result.error)).toEqual({ issues: [
      { path: 'events.0.role', code: 'invalid_literal' },
      { path: 'events.0.role', code: 'invalid_literal' },
    ] });
    const many = z.array(z.string()).safeParse(Array(30).fill(null));
    if (many.success) throw new Error('expected validator failure');
    expect(schemaRejectionDetail(many.error)).toHaveProperty('issues.length', 20);
  });

  it('redacts session diagnostics and dynamic validator paths before they can reach receipts', () => {
    const canary = 'redaction-canary-diagnostic';
    const error = new SessionContractError('MALFORMED_SOURCE', canary, { issues: [{ path: canary, code: 'custom' }] });
    expect(error.message).not.toContain(canary);
    expect(JSON.stringify(error.detail)).not.toContain(canary);
    const result = z.record(z.string()).safeParse({ [canary]: 42 });
    if (result.success) throw new Error('expected validator failure');
    expect(JSON.stringify(schemaRejectionDetail(result.error))).not.toContain(canary);
  });

  it('asserts every canonical provider ID with documented compatibility aliases', () => {
    expect(SESSION_PROVIDER_IDS).toEqual([
      'claude', 'codex', 'copilot', 'cursor', 'factory', 'hermes',
      'opencode', 'openclaw', 'openhuman', 'grokbot', 'grok-build', 'pi', 'omp', 'deepseek-harness', 'warp', 'devin-desktop', 'muse', 'generic',
    ]);
    expect(assertSessionProviderId('windsurf')).toBe('devin-desktop');
    expect(assertSessionProviderId('dsh')).toBe('deepseek-harness');
    expect(() => assertSessionProviderId('factory-ai')).toThrowError(
      expect.objectContaining({ code: 'UNKNOWN_PROVIDER' }),
    );
  });

  it('fails closed on unknown schema majors but preserves unknown event kinds', () => {
    expect(() => assertSupportedSchemaMajor('2.0.0')).toThrowError(
      expect.objectContaining({ code: 'UNKNOWN_SCHEMA_MAJOR' }),
    );
    const event = SessionEventSchema.parse({
      contractVersion: '1.0.0',
      eventId: 'event-1', sessionId: 'session-1', sourceId: 'source-1',
      importRunId: 'run-1', nativeId: null, sequence: 0,
      kind: 'provider.future-event', role: null, occurredAt: null,
      searchableText: '', digest: sha256('future'),
      rawReference: { locatorClass: 'fixture', sequence: 0 },
      adapterVersion: '1.0.0', consistency: 'complete',
      sensitivity: { classification: 'none', classes: [] }, opaque: true,
      extensions: { 'native.claude': { future: true } },
    });
    expect(event.opaque).toBe(true);
  });

  it('enforces fixture dispositions', () => {
    expect(() => defineSessionAdapterFixture({
      provider: 'warp', disposition: 'manual-only', synthetic: true,
      schemaVersion: '1.0.0', adapterVersion: '1.0.0', records: [],
    })).toThrow(/explicit reason/);
  });

  it('keeps deletion receipts content- and locator-free', () => {
    expect(() => DeletionReceiptSchema.parse({
      contractVersion: '1.0.0', receiptId: 'receipt-1', operationId: 'operation-1',
      scopeClass: 'workspace', counts: { events: 2 }, survivingDependentIds: [],
      actorClass: 'operator', reasonCode: 'user_request',
      orphanCounts: { events: 0 },
      outcome: 'committed', occurredAt: '2026-07-26T00:00:00.000Z',
      rawPath: '/sensitive/path',
    })).toThrow();
  });
});

describe('session source and content policy', () => {
  it('reports the authorized byte limit and observed source size without content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-policy-limit-'));
    const file = join(root, 'session.jsonl');
    const content = 'synthetic-transcript-marker';
    await writeFile(file, content);
    await expect(authorizeSourceFile({ selectedPath: file, allowedRoots: [root], maxBytes: 1 }))
      .rejects.toMatchObject({
        code: 'RESOURCE_LIMIT_EXCEEDED',
        detail: { limit: 'maxBytes', configured: 1, observed: Buffer.byteLength(content) },
      });
  });

  it('authorizes only explicitly selected regular files under canonical roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-session-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'aiwg-session-outside-'));
    const file = join(root, 'session.jsonl');
    const outsideFile = join(outside, 'session.jsonl');
    await writeFile(file, '{}\n');
    await writeFile(outsideFile, '{}\n');
    await expect(authorizeSourceFile({ selectedPath: file, allowedRoots: [root] }))
      .resolves.toMatchObject({ canonicalPath: file });
    await expect(authorizeSourceFile({ selectedPath: outsideFile, allowedRoots: [root] }))
      .rejects.toMatchObject({ code: 'SOURCE_OUTSIDE_ALLOWED_ROOT' });

    const link = join(root, 'linked.jsonl');
    await symlink(outsideFile, link);
    await expect(authorizeSourceFile({ selectedPath: link, allowedRoots: [root] }))
      .rejects.toMatchObject({ code: 'SOURCE_SYMLINK' });
  });

  it('redacts secrets and PII before derived use', () => {
    const result = redactSessionText('email a@example.com token=super-secret-value');
    expect(result.text).not.toContain('a@example.com');
    expect(result.text).not.toContain('super-secret-value');
    expect(result.sensitivity).toBe('sensitive');
  });

  it('recursively sanitizes native attributes with typed bounded markers', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = sanitizeNativeExtensions({
      status: 'complete',
      authorization: 'Bearer redaction-canary-authorization',
      nested: {
        futureField: 'redaction-canary-future',
        toolResult: 'redaction-canary-tool-output',
        url: 'https://user:redaction-canary-password@example.test/path',
        ownerEmail: 'redaction-canary@example.test',
        path: '/private/redaction-canary/path',
      },
      items: [
        { token: 'redaction-canary-array-token' },
        'redaction-canary-array-value',
      ],
      circular,
      deep: { a: { b: { c: { d: { e: { f: { g: { h: { i: 'secret' } } } } } } } } },
    });

    const serialized = JSON.stringify(result.value);
    expect(result.value.status).toBe('complete');
    expect(serialized).not.toContain('redaction-canary');
    expect(serialized).toContain('[REDACTED:sensitive-field]');
    expect(serialized).toContain('[REDACTED:content]');
    expect(serialized).toContain('[REDACTED:path]');
    expect(serialized).toContain('[REDACTED:circular-reference]');
    expect(serialized).toContain('[REDACTED:depth-limit]');
    expect(result.sensitivity).toBe('sensitive');
    expect(result.decisions).not.toHaveProperty('value');
  });

  it.each(syntheticSecrets)('redacts synthetic %s and records its classification count (%#)', (classification, value) => {
    const result = redactSessionText(value);
    expect(result.text).toBe(`[REDACTED:${classification}]`);
    expect(result.decisions[classification]).toBe(1);
  });

  it('redacts JWTs with large claims and lower-case AWS configuration assignments', () => {
    const jwt = `eyJ${'a'.repeat(12)}.${'b'.repeat(16_384)}.${'c'.repeat(128)}`;
    expect(redactSessionText(jwt + '.').text).toBe('[REDACTED:provider-token].');
    expect(redactSessionText('aws_secret_access_key = FAKE000000000000000000000000000000000000').text)
      .toBe('[REDACTED:environment-assignment]');
    expect(redactSessionText('api_key' + ' '.repeat(4096) + '= FAKE0000000000').text)
      .toBe('[REDACTED:credential]');
  });

  it('preserves ordinary prose, digests, UUIDs and session IDs', () => {
    const text = `The password should remain private. A token represents a word.
${sha256('safe')}
019d0000-0000-7000-8000-000000000101
session_0123456789abcdef`;
    expect(redactSessionText(text)).toMatchObject({ text, classes: [], decisions: {} });
  });

  it('redacts nested keys and arrays without prototype mutation or input mutation', () => {
    const input = { nested: [{ ['redaction-canary-key']: 'redaction-canary-value' }], id: 'session-1' };
    const result = redactSessionValue(input);
    expect(JSON.stringify(result.value)).not.toContain('redaction-canary');
    expect(result.value.id).toBe('session-1');
    expect(input.nested[0]['redaction-canary-key']).toBe('redaction-canary-value');
    expect(result.decisions['fixture-credential']).toBe(2);
    const native = sanitizeNativeExtensions({
      ['redaction-canary-native-key']: { name: 'safe' },
      password: { name: 'otherwise-safe' },
      dataBytes: [70, 65, 75, 69],
    });
    expect(JSON.stringify(native.value)).not.toContain('redaction-canary');
    expect(native.value.password).toBe('[REDACTED:sensitive-field]');
    expect(sanitizeNativeExtensions({ tokenCount: 42 }).value.tokenCount).toBe(42);
    expect(native.value.dataBytes).toBe('[REDACTED:content]');
  });

  it('bounds redaction of a 32 MiB record with malformed key blocks and long near matches', () => {
    const chunk = '-----BEGIN PRIVATE KEY-----\n'.repeat(32)
      + 'password' + ' '.repeat(1024) + 'end\n'
      + 'eyJ' + 'a-'.repeat(1024) + '\n'
      + 'a.'.repeat(1024) + '\n';
    const text = chunk.repeat(Math.ceil(32 * 1024 * 1024 / chunk.length)).slice(0, 32 * 1024 * 1024);
    const started = performance.now();
    const result = redactSessionText(text);
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(result.text).toBe('[REDACTED:private-key]');
    // Exercise every regex on a large record as well as the unfinished-key scanner.
    const nearMatch = 'ordinary prose password' + ' '.repeat(1024) + '\neyJ' + 'a-'.repeat(1024) + '\n' + 'a.'.repeat(1024) + '\n';
    const plain = nearMatch.repeat(Math.ceil(32 * 1024 * 1024 / nearMatch.length)).slice(0, 32 * 1024 * 1024);
    const plainStarted = performance.now();
    const redacted = redactSessionText(plain + '\n' + syntheticSecrets[0][1]);
    expect(performance.now() - plainStarted).toBeLessThan(10_000);
    expect(redacted.text).toBe(plain + '\n[REDACTED:provider-token]');
  }, 25_000);

  it('requires operation-specific network consent', () => {
    expect(() => requireNetworkConsent('codex.export', 'claude.export')).toThrowError(
      expect.objectContaining<Partial<SessionContractError>>({ code: 'NETWORK_NOT_AUTHORIZED' }),
    );
    expect(() => requireNetworkConsent('codex.export', 'codex.export')).not.toThrow();
  });

  it('prefilters workspace and provider authorization before ranking', () => {
    const visible = prefilterAuthorizedSearchScope([
      { workspaceId: 'one', provider: 'claude', score: 1 },
      { workspaceId: 'two', provider: 'claude', score: 100 },
      { workspaceId: 'one', provider: 'codex', score: 50 },
    ], { workspaceId: 'one', providers: ['claude'] });
    expect(visible).toEqual([{ workspaceId: 'one', provider: 'claude', score: 1 }]);
  });
});
