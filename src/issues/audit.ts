// Execute bounded audit batches with atomic, content-minimized item checkpoints.
import { readFile } from 'node:fs/promises';
import { atomicConfigWrite } from '../config/worker-write.js';
import { acquireDirectoryLock, DirectoryLockContentionError } from '../artifacts/prebuilt-build-lock.js';
import { ForgeReadError } from '../tracker/forge-http.js';
import { AuditStop, auditDigest, auditBytes, boundedPageSize, parseAuditFilter,
  type AuditTracker, type AuditMetadata, type AuditFinding, type AuditCheckpoint, type AuditReport, type AuditContent,
} from './audit-contract.js';

export interface AuditOptions {
  checkpoint: string;
  filter?: string;
  guidance?: string;
  pageSize?: number;
  /** Per invocation; reruns receive a fresh item/context budget. */
  maxItems?: number;
  maxPages?: number;
  /** Per page, including metadata and selected hydration. */
  maxBytes?: number;
  maxContextBytes?: number;
  signal?: AbortSignal;
  /** Stable identifier for caller-provided selection/analysis behavior. */
  policyKey?: string;
  select?: (issue: AuditMetadata) => boolean;
  analyze?: (issue: AuditMetadata, content?: AuditContent) => AuditFinding;
  /** Test/integration hook, called only after an item's durable commit. */
  afterItem?: (id: string) => void;
}

export const needsAuditContent = (issue: AuditMetadata): boolean =>
  /\b(epic|deferred|duplicate|superseded|fixed)\b/i.test(`${issue.title} ${issue.labels.join(' ')}`);

