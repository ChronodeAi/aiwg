// Read frontier/queue JSONL and checkpoint queue-before-ledger under the artifact path owner.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveProjectAiwgDirForWrite } from '../../config/project-artifacts.js';
import type { ExpansionCandidate } from './expand-queue.js';

export interface ExpansionState {
  ref: string;
  seed_id: string | null;
  explored_on: string;
  status: 'explored' | 'throttled' | 'not-found' | 'no-id';
  n_returned: number;
  error?: string;
}

export function expansionPaths(cwd: string) {
  // Validation is read-only, including in dry runs; external roots must be available.
  const artifactRoot = resolveProjectAiwgDirForWrite(cwd);
  const directory = join(artifactRoot, 'research', 'discovery');
  return { directory, ledger: join(directory, 'expansion-state.jsonl'), queue: join(directory, 'candidates.jsonl'),
    rejected: join(directory, 'rejected-candidates.jsonl'), report: join(directory, 'expansion-report.md') };
}

export function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line) as T]; }
    catch { throw new Error(`Invalid JSONL at ${file}:${index + 1}; repair it before expanding`); }
  });
}

export function writeQueue(paths: ReturnType<typeof expansionPaths>, rows: ExpansionCandidate[], report: string): void {
  mkdirSync(paths.directory, { recursive: true });
  for (const [file, content] of [[paths.queue, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '')], [paths.report, report]]) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, content, 'utf8');
    renameSync(temporary, file);
  }
  if (!existsSync(paths.rejected)) writeFileSync(paths.rejected, '', { flag: 'wx' });
}

export function appendState(paths: ReturnType<typeof expansionPaths>, row: ExpansionState): void {
  appendFileSync(paths.ledger, JSON.stringify(row) + '\n', 'utf8');
}
