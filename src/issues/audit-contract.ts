// Shared bounded retrieval and checkpoint envelope for issue-audit backends.
import { createHash } from 'node:crypto';

export interface AuditMetadata {
  id: string;
  title: string;
  status: string;
  labels: string[];
  updatedAt: string;
}
export interface AuditPage {
  items: AuditMetadata[];
  nextCursor: string | null;
  complete: boolean;
  bytes: number;
}
export interface AuditContent { body: string; comments: string[]; bytes: number }
export interface AuditTracker {
  /** Includes provider, endpoint/repository and actor; never credentials. */
  identity: string;
  listMetadata(options: {
    cursor: string | null; pageSize: number; maxBytes: number; filter: string; signal?: AbortSignal;
  }): Promise<AuditPage>;
  hydrate(issue: AuditMetadata, options: { maxBytes: number; signal?: AbortSignal }): Promise<AuditContent>;
}
export type AuditCategory = 'High Priority' | 'Cleanup Candidates' | 'Epic Hygiene'
  | 'Duplicate / Relationship Candidates' | 'Next Actions';
export interface AuditFinding { id: string; category: AuditCategory; recommendation: string }
export interface AuditCheckpoint {
  version: 1;
  scope: string;
  cursor: string | null;
  pending: AuditMetadata[];
  pageComplete: boolean;
  finished: boolean;
  completed: string[];
  findings: AuditFinding[];
  totalSeen: number;
  totalHydrated: number;
}
export interface AuditReport {
  mode: 'read-only';
  guidance: string;
  coverage: { totalSeen: number; totalHydrated: number; totalCompleted: number; incomplete: boolean; reason: string | null };
  continuation: { checkpoint: string; cursor: string | null; pending: number };
  batches: Array<{ items: number; bytes: number }>;
  findings: AuditFinding[];
}
export class AuditStop extends Error {
  constructor(readonly reason: string) { super(reason); }
}
export const auditBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
export const auditDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function boundedPageSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new AuditStop('invalid-page-size');
  return value;
}
export function encodeAuditCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
export function decodeAuditCursor<T>(cursor: string): T {
  try {
    if (!/^[A-Za-z0-9_-]{1,8192}$/.test(cursor)) throw new Error();
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as T;
  } catch { throw new AuditStop('cursor-invalidated'); }
}

/** Reject unsupported filters rather than quietly broadening audit coverage. */
export function parseAuditFilter(expression: string): { status: 'open' | 'closed' | 'all'; labels: string[] } {
  const result: { status: 'open' | 'closed' | 'all'; labels: string[] } = { status: 'open', labels: [] };
  const tokens = /(?:^|\s+)(status|label):("(?:[^"\\]|\\.)*"|'[^']*'|[^\s"']+)/gy;
  let position = 0;
  const input = expression.trim();
  while (position < input.length) {
    const match = tokens.exec(input);
    if (!match) throw new AuditStop('filter-invalid');
    let value = match[2];
    if (value.startsWith('"')) {
      try { value = JSON.parse(value) as string; } catch { throw new AuditStop('filter-invalid'); }
    } else if (value.startsWith("'")) value = value.slice(1, -1);
    if (!value) throw new AuditStop('filter-invalid');
    if (match[1] === 'status') {
      if (!['open', 'closed', 'all'].includes(value)) throw new AuditStop('filter-invalid');
      result.status = value as typeof result.status;
    } else result.labels.push(value);
    position = tokens.lastIndex;
  }
  return result;
}
