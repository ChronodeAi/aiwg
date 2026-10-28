import { describe, expect, it } from 'vitest';
import { createForgeAuditTracker } from '../../../src/tracker/issue-pages.js';
import { type ForgeTransport, type ForgeProvider } from '../../../src/tracker/forge-http.js';
import { encodeAuditCursor } from '../../../src/issues/audit-contract.js';

function fixture(provider: ForgeProvider, count = 55) {
  const calls: string[] = [];
  const issues = Array.from({ length: count }, (_, i) => ({ number: i + 1, title: `Issue ${i + 1}`,
    body: 'LIST BODY MUST BE DISCARDED', labels: [{ name: 'task' }], state: 'open', updated_at: '2026-10-01T00:00:00Z' }));
  const transport: ForgeTransport = async path => {
    calls.push(path);
    const url = new URL(path, 'https://fixture.invalid');
    let result: unknown;
    let headers: Record<string, string> = {};
    if (url.pathname.endsWith('/comments')) {
      const page = Number(url.searchParams.get('page'));
      result = page === 1 ? Array.from({ length: 25 }, (_, i) => ({ id: i + 1, body: `comment ${i}` })) : [{ id: 26, body: 'last comment' }];
      headers = page === 1 ? { link: '<https://fixture.invalid/comments?page=2>; rel="next"' } : {};
    } else if (/\/issues\/\d+$/.test(url.pathname)) {
      result = { ...issues[Number(url.pathname.split('/').at(-1)) - 1], body: 'SELECTED BODY' };
    } else {
      const page = Number(url.searchParams.get('page'));
      const size = Number(url.searchParams.get(provider === 'github' ? 'per_page' : 'limit'));
      result = issues.slice((page - 1) * size, page * size);
      headers = { 'x-total-count': String(issues.length) };
      if (provider === 'gitea') headers['x-hasmore'] = String(page * size < issues.length);
      else if (page * size < issues.length) headers.link = `<https://fixture.invalid/issues?page=${page + 1}>; rel="next"`;
    }
    return { status: 200, headers, body: Buffer.from(JSON.stringify(result)) };
  };
  return { tracker: createForgeAuditTracker(provider, 'owner/repo', transport), transport, calls, issues };
}

describe.each(['gitea', 'github'] as const)('%s bounded audit client', provider => {
  const options = { cursor: null, pageSize: 25, maxBytes: 40_000, filter: 'status:open label:task' };

  it('paginates metadata without exposing bodies and hydrates only one selected thread', async () => {
    const fake = fixture(provider);
    const first = await fake.tracker.listMetadata(options);
    expect(first.items).toHaveLength(25);
    expect(JSON.stringify(first)).not.toContain('LIST BODY');
    const second = await fake.tracker.listMetadata({ ...options, cursor: first.nextCursor });
    const last = await fake.tracker.listMetadata({ ...options, cursor: second.nextCursor });
    expect(last).toMatchObject({ complete: true, nextCursor: null });
    expect([...first.items, ...second.items, ...last.items].map(i => i.id)).toEqual(fake.issues.map(i => String(i.number)));
    expect(fake.calls.every(c => !/\/issues\/\d+/.test(c))).toBe(true);
    const content = await fake.tracker.hydrate(first.items[3], { maxBytes: 40_000 });
    expect(content.body).toBe('SELECTED BODY');
    expect(content.comments).toHaveLength(26);
    expect(fake.calls.filter(c => /\/issues\/\d+/.test(c))).toHaveLength(3);
  });

  it('invalidates malformed or mismatched cursors', async () => {
    const fake = fixture(provider);
    for (const cursor of ['invalid', encodeAuditCursor(null), encodeAuditCursor({ page: 2 })]) {
      await expect(fake.tracker.listMetadata({ ...options, cursor })).rejects.toThrow('cursor-invalidated');
    }
    const first = await fake.tracker.listMetadata(options);
    await expect(fake.tracker.listMetadata({ ...options, pageSize: 10, cursor: first.nextCursor })).rejects.toThrow('cursor-invalidated');
  });

  it('detects deleted or edited page boundaries instead of silently skipping issues', async () => {
    const fake = fixture(provider);
    const first = await fake.tracker.listMetadata(options);
    fake.issues.shift();
    await expect(fake.tracker.listMetadata({ ...options, cursor: first.nextCursor })).rejects.toThrow('tracker-changed');
  });

  it('detects a changed issue before hydrating its comments', async () => {
    const fake = fixture(provider);
    const first = await fake.tracker.listMetadata(options);
    fake.issues[0].updated_at = '2026-10-02T00:00:00Z';
    await expect(fake.tracker.hydrate(first.items[0], { maxBytes: 40_000 })).rejects.toThrow('tracker-changed');
    expect(fake.calls.some(c => c.includes('/comments'))).toBe(false);
  });

  it('enforces metadata and hydration byte bounds', async () => {
    const fake = fixture(provider);
    await expect(fake.tracker.listMetadata({ ...options, maxBytes: 10 })).rejects.toThrow('byte-budget');
    const first = await fake.tracker.listMetadata(options);
    await expect(fake.tracker.hydrate(first.items[0], { maxBytes: 10 })).rejects.toThrow('byte-budget');
  });

  it('classifies provider errors without propagating their body', async () => {
    const tracker = createForgeAuditTracker(provider, 'owner/repo', async () => ({ status: 503, headers: {}, body: Buffer.from('private error') }));
    await expect(tracker.listMetadata(options)).rejects.toThrow('server-error');
  });

  it('probes an ambiguous full page and excludes GitHub pull requests from metadata', async () => {
    const fake = fixture(provider, 25);
    const tracker = createForgeAuditTracker(provider, 'owner/repo', async (path, signal) => {
      const response = await fake.transport(path, signal);
      const raw = JSON.parse(Buffer.from(response.body).toString());
      if (provider === 'github' && Array.isArray(raw) && raw.length) raw[0].pull_request = {};
      return { ...response, headers: {}, body: Buffer.from(JSON.stringify(raw)) };
    });
    const first = await tracker.listMetadata(options);
    expect(first.complete).toBe(false);
    expect(first.items).toHaveLength(provider === 'github' ? 24 : 25);
    const last = await tracker.listMetadata({ ...options, cursor: first.nextCursor });
    expect(last).toMatchObject({ complete: true, items: [], nextCursor: null });
  });
});
