// Cursor-paged, metadata-only backlog views over the existing bounded forge transport.
import {
  createForgeReader, parseForgeJson, forgePagination, ForgeReadError,
  type ForgeTransport, type ForgeProvider,
} from './forge-http.js';
import {
  AuditStop, auditDigest, boundedPageSize, decodeAuditCursor, encodeAuditCursor, parseAuditFilter,
  type AuditTracker, type AuditMetadata,
} from '../issues/audit-contract.js';

interface Cursor { scope: string; page: number; previous: string; total?: number }

export function createForgeAuditTracker(provider: ForgeProvider, repository: string, transport: ForgeTransport,
  identity = `${provider}:${repository}`): AuditTracker {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || repository.split('/').some(p => p === '.' || p === '..')) {
    throw new AuditStop('tracker-repository-invalid');
  }
  const root = `/repos/${repository.split('/').map(encodeURIComponent).join('/')}/issues`;
  const sizeKey = provider === 'github' ? 'per_page' : 'limit';
  const object = (raw: unknown): Record<string, unknown> => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ForgeReadError('malformed');
    return raw as Record<string, unknown>;
  };
  return {
    identity,
    async listMetadata(options) {
      const size = boundedPageSize(options.pageSize);
      const filter = parseAuditFilter(options.filter);
      const scope = auditDigest([identity, size, filter]);
      const cursor = options.cursor ? decodeAuditCursor<Cursor>(options.cursor) : null;
      if (options.cursor && (!cursor || typeof cursor !== 'object')) throw new AuditStop('cursor-invalidated');
      if (cursor && (cursor.scope !== scope || !Number.isSafeInteger(cursor.page) || cursor.page < 2
        || typeof cursor.previous !== 'string')) throw new AuditStop('cursor-invalidated');
      const read = async (page: number) => {
        const query = new URLSearchParams({ state: filter.status, sort: provider === 'gitea' ? 'oldest' : 'created', direction: 'asc',
          page: String(page), [sizeKey]: String(size), ...(provider === 'gitea' ? { type: 'issues' } : {}) });
        if (filter.labels.length) query.set('labels', filter.labels.join(','));
        const response = await transport(`${root}?${query}`, options.signal);
        if (response.body.length > options.maxBytes) throw new AuditStop('byte-budget');
        const raw = parseForgeJson(response);
        if (!Array.isArray(raw) || raw.length > size) throw new ForgeReadError('malformed');
        const records = raw.map(object);
        const items: AuditMetadata[] = records.filter(r => !r.pull_request).map(r => {
          const number = r.number ?? r.index;
          if (!Number.isSafeInteger(number) || Number(number) < 1 || typeof r.title !== 'string'
            || typeof r.updated_at !== 'string' || (r.state !== 'open' && r.state !== 'closed')) throw new ForgeReadError('malformed');
          return { id: String(number), title: r.title, status: r.state, updatedAt: r.updated_at,
            labels: Array.isArray(r.labels) ? r.labels.map(l => typeof l === 'string' ? l : String(object(l).name ?? '')) : [] };
        });
        // Fingerprint includes PR positions, but excludes bodies/comments discarded at this boundary.
        const fingerprint = auditDigest(records.map(r => [r.number ?? r.index, r.updated_at, r.state, r.title, r.labels]));
        const pagination = forgePagination(response.headers, raw, page, size);
        return { items, fingerprint, pagination, bytes: response.body.length };
      };
      let verifiedBytes = 0;
      if (cursor) {
        // Offset APIs cannot guarantee a snapshot. Refuse shifted/edited boundaries instead of claiming completeness.
        const previous = await read(cursor.page - 1);
        verifiedBytes = previous.bytes;
        if (previous.fingerprint !== cursor.previous || previous.pagination.totalCount !== cursor.total) {
          throw new AuditStop('tracker-changed');
        }
      }
      const pageNumber = cursor?.page ?? 1;
      const page = await read(pageNumber);
      if (cursor && page.pagination.totalCount !== cursor.total) throw new AuditStop('tracker-changed');
      if (page.bytes + verifiedBytes > options.maxBytes) throw new AuditStop('byte-budget');
      // A full page lacking pagination headers needs one bounded probe, never a false complete result.
      const next = page.pagination.nextPage ?? (!page.pagination.complete && page.pagination.items.length === size ? pageNumber + 1 : null);
      if (next !== null && next <= pageNumber) throw new AuditStop('cursor-invalidated');
      return { items: page.items, bytes: page.bytes + verifiedBytes,
        complete: next === null && page.pagination.complete,
        nextCursor: next === null ? null : encodeAuditCursor({ scope, page: next, previous: page.fingerprint, total: page.pagination.totalCount }) };
    },
    async hydrate(issue, options) {
      if (!/^[1-9]\d*$/.test(issue.id)) throw new AuditStop('invalid-issue-id');
      const response = await transport(`${root}/${issue.id}`, options.signal);
      if (response.body.length > options.maxBytes) throw new AuditStop('byte-budget');
      const raw = object(parseForgeJson(response));
      if (raw.updated_at !== issue.updatedAt) throw new AuditStop('tracker-changed');
      const body = typeof raw.body === 'string' ? raw.body : '';
      const comments: string[] = [];
      let bytes = response.body.length;
      const reader = createForgeReader(provider, async (path, signal) => {
        const response = await transport(path, signal);
        bytes += response.body.length;
        if (bytes > options.maxBytes) throw new AuditStop('byte-budget');
        return response;
      }, { pageSize: 25 });
      for (let page = 1; ; page++) {
        const result = await reader.listIssueComments(repository, Number(issue.id), page, options.signal);
        comments.push(...result.items.map(c => c.body));
        if (result.complete) break;
        if (!result.items.length) throw new AuditStop('pagination-incomplete');
        if (result.nextPage !== null && result.nextPage !== page + 1) throw new AuditStop('cursor-invalidated');
        if (!result.nextPage && result.items.length < reader.pageSize) throw new AuditStop('pagination-incomplete');
      }
      return { body, comments, bytes };
    },
  };
}
