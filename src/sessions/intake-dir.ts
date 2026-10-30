// Intake-directory batch import for `sessions import --from-dir` (#3168).

import { readdir } from 'node:fs/promises';
import { SessionContractError } from './contracts.js';

export const INTAKE_DIR_SCHEMA_VERSION = '1.0.0';

export type IntakeFileStatus = 'imported' | 'already-imported' | 'skipped' | 'rejected';

export interface IntakeFileReceipt {
  file: string;
  sourceId: string | null;
  digest: string | null;
  status: IntakeFileStatus;
  reason: string | null;
  sessionsInserted: number;
  eventsInserted: number;
}

export interface IntakeDirSummary {
  total: number;
  imported: number;
  alreadyImported: number;
  skipped: number;
  rejected: number;
  sessionsInserted: number;
  eventsInserted: number;
}

/** Recognised intake files are provider export payloads, never control files. */
export function isRecognisedIntakeFile(
  provider: string,
  filename: string,
): { recognised: boolean; reason?: string } {
  if (filename.startsWith('.')) {
    return { recognised: false, reason: `skipped dotfile ${JSON.stringify(filename)}` };
  }
  if (provider === 'claude') {
    if (filename.endsWith('.json') || filename.endsWith('.jsonl')) return { recognised: true };
    return {
      recognised: false,
      reason: 'unrecognised extension for provider claude:'
        + ` expected .json (web/account export) or .jsonl (transcript/hook), got ${JSON.stringify(filename)}`,
    };
  }
  if (filename.endsWith('.json') || filename.endsWith('.jsonl')) return { recognised: true };
  return {
    recognised: false,
    reason: `unrecognised extension for provider ${provider}:`
      + ` expected .json or .jsonl, got ${JSON.stringify(filename)}`,
  };
}

/** Stable per-file source identity: an optional prefix plus the file basename. */
export function intakeSourceId(prefix: string | undefined, filename: string): string {
  const base = filename.replace(/[^A-Za-z0-9._-]+/g, '_');
  return prefix ? `${prefix}/${base}` : base;
}

/** Sorted basenames of regular files directly inside the intake directory. */
export async function listIntakeDirFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    throw new SessionContractError(
      'INVALID_ARGUMENT',
      `intake directory is not readable: ${dir}`,
    );
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

/** Content-free roll-up over one receipt per intake file. */
export function summarizeIntakeReceipts(files: IntakeFileReceipt[]): IntakeDirSummary {
  const summary: IntakeDirSummary = {
    total: files.length,
    imported: 0,
    alreadyImported: 0,
    skipped: 0,
    rejected: 0,
    sessionsInserted: 0,
    eventsInserted: 0,
  };
  for (const file of files) {
    if (file.status === 'imported') summary.imported += 1;
    else if (file.status === 'already-imported') summary.alreadyImported += 1;
    else if (file.status === 'skipped') summary.skipped += 1;
    else summary.rejected += 1;
    summary.sessionsInserted += file.sessionsInserted;
    summary.eventsInserted += file.eventsInserted;
  }
  return summary;
}