/** Deterministic triage candidates; deeper semantic conclusions belong to the auditor. */
export function auditFinding(issue: AuditMetadata, content?: AuditContent): AuditFinding {
  const text = `${issue.title} ${issue.labels.join(' ')}`;
  const references = content && /(?:#\d+|[A-Z][A-Z0-9]*-\d+)/.test(`${content.body}\n${content.comments.join('\n')}`);
  if (/\b(blocker|critical|P[01])\b/i.test(text)) return { id: issue.id, category: 'High Priority', recommendation: 'Review blocker for address-issues' };
  if (/\bepic\b/i.test(text)) return { id: issue.id, category: 'Epic Hygiene', recommendation: references
    ? 'Check linked child status and acceptance against current issues' : 'Add child issue references before checking epic completion' };
  if (/\b(duplicate|overlap)\b/i.test(text)) return { id: issue.id, category: 'Duplicate / Relationship Candidates', recommendation: references
    ? 'Verify overlap with referenced issues before recommending cleanup' : 'Identify a related issue before recommending duplicate cleanup' };
  if (/\b(deferred|superseded|fixed)\b/i.test(text)) return { id: issue.id, category: 'Cleanup Candidates', recommendation:
    content && !/\b\d{4}-\d{2}-\d{2}\b/.test(`${content.body}\n${content.comments.join('\n')}`)
      ? 'Add a follow-up date and verify the cleanup decision' : 'Verify cleanup decision and follow-up date' };
  return { id: issue.id, category: 'Next Actions', recommendation: content && !content.body.trim()
    ? 'Add issue context and acceptance criteria' : 'Review priority and scope before address-issues' };
}

async function loadCheckpoint(file: string, scope: string): Promise<AuditCheckpoint> {
  let raw: string;
  try { raw = await readFile(file, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { version: 1, scope, cursor: null, pending: [], pageComplete: false, finished: false,
      completed: [], findings: [], totalSeen: 0, totalHydrated: 0 };
  }
  let value: AuditCheckpoint;
  try { value = JSON.parse(raw) as AuditCheckpoint; } catch { throw new AuditStop('checkpoint-invalid'); }
  if (!value || value.version !== 1 || value.scope !== scope || !Array.isArray(value.completed)
    || !Array.isArray(value.pending) || !Array.isArray(value.findings)
    || typeof value.finished !== 'boolean' || typeof value.pageComplete !== 'boolean'
    || !(value.cursor === null || typeof value.cursor === 'string')
    || !Number.isSafeInteger(value.totalSeen) || value.totalSeen < 0
    || !Number.isSafeInteger(value.totalHydrated) || value.totalHydrated < 0
    || value.totalHydrated > value.completed.length || value.totalSeen < value.completed.length
    || new Set(value.completed).size !== value.completed.length
    || value.completed.some(id => typeof id !== 'string')
    || value.pending.some(i => !i || typeof i.id !== 'string' || typeof i.title !== 'string'
      || typeof i.status !== 'string' || typeof i.updatedAt !== 'string' || !Array.isArray(i.labels)
      || i.labels.some(l => typeof l !== 'string') || value.completed.includes(i.id))
    || new Set(value.pending.map(i => i.id)).size !== value.pending.length
    || value.totalSeen !== value.completed.length + value.pending.length
    || (value.finished && (value.pending.length > 0 || !value.pageComplete || value.cursor !== null))
    || value.findings.length !== value.completed.length
    || value.findings.some((f, i) => !f || f.id !== value.completed[i] || typeof f.recommendation !== 'string')) {
    throw new AuditStop(value?.scope !== scope ? 'checkpoint-scope-mismatch' : 'checkpoint-invalid');
  }
  return value;
}

export async function runIssueAudit(tracker: AuditTracker, options: AuditOptions): Promise<AuditReport> {
  const pageSize = boundedPageSize(options.pageSize ?? 25);
  const maxItems = options.maxItems ?? 250;
  const maxPages = options.maxPages ?? 100;
  const maxBytes = options.maxBytes ?? 65_536;
  const maxContext = options.maxContextBytes ?? 262_144;
  for (const bound of [maxItems, maxPages, maxBytes, maxContext]) {
    if (!Number.isSafeInteger(bound) || bound < 1) throw new AuditStop('invalid-budget');
  }
  const filter = options.filter ?? 'status:open';
  const guidance = options.guidance ?? '';
  parseAuditFilter(filter);
  if ((options.select || options.analyze) && !options.policyKey) throw new AuditStop('policy-key-required');
  const scope = auditDigest([tracker.identity, filter, guidance, pageSize, options.policyKey ?? 'metadata-triage-v1']);
  let release: () => Promise<void>;
  try { release = await acquireDirectoryLock(`${options.checkpoint}.lock`, { timeoutMs: 0, reclaimDeadOwner: true }); } catch (error) {
    if (error instanceof DirectoryLockContentionError) throw new AuditStop('checkpoint-busy');
    throw error;
  }
  try {
    return await execute();
  } finally { await release(); }

  async function execute(): Promise<AuditReport> {
    let state = await loadCheckpoint(options.checkpoint, scope);
    let durable = structuredClone(state);
    const save = async () => {
      try { await atomicConfigWrite(options.checkpoint, `${JSON.stringify(state)}\n`); }
      catch { throw new AuditStop('checkpoint-write-error'); }
      durable = structuredClone(state);
    };
    const completed = new Set(state.completed);
    const batches: AuditReport['batches'] = [];
    const visited = new Set<string | null>();
    let contextBytes = 0;
    let processed = 0;
    let reason: string | null = null;
    let batch = { items: 0, bytes: 0 };
    await save();
    try {
      while (!state.finished) {
        if (options.signal?.aborted) throw new AuditStop('interrupted');
        if (processed >= maxItems) throw new AuditStop('item-budget');
        if (!state.pending.length) {
          if (batches.length >= maxPages) throw new AuditStop('page-budget');
          if (visited.has(state.cursor)) throw new AuditStop('cursor-invalidated');
          if (contextBytes >= maxContext) throw new AuditStop('context-budget');
          const available = Math.min(maxBytes, maxContext - contextBytes);
          const page = await tracker.listMetadata({ cursor: state.cursor, pageSize, maxBytes: available, filter, signal: options.signal })
            .catch(error => { if (error instanceof AuditStop && error.reason === 'byte-budget' && available < maxBytes) throw new AuditStop('context-budget'); throw error; });
          if (page.items.length > pageSize || page.bytes > maxBytes) throw new AuditStop('byte-budget');
          if (page.bytes > maxContext - contextBytes) throw new AuditStop('context-budget');
          if (page.nextCursor !== null && page.nextCursor === state.cursor) throw new AuditStop('cursor-invalidated');
          if (!page.complete && page.nextCursor === null) throw new AuditStop('pagination-incomplete');
          const unique = new Map(page.items.filter(i => !completed.has(i.id)).map(i => [i.id, i]));
          visited.add(state.cursor);
          state.pending = [...unique.values()];
          state.totalSeen += state.pending.length;
          state.cursor = page.nextCursor;
          state.pageComplete = page.complete;
          batch = { items: 0, bytes: page.bytes };
          batches.push(batch);
          contextBytes += page.bytes;
          state.finished = !state.pending.length && state.pageComplete;
          await save();
          if (!state.pending.length) continue;
        } else if (!batches.length) {
          batch = { items: 0, bytes: auditBytes(state.pending) };
          if (batch.bytes > maxBytes) throw new AuditStop('byte-budget');
          contextBytes += batch.bytes;
          batches.push(batch);
        }
        const issue = state.pending[0];
        const metadataBytes = auditBytes(issue);
        if (contextBytes + metadataBytes > maxContext) throw new AuditStop('context-budget');
        let content: AuditContent | undefined;
        if ((options.select ?? needsAuditContent)(issue)) {
          const remaining = Math.min(maxBytes - batch.bytes, maxContext - contextBytes - metadataBytes);
          if (remaining < 1) throw new AuditStop(batch.bytes >= maxBytes ? 'byte-budget' : 'context-budget');
          content = await tracker.hydrate(issue, { maxBytes: remaining, signal: options.signal })
            .catch(error => { if (error instanceof AuditStop && error.reason === 'byte-budget' && remaining < maxBytes - batch.bytes) throw new AuditStop('context-budget'); throw error; });
          if (content.bytes > remaining) throw new AuditStop('byte-budget');
        }
        const finding = (options.analyze ?? auditFinding)(issue, content);
        if (finding.id !== issue.id) throw new AuditStop('finding-id-mismatch');
        state.completed.push(issue.id);
        completed.add(issue.id);
        state.findings.push(finding);
        state.totalHydrated += Number(!!content);
        state.pending.shift();
        state.finished = !state.pending.length && state.pageComplete;
        batch.items++;
        batch.bytes += content?.bytes ?? 0;
        contextBytes += metadataBytes + (content?.bytes ?? 0);
        processed++;
        await save();
        options.afterItem?.(issue.id);
      }
    } catch (error) {
      state = durable;
      reason = options.signal?.aborted ? 'interrupted' : error instanceof AuditStop ? error.reason
        : error instanceof ForgeReadError ? (error.code === 'oversized' ? 'byte-budget' : `tracker-${error.code}`) : 'tracker-error';
    }
    return { mode: 'read-only', guidance,
      coverage: { totalSeen: state.totalSeen, totalHydrated: state.totalHydrated, totalCompleted: state.completed.length,
        incomplete: reason !== null || !state.finished, reason },
      continuation: { checkpoint: options.checkpoint, cursor: state.cursor, pending: state.pending.length },
      batches, findings: state.findings };
  }
}

export function renderIssueAudit(report: AuditReport): string {
  const { coverage: c } = report;
  const lines = ['# Issue Audit', '', 'Mode: read-only', `Guidance: ${report.guidance || 'none'}`, '',
    `Coverage: ${c.incomplete ? `INCOMPLETE (${c.reason ?? 'unfinished'})` : 'complete'}`,
    `Total seen: ${c.totalSeen}; hydrated: ${c.totalHydrated}; completed: ${c.totalCompleted}`, '', '## Findings'];
  for (const category of ['High Priority', 'Cleanup Candidates', 'Epic Hygiene', 'Duplicate / Relationship Candidates', 'Next Actions']) {
    lines.push('', `### ${category}`);
    for (const finding of report.findings.filter(f => f.category === category)) lines.push(`- ${finding.id} — ${finding.recommendation}`);
  }
  if (c.incomplete) lines.push('', `Resume with checkpoint: ${report.continuation.checkpoint}`);
  return `${lines.join('\n')}\n`;
}
