import { mkdtemp } from '../../helpers/temp-dir.js';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  SessionSourceAdapterRegistry,
  fingerprintSourceFile,
  readBoundedJsonLines,
  readBoundedJson,
  readBoundedText,
  streamBoundedJsonLines,
  redactSourceLocator,
  type SessionSourceAdapter,
} from '../../../src/sessions/index.js';

const execFileAsync = promisify(execFile);

function fixtureAdapter(overrides: Partial<SessionSourceAdapter> = {}): SessionSourceAdapter {
  return {
    provider: 'generic',
    adapterVersion: '1.2.3',
    disposition: 'implemented',
    supportedOperations: ['discover', 'inspect', 'stream'],
    acquisitionModes: ['manual-export', 'jsonl'],
    async *discover(scope) {
      for (const root of scope.allowedRoots) {
        yield { provider: 'generic', locator: join(root, 'session.jsonl'), locatorClass: 'authorized-root' };
      }
    },
    async inspect() {
      return { sourceSchemaVersion: '1.0.0', consistency: 'complete', operationalState: 'available' };
    },
    async *stream() {},
    ...overrides,
  };
}

describe('session source adapter registry', () => {
  it('discovers only within explicitly authorized roots', async () => {
    const registry = new SessionSourceAdapterRegistry();
    registry.register(fixtureAdapter());
    await expect(collect(registry.discover('generic', {
      workspaceId: 'workspace-1', allowedRoots: [],
    }))).rejects.toMatchObject({ code: 'SOURCE_NOT_AUTHORIZED' });
    await expect(collect(registry.discover('generic', {
      workspaceId: 'workspace-1', allowedRoots: ['/explicit/root'],
    }))).resolves.toEqual([{
      provider: 'generic',
      locator: '/explicit/root/session.jsonl',
      locatorClass: 'authorized-root',
    }]);
  });

  it('represents explicitly authorized account discovery without a filesystem root', async () => {
    const registry = new SessionSourceAdapterRegistry();
    registry.register(fixtureAdapter({
      acquisitionModes: ['api'],
      async *discover(scope) {
        for (const account of scope.authorizedAccounts ?? []) {
          yield { provider: 'generic', locator: account, locatorClass: 'authorized-account' };
        }
      },
    }));
    await expect(collect(registry.discover('generic', {
      workspaceId: 'workspace-1', allowedRoots: [], authorizedAccounts: ['account-1'],
    }))).resolves.toEqual([{
      provider: 'generic', locator: 'account-1', locatorClass: 'authorized-account',
    }]);
  });

  it('rejects unsupported operations before invoking an adapter', () => {
    const discover = vi.fn();
    const registry = new SessionSourceAdapterRegistry();
    registry.register(fixtureAdapter({
      supportedOperations: ['inspect'],
      async *discover() { discover(); },
    }));
    expect(() => registry.assertOperation('generic', 'discover'))
      .toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_OPERATION' }));
    expect(discover).not.toHaveBeenCalled();
  });

  it('reports independent classification, state, evidence, modes, and remediation', () => {
    const registry = new SessionSourceAdapterRegistry();
    registry.register(fixtureAdapter());
    expect(registry.report('generic', {
      state: 'unavailable',
      evidence: { adapterVersion: '1.2.3', verifiedAt: '2026-07-26', reference: 'fixture-contract' },
      reason: 'manual export not selected',
      remediation: 'select an exported JSONL file',
    })).toMatchObject({
      provider: 'generic',
      classification: 'implemented',
      state: 'unavailable',
      supportedOperations: ['discover', 'inspect', 'stream'],
      acquisitionModes: ['manual-export', 'jsonl'],
      reason: 'manual export not selected',
    });
  });

  it('redacts normal diagnostic locators', () => {
    const redacted = redactSourceLocator('/Users/operator/secret-workspace/session 1.jsonl');
    expect(redacted).toBe('<session-source>/session_1.jsonl');
    expect(redacted).not.toContain('operator');
  });
});

