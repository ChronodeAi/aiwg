// Adapt the existing local issue index and selective issue reads to the audit envelope.
import { readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { LocalIssueProviderCore } from './local.js';
import { AuditStop, auditDigest, auditBytes, boundedPageSize, decodeAuditCursor,
  encodeAuditCursor, parseAuditFilter, type AuditTracker } from './audit-contract.js';

export function createLocalAuditTracker(root: string): AuditTracker {
  const provider = new LocalIssueProviderCore(root);
  const identity = `local:${root}`;
  return {
    identity,
    async listMetadata(options) {
      options.signal?.throwIfAborted();
      const size = boundedPageSize(options.pageSize);
      const filter = parseAuditFilter(options.filter);
      // Hash metadata only. Any changed index invalidates an offset cursor, avoiding silent omissions.
      const fingerprint = auditDigest(await readFile(join(root, 'index/issues.index.json'), 'utf8'));
      const scope = auditDigest([identity, size, filter]);
      const cursor = options.cursor ? decodeAuditCursor<{ scope: string; fingerprint: string; offset: string }>(options.cursor) : null;
      if (options.cursor && (!cursor || typeof cursor !== 'object')) throw new AuditStop('cursor-invalidated');
      if (cursor && (cursor.scope !== scope || typeof cursor.offset !== 'string' || !/^\d+$/.test(cursor.offset))) {
        throw new AuditStop('cursor-invalidated');
      }
      if (cursor && cursor.fingerprint !== fingerprint) throw new AuditStop('tracker-changed');
      const result = await provider.listIssues({ limit: size, cursor: cursor?.offset,
        filter: { status: filter.status === 'all' ? undefined : filter.status, labels: filter.labels } });
      if (auditDigest(await readFile(join(root, 'index/issues.index.json'), 'utf8')) !== fingerprint) throw new AuditStop('tracker-changed');
      const items = result.issues.map(i => ({ id: i.id, title: i.title, status: i.status,
        labels: [...i.labels, i.type, i.priority], updatedAt: i.updated_at }));
      const bytes = auditBytes(items);
      if (bytes > options.maxBytes) throw new AuditStop('byte-budget');
      return { items, bytes, complete: !result.nextCursor,
        nextCursor: result.nextCursor ? encodeAuditCursor({ scope, fingerprint, offset: result.nextCursor }) : null };
    },
    async hydrate(issue, options) {
      options.signal?.throwIfAborted();
      if (!/^[A-Z][A-Z0-9]*-\d+$/.test(issue.id)) throw new AuditStop('invalid-issue-id');
      // Preflight the selected files before the existing reader loads any bodies.
      let bytes = 0;
      const account = async (file: string) => {
        const size = await stat(file).then(s => s.size).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return 0;
          throw error;
        });
        bytes += size;
        if (bytes > options.maxBytes) throw new AuditStop('byte-budget');
      };
      await account(join(root, 'items', `${issue.id}.md`));
      const eventsPath = join(root, 'events', `${issue.id}.jsonl`);
      await account(eventsPath);
      const events = await readFile(eventsPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      for (const line of events.split(/\r?\n/).filter(Boolean)) {
        const event = JSON.parse(line) as { body_path?: string };
        if (!event.body_path) continue;
        const file = resolve(root, event.body_path);
        if (!file.startsWith(resolve(root) + sep)) throw new AuditStop('invalid-comment-path');
        await account(file);
      }
      const record = await provider.getIssue(issue.id, { body: true, comments: 'all' });
      if (record.fields.updated_at !== issue.updatedAt) throw new AuditStop('tracker-changed');
      const content = { body: record.body, comments: record.events.filter(e => e.type === 'comment').map(e => e.body ?? '') };
      bytes = Math.max(bytes, auditBytes(content));
      if (bytes > options.maxBytes) throw new AuditStop('byte-budget');
      return { ...content, bytes };
    },
  };
}