describe('bounded session readers', () => {
  it.each([
    ['maxRecordBytes', 1, 40],
    ['maxTotalBytes', 1, 40],
    ['maxRecords', 1, 2],
    ['maxNestingDepth', 0, 1],
  ] as const)('identifies the configured and observed %s JSONL limit', async (limit, configured, observed) => {
    const root = await mkdtemp(join(tmpdir(), 'session-reader-limit-'));
    const path = join(root, 'session.jsonl');
    const content = JSON.stringify({ text: 'synthetic-transcript-marker' }) + '\n';
    await writeFile(path, content.repeat(2));
    await expect(readBoundedJsonLines({ selectedPath: path, allowedRoots: [root] }, {
      consistency: 'complete', limits: { [limit]: configured },
    })).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED',
      detail: { limit, configured, observed: limit.endsWith('Bytes') ? Buffer.byteLength(content) : observed },
    });
  });

  it.each([readBoundedJson, readBoundedText])('reports whole-document byte limits without source text', async (read) => {
    const root = await mkdtemp(join(tmpdir(), 'session-document-limit-'));
    const path = join(root, 'session.json');
    const content = JSON.stringify({ text: 'synthetic-transcript-marker' });
    await writeFile(path, content);
    await expect(read({ selectedPath: path, allowedRoots: [root] }, { maxTotalBytes: 1 }))
      .rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED', detail: {
        limit: 'maxTotalBytes', configured: 1, observed: Buffer.byteLength(content),
      } });
  });

  it('reports malformed JSON at the root without including parser input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-json-rejection-'));
    const path = join(root, 'session.json');
    await writeFile(path, '{"text":"synthetic-transcript-marker"');
    for (const read of [
      () => readBoundedJson({ selectedPath: path, allowedRoots: [root] }),
      () => readBoundedJsonLines({ selectedPath: path, allowedRoots: [root] }, { consistency: 'complete' }),
    ]) {
      await expect(read()).rejects.toMatchObject({ code: 'SCHEMA_DRIFT', detail: {
        issues: [{ path: '<root>', code: 'invalid_json' }],
      } });
    }
  });

  it('reads complete JSONL records with stable byte cursors and fingerprints', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-reader-'));
    const path = join(root, 'session.jsonl');
    await writeFile(path, '{"id":1}\n{"id":2}\n');
    const authorization = { selectedPath: path, allowedRoots: [root], maxBytes: 1024 };
    const result = await readBoundedJsonLines(authorization, { consistency: 'complete' });
    expect(result.records.map((record) => record.value)).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.nextCursor).toBe('18');
    expect(result.incompleteTail).toBe(false);
    await expect(fingerprintSourceFile(authorization)).resolves.toMatchObject({
      digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      size: 18,
    });
  });

  it.each(['complete', 'provisional'] as const)(
    'preserves raw U+2028 and U+2029 across chunks with byte-exact cursors in %s mode',
    async (consistency) => {
      const root = await mkdtemp(join(tmpdir(), 'session-reader-unicode-'));
      const path = join(root, 'session.jsonl');
      const prefix = '\r\n \t\n';
      // Put the first separator across the stream's 64 KiB chunk boundary.
      const values = [
        { text: 'x'.repeat(64 * 1024 - Buffer.byteLength(prefix + '{"text":"') - 1) + '\u2028\u2029é' },
        { text: 'a\u2028b\u2029c' },
      ];
      const lines = values.map((value, index) => JSON.stringify(value) + (index === 0 ? '\r\n' : ''));
      const bytes = prefix + lines.join('');
      expect(bytes).toContain('\u2028');
      expect(bytes).toContain('\u2029');
      await writeFile(path, bytes);
      const authorization = { selectedPath: path, allowedRoots: [root] };
      const result = await readBoundedJsonLines(authorization, {
        consistency,
        limits: {
          maxRecordBytes: Math.max(...lines.map((line) => Buffer.byteLength(line))),
          maxTotalBytes: Buffer.byteLength(bytes),
        },
      });
      let offset = Buffer.byteLength(prefix);
      expect(result.records).toEqual(lines.map((line, sequence) => {
        const record = {
          value: values[sequence], sequence, byteOffset: offset, byteLength: Buffer.byteLength(line),
        };
        offset += record.byteLength;
        return record;
      }));
      expect(result.bytesRead).toBe(Buffer.byteLength(bytes));
      expect(result.nextCursor).toBe(String(Buffer.byteLength(bytes)));
      expect(result.incompleteTail).toBe(false);
      const resumed = await readBoundedJsonLines(authorization, {
        consistency, cursor: String(Buffer.byteLength(prefix + lines[0])),
      });
      expect(resumed.records).toEqual([{ ...result.records[1], sequence: 0 }]);
      expect(resumed.bytesRead).toBe(Buffer.byteLength(lines[1]));
      expect(resumed.nextCursor).toBe(result.nextCursor);
      await expect(readBoundedJsonLines(authorization, {
        consistency, cursor: result.nextCursor,
      })).resolves.toMatchObject({ records: [], bytesRead: 0, nextCursor: result.nextCursor });
    },
  );

  it.each(['complete', 'provisional'] as const)('treats lone CR as JSON whitespace in %s mode', async (consistency) => {
    const root = await mkdtemp(join(tmpdir(), 'session-reader-cr-'));
    const path = join(root, 'session.jsonl');
    const content = '{"id":\r1}\n';
    await writeFile(path, content);
    await expect(readBoundedJsonLines({ selectedPath: path, allowedRoots: [root] }, { consistency }))
      .resolves.toMatchObject({
        records: [{ value: { id: 1 }, byteOffset: 0, byteLength: Buffer.byteLength(content) }],
        nextCursor: String(Buffer.byteLength(content)), incompleteTail: false,
      });
  });

  it.each(['maxRecordBytes', 'maxTotalBytes'] as const)(
    'counts CRLF bytes toward %s', async (limit) => {
      const root = await mkdtemp(join(tmpdir(), 'session-reader-crlf-limit-'));
      const path = join(root, 'session.jsonl');
      const content = JSON.stringify({ text: 'a\u2028b\u2029c' }) + '\r\n';
      const observed = Buffer.byteLength(content);
      await writeFile(path, content);
      await expect(readBoundedJsonLines({ selectedPath: path, allowedRoots: [root] }, {
        consistency: 'complete', limits: { [limit]: observed - 1 },
      })).rejects.toMatchObject({
        code: 'RESOURCE_LIMIT_EXCEEDED', detail: { limit, configured: observed - 1, observed },
      });
    },
  );

  it.each(['maxRecordBytes', 'maxTotalBytes'] as const)(
    'enforces %s before assembling an oversized unterminated line', async (limit) => {
      const root = await mkdtemp(join(tmpdir(), 'session-reader-unbounded-'));
      const path = join(root, 'session.jsonl');
      const content = JSON.stringify({ text: 'x'.repeat(1024 * 1024) });
      await writeFile(path, content);
      await expect(readBoundedJsonLines({ selectedPath: path, allowedRoots: [root] }, {
        consistency: 'complete', limits: { [limit]: 64 * 1024 },
      })).rejects.toSatisfy((error: { code: string; detail: { limit: string; observed: number } }) => {
        expect(error.code).toBe('RESOURCE_LIMIT_EXCEEDED');
        expect(error.detail.limit).toBe(limit);
        expect(error.detail.observed).toBeGreaterThan(64 * 1024);
        expect(error.detail.observed).toBeLessThanOrEqual(128 * 1024);
        return true;
      });
    },
  );

  it('resumes an incomplete provisional tail after Unicode records and CRLF blank lines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-reader-unicode-tail-'));
    const path = join(root, 'session.jsonl');
    const prefix = JSON.stringify({ text: 'a\u2028b\u2029c' }) + '\r\n\r\n';
    const tail = '{"text":"d\u2028e\u2029f';
    await writeFile(path, prefix + tail);
    const authorization = { selectedPath: path, allowedRoots: [root] };
    const result = await readBoundedJsonLines(authorization, { consistency: 'provisional' });
    expect(result.records.map((record) => record.value)).toEqual([{ text: 'a\u2028b\u2029c' }]);
    expect(result.bytesRead).toBe(Buffer.byteLength(prefix));
    expect(result.nextCursor).toBe(String(Buffer.byteLength(prefix)));
    expect(result.incompleteTail).toBe(true);
    await writeFile(path, '"}\r\n', { flag: 'a' });
    const resumed = await readBoundedJsonLines(authorization, {
      consistency: 'provisional', cursor: result.nextCursor,
    });
    expect(resumed.records).toEqual([{
      value: { text: 'd\u2028e\u2029f' }, sequence: 0,
      byteOffset: Buffer.byteLength(prefix), byteLength: Buffer.byteLength(tail + '"}\r\n'),
    }]);
    expect(resumed.nextCursor).toBe(String(Buffer.byteLength(prefix + tail + '"}\r\n')));
    expect(resumed.incompleteTail).toBe(false);
  });

  it('pulls records on demand and stops source consumption on cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-reader-stream-'));
    const path = join(root, 'large.jsonl');
    await writeFile(path, Array.from(
      { length: 10_000 },
      (_, index) => JSON.stringify({ id: index }),
    ).join('\n') + '\n');
    const stream = await streamBoundedJsonLines(
      { selectedPath: path, allowedRoots: [root] },
      { consistency: 'complete' },
    );
    expect(stream.recordsRead).toBe(0);
    expect(stream.bytesRead).toBe(0);
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { value: { id: 0 }, sequence: 0 },
    });
    expect(stream.recordsRead).toBe(1);
    expect(stream.bytesRead).toBeGreaterThan(0);
    await iterator.return?.();
    expect(stream.recordsRead).toBe(1);
  });

  it('streams one million records with source-size-independent retained memory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-reader-million-'));
    const path = join(root, 'million.jsonl');
    await writeFile(path, '{"ok":1}\n'.repeat(1_000_000));
    const probe = fileURLToPath(new URL('../../fixtures/sessions/reader-retained-memory.ts', import.meta.url));
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--expose-gc', '--import', 'tsx', probe, path, root],
      { timeout: 20_000, maxBuffer: 64 * 1024 },
    );
    const result = JSON.parse(stdout) as {
      count: number;
      recordsRead: number;
      first: unknown;
      last: unknown;
      retainedPeakGrowthBytes: number;
    };
    expect(result).toMatchObject({
      count: 1_000_000,
      recordsRead: 1_000_000,
      first: { ok: 1 },
      last: { ok: 1 },
    });
    expect(result.retainedPeakGrowthBytes).toBeLessThan(32 * 1024 * 1024);
  }, 30_000);

  it('ignores an incomplete active tail without advancing past it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-reader-tail-'));
    const path = join(root, 'active.jsonl');
    await writeFile(path, '{"id":1}\n{"id":');
    const result = await readBoundedJsonLines(
      { selectedPath: path, allowedRoots: [root] },
      { consistency: 'provisional' },
    );
    expect(result.records).toHaveLength(1);
    expect(result.nextCursor).toBe('9');
    expect(result.incompleteTail).toBe(true);
  });

  it('fails closed for malformed snapshots and resource violations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-reader-invalid-'));
    const path = join(root, 'invalid.jsonl');
    await writeFile(path, '{"nested":{"too":{"deep":true}}}\n');
    await expect(readBoundedJsonLines(
      { selectedPath: path, allowedRoots: [root] },
      { consistency: 'complete', limits: { maxNestingDepth: 1 } },
    )).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
    await writeFile(path, '{"broken":\n');
    await expect(readBoundedJsonLines(
      { selectedPath: path, allowedRoots: [root] },
      { consistency: 'complete' },
    )).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
  });

  it('does not leak source paths through authorization errors', async () => {
    const secretPath = '/private/operator/session-secret.jsonl';
    await expect(readBoundedJsonLines(
      { selectedPath: secretPath, allowedRoots: ['/private/operator'] },
      { consistency: 'complete' },
    )).rejects.toSatisfy((error: Error) => !error.message.includes(secretPath));
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
